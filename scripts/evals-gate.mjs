#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = dirname(scriptDir);
const workspaceRoot = process.cwd();
const tsxCliPath = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCliPath = join(repoRoot, "src", "index.ts");
const parsed = parseGateArgs(process.argv.slice(2));

if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(1);
}

const gateArgs = [
  "--no-session",
  "/evals",
  "gate",
  "--max-duration-delta",
  String(parsed.maxDurationDeltaMs),
];

if (parsed.against) {
  gateArgs.push("--against", parsed.against);
}

if (parsed.strict) {
  gateArgs.push("--strict");
}

const child = spawnSync(
  process.execPath,
  [tsxCliPath, sourceCliPath, ...gateArgs],
  {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (child.error) {
  process.stderr.write(`${child.error.message}\n`);
  process.exit(1);
}

process.exit(child.status ?? 1);

function parseGateArgs(argv) {
  const usage = [
    "Usage: npm run evals:gate [-- --max-duration-delta <ms>] [-- --against <report>] [-- --strict]",
    "       CCAGENT_EVAL_MAX_DURATION_DELTA=50 npm run evals:gate",
  ].join("\n");
  const args = [...argv];
  const envValue = process.env.CCAGENT_EVAL_MAX_DURATION_DELTA;
  const defaults = envValue === undefined ? 100 : readThreshold(envValue);
  let maxDurationDeltaMs = defaults;
  let against;
  let strict = false;
  let thresholdSetFromArgs = false;

  while (args.length > 0) {
    const arg = args.shift();

    if (arg === "--help" || arg === "-h") {
      return {
        error: usage,
        ok: false,
      };
    }

    if (arg === "--max-duration-delta") {
      const value = args.shift();

      if (!value) {
        return {
          error: "Missing value for --max-duration-delta.\n" + usage,
          ok: false,
        };
      }

      const parsed = readThreshold(value);

      if (parsed === null) {
        return {
          error: "Invalid value for --max-duration-delta.\n" + usage,
          ok: false,
        };
      }

      maxDurationDeltaMs = parsed;
      thresholdSetFromArgs = true;
      continue;
    }

    if (arg?.startsWith("--max-duration-delta=")) {
      const parsed = readThreshold(arg.slice("--max-duration-delta=".length));

      if (parsed === null) {
        return {
          error: "Invalid value for --max-duration-delta.\n" + usage,
          ok: false,
        };
      }

      maxDurationDeltaMs = parsed;
      thresholdSetFromArgs = true;
      continue;
    }

    if (arg === "--against") {
      const value = args.shift();

      if (!value || value.startsWith("--")) {
        return {
          error: "Missing value for --against.\n" + usage,
          ok: false,
        };
      }

      against = value;
      continue;
    }

    if (arg?.startsWith("--against=")) {
      const value = arg.slice("--against=".length);

      if (!value) {
        return {
          error: "Missing value for --against.\n" + usage,
          ok: false,
        };
      }

      against = value;
      continue;
    }

    if (arg === "--strict") {
      if (strict) {
        return {
          error: "--strict can only be provided once.\n" + usage,
          ok: false,
        };
      }

      strict = true;
      continue;
    }

    return {
      error: `Unsupported argument: ${arg}\n${usage}`,
      ok: false,
    };
  }

  if (envValue !== undefined && defaults === null && !thresholdSetFromArgs) {
    return {
      error: "Invalid CCAGENT_EVAL_MAX_DURATION_DELTA value.\n" + usage,
      ok: false,
    };
  }

  return {
    against,
    maxDurationDeltaMs,
    ok: true,
    strict,
  };
}

function readThreshold(value) {
  if (value === undefined || value === "") {
    return 100;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 600000) {
    return null;
  }

  return parsed;
}
