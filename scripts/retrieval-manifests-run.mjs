#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const DEFAULT_SUITE_DIR = join(repoRoot, "tests", "fixtures", "retrieval-manifests");
const DEFAULT_ENTRY = join(repoRoot, "dist", "index.js");
const requireFromRepo = createRequire(join(repoRoot, "package.json"));

function formatUsage() {
  return [
    "Usage: node scripts/retrieval-manifests-run.mjs [repo-id...] [options]",
    "",
    "Run hosted retrieval eval manifests against real repositories.",
    "",
    "Arguments:",
    "  repo-id          One or more repository ids from the registry (default: all).",
    "                   Use \"all\" to run every registered repository.",
    "",
    "Options:",
    "  --target <dir>   Run against an existing extracted repository at <dir>.",
    "                   Requires exactly one repo-id.",
    "  --fetch          Download the pinned package tarballs with \"npm pack\"",
    "                   and extract them into a temporary directory.",
    "  --keep           Keep temporary downloads for inspection.",
    "  --entry <path>   CLI entry point (default: dist/index.js).",
    "  --tsx            Load the entry through the tsx TypeScript loader",
    "                   (useful when dist/ has not been built).",
    "  --suite-dir <d>  Directory containing index.json and manifest files.",
    "  --help           Show this usage text.",
    "",
    "Exit codes: 0 all suites passed, 1 at least one suite failed, 2 usage error.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    entry: DEFAULT_ENTRY,
    fetch: false,
    ids: [],
    keep: false,
    suiteDir: DEFAULT_SUITE_DIR,
    target: undefined,
    tsx: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--fetch") {
      options.fetch = true;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--tsx") {
      options.tsx = true;
    } else if (arg === "--suite-dir") {
      options.suiteDir = resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (arg === "--entry") {
      options.entry = resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (arg === "--target") {
      options.target = resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(formatUsage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option ${arg}`);
      console.error(formatUsage());
      process.exit(2);
    } else {
      options.ids.push(arg);
    }
  }

  return options;
}

async function loadRegistry(suiteDir) {
  let raw;

  try {
    raw = await readFile(join(suiteDir, "index.json"), "utf8");
  } catch {
    throw new Error(`Registry index.json missing in suite directory ${suiteDir}.`);
  }

  try {
    const parsed = JSON.parse(raw);

    if (parsed.version !== 1 || !Array.isArray(parsed.repositories) || parsed.repositories.length === 0) {
      throw new Error("Registry schema error: expected version 1 with a non-empty repositories array.");
    }

    return parsed;
  } catch (error) {
    throw new Error(`Registry index.json in ${suiteDir} is not a valid registry: ${String(error && error.message ? error.message : error)}`);
  }
}

async function extractTarball(tarball, destination) {
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", destination], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const stderr = String(error && error.stderr ? error.stderr : "");
    throw new Error(`tar failed to extract ${tarball}: ${stderr.trim() || String(error && error.message ? error.message : error)}`);
  }
}

async function fetchRepository(repository, temporaryRoot) {
  const packageSpec = `${repository.package}@${repository.npmVersion}`;
  const tarballDir = join(temporaryRoot, `${repository.id}-tarball`);
  const extractedDir = join(temporaryRoot, `${repository.id}-src`);
  await mkdir(tarballDir, { recursive: true });
  await mkdir(extractedDir, { recursive: true });

  if (/[\s"'`]/.test(repository.package) || !/^[0-9A-Za-z._-]+$/.test(repository.npmVersion)) {
    throw new Error(`Refusing to download ${repository.id}: package name or npmVersion contains unsafe characters.`);
  }

  let packOutput;

  try {
    const packArgs = ["pack", packageSpec, "--json", "--pack-destination", "."];
    packOutput = process.platform === "win32"
      ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${packArgs.join(" ")}`], {
          cwd: tarballDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
          windowsHide: true,
        })
      : execFileSync("npm", packArgs, {
          cwd: tarballDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
          windowsHide: true,
        });
  } catch (error) {
    throw new Error(`npm pack ${packageSpec} failed: ${String(error && error.message ? error.message : error)}`);
  }

  const openJson = packOutput.indexOf("[");
  const closeJson = packOutput.lastIndexOf("]");

  if (openJson < 0 || closeJson < openJson) {
    throw new Error(`npm pack ${packageSpec} produced no JSON array output.`);
  }

  const entries = JSON.parse(packOutput.slice(openJson, closeJson + 1));
  const filename = entries[0] && entries[0].filename;

  if (!filename) {
    throw new Error(`npm pack ${packageSpec} did not report a tarball filename.`);
  }

  await extractTarball(join(tarballDir, filename), extractedDir);

  const packageRoot = join(extractedDir, "package");

  try {
    await stat(packageRoot);
    return packageRoot;
  } catch {
    return extractedDir;
  }
}

async function resolveTarget(repository, options, temporaryDirs) {
  if (options.target) {
    try {
      const targetStat = await stat(options.target);

      if (!targetStat.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error(`--target ${options.target} is not a readable directory.`);
    }

    return options.target;
  }

  if (!options.fetch) {
    throw new Error(`No target for "${repository.id}": pass --target <dir> or --fetch.`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "ccagent-retrieval-"));
  temporaryDirs.push(temporaryRoot);

  return fetchRepository(repository, temporaryRoot);
}

function runSuite(repository, target, options) {
  const nodeArgs = options.tsx
    ? ["--import", pathToFileURL(requireFromRepo.resolve("tsx")).href, options.entry, "--no-session", "--plain"]
    : [options.entry, "--no-session", "--plain"];

  try {
    execFileSync(process.execPath, [...nodeArgs, "/index build"], {
      cwd: target,
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    });
  } catch {
    throw new Error(`Context index build failed for ${repository.id} in ${target}.`);
  }

  let evalOutput;

  try {
    evalOutput = execFileSync(process.execPath, [...nodeArgs, "/index eval run --json"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
  } catch (error) {
    const stdout = String(error && error.stdout ? error.stdout : "");

    if (stdout.indexOf("{") >= 0) {
      evalOutput = stdout;
    } else {
      throw new Error(`Retrieval eval failed for ${repository.id}: ${String(error && error.message ? error.message : error)}`);
    }
  }

  const jsonStart = evalOutput.indexOf("{");

  if (jsonStart < 0) {
    throw new Error(`Retrieval eval for ${repository.id} produced no JSON report.`);
  }

  let report;

  try {
    report = JSON.parse(evalOutput.slice(jsonStart));
  } catch {
    throw new Error(`Retrieval eval for ${repository.id} produced unreadable JSON.`);
  }

  return {
    automaticMrr: report.automatic?.mrr ?? 0,
    automaticRecall: report.automatic?.recallAtK ?? 0,
    id: repository.id,
    lexicalMrr: report.lexical?.mrr ?? 0,
    lexicalRecall: report.lexical?.recallAtK ?? 0,
    status: report.status ?? "fail",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const registry = await loadRegistry(options.suiteDir);

  if (options.target && options.ids.length !== 1) {
    console.error("--target requires exactly one repo-id.");
    process.exit(2);
  }

  const requestedIds = options.ids.length === 0 || options.ids.includes("all")
    ? registry.repositories.map((repository) => repository.id)
    : options.ids;
  const knownIds = new Set(registry.repositories.map((repository) => repository.id));
  const unknownIds = requestedIds.filter((id) => !knownIds.has(id));

  if (unknownIds.length > 0) {
    console.error(`Unknown repository id(s): ${unknownIds.join(", ")}. Known ids: ${[...knownIds].join(", ")}.`);
    process.exit(2);
  }

  const temporaryDirs = [];
  const summaries = [];

  try {
    for (const id of requestedIds) {
      const repository = registry.repositories.find((candidate) => candidate.id === id);

      if (!repository) {
        continue;
      }

      const manifestPath = join(options.suiteDir, repository.manifest);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

      if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
        throw new Error(`Manifest ${repository.manifest} for ${repository.id} has no cases.`);
      }

      const target = await resolveTarget(repository, options, temporaryDirs);
      const ccagentDir = join(target, ".ccagent");
      await mkdir(ccagentDir, { recursive: true });
      await writeFile(join(ccagentDir, "retrieval-eval.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

      const summary = runSuite(repository, target, options);
      summaries.push(summary);

      console.log(`SUITE ${summary.id} status=${summary.status} lexicalRecall=${summary.lexicalRecall.toFixed(3)} lexicalMrr=${summary.lexicalMrr.toFixed(3)} automaticRecall=${summary.automaticRecall.toFixed(3)} automaticMrr=${summary.automaticMrr.toFixed(3)}`);
    }
  } finally {
    if (!options.keep) {
      await Promise.all(temporaryDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    }
  }

  const passed = summaries.filter((summary) => summary.status === "pass").length;
  console.log(`Summary: ${passed}/${summaries.length} suites passed.`);
  process.exit(passed === summaries.length ? 0 : 1);
}

main().catch((error) => {
  console.error(`retrieval-manifests-run: ${String(error && error.message ? error.message : error)}`);
  process.exit(1);
});
