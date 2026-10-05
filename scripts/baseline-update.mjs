#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(resolve(scriptPath)));
const workspaceRoot = process.cwd();
const fixturePath = resolve(
  process.env.CCAGENT_BASELINE_FIXTURE ?? join(repoRoot, "tests", "fixtures", "eval-baseline-smoke.json"),
);
const tsxCliPath = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCliPath = join(repoRoot, "src", "index.ts");

const reportRun = spawnSync(
  process.execPath,
  [tsxCliPath, sourceCliPath, "--no-session", "/evals", "report", "smoke"],
  {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (reportRun.error) {
  process.stderr.write(`Failed to run the smoke report: ${reportRun.error.message}\n`);
  process.exit(1);
}

if (reportRun.status !== 0) {
  process.stderr.write("The smoke eval report run failed; baseline was not updated.\n");
  process.exit(reportRun.status ?? 1);
}

try {
  const report = await readLatestSmokeReport(workspaceRoot);

  if (!report) {
    process.stderr.write("No smoke eval report found in .ccagent/reports/; baseline was not updated.\n");
    process.exit(1);
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    fileName: "eval-baseline-smoke.json",
    jsonFileName: "eval-baseline-smoke.json",
    jsonPath: "tests/fixtures/eval-baseline-smoke.json",
    path: "tests/fixtures/eval-baseline-smoke.json",
    result: report.result,
    suite: "smoke",
  };

  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  process.stdout.write(
    [
      "Updated committed eval baseline",
      `Path: ${fixturePath}`,
      `Suite: smoke`,
      `Duration: ${report.result.durationMs}ms`,
      `Passed: ${report.result.passed}`,
      `Failed: ${report.result.failed}`,
      `Skipped: ${report.result.skipped}`,
    ].join("\n") + "\n",
  );

  process.exit(0);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to update the eval baseline: ${reason}\n`);
  process.exit(1);
}

async function readLatestSmokeReport(root) {
  const reportsDir = join(root, ".ccagent", "reports");
  let entries = [];

  try {
    entries = await readdir(reportsDir);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const jsonNames = entries
    .filter((entry) => /^eval-report-smoke-.+\.json$/.test(entry))
    .sort();
  let latest = null;

  for (const jsonName of jsonNames) {
    try {
      const value = JSON.parse(await readFile(join(reportsDir, jsonName), "utf8"));

      if (typeof value.result === "object" && value.result !== null && value.suite === "smoke") {
        if (!latest || String(value.exportedAt) > String(latest.exportedAt)) {
          latest = value;
        }
      }
    } catch {
      // Ignore unreadable report files; the next candidate may be valid.
    }
  }

  return latest;
}