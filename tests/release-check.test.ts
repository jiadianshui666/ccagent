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
const releaseCheckScriptPath = join(projectRoot, "scripts", "release-check.mjs");

test("release check script validates a package fixture", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-release-check-ok-"));

  try {
    await writeReleaseFixture(workspaceRoot, {
      bin: {
        ccagent: "./dist/index.js",
      },
      files: ["dist/", "README.md"],
    });

    const result = await runReleaseCheckScript(workspaceRoot, ["--skip-pack"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Release check/);
    assert.match(result.stdout, /\[OK\] package_bin: bin\.ccagent="dist\/index\.js"/);
    assert.match(result.stdout, /\[OK\] dist_shebang: dist\/index\.js starts with node shebang/);
    assert.match(result.stdout, /\[WARN\] npm_publish: private=true/);
    assert.match(result.stdout, /Summary: 0 failure\(s\), 1 warning\(s\)\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("release check script fails when the CLI bin is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-release-check-fail-"));

  try {
    await writeReleaseFixture(workspaceRoot, {
      files: ["dist/", "README.md"],
    });

    const result = await runReleaseCheckScript(workspaceRoot, ["--skip-pack"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /\[FAIL\] package_bin: bin\.ccagent=\(missing\)/);
    assert.match(result.stdout, /Summary: \d+ failure\(s\), 1 warning\(s\)\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function writeReleaseFixture(
  workspaceRoot: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const packageJson = {
    name: "ccagent",
    version: "0.1.0",
    private: true,
    type: "module",
    license: "MIT",
    ...overrides,
  };

  await mkdir(join(workspaceRoot, "dist"), { recursive: true });
  await writeFile(join(workspaceRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(join(workspaceRoot, "README.md"), "# CCAgent\n", "utf8");
  await writeFile(join(workspaceRoot, "LICENSE"), "MIT License\n", "utf8");
  await writeFile(
    join(workspaceRoot, "dist", "index.js"),
    "#!/usr/bin/env node\nconsole.log('ccagent');\n",
    "utf8",
  );
}

async function runReleaseCheckScript(
  workspaceRoot: string,
  args: string[] = [],
): Promise<ScriptRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [releaseCheckScriptPath, "--root", workspaceRoot, ...args],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
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
