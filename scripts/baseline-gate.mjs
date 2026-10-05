#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(resolve(scriptPath)));
const workspaceRoot = process.cwd();
const fixturePath = resolve(
  process.env.CCAGENT_BASELINE_FIXTURE ?? join(repoRoot, "tests", "fixtures", "eval-baseline-smoke.json"),
);
const gateScriptPath = join(repoRoot, "scripts", "evals-gate.mjs");
const tsxCliPath = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCliPath = join(repoRoot, "src", "index.ts");
const reportsDir = join(workspaceRoot, ".ccagent", "reports");
const installedBaselinePath = join(reportsDir, "eval-baseline-smoke.json");

try {
  await validateFixture(fixturePath);
  await mkdir(reportsDir, { recursive: true });
  await copyFile(fixturePath, installedBaselinePath);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Baseline gate setup failed: ${reason}\n`);
  process.stderr.write('Run "npm run baseline:update" to (re)generate the committed baseline.\n');
  process.exit(1);
}

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
  process.stderr.write("The smoke eval report run failed; baseline gate failed.\n");
  process.exit(reportRun.status ?? 1);
}

const gateRun = spawnSync(
  process.execPath,
  [gateScriptPath, "--against", "baseline-smoke", "--strict"],
  {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (gateRun.error) {
  process.stderr.write(`Failed to run the eval gate: ${gateRun.error.message}\n`);
  process.exit(1);
}

process.exit(gateRun.status ?? 1);

async function validateFixture(path) {
  const content = JSON.parse(await readFile(path, "utf8"));

  if (
    content.suite !== "smoke" ||
    typeof content.result !== "object" ||
    content.result === null ||
    !Array.isArray(content.result.results) ||
    content.result.results.length === 0
  ) {
    throw new Error(`"${path}" is not a valid smoke eval baseline fixture.`);
  }
}