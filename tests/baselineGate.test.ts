import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type ScriptRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

const projectRoot = process.cwd();
const updateScriptPath = join(projectRoot, "scripts", "baseline-update.mjs");
const gateScriptPath = join(projectRoot, "scripts", "baseline-gate.mjs");

test("baseline-update writes a committed smoke baseline fixture", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-baseline-update-"));
  const fixturePath = join(workspaceRoot, "eval-baseline-smoke.json");

  try {
    const first = await runScript(updateScriptPath, workspaceRoot, { CCAGENT_BASELINE_FIXTURE: fixturePath });

    assert.equal(first.exitCode, 0);
    assert.match(first.stdout, /Updated committed eval baseline/);
    assert.match(first.stdout, /Passed: 3/);

    const payload = JSON.parse(await readFile(fixturePath, "utf8")) as {
      jsonFileName: string;
      result: { passed: number; results: Array<{ name: string; status: string }>; suite: string };
      suite: string;
    };

    assert.equal(payload.suite, "smoke");
    assert.equal(payload.jsonFileName, "eval-baseline-smoke.json");
    assert.equal(payload.result.suite, "smoke");
    assert.equal(payload.result.passed, 3);
    assert.deepEqual(
      payload.result.results.map((item) => item.name),
      ["list_files", "workspace_info", "read_file"],
    );

    const second = await runScript(updateScriptPath, workspaceRoot, { CCAGENT_BASELINE_FIXTURE: fixturePath });

    assert.equal(second.exitCode, 0);
    assert.match(second.stdout, /Updated committed eval baseline/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("baseline-gate passes a fresh smoke report against the committed baseline", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-baseline-gate-"));
  const fixturePath = join(workspaceRoot, "eval-baseline-smoke.json");

  try {
    await runScript(updateScriptPath, workspaceRoot, { CCAGENT_BASELINE_FIXTURE: fixturePath });
    const gate = await runScript(gateScriptPath, workspaceRoot, {
      CCAGENT_BASELINE_FIXTURE: fixturePath,
    });

    assert.equal(gate.exitCode, 0);
    assert.match(gate.stdout, /Eval report comparison/);
    assert.match(gate.stdout, /Status: OK/);
    assert.match(gate.stdout, /Regressions: none/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("baseline-gate fails fast when the committed baseline fixture is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-baseline-gate-missing-"));

  try {
    const gate = await runScript(gateScriptPath, workspaceRoot, {
      CCAGENT_BASELINE_FIXTURE: join(workspaceRoot, "no-such-baseline.json"),
    });

    assert.equal(gate.exitCode, 1);
    assert.doesNotMatch(gate.stdout, /Eval report comparison/);
    assert.match(gate.stderr, /Baseline gate setup failed/);
    assert.match(gate.stderr, /npm run baseline:update/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function runScript(
  scriptPath: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = {},
): Promise<ScriptRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
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