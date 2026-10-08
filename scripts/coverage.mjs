#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const testsDir = join(repoRoot, "tests");

const testFiles = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join("tests", name));

const linesThreshold = process.env.CCAGENT_COVERAGE_LINES ?? "90";

const coverageArgs = [
  "--experimental-test-coverage",
  "--test-coverage-exclude=node_modules/",
  "--test-coverage-exclude=tests/",
  "--test-coverage-exclude=dist/",
];

if (linesThreshold !== "0" && linesThreshold !== "off") {
  coverageArgs.push(`--test-coverage-lines=${linesThreshold}`);
}

const child = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...coverageArgs, ...testFiles, ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

process.exit(typeof child.status === "number" ? child.status : 1);