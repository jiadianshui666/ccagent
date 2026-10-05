#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const REQUIRED_PACKED_FILES = ["package.json", "README.md", "LICENSE", "dist/index.js"];
const BLOCKED_PACKED_PREFIXES = ["node_modules/", ".ccagent/", "tests/", "src/"];

const parsed = parseReleaseCheckArgs(process.argv.slice(2));

if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(1);
}

try {
  const result = await runReleaseCheck(parsed.root, {
    skipPack: parsed.skipPack,
  });
  process.stdout.write(`${formatReleaseCheck(result)}\n`);
  process.exit(result.failures > 0 ? 1 : 0);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Release check failed: ${reason}\n`);
  process.exit(1);
}

async function runReleaseCheck(root, options = {}) {
  const checks = [];
  const packageJsonPath = join(root, "package.json");
  const packageJson = await readJsonFile(packageJsonPath);
  const binPath = readCCAgentBinPath(packageJson);
  const distIndexPath = binPath ? join(root, binPath) : join(root, "dist", "index.js");

  const version = typeof packageJson.version === "string" ? packageJson.version : "";

  checks.push(check(packageJson.name === "ccagent", "package_name", `name=${formatValue(packageJson.name)}`));
  checks.push(
    check(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
      "package_version",
      `version=${formatValue(packageJson.version)}`,
    ),
  );
  checks.push(check(packageJson.type === "module", "package_type", `type=${formatValue(packageJson.type)}`));
  checks.push(check(packageJson.license === "MIT", "package_license", `license=${formatValue(packageJson.license)}`));
  checks.push(check(binPath === "dist/index.js", "package_bin", `bin.ccagent=${formatValue(binPath)}`));
  checks.push(check(Array.isArray(packageJson.files), "package_files", "files controls packed artifacts"));

  if (Array.isArray(packageJson.files)) {
    const files = packageJson.files.map((item) => String(item).replace(/\\/g, "/"));
    checks.push(check(files.includes("dist/") || files.includes("dist"), "package_files_dist", "files includes dist/"));
    checks.push(check(files.includes("README.md"), "package_files_readme", "files includes README.md"));
  }

  if (packageJson.private === true) {
    checks.push(warn("npm_publish", "private=true; suitable for local learning installs, not npm publish"));
  }

  checks.push(await checkFileExists(join(root, "README.md"), "readme", "README.md exists"));
  checks.push(await checkFileExists(distIndexPath, "dist_entry", `${binPath ?? "dist/index.js"} exists`));
  checks.push(await checkShebang(distIndexPath));

  if (!options.skipPack) {
    checks.push(...runNpmPackDryRun(root));
  }

  return {
    checks,
    failures: checks.filter((item) => item.level === "fail").length,
    root,
    warnings: checks.filter((item) => item.level === "warn").length,
  };
}

function runNpmPackDryRun(root) {
  const npmCommand = "npm";
  const child = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
    windowsHide: true,
  });

  if (child.error) {
    return [fail("npm_pack", child.error.message)];
  }

  if (child.status !== 0) {
    const detail = (child.stderr || child.stdout || `exit code ${child.status}`).trim();
    return [fail("npm_pack", detail)];
  }

  let parsed;

  try {
    parsed = JSON.parse(child.stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [fail("npm_pack_json", `Could not parse npm pack JSON: ${reason}`)];
  }

  const files = readPackedFiles(parsed);
  const checks = [check(files.length > 0, "npm_pack", `packed files=${files.length}`)];

  for (const required of REQUIRED_PACKED_FILES) {
    checks.push(check(files.includes(required), `npm_pack_${slug(required)}`, `includes ${required}`));
  }

  for (const prefix of BLOCKED_PACKED_PREFIXES) {
    const offenders = files.filter((file) => file === prefix.slice(0, -1) || file.startsWith(prefix));
    checks.push(
      check(
        offenders.length === 0,
        `npm_pack_no_${slug(prefix)}`,
        offenders.length > 0 ? `unexpected: ${offenders.slice(0, 3).join(", ")}` : `excludes ${prefix}`,
      ),
    );
  }

  return checks;
}

function readPackedFiles(value) {
  const packages = Array.isArray(value) ? value : [value];
  const firstPackage = packages[0];
  const files = Array.isArray(firstPackage?.files) ? firstPackage.files : [];

  return files
    .map((file) => file?.path)
    .filter((path) => typeof path === "string")
    .map((path) => path.replace(/\\/g, "/").replace(/^package\//, ""))
    .sort((left, right) => left.localeCompare(right));
}

async function checkFileExists(path, name, detail) {
  try {
    await access(path);
    return ok(name, detail);
  } catch {
    return fail(name, detail);
  }
}

async function checkShebang(path) {
  try {
    const content = await readFile(path, "utf8");
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";

    return check(firstLine === "#!/usr/bin/env node", "dist_shebang", "dist/index.js starts with node shebang");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail("dist_shebang", reason);
  }
}

async function readJsonFile(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

function readCCAgentBinPath(packageJson) {
  const bin = packageJson.bin;

  if (!bin || typeof bin !== "object" || typeof bin.ccagent !== "string") {
    return undefined;
  }

  return bin.ccagent.replace(/\\/g, "/").replace(/^\.\//, "");
}

function formatReleaseCheck(result) {
  return [
    "Release check",
    `Root: ${result.root}`,
    "",
    ...result.checks.map((item) => `[${item.level.toUpperCase()}] ${item.name}: ${item.detail}`),
    "",
    `Summary: ${result.failures} failure(s), ${result.warnings} warning(s).`,
  ].join("\n");
}

function parseReleaseCheckArgs(argv) {
  const usage = [
    "Usage: node scripts/release-check.mjs [--root <path>] [--skip-pack]",
    "       npm run release:check",
  ].join("\n");
  const args = [...argv];
  let root = repoRoot;
  let skipPack = false;

  while (args.length > 0) {
    const arg = args.shift();

    if (arg === "--help" || arg === "-h") {
      return {
        error: usage,
        ok: false,
      };
    }

    if (arg === "--root") {
      const value = args.shift();

      if (!value) {
        return {
          error: `Missing value for --root.\n${usage}`,
          ok: false,
        };
      }

      root = resolve(value);
      continue;
    }

    if (arg === "--skip-pack") {
      skipPack = true;
      continue;
    }

    return {
      error: `Unsupported argument: ${arg}\n${usage}`,
      ok: false,
    };
  }

  return {
    ok: true,
    root,
    skipPack,
  };
}

function check(condition, name, detail) {
  return condition ? ok(name, detail) : fail(name, detail);
}

function ok(name, detail) {
  return {
    detail,
    level: "ok",
    name,
  };
}

function warn(name, detail) {
  return {
    detail,
    level: "warn",
    name,
  };
}

function fail(name, detail) {
  return {
    detail,
    level: "fail",
    name,
  };
}

function formatValue(value) {
  return value === undefined ? "(missing)" : JSON.stringify(value);
}

function slug(value) {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
