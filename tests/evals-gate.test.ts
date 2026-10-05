import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type ScriptRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

const projectRoot = process.cwd();
const gateScriptPath = join(projectRoot, "scripts", "evals-gate.mjs");

test("evals gate script supports default, env, and argv thresholds", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-evals-gate-script-"));

  try {
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 10, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 10, name: "workspace_info", status: "pass", summary: "ok" },
        { durationMs: 20, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 40,
      exportedAt: "2026-07-11T10:00:00.000Z",
      suite: "smoke",
    });
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 20, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 10, name: "workspace_info", status: "pass", summary: "ok" },
        { durationMs: 40, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 70,
      exportedAt: "2026-07-11T10:05:00.000Z",
      suite: "smoke",
    });

    const defaultRun = await runGateScript(workspaceRoot);
    const envRun = await runGateScript(workspaceRoot, [], {
      CCAGENT_EVAL_MAX_DURATION_DELTA: "5",
    });
    const argvRun = await runGateScript(workspaceRoot, ["--max-duration-delta", "5"]);
    const equalArgRun = await runGateScript(workspaceRoot, ["--max-duration-delta=100"]);

    assert.equal(defaultRun.exitCode, 0);
    assert.match(defaultRun.stdout, /Duration threshold: 100ms/);
    assert.match(defaultRun.stdout, /Status: OK/);
    assert.equal(envRun.exitCode, 1);
    assert.match(envRun.stdout, /Duration threshold: 5ms/);
    assert.match(envRun.stdout, /Status: REGRESSED/);
    assert.equal(argvRun.exitCode, 1);
    assert.match(argvRun.stdout, /Duration threshold: 5ms/);
    assert.equal(equalArgRun.exitCode, 0);
    assert.match(equalArgRun.stdout, /Duration threshold: 100ms/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("evals gate script forwards --against to a pinned baseline", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-evals-gate-against-"));

  try {
    await writeBaselineJson(workspaceRoot, "smoke", [
      { durationMs: 10, name: "list_files", status: "pass", summary: "ok" },
      { durationMs: 10, name: "workspace_info", status: "pass", summary: "ok" },
      { durationMs: 10, name: "read_file", status: "pass", summary: "ok" },
    ]);
    await writeEvalReportJson(workspaceRoot, {
      cases: [{ durationMs: 20, name: "list_files", status: "pass", summary: "ok" }],
      durationMs: 20,
      exportedAt: "2026-07-11T10:05:00.000Z",
      suite: "smoke",
    });

    const run = await runGateScript(workspaceRoot, ["--against", "baseline-smoke"]);

    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /Status: REGRESSED/);
    assert.match(run.stdout, /coverage: missing expected cases: workspace_info, read_file/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("evals gate script strict mode fails when the latest report has failed cases", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-evals-gate-strict-"));

  try {
    const cases = [
      { durationMs: 10, name: "list_files", status: "fail" as const, summary: "boom" },
      { durationMs: 10, name: "workspace_info", status: "pass" as const, summary: "ok" },
      { durationMs: 10, name: "read_file", status: "pass" as const, summary: "ok" },
    ];

    await writeEvalReportJson(workspaceRoot, {
      cases,
      durationMs: 30,
      exportedAt: "2026-07-11T10:00:00.000Z",
      suite: "smoke",
    });
    await writeEvalReportJson(workspaceRoot, {
      cases,
      durationMs: 30,
      exportedAt: "2026-07-11T10:05:00.000Z",
      suite: "smoke",
    });

    const defaultRun = await runGateScript(workspaceRoot);
    const strictRun = await runGateScript(workspaceRoot, ["--strict"]);

    assert.equal(defaultRun.exitCode, 0);
    assert.match(defaultRun.stdout, /Status: OK/);
    assert.equal(strictRun.exitCode, 1);
    assert.match(strictRun.stdout, /Status: OK/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function runGateScript(
  workspaceRoot: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<ScriptRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gateScriptPath, ...args], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        ...env,
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        CCAGENT_API_MODE: "",
        CCAGENT_MODEL: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
    child.stdin.end();
  });
}

async function writeEvalReportJson(
  workspaceRoot: string,
  report: {
    cases: Array<{
      durationMs: number;
      name: string;
      status: "pass" | "fail" | "skip";
      summary: string;
    }>;
    durationMs: number;
    exportedAt: string;
    suite: "smoke" | "regression" | "benchmark";
  },
): Promise<void> {
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileStamp = report.exportedAt.replace(/[:.]/g, "-");
  const jsonFileName = `eval-report-${report.suite}-${fileStamp}.json`;
  const fileName = `eval-report-${report.suite}-${fileStamp}.md`;
  const payload = {
    exportedAt: report.exportedAt,
    fileName,
    jsonFileName,
    jsonPath: `.ccagent/reports/${jsonFileName}`,
    path: `.ccagent/reports/${fileName}`,
    result: {
      durationMs: report.durationMs,
      failed: report.cases.filter((item) => item.status === "fail").length,
      passed: report.cases.filter((item) => item.status === "pass").length,
      results: report.cases,
      suite: report.suite,
      skipped: report.cases.filter((item) => item.status === "skip").length,
    },
    suite: report.suite,
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, jsonFileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeBaselineJson(
  workspaceRoot: string,
  suite: "smoke" | "regression" | "benchmark",
  cases: Array<{
    durationMs: number;
    name: string;
    status: "pass" | "fail" | "skip";
    summary: string;
  }>,
): Promise<void> {
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const jsonFileName = `eval-baseline-${suite}.json`;
  const fileName = `eval-baseline-${suite}.md`;
  const payload = {
    exportedAt: "2026-07-11T09:00:00.000Z",
    fileName,
    jsonFileName,
    jsonPath: `.ccagent/reports/${jsonFileName}`,
    path: `.ccagent/reports/${fileName}`,
    result: {
      durationMs: cases.reduce((total, item) => total + item.durationMs, 0),
      failed: cases.filter((item) => item.status === "fail").length,
      passed: cases.filter((item) => item.status === "pass").length,
      results: cases,
      suite,
      skipped: cases.filter((item) => item.status === "skip").length,
    },
    suite,
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, jsonFileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
