import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolAuditEvent } from "../src/audit.js";
import { foldContinuationLine, hasContinuingBackslash, loadCheckpointCompletionNames } from "../src/cli.js";

type CliRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

const projectRoot = process.cwd();
const tsxCliPath = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCliPath = join(projectRoot, "src", "index.ts");

// Windows releases directory handles for spawned child processes (such as MCP
// stdio servers) asynchronously after the parent exits, so an immediate rm can
// fail with EBUSY. Retry briefly for the handle release to complete.
async function removeWorkspace(workspaceRoot: string): Promise<void> {
  const delaysMs = [50, 100, 200, 400];

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(workspaceRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";

      if (!retryable || attempt >= delaysMs.length) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

test("CLI initializes project skills without overwriting existing content", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-init-skill-"));
  const path = join(workspaceRoot, ".ccagent", "skills", "code-review", "SKILL.md");

  try {
    const created = await runCli(workspaceRoot, ["--init-skill", "code-review"]);
    const template = await readFile(path, "utf8");
    const existing = await runCli(workspaceRoot, ["--init-skill", "code-review"]);
    const invalid = await runCli(workspaceRoot, ["--init-skill", "../outside"]);

    assert.equal(created.exitCode, 0);
    assert.match(created.stdout, /Created project skill:/);
    assert.match(template, /description: Code Review workflow guidance\./);
    assert.equal(existing.exitCode, 0);
    assert.match(existing.stdout, /Project skill already exists\./);
    assert.equal(await readFile(path, "utf8"), template);
    assert.equal(invalid.exitCode, 0);
    assert.match(invalid.stdout, /Expected skill name to contain 1-64 letters, numbers, dashes, or underscores\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI lists and reads project skills without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-skills-"));

  try {
    await writeProjectSkill(
      workspaceRoot,
      "code-review",
      [
        "---",
        "description: Review code for correctness.",
        "tags: review, safety",
        "---",
        "",
        "# Code Review",
        "",
        "Read changed files before reporting findings.",
      ].join("\n"),
    );

    const listed = await runCli(workspaceRoot, ["--no-session", "/skills"]);
    const read = await runCli(workspaceRoot, ["--no-session", "/skill", "code-review"]);
    const usage = await runCli(workspaceRoot, ["--no-session", "/skill"]);
    const missing = await runCli(workspaceRoot, ["--no-session", "/skill", "missing"]);

    assert.equal(listed.exitCode, 0);
    assert.match(listed.stdout, /Project skills/);
    assert.match(listed.stdout, /code-review: Review code for correctness\./);
    assert.doesNotMatch(listed.stdout, /\[mock model\]/);
    assert.equal(read.exitCode, 0);
    assert.match(read.stdout, /Name: code-review/);
    assert.match(read.stdout, /Tags: review, safety/);
    assert.match(read.stdout, /Read changed files before reporting findings\./);
    assert.doesNotMatch(read.stdout, /\[mock model\]/);
    assert.match(usage.stdout, /Usage: \/skill <name>/);
    assert.match(missing.stdout, /Project skill not found: missing/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI blocks confirm project commands when stdin is not interactive", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-confirm-blocked-"));

  try {
    await writeProjectCommand(
      workspaceRoot,
      "review",
      [
        "---",
        "description: Review workflow.",
        "args: required",
        "confirm: true",
        "---",
        "",
        "Review {{args}}",
      ].join("\n"),
    );

    const result = await runCli(workspaceRoot, ["--no-session", "/cmd", "review", "src/agent.ts"]);
    const auditEvents = await readProjectCommandAuditEvents(workspaceRoot);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Project command requires confirmation, but stdin is not interactive: review/);
    assert.doesNotMatch(result.stdout, /\[mock model\]/);

    assert.deepEqual(
      auditEvents.map((event) => ({
        action: event.action,
        commandName: event.commandName,
        status: event.status,
        summary: event.summary,
      })),
      [
        {
          action: "run",
          commandName: "review",
          status: "blocked",
          summary: "Project command requires confirmation, but stdin is not interactive.",
        },
      ],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI runs project commands that do not require confirmation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-confirm-not-required-"));

  try {
    await writeProjectCommand(
      workspaceRoot,
      "say",
      [
        "---",
        "description: Say workflow.",
        "confirm: false",
        "---",
        "",
        "Say {{args}}",
      ].join("\n"),
    );

    const result = await runCli(workspaceRoot, ["--no-session", "/cmd", "say", "hello"]);
    const auditEvents = await readProjectCommandAuditEvents(workspaceRoot);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /\[mock model\] You said: Say hello/);

    assert.deepEqual(
      auditEvents.map((event) => ({
        action: event.action,
        commandName: event.commandName,
        status: event.status,
        summary: event.summary,
      })),
      [
        {
          action: "run",
          commandName: "say",
          status: "started",
          summary: "Expanded project command sent to agent.",
        },
      ],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI previews project commands with named arguments", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-named-args-preview-"));

  try {
    await writeProjectCommand(
      workspaceRoot,
      "review",
      [
        "---",
        "description: Review workflow.",
        "usage: /cmd review --file <path> --topic <topic> [notes]",
        "---",
        "",
        "# Review {{file}}",
        "",
        "Focus: {{topic}}",
        "Notes: {{args}}",
      ].join("\n"),
    );

    const result = await runCli(workspaceRoot, [
      "--no-session",
      "/cmd-preview",
      "review",
      "--file",
      "src/agent.ts",
      "--topic=security",
      "extra",
      "notes",
    ]);

    const auditEvents = await readProjectCommandAuditEvents(workspaceRoot);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Named args:\n  file: src\/agent\.ts\n  topic: security/);
    assert.match(result.stdout, /Positional args: extra notes/);
    assert.match(result.stdout, /# Review src\/agent\.ts/);
    assert.match(result.stdout, /Focus: security/);
    assert.match(result.stdout, /Notes: extra notes/);
    assert.deepEqual(auditEvents[0]?.namedArgs, {
      file: "src/agent.ts",
      topic: "security",
    });
    assert.equal(auditEvents[0]?.positionalArgs, "extra notes");
    assert.equal(
      auditEvents[0]?.expandedPromptPreview,
      "# Review src/agent.ts Focus: security Notes: extra notes",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI blocks project commands with missing named arguments", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-named-args-missing-"));

  try {
    await writeProjectCommand(
      workspaceRoot,
      "review",
      ["---", "usage: /cmd review --file <path> --topic <topic>", "---", "Review {{file}} for {{topic}}"].join("\n"),
    );

    const result = await runCli(workspaceRoot, [
      "--no-session",
      "/cmd-preview",
      "review",
      "--file",
      "src/agent.ts",
    ]);
    const auditEvents = await readProjectCommandAuditEvents(workspaceRoot);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /missing required named argument\(s\): topic/);
    assert.match(result.stdout, /--topic <value>/);
    assert.deepEqual(auditEvents[0]?.namedArgs, {
      file: "src/agent.ts",
    });
    assert.equal(auditEvents[0]?.positionalArgs, "");
    assert.deepEqual(
      auditEvents.map((event) => ({
        action: event.action,
        commandName: event.commandName,
        status: event.status,
        summary: event.summary,
      })),
      [
        {
          action: "preview",
          commandName: "review",
          status: "blocked",
          summary: "Project command is missing required named argument(s): topic",
        },
      ],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI shows completion help commands without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-completion-help-"));

  try {
    const completion = await runCli(workspaceRoot, ["--no-session", "/completion"]);
    const keys = await runCli(workspaceRoot, ["--no-session", "/keys"]);

    assert.equal(completion.exitCode, 0);
    assert.match(completion.stdout, /Completion help/);
    assert.match(completion.stdout, /Tab completion supports:/);
    assert.doesNotMatch(completion.stdout, /\[mock model\]/);
    assert.equal(keys.exitCode, 0);
    assert.match(keys.stdout, /Alias for \/completion/);
    assert.doesNotMatch(keys.stdout, /\[mock model\]/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI runs hello slash command without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-hello-"));

  try {
    const result = await runCli(workspaceRoot, ["--no-session", "/hello"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Hello from CCAgent/);
    assert.match(result.stdout, /runs locally/);
    assert.doesNotMatch(result.stdout, /\[mock model\]/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI shows architecture help without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-architecture-help-"));

  try {
    const architecture = await runCli(workspaceRoot, ["--no-session", "/architecture"]);
    const arch = await runCli(workspaceRoot, ["--no-session", "/arch"]);
    const flow = await runCli(workspaceRoot, ["--no-session", "/flow"]);
    const tools = await runCli(workspaceRoot, ["--no-session", "/architecture", "tools"]);
    const sources = await runCli(workspaceRoot, ["--no-session", "/architecture", "sources"]);
    const exercises = await runCli(workspaceRoot, ["--no-session", "/architecture", "exercises"]);

    assert.equal(architecture.exitCode, 0);
    assert.match(architecture.stdout, /CCAgent architecture/);
    assert.match(architecture.stdout, /CLI -> Agent -> ModelClient -> ToolRegistry -> Tools -> Renderer/);
    assert.doesNotMatch(architecture.stdout, /\[mock model\]/);
    assert.equal(arch.exitCode, 0);
    assert.match(arch.stdout, /CCAgent architecture/);
    assert.equal(flow.exitCode, 0);
    assert.match(flow.stdout, /Learning order:/);
    assert.equal(tools.exitCode, 0);
    assert.match(tools.stdout, /Architecture: tools/);
    assert.match(tools.stdout, /Tool registry and tool execution/);
    assert.equal(sources.exitCode, 0);
    assert.match(sources.stdout, /Architecture: source landmarks/);
    assert.match(sources.stdout, /rg -n "async function handleInput/);
    assert.equal(exercises.exitCode, 0);
    assert.match(exercises.stdout, /Architecture: learning exercises/);
    assert.match(exercises.stdout, /Exercise 2: trace a read-only tool/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI shows model runtime settings without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-model-runtime-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify(
        {
          model: "config-model",
          openai: {
            apiMode: "chat",
            baseURL: "https://relay.example/v1",
            retry: {
              maxAttempts: 4,
              baseDelayMs: 500,
              maxDelayMs: 5000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const model = await runCli(workspaceRoot, ["--no-session", "/model"]);
    const models = await runCli(workspaceRoot, ["--no-session", "/models"]);

    assert.equal(model.exitCode, 0);
    assert.match(model.stdout, /Model runtime/);
    assert.match(model.stdout, /Active client: mock/);
    assert.match(model.stdout, /Configured model: config-model \(source: config\)/);
    assert.match(model.stdout, /OpenAI API mode: chat \(source: config\)/);
    assert.match(model.stdout, /OpenAI base URL: https:\/\/relay\.example\/v1 \(source: config\)/);
    assert.match(model.stdout, /OpenAI provider retry: maxAttempts=4, baseDelayMs=500, maxDelayMs=5000/);
    assert.match(model.stdout, /OPENAI_API_KEY: not set \(mock model is active\)/);
    assert.doesNotMatch(model.stdout, /\[mock model\]/);
    assert.equal(models.exitCode, 0);
    assert.match(models.stdout, /Model runtime/);
    assert.doesNotMatch(models.stdout, /\[mock model\]/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI loads configured MCP tools into runtime context", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-mcp-context-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        mcp: {
          enabled: true,
          servers: {
            fixture: {
              command: process.execPath,
              args: [join(projectRoot, "tests", "fixtures", "mcp-test-server.mjs")],
              timeoutMs: 10_000,
            },
          },
        },
      }),
      "utf8",
    );

    const result = await runCli(workspaceRoot, ["--no-session", "/context"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /mcp\.enabled: on/);
    assert.match(result.stdout, /mcp\.servers: 1/);
    assert.match(result.stdout, /mcp\.tools: 1/);
    assert.match(result.stdout, /mcp\.resources: 1/);
    assert.match(result.stdout, /mcp\.prompts: 1/);
    assert.match(result.stdout, /mcp\.templates: 1/);
    assert.doesNotMatch(result.stdout, /MCP warning:/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI adds, disables, and removes MCP server configuration without starting a model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-mcp-config-"));

  try {
    const added = await runCli(workspaceRoot, [
      "--mcp-add",
      "fixture",
      process.execPath,
      "--",
      join(projectRoot, "tests", "fixtures", "mcp-test-server.mjs"),
    ]);
    const disabled = await runCli(workspaceRoot, ["--mcp-disable"]);
    const removed = await runCli(workspaceRoot, ["--mcp-remove", "fixture"]);
    const stored = JSON.parse(await readFile(join(workspaceRoot, ".ccagent", "config.json"), "utf8")) as {
      mcp?: { enabled?: boolean; servers?: Record<string, unknown> };
    };

    assert.equal(added.exitCode, 0);
    assert.match(added.stdout, /Added MCP server fixture/);
    assert.match(added.stdout, /MCP enabled: yes/);
    assert.equal(disabled.exitCode, 0);
    assert.match(disabled.stdout, /MCP disabled/);
    assert.equal(removed.exitCode, 0);
    assert.match(removed.stdout, /Removed MCP server fixture/);
    assert.equal(stored.mcp?.enabled, false);
    assert.deepEqual(stored.mcp?.servers, {});
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI shows MCP status and discovered tool catalog without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-mcp-status-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        mcp: {
          enabled: true,
          servers: {
            fixture: {
              command: process.execPath,
              args: [join(projectRoot, "tests", "fixtures", "mcp-test-server.mjs")],
              env: {
                MCP_TEST_SECRET: "must-not-appear",
              },
              timeoutMs: 10_000,
            },
          },
        },
      }),
      "utf8",
    );

    const status = await runCli(workspaceRoot, ["--no-session", "/mcp"]);
    const tools = await runCli(workspaceRoot, ["--no-session", "/mcp tools"]);
    const json = await runCli(workspaceRoot, ["--no-session", "/mcp --json"]);
    const reloaded = await runCli(workspaceRoot, ["--no-session", "/mcp reload"]);
    const interactive = await runInteractiveCli(workspaceRoot, [
      "/mcp reload",
      "/mcp resources",
      "/mcp read fixture fixture://guide",
      "/mcp prompts",
      '/mcp prompt fixture echo_prompt {"message":"hello"}',
      "/mcp templates",
      "/mcp read fixture fixture://docs/agent",
      "/tool mcp_fixture_echo_text",
      "exit",
    ], 15000);

    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /MCP status/);
    assert.match(status.stdout, /fixture: status=connected, tools=1/);
    assert.doesNotMatch(status.stdout, /MCP_TEST_SECRET|must-not-appear/);
    assert.equal(tools.exitCode, 0);
    assert.match(tools.stdout, /MCP tools/);
    assert.match(tools.stdout, /mcp_fixture_echo_text \(fixture\.echo_text\)/);
    assert.equal(reloaded.exitCode, 0);
    assert.match(reloaded.stdout, /MCP reloaded/);
    assert.match(reloaded.stdout, /fixture: status=connected, tools=1/);
    assert.equal(interactive.exitCode, 0);
    assert.match(interactive.stdout, /MCP reloaded/);
    assert.match(interactive.stdout, /MCP resources/);
    assert.match(interactive.stdout, /Fixture guide \(fixture:\/\/guide\)/);
    assert.match(interactive.stdout, /Fixture resource content\./);
    assert.match(interactive.stdout, /MCP prompts/);
    assert.match(interactive.stdout, /fixture\.echo_prompt/);
    assert.match(interactive.stdout, /Fixture prompt: hello/);
    assert.match(interactive.stdout, /MCP resource templates/);
    assert.match(interactive.stdout, /fixture:\/\/docs\/\{topic\}/);
    assert.match(interactive.stdout, /Fixture topic resource: agent/);
    assert.match(interactive.stdout, /Tool: mcp_fixture_echo_text/);
    assert.doesNotMatch(interactive.stdout, /Unknown tool: mcp_fixture_echo_text/);
    assert.deepEqual(JSON.parse(json.stdout), {
      connectedServers: 1,
      configuredServers: 1,
      enabled: true,
      promptCount: 1,
      resourceCount: 1,
      servers: [{
        command: process.execPath,
        name: "fixture",
        promptCount: 1,
        resourceCount: 1,
        status: "connected",
        templateCount: 1,
        toolCount: 1,
      }],
      templateCount: 1,
      toolCount: 1,
      warnings: [],
    });
  } finally {
    await removeWorkspace(workspaceRoot);
  }
});

test("CLI shows provider compatibility matrix without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-provider-matrix-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify(
        {
          openai: {
            apiMode: "chat",
            baseURL: "https://relay.example/v1",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await runCli(workspaceRoot, ["--no-session", "/providers"]);
    const matrix = await runCli(workspaceRoot, ["--no-session", "/provider-matrix"]);

    assert.equal(providers.exitCode, 0);
    assert.match(providers.stdout, /Provider compatibility matrix/);
    assert.match(providers.stdout, /API mode: chat \(source: config\)/);
    assert.match(providers.stdout, /Base URL: https:\/\/relay\.example\/v1 \(source: config\)/);
    assert.match(providers.stdout, /Detected profile: Custom Chat Completions relay/);
    assert.match(providers.stdout, /generic-chat-relay: Generic OpenAI-compatible relay/);
    assert.match(providers.stdout, /ccagent --no-session \/provider-smoke/);
    assert.doesNotMatch(providers.stdout, /\[mock model\]/);
    assert.equal(matrix.exitCode, 0);
    assert.match(matrix.stdout, /Provider compatibility matrix/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI shows roadmap without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-roadmap-"));

  try {
    const roadmap = await runCli(workspaceRoot, ["--no-session", "/roadmap"]);

    assert.equal(roadmap.exitCode, 0);
    assert.match(roadmap.stdout, /CCAgent roadmap/);
    assert.match(roadmap.stdout, /Learning-focused Claude Code style agent: about 99% complete\./);
    assert.match(roadmap.stdout, /Completed foundations:/);
    assert.match(roadmap.stdout, /Next recommended work:/);
    assert.doesNotMatch(roadmap.stdout, /\[mock model\]/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI shows and exports code map without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-code-map-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "package.json"), "{}\n", "utf8");
    await writeFile(join(workspaceRoot, "src", "cli.ts"), "export {};\n", "utf8");

    const codeMap = await runCli(workspaceRoot, ["--no-session", "/code-map"]);
    const alias = await runCli(workspaceRoot, ["--no-session", "/codemap"]);
    const exported = await runCli(workspaceRoot, ["--no-session", "/code-map", "export"]);
    const usage = await runCli(workspaceRoot, ["--no-session", "/code-map", "bad"]);

    assert.equal(codeMap.exitCode, 0);
    assert.match(codeMap.stdout, /CCAgent code map/);
    assert.match(codeMap.stdout, /src\/cli\.ts/);
    assert.match(codeMap.stdout, /Learning order:/);
    assert.doesNotMatch(codeMap.stdout, /\[mock model\]/);
    assert.equal(alias.exitCode, 0);
    assert.match(alias.stdout, /CCAgent code map/);
    assert.equal(exported.exitCode, 0);
    assert.match(exported.stdout, /Exported code map report/);
    const reportPath = getExportPath(exported.stdout);
    const reportContent = await readFile(join(workspaceRoot, reportPath), "utf8");
    assert.match(reportPath, /^\.ccagent\/reports\/code-map-.+\.md$/);
    assert.match(reportContent, /^# CCAgent Code Map/m);
    assert.match(usage.stdout, /Usage: \/code-map/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI exports diagnostics report without calling the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-diagnostics-"));

  try {
    const exported = await runCli(workspaceRoot, ["--no-session", "/diagnostics", "export"]);
    const usage = await runCli(workspaceRoot, ["--no-session", "/diagnostics"]);

    assert.equal(exported.exitCode, 0);
    assert.match(exported.stdout, /Exported diagnostics report/);
    assert.match(exported.stdout, /Secrets: OPENAI_API_KEY value was not written/);
    assert.doesNotMatch(exported.stdout, /\[mock model\]/);
    const reportPath = getExportPath(exported.stdout);
    const reportContent = await readFile(join(workspaceRoot, reportPath), "utf8");
    assert.match(reportPath, /^\.ccagent\/reports\/diagnostics-.+\.md$/);
    assert.match(reportContent, /# CCAgent Diagnostics Report/);
    assert.match(reportContent, /OPENAI_API_KEY: not set/);
    assert.match(reportContent, /ccagent --no-session \/provider-smoke/);
    assert.doesNotMatch(reportContent, /OPENAI_API_KEY=/);
    assert.match(usage.stdout, /Usage: \/diagnostics export/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI runs offline evals without calling the prompt model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-evals-"));

  try {
    const evals = await runCli(workspaceRoot, ["--no-session", "/evals"]);
    const runAlias = await runCli(workspaceRoot, ["--no-session", "/evals", "run"]);
    const cases = await runCli(workspaceRoot, ["--no-session", "/evals", "cases"]);
    const casesRegression = await runCli(workspaceRoot, ["--no-session", "/evals", "cases", "regression"]);
    const tagsRegression = await runCli(workspaceRoot, ["--no-session", "/evals", "tags", "regression"]);
    const tagsJson = await runCli(workspaceRoot, ["--no-session", "/evals", "tags", "--json"]);
    const casesRepair = await runCli(workspaceRoot, [
      "--no-session",
      "/evals",
      "cases",
      "regression",
      "--tag",
      "repair",
    ]);
    const casesJson = await runCli(workspaceRoot, ["--no-session", "/evals", "cases", "--json"]);
    const caseRun = await runCli(workspaceRoot, ["--no-session", "/evals", "case", "list_files"]);
    const caseJson = await runCli(workspaceRoot, ["--no-session", "/evals", "case", "list_files", "--json"]);
    const regression = await runCli(workspaceRoot, [
      "--no-session",
      "/evals",
      "regression",
      "--tag",
      "plan",
    ]);
    const regressionTag = await runCli(workspaceRoot, [
      "--no-session",
      "/evals",
      "smoke",
      "--tag",
      "tool",
    ]);
    const benchmarkJson = await runCli(workspaceRoot, [
      "--no-session",
      "/evals",
      "benchmark",
      "--tag",
      "tool",
      "--iterations",
      "1",
      "--json",
    ]);
    const report = await runCli(workspaceRoot, ["--no-session", "/evals", "report", "smoke"]);
    const secondReport = await runCli(workspaceRoot, [
      "--no-session",
      "/evals",
      "report",
      "benchmark",
      "--tag",
      "tool",
      "--iterations",
      "1",
    ]);
    const reports = await runCli(workspaceRoot, ["--no-session", "/evals", "reports"]);
    const reportsJson = await runCli(workspaceRoot, ["--no-session", "/evals", "reports", "--json"]);
    const compare = await runCli(workspaceRoot, ["--no-session", "/evals", "compare"]);
    const compareJson = await runCli(workspaceRoot, ["--no-session", "/evals", "compare", "--json"]);
    const gate = await runCli(workspaceRoot, [
      "--no-session",
      "/evals",
      "gate",
      "--max-duration-delta",
      "100",
    ]);
    const usage = await runCli(workspaceRoot, ["--no-session", "/evals", "bad"]);

    assert.equal(evals.exitCode, 0);
    assert.match(evals.stdout, /Offline evals \(smoke\)/);
    assert.match(evals.stdout, /Passed: 3/);
    assert.match(evals.stdout, /Failed: 0/);
    assert.match(evals.stdout, /\[PASS\] list_files/);
    assert.match(evals.stdout, /\[PASS\] workspace_info/);
    assert.match(evals.stdout, /\[PASS\] read_file/);
    assert.doesNotMatch(evals.stdout, /\[mock model\] You said: \/evals/);

    assert.equal(runAlias.exitCode, 0);
    assert.match(runAlias.stdout, /Offline evals \(smoke\)/);

    assert.equal(cases.exitCode, 0);
    assert.match(cases.stdout, /Offline eval cases/);
    assert.match(cases.stdout, /Count: 29/);
    assert.match(cases.stdout, /context_graph_retrieval/);
    assert.match(cases.stdout, /repair_loop_bad_patch_recovery/);
    assert.match(cases.stdout, /repair_loop_wrong_file_recovery/);
    assert.match(cases.stdout, /repair_loop_partial_multifile_recovery/);
    assert.match(cases.stdout, /repair_loop_multifile/);
    assert.match(cases.stdout, /repair_loop_service_contract/);
    assert.match(cases.stdout, /repair_loop_renamed_api_contract/);
    assert.match(cases.stdout, /repair_loop_stale_import_contract/);
    assert.match(cases.stdout, /repair_loop_contract_drift/);
    assert.match(cases.stdout, /repair_loop_multi_caller_contract_drift/);
    assert.match(cases.stdout, /repair_loop_cascading_dependency_chain/);
    assert.match(cases.stdout, /repair_loop_ambiguous_test_signal/);
    assert.match(cases.stdout, /repair_loop_large_repo_retrieval/);
    assert.match(cases.stdout, /repair_loop_process_cleanup/);
    assert.match(cases.stdout, /repair_loop_service_readiness/);
    assert.match(cases.stdout, /repair_loop_project_fixture/);
    assert.match(cases.stdout, /verification_flaky_guard/);
    assert.match(cases.stdout, /verification_environment_failures/);
    assert.match(cases.stdout, /suites: regression, benchmark/);
    assert.equal(casesRegression.exitCode, 0);
    assert.match(casesRegression.stdout, /Suite: regression/);
    assert.match(casesRegression.stdout, /Count: 26/);
    assert.doesNotMatch(casesRegression.stdout, /- list_files/);
    assert.equal(casesRepair.exitCode, 0);
    assert.match(casesRepair.stdout, /Suite: regression/);
    assert.match(casesRepair.stdout, /Tag: repair/);
    assert.match(casesRepair.stdout, /Count: 19/);
    assert.match(casesRepair.stdout, /repair_loop_bad_patch_recovery/);
    assert.match(casesRepair.stdout, /repair_loop_wrong_file_recovery/);
    assert.match(casesRepair.stdout, /repair_loop_partial_multifile_recovery/);
    assert.match(casesRepair.stdout, /repair_loop_multifile/);
    assert.match(casesRepair.stdout, /repair_loop_service_contract/);
    assert.match(casesRepair.stdout, /repair_loop_renamed_api_contract/);
    assert.match(casesRepair.stdout, /repair_loop_stale_import_contract/);
    assert.match(casesRepair.stdout, /repair_loop_contract_drift/);
    assert.match(casesRepair.stdout, /repair_loop_multi_caller_contract_drift/);
    assert.match(casesRepair.stdout, /repair_loop_cascading_dependency_chain/);
    assert.match(casesRepair.stdout, /repair_loop_ambiguous_test_signal/);
    assert.match(casesRepair.stdout, /repair_loop_large_repo_retrieval/);
    assert.match(casesRepair.stdout, /repair_loop_process_cleanup/);
    assert.match(casesRepair.stdout, /repair_loop_service_readiness/);
    assert.match(casesRepair.stdout, /repair_loop_project_fixture/);
    assert.match(casesRepair.stdout, /verification_flaky_guard/);
    assert.match(casesRepair.stdout, /verification_environment_failures/);
    assert.doesNotMatch(casesRepair.stdout, /- plan_update/);
    assert.equal(casesJson.exitCode, 0);
    const parsedCases = JSON.parse(casesJson.stdout) as { cases: Array<{ name: string }>; count: number };
    assert.equal(parsedCases.count, 29);
    assert.equal(parsedCases.cases.some((item) => item.name === "context_graph_retrieval"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_bad_patch_recovery"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_wrong_file_recovery"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_partial_multifile_recovery"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_service_contract"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_renamed_api_contract"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_stale_import_contract"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_contract_drift"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_multi_caller_contract_drift"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_cascading_dependency_chain"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_ambiguous_test_signal"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_large_repo_retrieval"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_process_cleanup"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_service_readiness"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "repair_loop_project_fixture"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "verification_failure_strategies"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "verification_environment_failures"), true);
    assert.equal(parsedCases.cases.some((item) => item.name === "verification_flaky_guard"), true);

    assert.equal(tagsRegression.exitCode, 0);
    assert.match(tagsRegression.stdout, /Offline eval tags/);
    assert.match(tagsRegression.stdout, /Suite: regression/);
    assert.match(tagsRegression.stdout, /- repair/);
    assert.match(tagsRegression.stdout, /- workspace/);
    assert.equal(tagsJson.exitCode, 0);
    const parsedTags = JSON.parse(tagsJson.stdout) as { count: number; tags: Array<{ name: string }> };
    assert.equal(parsedTags.count, 13);
    assert.equal(parsedTags.tags.some((item) => item.name === "retrieval"), true);
    assert.equal(parsedTags.tags.some((item) => item.name === "verification"), true);

    assert.equal(caseRun.exitCode, 0);
    assert.match(caseRun.stdout, /Offline eval case \(list_files\)/);
    assert.match(caseRun.stdout, /\[PASS\] list_files/);
    assert.equal(caseJson.exitCode, 0);
    const parsedCase = JSON.parse(caseJson.stdout) as { caseName: string; result: { status: string } };
    assert.equal(parsedCase.caseName, "list_files");
    assert.equal(parsedCase.result.status, "pass");

    assert.equal(regression.exitCode, 0);
    assert.match(regression.stdout, /Offline evals \(regression\)/);
    assert.match(regression.stdout, /Tag: plan/);
    assert.match(regression.stdout, /\[PASS\] plan_update/);
    assert.doesNotMatch(regression.stdout, /\[PASS\] repair_loop/);

    assert.equal(regressionTag.exitCode, 0);
    assert.match(regressionTag.stdout, /Offline evals \(smoke\)/);
    assert.match(regressionTag.stdout, /Tag: tool/);
    assert.match(regressionTag.stdout, /\[PASS\] list_files/);
    assert.match(regressionTag.stdout, /\[PASS\] workspace_info/);
    assert.match(regressionTag.stdout, /\[PASS\] read_file/);
    assert.doesNotMatch(regressionTag.stdout, /\[PASS\] plan_update/);

    assert.equal(benchmarkJson.exitCode, 0);
    assert.doesNotMatch(benchmarkJson.stdout, /Offline evals/);
    const benchmark = JSON.parse(benchmarkJson.stdout) as { iterations: number; suite: string };
    assert.equal(benchmark.suite, "benchmark");
    assert.equal(benchmark.iterations, 1);

    assert.equal(report.exitCode, 0);
    assert.match(report.stdout, /Exported eval report/);
    assert.match(report.stdout, /Suite: smoke/);
    const reportPath = getExportPath(report.stdout);
    const reportContent = await readFile(join(workspaceRoot, reportPath), "utf8");
    assert.match(reportPath, /^\.ccagent\/reports\/eval-report-smoke-.+\.md$/);
    assert.match(reportContent, /# CCAgent Eval Report/);
    assert.match(reportContent, /\| list_files \| PASS \|/);
    assert.match(reportContent, /\| workspace_info \| PASS \|/);

    assert.equal(secondReport.exitCode, 0);
    assert.match(secondReport.stdout, /Suite: benchmark/);
    const secondReportPath = getExportPath(secondReport.stdout);
    assert.match(secondReportPath, /^\.ccagent\/reports\/eval-report-benchmark-.+\.md$/);

    assert.equal(reports.exitCode, 0);
    assert.match(reports.stdout, /Eval reports/);
    assert.match(reports.stdout, /Count: 2/);
    assert.match(reports.stdout, /benchmark/);
    assert.match(reports.stdout, /smoke/);
    assert.equal(reportsJson.exitCode, 0);
    const parsedReports = JSON.parse(reportsJson.stdout) as { reports: Array<{ suite: string }> };
    assert.deepEqual(parsedReports.reports.map((item) => item.suite), ["benchmark", "smoke"]);

    assert.equal(compare.exitCode, 0);
    assert.match(compare.stdout, /Eval report comparison/);
    assert.match(compare.stdout, /Suite: smoke -> benchmark/);
    assert.match(compare.stdout, /\| Case \| Left ms \| Right ms \| Delta \|/);
    assert.equal(compareJson.exitCode, 0);
    const parsedCompare = JSON.parse(compareJson.stdout) as {
      left: { suite: string };
      ok: boolean;
      right: { suite: string };
    };
    assert.equal(parsedCompare.ok, true);
    assert.equal(parsedCompare.left.suite, "smoke");
    assert.equal(parsedCompare.right.suite, "benchmark");
    assert.equal(gate.exitCode, 0);
    assert.match(gate.stdout, /Eval report comparison/);
    assert.match(gate.stdout, /Status: INFO/);
    assert.match(gate.stdout, /Duration threshold: 100ms/);

    assert.equal(usage.exitCode, 0);
    assert.match(usage.stdout, /Usage: \/evals \[smoke\|regression\|benchmark\] \[--tag <tag>\] \[--iterations <1-20>\] \[--json\]/);
    assert.match(usage.stdout, /\/evals cases \[smoke\|regression\|benchmark\] \[--tag <tag>\] \[--json\]/);
    assert.match(usage.stdout, /\/evals tags \[smoke\|regression\|benchmark\] \[--json\]/);
    assert.match(usage.stdout, /Tags: .*repair/);
    assert.match(usage.stdout, /\/evals case <name> \[--json\]/);
    assert.match(usage.stdout, /Cases: .*list_files/);
    assert.match(usage.stdout, /\/evals report \[smoke\|regression\|benchmark\] \[--tag <tag>\] \[--iterations <1-20>\] \[--json\]/);
    assert.match(usage.stdout, /\/evals reports \[count\] \[--json\]/);
    assert.match(usage.stdout, /\/evals compare \[left\] \[right\] \[--max-duration-delta <ms>\] \[--json\]/);
    assert.match(usage.stdout, /\/evals gate \[--against <report>\] \[--strict\] \[--max-duration-delta <ms>\] \[--json\]/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI compare exits non-zero when duration regression exceeds threshold", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-evals-compare-threshold-"));

  try {
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 10, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 20, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 30,
      exportedAt: "2026-07-11T10:00:00.000Z",
      suite: "smoke",
    });
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 20, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 40, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 60,
      exportedAt: "2026-07-11T10:05:00.000Z",
      suite: "smoke",
    });

    const compare = await runCli(workspaceRoot, ["--no-session", "/evals", "compare", "--max-duration-delta", "5"]);
    const gate = await runCli(workspaceRoot, [
      "--no-session",
      "/evals",
      "gate",
      "--max-duration-delta",
      "5",
    ]);

    assert.equal(compare.exitCode, 1);
    assert.match(compare.stdout, /Eval report comparison/);
    assert.match(compare.stdout, /Status: REGRESSED/);
    assert.match(compare.stdout, /Duration threshold: 5ms/);
    assert.equal(gate.exitCode, 1);
    assert.match(gate.stdout, /Eval report comparison/);
    assert.match(gate.stdout, /Status: REGRESSED/);
    assert.match(gate.stdout, /Duration threshold: 5ms/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI evals gate exits non-zero when expected cases are missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-evals-gate-coverage-"));

  try {
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 10, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 10, name: "workspace_info", status: "pass", summary: "ok" },
        { durationMs: 10, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 30,
      exportedAt: "2026-07-11T10:00:00.000Z",
      suite: "smoke",
    });
    await writeEvalReportJson(workspaceRoot, {
      cases: [{ durationMs: 10, name: "list_files", status: "pass", summary: "ok" }],
      durationMs: 10,
      exportedAt: "2026-07-11T10:05:00.000Z",
      suite: "smoke",
    });

    const gate = await runCli(workspaceRoot, ["--no-session", "/evals", "gate"]);

    assert.equal(gate.exitCode, 1);
    assert.match(gate.stdout, /Status: REGRESSED/);
    assert.match(gate.stdout, /coverage: missing expected cases: workspace_info, read_file/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI evals gate --strict exits non-zero when the latest report has failed cases", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-evals-gate-strict-"));

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

    const defaultGate = await runCli(workspaceRoot, ["--no-session", "/evals", "gate"]);
    const strictGate = await runCli(workspaceRoot, ["--no-session", "/evals", "gate", "--strict"]);

    assert.equal(defaultGate.exitCode, 0);
    assert.match(defaultGate.stdout, /Status: OK/);
    assert.equal(strictGate.exitCode, 1);
    assert.match(strictGate.stdout, /Status: OK/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI evals baseline pins the latest suite report", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-evals-baseline-"));

  try {
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 10, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 10, name: "workspace_info", status: "pass", summary: "ok" },
        { durationMs: 10, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 30,
      exportedAt: "2026-07-11T10:00:00.000Z",
      suite: "smoke",
    });

    const baseline = await runCli(workspaceRoot, ["--no-session", "/evals", "baseline"]);
    const missing = await runCli(workspaceRoot, ["--no-session", "/evals", "baseline", "regression"]);

    assert.equal(baseline.exitCode, 0);
    assert.match(baseline.stdout, /Saved eval baseline/);
    assert.match(baseline.stdout, /Suite: smoke/);
    assert.match(baseline.stdout, /Gate against it with: \/evals gate --against baseline-smoke/);
    assert.equal(missing.exitCode, 0);
    assert.match(missing.stdout, /No regression eval report found/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI provider repair gate exits non-zero when repair status regresses", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-provider-repair-gate-"));

  try {
    await writeProviderRepairReportJson(workspaceRoot, {
      durationMs: 100,
      exportedAt: "2026-07-11T11:00:00.000Z",
      status: "pass",
      summary: "provider repaired fixture",
    });
    await writeProviderRepairReportJson(workspaceRoot, {
      durationMs: 50,
      exportedAt: "2026-07-11T11:05:00.000Z",
      status: "skip",
      summary: "provider skipped fixture",
    });

    const compare = await runCli(workspaceRoot, ["--no-session", "/provider-repair-compare"]);
    const gate = await runCli(workspaceRoot, ["--no-session", "/provider-repair-gate"]);

    assert.equal(compare.exitCode, 0);
    assert.match(compare.stdout, /Provider repair comparison/);
    assert.match(compare.stdout, /Status: REGRESSED/);
    assert.match(compare.stdout, /Status: pass -> skip/);
    assert.equal(gate.exitCode, 1);
    assert.match(gate.stdout, /Provider repair comparison/);
    assert.match(gate.stdout, /Status: REGRESSED/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI runs model smoke without saving session history", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-model-smoke-"));

  try {
    const smoke = await runCli(workspaceRoot, ["/model-smoke"]);
    const customSmoke = await runCli(workspaceRoot, [
      "--no-session",
      "/model-smoke",
      "custom",
      "ping",
    ]);
    const streamingSmoke = await runCli(workspaceRoot, [
      "--no-session",
      "/model-smoke",
      "--stream",
      "stream",
      "ping",
    ]);
    const toolSmoke = await runCli(workspaceRoot, [
      "--no-session",
      "/model-smoke",
      "--tool",
    ]);

    assert.equal(smoke.exitCode, 0);
    assert.match(smoke.stdout, /Model smoke/);
    assert.match(smoke.stdout, /Client: mock/);
    assert.match(smoke.stdout, /Streaming: off/);
    assert.match(smoke.stdout, /Prompt: Reply with exactly: OK/);
    assert.match(smoke.stdout, /Tool calls: \(none\)/);
    assert.match(smoke.stdout, /Usage: input=\d+, output=\d+, total=\d+ estimated=yes/);
    assert.match(smoke.stdout, /\[mock model\] You said: Reply with exactly: OK/);
    assert.equal(customSmoke.exitCode, 0);
    assert.match(customSmoke.stdout, /Prompt: custom ping/);
    assert.match(customSmoke.stdout, /\[mock model\] You said: custom ping/);
    assert.equal(streamingSmoke.exitCode, 0);
    assert.match(streamingSmoke.stdout, /Streaming: on/);
    assert.match(streamingSmoke.stdout, /Text delta chunks: \d+/);
    assert.match(streamingSmoke.stdout, /Prompt: stream ping/);
    assert.match(streamingSmoke.stdout, /\[mock model\] You said: stream ping/);
    assert.equal(toolSmoke.exitCode, 0);
    assert.match(toolSmoke.stdout, /Tool smoke: on \(smoke_ping returned\)/);
    assert.match(toolSmoke.stdout, /Tool calls: smoke_ping/);
    assert.match(toolSmoke.stdout, /Tool arguments:\r?\n- smoke_ping: \{"message":"OK"\}/);
    assert.match(toolSmoke.stdout, /Response:\r?\n\(empty\)/);
    await assert.rejects(
      readFile(join(workspaceRoot, ".ccagent", "sessions", "current.json"), "utf8"),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI runs provider smoke without saving session history", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-provider-smoke-"));

  try {
    const smoke = await runCli(workspaceRoot, ["/provider-smoke"]);
    const smokeJson = await runCli(workspaceRoot, ["--no-session", "/provider-smoke", "--json"]);
    const fullSmoke = await runCli(workspaceRoot, ["--no-session", "/provider-smoke", "--full"]);
    const savedQuickSmoke = await runCli(workspaceRoot, ["--no-session", "/provider-smoke", "--save"]);
    const savedFullSmoke = await runCli(workspaceRoot, ["--no-session", "/provider-smoke", "--full", "--save"]);
    const providerReports = await runCli(workspaceRoot, ["--no-session", "/provider-reports"]);
    const providerReportsJson = await runCli(workspaceRoot, ["--no-session", "/provider-reports", "--json"]);
    const providerCompare = await runCli(workspaceRoot, ["--no-session", "/provider-compare"]);
    const providerCompareJson = await runCli(workspaceRoot, ["--no-session", "/provider-compare", "--json"]);
    const providerGate = await runCli(workspaceRoot, ["--no-session", "/provider-gate"]);
    const providerRepair = await runCli(workspaceRoot, ["--no-session", "/provider-repair"]);
    const providerRepairJson = await runCli(workspaceRoot, ["--no-session", "/provider-repair", "--json"]);
    const providerRepairSaved = await runCli(workspaceRoot, ["--no-session", "/provider-repair", "--save"]);
    const providerRepairSavedAgain = await runCli(workspaceRoot, ["--no-session", "/provider-repair", "--save"]);
    const providerRepairReports = await runCli(workspaceRoot, ["--no-session", "/provider-repair-reports"]);
    const providerRepairReportsJson = await runCli(workspaceRoot, ["--no-session", "/provider-repair-reports", "--json"]);
    const providerRepairCompare = await runCli(workspaceRoot, ["--no-session", "/provider-repair-compare"]);
    const providerRepairCompareJson = await runCli(workspaceRoot, ["--no-session", "/provider-repair-compare", "--json"]);
    const providerRepairGate = await runCli(workspaceRoot, ["--no-session", "/provider-repair-gate"]);
    const fullSmokeJson = await runCli(workspaceRoot, [
      "--no-session",
      "/provider-smoke",
      "--profile",
      "full",
      "--json",
    ]);
    const emptyProfiles = await runCli(workspaceRoot, ["--no-session", "/provider-profiles"]);
    const mockProfileAdd = await runCli(workspaceRoot, ["--no-session", "/provider-profiles", "add"]);
    await writeKnownGoodProviderSmokeReport(workspaceRoot, "provider-smoke-2030-01-01T00-00-00-000Z.json");
    const knownProfileAdd = await runCli(workspaceRoot, [
      "--no-session",
      "/provider-profiles",
      "add",
      "provider-smoke-2030-01-01T00-00-00-000Z.json",
    ]);
    const providerProfiles = await runCli(workspaceRoot, ["--no-session", "/provider-profiles"]);
    const providerProfilesJson = await runCli(workspaceRoot, ["--no-session", "/provider-profiles", "--json"]);
    const useProviderProfile = await runCli(workspaceRoot, [
      "--no-session",
      "/provider-profiles",
      "use",
      "relay-example-chat-relay-model",
    ]);
    const configAfterProfile = JSON.parse(
      await readFile(join(workspaceRoot, ".ccagent", "config.json"), "utf8"),
    ) as {
      model?: string;
      openai?: {
        apiMode?: string;
        baseURL?: string;
      };
    };

    assert.equal(smoke.exitCode, 0);
    assert.match(smoke.stdout, /Provider smoke/);
    assert.match(smoke.stdout, /Client: mock/);
    assert.match(smoke.stdout, /Client kind: mock \(OPENAI_API_KEY is not set\)/);
    assert.match(smoke.stdout, /OpenAI API mode: responses/);
    assert.match(smoke.stdout, /Profile: quick/);
    assert.match(smoke.stdout, /Summary: 3 passed, 0 failed/);
    assert.match(smoke.stdout, /Provider diagnosis/);
    assert.match(smoke.stdout, /Status: needs-real-run/);
    assert.match(smoke.stdout, /API key is not set; mock results do not prove real provider compatibility/);
    assert.match(smoke.stdout, /Run ccagent --no-session \/provider-smoke --full to check unicode and streaming tool calls/);
    assert.match(smoke.stdout, /Compatibility profile/);
    assert.match(smoke.stdout, /Status: mock-only/);
    assert.match(smoke.stdout, /unicode: not-run - not run by selected smoke profile/);
    assert.match(smoke.stdout, /\[PASS\] text \(\d+ms\): text response returned/);
    assert.match(smoke.stdout, /\[PASS\] streaming \(\d+ms\): streamed \d+ text delta chunk\(s\)/);
    assert.match(smoke.stdout, /\[PASS\] tool-call \(\d+ms\): smoke_ping tool call returned/);
    assert.match(smoke.stdout, /Tool calls: smoke_ping/);
    assert.match(smoke.stdout, /smoke_ping: \{"message":"OK"\}/);
    assert.match(smoke.stdout, /Response: \[mock model\] You said: Reply with exactly: OK/);
    assert.equal(smokeJson.exitCode, 0);
    const parsed = JSON.parse(smokeJson.stdout) as {
      apiMode: string;
      client: string;
      clientKind: string;
      failed: number;
      hasApiKey: boolean;
      passed: number;
      probes: Array<{
        name: string;
        ok: boolean;
        summary: string;
        toolCalls: string[];
      }>;
      diagnosis: {
        actions: string[];
        notes: string[];
        status: string;
        warnings: string[];
      };
      compatibility: {
        capabilities: Array<{ name: string; status: string }>;
        status: string;
      };
    };
    assert.equal(parsed.client, "mock");
    assert.equal(parsed.clientKind, "mock (OPENAI_API_KEY is not set)");
    assert.equal(parsed.apiMode, "responses");
    assert.equal(parsed.hasApiKey, false);
    assert.equal(parsed.diagnosis.status, "needs-real-run");
    assert.equal(parsed.diagnosis.warnings.some((warning) => warning.includes("mock results")), true);
    assert.equal(parsed.compatibility.status, "mock-only");
    assert.equal(parsed.compatibility.capabilities.find((capability) => capability.name === "unicode")?.status, "not-run");
    assert.equal((parsed as { profile?: string }).profile, "quick");
    assert.equal(parsed.passed, 3);
    assert.equal(parsed.failed, 0);
    assert.deepEqual(parsed.probes.map((probe) => probe.name), ["text", "streaming", "tool-call"]);
    assert.equal(parsed.probes.every((probe) => probe.ok), true);
    assert.equal(parsed.probes[2]?.toolCalls.includes("smoke_ping"), true);
    assert.equal(fullSmoke.exitCode, 0);
    assert.match(fullSmoke.stdout, /Profile: full/);
    assert.match(fullSmoke.stdout, /Summary: 6 passed, 0 failed/);
    assert.match(fullSmoke.stdout, /\[PASS\] unicode \(\d+ms\): text response returned/);
    assert.match(fullSmoke.stdout, /\[PASS\] streaming-tool-call \(\d+ms\): streaming smoke_ping tool call returned/);
    assert.match(fullSmoke.stdout, /\[PASS\] tool-followup \(\d+ms\): follow-up turn returned text \(9 chars\)/);
    assert.equal(savedQuickSmoke.exitCode, 0);
    assert.match(savedQuickSmoke.stdout, /Saved report:/);
    assert.equal(savedFullSmoke.exitCode, 0);
    assert.match(savedFullSmoke.stdout, /Saved report:/);
    assert.match(savedFullSmoke.stdout, /Path: \.ccagent\/reports\/provider-smoke-.+\.md/);
    assert.match(savedFullSmoke.stdout, /JSON: \.ccagent\/reports\/provider-smoke-.+\.json/);
    const reportFiles = await readdir(join(workspaceRoot, ".ccagent", "reports"));
    const jsonReports = await Promise.all(
      reportFiles
        .filter((fileName) => /^provider-smoke-.+\.json$/.test(fileName))
        .map(async (fileName) => ({
          fileName,
          report: JSON.parse(
            await readFile(join(workspaceRoot, ".ccagent", "reports", fileName), "utf8"),
          ) as {
            jsonFileName: string;
            jsonPath: string;
            path: string;
            summary: {
              compatibility: {
                status: string;
              };
              diagnosis: {
                status: string;
              };
              failed: number;
              passed: number;
              profile: string;
              probes: Array<{ name: string }>;
            };
          },
        })),
    );
    const fullReport = jsonReports.find((item) => item.report.summary.profile === "full");
    const quickReport = jsonReports.find((item) => item.report.summary.profile === "quick");

    assert.ok(fullReport);
    assert.ok(quickReport);
    const savedReport = fullReport.report;
    const markdownContent = await readFile(join(workspaceRoot, savedReport.path), "utf8");
    const providerGateRegressed = await runCli(workspaceRoot, [
      "--no-session",
      "/provider-gate",
      fullReport.report.jsonFileName,
      quickReport.report.jsonFileName,
    ]);

    assert.match(markdownContent, /# CCAgent Provider Smoke Report/);
    assert.match(markdownContent, /API key: not set/);
    assert.match(markdownContent, /## Diagnosis/);
    assert.match(markdownContent, /Status: needs-real-run/);
    assert.match(markdownContent, /## Compatibility Profile/);
    assert.match(markdownContent, /Status: mock-only/);
    assert.match(markdownContent, /\| streaming-tool-call \| PASS \| on \| on \|/);
    assert.match(savedReport.path, /^\.ccagent\/reports\/provider-smoke-.+\.md$/);
    assert.match(savedReport.jsonPath, /^\.ccagent\/reports\/provider-smoke-.+\.json$/);
    assert.equal(savedReport.summary.profile, "full");
    assert.equal(savedReport.summary.compatibility.status, "mock-only");
    assert.equal(savedReport.summary.diagnosis.status, "needs-real-run");
    assert.equal(savedReport.summary.passed, 6);
    assert.equal(savedReport.summary.failed, 0);
    assert.equal(savedReport.summary.probes.some((probe) => probe.name === "unicode"), true);
    assert.equal(providerReports.exitCode, 0);
    assert.match(providerReports.stdout, /Provider smoke reports/);
    assert.match(providerReports.stdout, /Count: 2/);
    assert.match(providerReports.stdout, /full .+ client=mock model=gpt-5\.5 mode=responses passed=6 failed=0/);
    assert.equal(providerReportsJson.exitCode, 0);
    const parsedProviderReports = JSON.parse(providerReportsJson.stdout) as {
      reports: Array<{
        path: string;
        summary: {
          failed: number;
          passed: number;
          profile: string;
        };
      }>;
    };

    assert.equal(parsedProviderReports.reports.length, 2);
    assert.match(parsedProviderReports.reports[0]?.path ?? "", /^\.ccagent\/reports\/provider-smoke-.+\.md$/);
    assert.equal(parsedProviderReports.reports[0]?.summary.profile, "full");
    assert.equal(parsedProviderReports.reports[0]?.summary.passed, 6);
    assert.equal(parsedProviderReports.reports[0]?.summary.failed, 0);
    assert.equal(emptyProfiles.exitCode, 0);
    assert.match(emptyProfiles.stdout, /Provider profiles/);
    assert.match(emptyProfiles.stdout, /Count: 0/);
    assert.equal(mockProfileAdd.exitCode, 0);
    assert.match(mockProfileAdd.stdout, /Provider profile not added/);
    assert.match(mockProfileAdd.stdout, /Status: mock-only/);
    assert.equal(knownProfileAdd.exitCode, 0);
    assert.match(knownProfileAdd.stdout, /Provider profile saved/);
    assert.match(knownProfileAdd.stdout, /ID: relay-example-chat-relay-model/);
    assert.equal(providerProfiles.exitCode, 0);
    assert.match(providerProfiles.stdout, /Provider profiles/);
    assert.match(providerProfiles.stdout, /Count: 1/);
    assert.match(providerProfiles.stdout, /relay-example-chat-relay-model model=relay-model mode=chat status=known-good/);
    assert.equal(providerProfilesJson.exitCode, 0);
    const parsedProviderProfiles = JSON.parse(providerProfilesJson.stdout) as {
      profiles: Array<{
        baseURL: string;
        compatibility: { status: string };
        id: string;
        model: string;
      }>;
    };
    assert.equal(parsedProviderProfiles.profiles.length, 1);
    assert.equal(parsedProviderProfiles.profiles[0]?.id, "relay-example-chat-relay-model");
    assert.equal(parsedProviderProfiles.profiles[0]?.model, "relay-model");
    assert.equal(parsedProviderProfiles.profiles[0]?.baseURL, "https://relay.example/v1");
    assert.equal(parsedProviderProfiles.profiles[0]?.compatibility.status, "known-good");
    assert.equal(useProviderProfile.exitCode, 0);
    assert.match(useProviderProfile.stdout, /Provider profile applied/);
    assert.match(useProviderProfile.stdout, /set model = relay-model/);
    assert.match(useProviderProfile.stdout, /set openai\.apiMode = chat/);
    assert.match(useProviderProfile.stdout, /set openai\.baseURL = https:\/\/relay\.example\/v1/);
    assert.equal(configAfterProfile.model, "relay-model");
    assert.equal(configAfterProfile.openai?.apiMode, "chat");
    assert.equal(configAfterProfile.openai?.baseURL, "https://relay.example/v1");
    assert.equal(providerCompare.exitCode, 0);
    assert.match(providerCompare.stdout, /Provider smoke comparison/);
    assert.match(providerCompare.stdout, /Status: IMPROVED/);
    assert.match(providerCompare.stdout, /Profile: quick -> full/);
    assert.match(providerCompare.stdout, /Passed: 3 -> 6/);
    assert.match(providerCompare.stdout, /- unicode: missing -> PASS/);
    assert.equal(providerCompareJson.exitCode, 0);
    const parsedProviderCompare = JSON.parse(providerCompareJson.stdout) as {
      status: string;
      left: { summary: { profile: string } };
      right: { summary: { profile: string } };
      probes: Array<{ name: string; right: { ok: boolean } | null }>;
    };

    assert.equal(parsedProviderCompare.status, "improved");
    assert.equal(parsedProviderCompare.left.summary.profile, "quick");
    assert.equal(parsedProviderCompare.right.summary.profile, "full");
    assert.equal(parsedProviderCompare.probes.find((probe) => probe.name === "unicode")?.right?.ok, true);
    assert.equal(providerGate.exitCode, 0);
    assert.match(providerGate.stdout, /Status: IMPROVED/);
    assert.equal(providerRepair.exitCode, 0);
    assert.match(providerRepair.stdout, /Provider repair benchmark/);
    assert.match(providerRepair.stdout, /Status: SKIP/);
    assert.match(providerRepair.stdout, /API key is not set/);
    assert.equal(providerRepairJson.exitCode, 0);
    const parsedProviderRepair = JSON.parse(providerRepairJson.stdout) as {
      hasApiKey: boolean;
      status: string;
      summary: string;
    };
    assert.equal(parsedProviderRepair.status, "skip");
    assert.equal(parsedProviderRepair.hasApiKey, false);
    assert.match(parsedProviderRepair.summary, /API key is not set/);
    assert.equal(providerRepairSaved.exitCode, 0);
    assert.match(providerRepairSaved.stdout, /Saved report:/);
    assert.match(providerRepairSaved.stdout, /Path: \.ccagent\/reports\/provider-repair-.+\.md/);
    assert.equal(providerRepairSavedAgain.exitCode, 0);
    assert.match(providerRepairSavedAgain.stdout, /Path: \.ccagent\/reports\/provider-repair-.+\.md/);
    assert.equal(providerRepairReports.exitCode, 0);
    assert.match(providerRepairReports.stdout, /Provider repair reports/);
    assert.match(providerRepairReports.stdout, /Count: 2/);
    assert.match(providerRepairReports.stdout, /status=skip model=gpt-5\.5 mode=responses attempts=1/);
    assert.equal(providerRepairReportsJson.exitCode, 0);
    const parsedProviderRepairReports = JSON.parse(providerRepairReportsJson.stdout) as {
      reports: Array<{ result: { status: string } }>;
    };
    assert.equal(parsedProviderRepairReports.reports.length, 2);
    assert.equal(parsedProviderRepairReports.reports.every((report) => report.result.status === "skip"), true);
    assert.equal(providerRepairCompare.exitCode, 0);
    assert.match(providerRepairCompare.stdout, /Provider repair comparison/);
    assert.match(providerRepairCompare.stdout, /Status: (UNCHANGED|CHANGED)/);
    assert.match(providerRepairCompare.stdout, /Status: skip -> skip/);
    assert.equal(providerRepairCompareJson.exitCode, 0);
    const parsedProviderRepairCompare = JSON.parse(providerRepairCompareJson.stdout) as {
      left: { result: { status: string } };
      right: { result: { status: string } };
      status: string;
    };
    assert.equal(parsedProviderRepairCompare.left.result.status, "skip");
    assert.equal(parsedProviderRepairCompare.right.result.status, "skip");
    assert.match(parsedProviderRepairCompare.status, /^(unchanged|changed)$/);
    assert.equal(providerRepairGate.exitCode, 0);
    assert.match(providerRepairGate.stdout, /Provider repair comparison/);
    assert.equal(providerGateRegressed.exitCode, 1);
    assert.match(providerGateRegressed.stdout, /Status: REGRESSED/);
    assert.match(providerGateRegressed.stdout, /Profile: full -> quick/);
    assert.equal(fullSmokeJson.exitCode, 0);
    const fullParsed = JSON.parse(fullSmokeJson.stdout) as {
      profile: string;
      passed: number;
      failed: number;
      probes: Array<{ name: string; ok: boolean }>;
    };
    assert.equal(fullParsed.profile, "full");
    assert.equal(fullParsed.passed, 6);
    assert.equal(fullParsed.failed, 0);
    assert.deepEqual(fullParsed.probes.map((probe) => probe.name), [
      "text",
      "unicode",
      "streaming",
      "tool-call",
      "streaming-tool-call",
      "tool-followup",
    ]);
    assert.equal(fullParsed.probes.every((probe) => probe.ok), true);
    await assert.rejects(
      readFile(join(workspaceRoot, ".ccagent", "sessions", "current.json"), "utf8"),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI saves and restores named session checkpoints", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-checkpoint-"));

  try {
    const first = await runCli(workspaceRoot, ["remember", "alpha"]);
    const sessionShown = await runCli(workspaceRoot, ["/session", "show"]);
    const sessionStats = await runCli(workspaceRoot, ["/session", "stats"]);
    const sessionSearch = await runCli(workspaceRoot, ["/session", "search", "alpha"]);
    const saved = await runCli(workspaceRoot, ["/checkpoint", "save", "before-clear"]);
    const listed = await runCli(workspaceRoot, ["/checkpoint"]);
    const shown = await runCli(workspaceRoot, ["/checkpoint", "show", "before-clear"]);
    const checkpointStats = await runCli(workspaceRoot, ["/checkpoint", "stats", "before-clear"]);
    const checkpointSearch = await runCli(workspaceRoot, ["/checkpoint", "search", "before-clear", "alpha"]);
    const second = await runCli(workspaceRoot, ["remember", "beta"]);
    const sessionShownLimited = await runCli(workspaceRoot, ["/session", "show", "--limit", "1"]);
    const diffCurrent = await runCli(workspaceRoot, ["/checkpoint", "diff-current", "before-clear"]);
    const savedAfter = await runCli(workspaceRoot, ["/checkpoint", "save", "after-beta"]);
    const shownAfterLimited = await runCli(workspaceRoot, ["/checkpoint", "show", "after-beta", "--limit", "1"]);
    const diff = await runCli(workspaceRoot, ["/checkpoint", "diff", "before-clear", "after-beta"]);
    const cleared = await runCli(workspaceRoot, ["/clear"]);
    const emptyHistory = await runCli(workspaceRoot, ["/history"]);
    const loaded = await runCli(workspaceRoot, ["/checkpoint", "load", "before-clear"]);
    const listedAfterLoad = await runCli(workspaceRoot, ["/checkpoint"]);
    const listedBackups = await runCli(workspaceRoot, ["/checkpoint", "backups"]);
    const restoredHistory = await runCli(workspaceRoot, ["/history"]);

    assert.equal(first.exitCode, 0);
    assert.match(first.stdout, /\[mock model\] You said: remember alpha/);
    assert.match(sessionShown.stdout, /Current session/);
    assert.match(sessionShown.stdout, /Recent messages: 2 of 2/);
    assert.match(sessionShown.stdout, /remember alpha/);
    assert.match(sessionStats.stdout, /Current session stats/);
    assert.match(sessionStats.stdout, /total: 2/);
    assert.match(sessionStats.stdout, /user: 1/);
    assert.match(sessionStats.stdout, /assistant: 1/);
    assert.match(sessionSearch.stdout, /Current session search/);
    assert.match(sessionSearch.stdout, /Query: alpha/);
    assert.match(sessionSearch.stdout, /Matches: 2/);
    assert.match(sessionSearch.stdout, /remember alpha/);
    assert.match(saved.stdout, /Saved session checkpoint: before-clear/);
    assert.match(listed.stdout, /before-clear: messages=2/);
    assert.match(shown.stdout, /Session checkpoint: before-clear/);
    assert.match(shown.stdout, /Recent messages: 2 of 2/);
    assert.match(shown.stdout, /remember alpha/);
    assert.match(checkpointStats.stdout, /Session checkpoint stats: before-clear/);
    assert.match(checkpointStats.stdout, /total: 2/);
    assert.match(checkpointStats.stdout, /estimated tokens/);
    assert.match(checkpointSearch.stdout, /Session checkpoint search: before-clear/);
    assert.match(checkpointSearch.stdout, /Query: alpha/);
    assert.match(checkpointSearch.stdout, /Matches: 2/);
    assert.match(checkpointSearch.stdout, /remember alpha/);
    assert.match(second.stdout, /\[mock model\] You said: remember beta/);
    assert.match(sessionShownLimited.stdout, /Recent messages: 1 of 4/);
    assert.match(sessionShownLimited.stdout, /remember beta/);
    assert.doesNotMatch(sessionShownLimited.stdout, /remember alpha/);
    assert.match(diffCurrent.stdout, /Session checkpoint diff: before-clear -> current/);
    assert.match(diffCurrent.stdout, /messages: 2 -> 4 \(\+2\)/);
    assert.match(diffCurrent.stdout, /remember beta/);
    assert.match(savedAfter.stdout, /Saved session checkpoint: after-beta/);
    assert.match(shownAfterLimited.stdout, /Session checkpoint: after-beta/);
    assert.match(shownAfterLimited.stdout, /Recent messages: 1 of 4/);
    assert.match(shownAfterLimited.stdout, /remember beta/);
    assert.doesNotMatch(shownAfterLimited.stdout, /remember alpha/);
    assert.match(diff.stdout, /Session checkpoint diff: before-clear -> after-beta/);
    assert.match(diff.stdout, /messages: 2 -> 4 \(\+2\)/);
    assert.match(diff.stdout, /common message prefix: 2/);
    assert.match(diff.stdout, /remember beta/);
    assert.match(cleared.stdout, /Conversation history and plan cleared/);
    assert.match(emptyHistory.stdout, /Conversation history is empty/);
    assert.match(loaded.stdout, /Loaded session checkpoint: before-clear/);
    assert.match(loaded.stdout, /Backup checkpoint saved before load: before-load-\d{8}T\d{9}Z/);
    assert.match(listedAfterLoad.stdout, /before-load-\d{8}T\d{9}Z: messages=0/);
    assert.match(listedBackups.stdout, /Session checkpoint backups:/);
    assert.match(listedBackups.stdout, /before-load-\d{8}T\d{9}Z: messages=0/);
    assert.doesNotMatch(listedBackups.stdout, /before-clear: messages=2/);
    assert.match(restoredHistory.stdout, /remember alpha/);
    assert.match(restoredHistory.stdout, /\[mock model\] You said: remember alpha/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadCheckpointCompletionNames lists valid checkpoint filenames only", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-checkpoint-completion-"));

  try {
    const checkpointDir = join(workspaceRoot, ".ccagent", "sessions", "checkpoints");
    await mkdir(checkpointDir, { recursive: true });
    await writeFile(join(checkpointDir, "before-edit.json"), "{}", "utf8");
    await writeFile(join(checkpointDir, "after-beta.json"), "{}", "utf8");
    await writeFile(join(checkpointDir, "bad name.json"), "{}", "utf8");
    await writeFile(join(checkpointDir, "notes.txt"), "{}", "utf8");
    await mkdir(join(checkpointDir, "nested.json"));

    assert.deepEqual(await loadCheckpointCompletionNames(workspaceRoot), [
      "after-beta",
      "before-edit",
    ]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("interactive CLI persists terminal input history", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-input-history-"));

  try {
    const result = await runInteractiveCli(workspaceRoot, [
      "/input-history clear",
      "hello terminal history",
      "exit",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Terminal input history cleared/);
    assert.match(result.stdout, /\[mock model\] You said: hello terminal history/);
    assert.match(result.stdout, /Bye\./);

    const rawHistory = await readFile(join(workspaceRoot, ".ccagent", "history"), "utf8");

    assert.equal(rawHistory, "hello terminal history\n");

    const shown = await runCli(workspaceRoot, ["/input-history"]);

    assert.equal(shown.exitCode, 0);
    assert.match(shown.stdout, /Terminal input history:/);
    assert.match(shown.stdout, /1\. hello terminal history/);

    const disabled = await runCli(workspaceRoot, ["--no-session", "/input-history"]);

    assert.equal(disabled.exitCode, 0);
    assert.match(disabled.stdout, /Terminal input history is disabled/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("continuation helpers treat only odd trailing backslashes as continuing", () => {
  assert.equal(hasContinuingBackslash(""), false);
  assert.equal(hasContinuingBackslash("plain line"), false);
  assert.equal(hasContinuingBackslash("plain line    "), false);
  assert.equal(hasContinuingBackslash("single \\"), true);
  assert.equal(hasContinuingBackslash("single \\   "), true);
  assert.equal(hasContinuingBackslash("double \\\\"), false);
  assert.equal(hasContinuingBackslash("triple \\\\\\"), true);
  assert.equal(foldContinuationLine("first part \\", "second part"), "first part \nsecond part");
  assert.equal(foldContinuationLine("first part \\  ", "second part"), "first part \nsecond part");
});

test("interactive CLI joins backslash-continuation lines into one message", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-multiline-"));

  try {
    const result = await runInteractiveCli(workspaceRoot, [
      "first part \\",
      "second part",
      "last \\\\",
      "exit",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /You said: first part \nsecond part/);
    assert.match(result.stdout, /You said: last \\\\/);
    assert.match(result.stdout, /Bye\./);

    const rawHistory = await readFile(join(workspaceRoot, ".ccagent", "history"), "utf8");

    assert.match(rawHistory, /first part second part/);
    assert.match(rawHistory, /last \\\\/);

    const help = await runCli(workspaceRoot, ["--no-session", "/help", "completion"]);

    assert.match(help.stdout, /Continue typing on the next line/);
    assert.match(help.stdout, /Cancel a pending multi-line input/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test(
  "interactive CLI cancels a pending multi-line input on SIGINT",
  { skip: process.platform === "win32" },
  async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-multiline-cancel-"));

    try {
      const result = await runInteractiveCliWithSigintCancel(
        workspaceRoot,
        ["first part \\"],
        (child, stdin) => {
          child.kill("SIGINT");

          setTimeout(() => {
            stdin.end(["second part", "exit"].join("\n") + "\n");
          }, 150);
        },
      );

      assert.equal(result.exitCode, 0);
      assert.doesNotMatch(result.stdout, /You said: first part/);
      assert.match(result.stdout, /You said: second part/);
      assert.match(result.stdout, /Bye\./);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test("CLI stores, reports, and removes a persisted API key with login and logout", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-login-"));
  const authPath = join(workspaceRoot, "user-home", "auth.json");

  try {
    const stored = await runCli(workspaceRoot, ["login", "--api-key", "sk-cli-test-key"]);

    assert.equal(stored.exitCode, 0);
    assert.match(stored.stdout, /Logged in\./);
    assert.match(stored.stdout, /Stored auth file:/);
    assert.doesNotMatch(stored.stdout, /sk-cli-test-key/);
    const storedPayload = JSON.parse(await readFile(authPath, "utf8")) as {
      apiKey?: string;
      updatedAt?: string;
    };

    assert.equal(storedPayload.apiKey, "sk-cli-test-key");
    assert.equal(typeof storedPayload.updatedAt, "string");

    const status = await runCli(workspaceRoot, ["login"]);

    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /Already logged in\./);

    const loggedOut = await runCli(workspaceRoot, ["logout"]);

    assert.equal(loggedOut.exitCode, 0);
    assert.match(loggedOut.stdout, /Logged out\./);
    await assert.rejects(readFile(authPath, "utf8"));

    const loggedOutAgain = await runCli(workspaceRoot, ["logout"]);

    assert.equal(loggedOutAgain.exitCode, 0);
    assert.match(loggedOutAgain.stdout, /Not logged in\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI manages user-level config defaults and reports user-config sources", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-userconfig-"));

  try {
    const setBaseURL = await runCli(workspaceRoot, [
      "--user-config-set",
      "openai.baseURL",
      "https://user-relay.example/v1",
    ]);
    const setModel = await runCli(workspaceRoot, ["--user-config-set", "model", "user-model"]);
    const getBaseURL = await runCli(workspaceRoot, ["--user-config-get", "openai.baseURL"]);
    const unsupported = await runCli(workspaceRoot, ["--user-config-set", "context.auto", "false"]);
    const model = await runCli(workspaceRoot, ["--no-session", "/model"]);
    const unsetModel = await runCli(workspaceRoot, ["--user-config-unset", "model"]);

    assert.equal(setBaseURL.exitCode, 0);
    assert.match(setBaseURL.stdout, /Updated openai\.baseURL = https:\/\/user-relay\.example\/v1/);
    assert.match(setBaseURL.stdout, /User config path:/);
    assert.equal(setModel.exitCode, 0);
    assert.match(setModel.stdout, /Updated model = user-model/);
    assert.equal(getBaseURL.exitCode, 0);
    assert.match(getBaseURL.stdout, /openai\.baseURL = https:\/\/user-relay\.example\/v1/);
    assert.equal(unsupported.exitCode, 0);
    assert.match(unsupported.stdout, /Unsupported user config key/);
    assert.equal(model.exitCode, 0);
    assert.match(model.stdout, /Configured model: user-model \(source: user-config\)/);
    assert.match(model.stdout, /OpenAI base URL: https:\/\/user-relay\.example\/v1 \(source: user-config\)/);
    assert.match(model.stdout, /User config loaded: yes/);
    assert.equal(unsetModel.exitCode, 0);
    assert.match(unsetModel.stdout, /Removed model/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI reports the stored auth-file key as the api key source", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-cli-authsource-"));
  const userHome = join(workspaceRoot, "user-home");

  try {
    await mkdir(userHome, { recursive: true });
    await writeFile(
      join(userHome, "auth.json"),
      `${JSON.stringify({ apiKey: "sk-auth-file-test" })}\n`,
      "utf8",
    );

    const model = await runCli(workspaceRoot, ["--no-session", "/model"]);
    const doctor = await runCli(workspaceRoot, ["--doctor"]);

    assert.equal(model.exitCode, 0);
    assert.match(model.stdout, /API key: set \(source: auth-file; real OpenAI model client is active\)/);
    assert.doesNotMatch(model.stdout, /sk-auth-file-test/);
    assert.equal(doctor.exitCode, 0);
    assert.match(doctor.stdout, /\[OK\] openai_api_key: API key stored in /);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function runCli(workspaceRoot: string, args: string[]): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, sourceCliPath, ...args], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CCAGENT_USER_DIR: join(workspaceRoot, "user-home"),
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
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end();
  });
}

async function runInteractiveCli(
  workspaceRoot: string,
  lines: string[],
  timeoutMs = 5000,
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, sourceCliPath], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CCAGENT_USER_DIR: join(workspaceRoot, "user-home"),
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        CCAGENT_API_MODE: "",
        CCAGENT_MODEL: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("interactive CLI timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}

async function runInteractiveCliWithSigintCancel(
  workspaceRoot: string,
  firstLines: string[],
  onContinuation: (child: ChildProcess, stdin: NodeJS.WritableStream) => void,
  timeoutMs = 8000,
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, sourceCliPath], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CCAGENT_USER_DIR: join(workspaceRoot, "user-home"),
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        CCAGENT_API_MODE: "",
        CCAGENT_MODEL: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let signalSent = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("interactive CLI with SIGINT timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);

      if (!signalSent && chunk.toString("utf8").includes("... > ")) {
        signalSent = true;
        onContinuation(child, child.stdin);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.write(`${firstLines.join("\n")}\n`);
  });
}

async function writeProjectCommand(
  workspaceRoot: string,
  name: string,
  content: string,
): Promise<void> {
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  await mkdir(commandsDir, { recursive: true });
  await writeFile(join(commandsDir, `${name}.md`), content, "utf8");
}

async function writeProjectSkill(
  workspaceRoot: string,
  name: string,
  content: string,
): Promise<void> {
  const skillDir = join(workspaceRoot, ".ccagent", "skills", name);

  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
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

async function writeProviderRepairReportJson(
  workspaceRoot: string,
  report: {
    durationMs: number;
    exportedAt: string;
    status: "fail" | "pass" | "skip";
    summary: string;
  },
): Promise<void> {
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileStamp = report.exportedAt.replace(/[:.]/g, "-");
  const jsonFileName = `provider-repair-${fileStamp}.json`;
  const fileName = `provider-repair-${fileStamp}.md`;
  const payload = {
    exportedAt: report.exportedAt,
    fileName,
    jsonFileName,
    jsonPath: `.ccagent/reports/${jsonFileName}`,
    path: `.ccagent/reports/${fileName}`,
    result: {
      apiMode: "chat",
      apiModeSource: "config",
      attempts: 1,
      baseURL: "https://relay.example/v1",
      baseURLSource: "config",
      client: "relay-model",
      clientKind: "openai-chat (/v1/chat/completions)",
      durationMs: report.durationMs,
      fixture: "order-service-project",
      hasApiKey: true,
      model: "relay-model",
      modelSource: "config",
      status: report.status,
      summary: report.summary,
    },
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, jsonFileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeKnownGoodProviderSmokeReport(
  workspaceRoot: string,
  jsonFileName: string,
): Promise<void> {
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const exportedAt = "2030-01-01T00:00:00.000Z";
  const fileName = jsonFileName.replace(/\.json$/, ".md");
  const capabilities = [
    ["text", "text ok"],
    ["unicode", "unicode ok"],
    ["streaming", "streaming ok"],
    ["tool-call", "tool ok"],
    ["streaming-tool-call", "streaming tool ok"],
  ].map(([name, summary]) => ({
    name,
    status: "pass",
    summary,
  }));
  const payload = {
    exportedAt,
    fileName,
    jsonFileName,
    jsonPath: `.ccagent/reports/${jsonFileName}`,
    path: `.ccagent/reports/${fileName}`,
    summary: {
      apiMode: "chat",
      apiModeSource: "config",
      baseURL: "https://relay.example/v1",
      baseURLSource: "config",
      client: "openai-chat",
      clientKind: "openai-chat (/v1/chat/completions)",
      compatibility: {
        capabilities,
        reuseCommands: [
          "ccagent --config-set openai.baseURL https://relay.example/v1",
          "ccagent --config-set openai.apiMode chat",
          "ccagent --config-set model relay-model",
        ],
        status: "known-good",
        summary: "Real provider passed the full compatibility profile.",
      },
      diagnosis: {
        actions: ["Save two full reports around provider changes, then run ccagent --no-session /provider-gate."],
        notes: ["All selected provider probes passed for this runtime."],
        status: "ready",
        warnings: [],
      },
      failed: 0,
      hasApiKey: true,
      model: "relay-model",
      modelSource: "config",
      passed: 5,
      profile: "full",
      probes: capabilities.map((capability) => ({
        durationMs: 1,
        name: capability.name,
        ok: true,
        stream: capability.name.includes("streaming"),
        streamFallback: false,
        summary: capability.summary,
        textDeltaChunks: capability.name.includes("streaming") ? 1 : 0,
        tool: capability.name.includes("tool"),
        toolCalls: capability.name.includes("tool") ? ["smoke_ping"] : [],
      })),
    },
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, jsonFileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readProjectCommandAuditEvents(
  workspaceRoot: string,
): Promise<Array<Extract<ToolAuditEvent, { type: "project_command" }>>> {
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const entries = await readdir(logsDir);
  const events: Array<Extract<ToolAuditEvent, { type: "project_command" }>> = [];

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }

    const content = await readFile(join(logsDir, entry), "utf8");

    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line) as ToolAuditEvent;

      if (event.type === "project_command") {
        events.push(event);
      }
    }
  }

  return events;
}

function getExportPath(output: string): string {
  const match = output.match(/^Path:\s+(.+)$/m);

  if (!match?.[1]) {
    throw new Error(`Could not find export path in output:\n${output}`);
  }

  return match[1];
}
