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

const child = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...testFiles, ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

process.exit(typeof child.status === "number" ? child.status : 1);