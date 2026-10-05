import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadApiKeyStatus } from "../src/auth.js";
import { loadConfig, loadUserConfig } from "../src/config.js";
import { exportDiagnosticsReport, formatDiagnosticsReportResult } from "../src/diagnostics.js";
import { loadProjectInstructions } from "../src/instructions.js";

test("exportDiagnosticsReport writes a redacted provider report", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-diagnostics-"));
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUserDir = process.env.CCAGENT_USER_DIR;

  try {
    process.env.OPENAI_API_KEY = "sk-secret-diagnostics-test";
    process.env.CCAGENT_USER_DIR = join(workspaceRoot, "user-home");
    await mkdir(join(workspaceRoot, ".ccagent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        openai: {
          retry: {
            maxAttempts: 4,
            baseDelayMs: 500,
            maxDelayMs: 5000,
          },
        },
      }),
      "utf8",
    );
    const loadedConfig = await loadConfig(workspaceRoot);
    const projectInstructions = await loadProjectInstructions(workspaceRoot);
    const report = await exportDiagnosticsReport(workspaceRoot, {
      activeClient: "mock",
      apiKeyStatus: await loadApiKeyStatus(),
      loadedConfig,
      projectInstructions,
      stream: false,
      userConfig: await loadUserConfig(),
      useSession: false,
    });

    assert.match(report.path, /^\.ccagent\/reports\/diagnostics-.+\.md$/);
    assert.match(formatDiagnosticsReportResult(report), /Exported diagnostics report/);

    const content = await readFile(report.absolutePath, "utf8");

    assert.match(content, /# CCAgent Diagnostics Report/);
    assert.match(content, /OPENAI_API_KEY: set/);
    assert.match(content, /OpenAI provider retry: maxAttempts=4, baseDelayMs=500, maxDelayMs=5000/);
    assert.match(content, /ccagent --doctor/);
    assert.match(content, /ccagent --no-session \/provider-smoke/);
    assert.doesNotMatch(content, /sk-secret-diagnostics-test/);
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }

    if (previousUserDir === undefined) {
      delete process.env.CCAGENT_USER_DIR;
    } else {
      process.env.CCAGENT_USER_DIR = previousUserDir;
    }

    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
