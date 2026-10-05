import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addMcpServer,
  formatConfigGetResult,
  formatConfigSetResult,
  formatConfigUnsetResult,
  formatLoadedConfig,
  formatMcpConfigResult,
  formatPermissions,
  getConfigValue,
  initConfig,
  isAutoApprovedShellCommand,
  isToolApprovalRequiredByPolicy,
  isToolDenied,
  isToolRiskApprovalRequiredByPolicy,
  isToolRiskDenied,
  loadConfig,
  removeMcpServer,
  setConfigValue,
  setMcpEnabled,
  unsetConfigValue,
} from "../src/config.js";

test("loadConfig returns defaults when config file is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    const loaded = await loadConfig(workspaceRoot);

    assert.equal(loaded.exists, false);
    assert.deepEqual(loaded.config, {});
    assert.deepEqual(loaded.warnings, []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadConfig reads model and auto-approved shell commands", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        model: "gpt-test",
        context: {
          auto: false,
        },
        openai: {
          apiMode: "chat",
          baseURL: "https://relay.example/v1",
          embeddingModel: "text-embedding-3-small",
          retry: {
            maxAttempts: 4,
            baseDelayMs: 500,
            maxDelayMs: 5000,
          },
        },
        autoApprove: {
          shellCommands: ["node -v"],
        },
        mcp: {
          enabled: true,
          servers: {
            fixture: {
              command: "node",
              args: ["server.mjs"],
              cwd: "tools",
              env: { FIXTURE_MODE: "test" },
              timeoutMs: 5000,
            },
          },
        },
        toolPolicy: {
          deny: ["run_shell"],
          denyRisk: ["high"],
          requireApproval: ["read_file"],
          requireApprovalRisk: ["medium"],
        },
      }),
    );

    const loaded = await loadConfig(workspaceRoot);

    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.model, "gpt-test");
    assert.equal(loaded.config.context?.auto, false);
    assert.equal(loaded.config.openai?.apiMode, "chat");
    assert.equal(loaded.config.openai?.baseURL, "https://relay.example/v1");
    assert.equal(loaded.config.openai?.embeddingModel, "text-embedding-3-small");
    assert.deepEqual(loaded.config.openai?.retry, {
      maxAttempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 5000,
    });
    assert.deepEqual(loaded.config.autoApprove?.shellCommands, ["node -v"]);
    assert.equal(loaded.config.mcp?.enabled, true);
    assert.deepEqual(loaded.config.mcp?.servers?.fixture, {
      command: "node",
      args: ["server.mjs"],
      cwd: "tools",
      env: { FIXTURE_MODE: "test" },
      timeoutMs: 5000,
    });
    assert.deepEqual(loaded.config.toolPolicy?.deny, ["run_shell"]);
    assert.deepEqual(loaded.config.toolPolicy?.denyRisk, ["high"]);
    assert.deepEqual(loaded.config.toolPolicy?.requireApproval, ["read_file"]);
    assert.deepEqual(loaded.config.toolPolicy?.requireApprovalRisk, ["medium"]);
    assert.equal(isAutoApprovedShellCommand(loaded, " node -v "), true);
    assert.equal(isAutoApprovedShellCommand(loaded, "npm test"), false);
    assert.equal(isToolDenied(loaded, "run_shell"), true);
    assert.equal(isToolRiskDenied(loaded, "high"), true);
    assert.equal(isToolApprovalRequiredByPolicy(loaded, "read_file"), true);
    assert.equal(isToolRiskApprovalRequiredByPolicy(loaded, "medium"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadConfig tolerates UTF-8 BOM in config files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-bom-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      `${String.fromCharCode(0xfeff)}${JSON.stringify({
        model: "gpt-bom",
        toolPolicy: {
          denyRisk: ["low"],
        },
      })}`,
    );

    const loaded = await loadConfig(workspaceRoot);
    const result = await setConfigValue(workspaceRoot, "toolPolicy.requireApprovalRisk", "high");
    const updated = await loadConfig(workspaceRoot);

    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.model, "gpt-bom");
    assert.deepEqual(loaded.config.toolPolicy?.denyRisk, ["low"]);
    assert.equal(result.key, "toolPolicy.requireApprovalRisk");
    assert.deepEqual(updated.config.toolPolicy?.requireApprovalRisk, ["high"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ui.promptHints can be set, read, hidden, and unset", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-hints-"));

  try {
    const setResult = await setConfigValue(
      workspaceRoot,
      "ui.promptHints",
      "/help, /model, /mcp status",
    );
    const loaded = await loadConfig(workspaceRoot);
    const getResult = await getConfigValue(workspaceRoot, "ui.promptHints");

    assert.equal(setResult.key, "ui.promptHints");
    assert.deepEqual(loaded.config.ui?.promptHints, ["/help", "/model", "/mcp status"]);
    assert.equal(setResult.value, "/help, /model, /mcp status");
    assert.equal(getResult.value, "/help, /model, /mcp status");

    const hidden = await setConfigValue(workspaceRoot, "ui.promptHints", "off");
    assert.deepEqual(hidden.value, "(none)");
    assert.deepEqual((await loadConfig(workspaceRoot)).config.ui?.promptHints, []);
    assert.match(formatLoadedConfig(await loadConfig(workspaceRoot)), /Prompt hint bar: \(hidden\)/);

    await assert.rejects(
      () =>
        setConfigValue(
          workspaceRoot,
          "ui.promptHints",
          "/a, /b, /c, /d, /e, /f, /g, /h, /i, /j, /k, /l, /m",
        ),
      /at most 12/,
    );

    const unset = await unsetConfigValue(workspaceRoot, "ui.promptHints");
    assert.equal(unset.existed, true);
    assert.equal((await loadConfig(workspaceRoot)).config.ui, undefined);

    const missingUnset = await unsetConfigValue(workspaceRoot, "ui.promptHints");
    assert.equal(missingUnset.existed, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadConfig warns for invalid ui prompt hints", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-hints-warn-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        ui: {
          promptHints: ["/help", 7, "  "],
        },
      }),
    );

    const loaded = await loadConfig(workspaceRoot);

    assert.deepEqual(loaded.config.ui?.promptHints, ["/help"]);
    assert.ok(loaded.warnings.some((warning) => warning.includes("ui.promptHints")));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("MCP config helpers add, disable, and remove servers without overwriting duplicates", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-mcp-update-"));

  try {
    const added = await addMcpServer(workspaceRoot, "fixture", "node", ["server.mjs"]);
    const addedConfig = await loadConfig(workspaceRoot);

    assert.deepEqual(added, {
      action: "added",
      args: ["server.mjs"],
      command: "node",
      enabled: true,
      name: "fixture",
      path: join(workspaceRoot, ".ccagent", "config.json"),
    });
    assert.deepEqual(addedConfig.config.mcp, {
      enabled: true,
      servers: {
        fixture: {
          args: ["server.mjs"],
          command: "node",
        },
      },
    });
    assert.match(formatMcpConfigResult(added), /Added MCP server fixture: node/);
    await assert.rejects(
      () => addMcpServer(workspaceRoot, "fixture", "replacement"),
      /already configured/,
    );

    const disabled = await setMcpEnabled(workspaceRoot, false);
    const removed = await removeMcpServer(workspaceRoot, "fixture");
    const missing = await removeMcpServer(workspaceRoot, "fixture");
    const updated = await loadConfig(workspaceRoot);

    assert.deepEqual(disabled, {
      action: "disabled",
      enabled: false,
      path: join(workspaceRoot, ".ccagent", "config.json"),
    });
    assert.deepEqual(removed, {
      action: "removed",
      enabled: false,
      existed: true,
      name: "fixture",
      path: join(workspaceRoot, ".ccagent", "config.json"),
    });
    assert.equal(missing.existed, false);
    assert.equal(updated.config.mcp?.enabled, false);
    assert.deepEqual(updated.config.mcp?.servers, {});
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatPermissions summarizes runtime flags and project policy", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        autoApprove: {
          shellCommands: ["node -v"],
        },
        toolPolicy: {
          deny: ["run_shell"],
          denyRisk: ["high"],
          requireApproval: ["read_file"],
          requireApprovalRisk: ["medium"],
        },
      }),
    );

    const loaded = await loadConfig(workspaceRoot);
    const output = formatPermissions(loaded, {
      allowEdits: true,
      verifyCommand: "npm test",
    });

    assert.match(output, /Tool permissions/);
    assert.match(output, /--allow-edits: on/);
    assert.match(output, /--verify: npm test/);
    assert.match(output, /Auto-approved shell commands:\n- node -v/);
    assert.match(output, /Denied tools:\n- run_shell/);
    assert.match(output, /Denied risk levels:\n- high/);
    assert.match(output, /Tools requiring approval:\n- read_file/);
    assert.match(output, /Risk levels requiring approval:\n- medium/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("config supports write path policy fields", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-write-paths-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        toolPolicy: {
          allowWritePaths: ["src/"],
          denyWritePaths: [".ccagent/"],
        },
      }),
    );

    const loaded = await loadConfig(workspaceRoot);
    const permissions = formatPermissions(loaded);

    assert.deepEqual(loaded.config.toolPolicy?.allowWritePaths, ["src/"]);
    assert.deepEqual(loaded.config.toolPolicy?.denyWritePaths, [".ccagent/"]);
    assert.match(permissions, /Allowed write paths:\n- src\//);
    assert.match(permissions, /Denied write paths:\n- \.ccagent\//);

    const allowResult = await setConfigValue(
      workspaceRoot,
      "toolPolicy.allowWritePaths",
      "src/, tests/",
    );
    const denyResult = await setConfigValue(
      workspaceRoot,
      "toolPolicy.denyWritePaths",
      ".ccagent/, package-lock.json",
    );
    const allowGet = await getConfigValue(workspaceRoot, "toolPolicy.allowWritePaths");
    const denyGet = await getConfigValue(workspaceRoot, "toolPolicy.denyWritePaths");

    assert.equal(allowResult.key, "toolPolicy.allowWritePaths");
    assert.equal(allowResult.value, "src/, tests/");
    assert.equal(denyResult.key, "toolPolicy.denyWritePaths");
    assert.equal(denyResult.value, ".ccagent/, package-lock.json");
    assert.equal(allowGet.value, "src/, tests/");
    assert.equal(denyGet.value, ".ccagent/, package-lock.json");

    const removedAllow = await unsetConfigValue(workspaceRoot, "toolPolicy.allowWritePaths");
    const removedDeny = await unsetConfigValue(workspaceRoot, "toolPolicy.denyWritePaths");
    const updated = await loadConfig(workspaceRoot);

    assert.equal(removedAllow.existed, true);
    assert.equal(removedDeny.existed, true);
    assert.equal(updated.config.toolPolicy, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadConfig reports warnings for invalid shapes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        model: 123,
        context: {
          auto: "sometimes",
        },
        openai: {
          apiMode: "bad",
          baseURL: "not a url",
          retry: {
            maxAttempts: 0,
            baseDelayMs: "fast",
            maxDelayMs: 100_000,
          },
        },
        autoApprove: {
          shellCommands: ["node -v", 42],
        },
        toolPolicy: {
          deny: ["read_file", ""],
          denyRisk: ["high", "bad"],
          requireApproval: "list_files",
          requireApprovalRisk: "medium",
        },
      }),
    );

    const loaded = await loadConfig(workspaceRoot);

    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.model, undefined);
    assert.equal(loaded.config.context?.auto, undefined);
    assert.equal(loaded.config.openai?.apiMode, undefined);
    assert.equal(loaded.config.openai?.baseURL, undefined);
    assert.deepEqual(loaded.config.openai?.retry, {});
    assert.deepEqual(loaded.config.autoApprove?.shellCommands, ["node -v"]);
    assert.deepEqual(loaded.config.toolPolicy?.deny, ["read_file"]);
    assert.deepEqual(loaded.config.toolPolicy?.denyRisk, ["high"]);
    assert.deepEqual(loaded.config.toolPolicy?.requireApproval, []);
    assert.deepEqual(loaded.config.toolPolicy?.requireApprovalRisk, []);
    assert.ok(loaded.warnings.some((warning) => warning.includes("config.model")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("context.auto")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("openai.apiMode")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("openai.baseURL")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("openai.retry.maxAttempts")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("openai.retry.baseDelayMs")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("openai.retry.maxDelayMs")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("shellCommands item")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("toolPolicy.deny item")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("toolPolicy.denyRisk item")));
    assert.ok(loaded.warnings.some((warning) => warning.includes("toolPolicy.requireApproval")));
    assert.ok(
      loaded.warnings.some((warning) => warning.includes("toolPolicy.requireApprovalRisk")),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("initConfig creates default config when missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    const result = await initConfig(workspaceRoot);
    const loaded = await loadConfig(workspaceRoot);

    assert.equal(result.created, true);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.model, "gpt-5.5");
    assert.equal(loaded.config.context?.auto, true);
    assert.equal(loaded.config.openai?.apiMode, "responses");
    assert.deepEqual(loaded.config.openai?.retry, {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 2000,
    });
    assert.deepEqual(loaded.config.autoApprove?.shellCommands, []);
    assert.deepEqual(loaded.config.toolPolicy?.deny, []);
    assert.deepEqual(loaded.config.toolPolicy?.denyRisk, []);
    assert.deepEqual(loaded.config.toolPolicy?.requireApproval, []);
    assert.deepEqual(loaded.config.toolPolicy?.requireApprovalRisk, []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("initConfig does not overwrite an existing config", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        model: "custom-model",
        autoApprove: {
          shellCommands: ["npm test"],
        },
      }),
    );

    const result = await initConfig(workspaceRoot);
    const loaded = await loadConfig(workspaceRoot);

    assert.equal(result.created, false);
    assert.equal(loaded.config.model, "custom-model");
    assert.deepEqual(loaded.config.autoApprove?.shellCommands, ["npm test"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("setConfigValue persists model and OpenAI relay settings", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        model: "old-model",
        autoApprove: {
          shellCommands: ["npm test"],
        },
      }),
    );

    const modeResult = await setConfigValue(workspaceRoot, "openai.apiMode", "CHAT");
    const baseURLResult = await setConfigValue(
      workspaceRoot,
      "openai.baseURL",
      " https://relay.example/v1 ",
    );
    const embeddingModelResult = await setConfigValue(
      workspaceRoot,
      "openai.embeddingModel",
      " text-embedding-3-small ",
    );
    const retryAttemptsResult = await setConfigValue(workspaceRoot, "openai.retry.maxAttempts", "4");
    const retryBaseDelayResult = await setConfigValue(workspaceRoot, "openai.retry.baseDelayMs", "500");
    const retryMaxDelayResult = await setConfigValue(workspaceRoot, "openai.retry.maxDelayMs", "5000");
    await setConfigValue(workspaceRoot, "model", "gpt-test");
    const denyResult = await setConfigValue(workspaceRoot, "toolPolicy.deny", "run_shell, read_file");
    const denyRiskResult = await setConfigValue(workspaceRoot, "toolPolicy.denyRisk", "high");
    const requireResult = await setConfigValue(
      workspaceRoot,
      "toolPolicy.requireApproval",
      "list_files",
    );
    const requireRiskResult = await setConfigValue(
      workspaceRoot,
      "toolPolicy.requireApprovalRisk",
      "medium, high",
    );
    const loaded = await loadConfig(workspaceRoot);
    const raw = await readFile(join(workspaceRoot, ".ccagent", "config.json"), "utf8");

    assert.equal(modeResult.key, "openai.apiMode");
    assert.equal(modeResult.value, "chat");
    assert.equal(baseURLResult.key, "openai.baseURL");
    assert.equal(baseURLResult.value, "https://relay.example/v1");
    assert.equal(embeddingModelResult.key, "openai.embeddingModel");
    assert.equal(embeddingModelResult.value, "text-embedding-3-small");
    assert.equal(retryAttemptsResult.key, "openai.retry.maxAttempts");
    assert.equal(retryAttemptsResult.value, "4");
    assert.equal(retryBaseDelayResult.key, "openai.retry.baseDelayMs");
    assert.equal(retryBaseDelayResult.value, "500");
    assert.equal(retryMaxDelayResult.key, "openai.retry.maxDelayMs");
    assert.equal(retryMaxDelayResult.value, "5000");
    assert.equal(denyResult.key, "toolPolicy.deny");
    assert.equal(denyRiskResult.key, "toolPolicy.denyRisk");
    assert.equal(denyRiskResult.value, "high");
    assert.equal(requireResult.key, "toolPolicy.requireApproval");
    assert.equal(requireRiskResult.key, "toolPolicy.requireApprovalRisk");
    assert.equal(requireRiskResult.value, "medium, high");
    assert.equal(loaded.config.model, "gpt-test");
    assert.equal(loaded.config.openai?.apiMode, "chat");
    assert.equal(loaded.config.openai?.baseURL, "https://relay.example/v1");
    assert.equal(loaded.config.openai?.embeddingModel, "text-embedding-3-small");
    assert.deepEqual(loaded.config.openai?.retry, {
      maxAttempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 5000,
    });
    assert.deepEqual(loaded.config.autoApprove?.shellCommands, ["npm test"]);
    assert.deepEqual(loaded.config.toolPolicy?.deny, ["run_shell", "read_file"]);
    assert.deepEqual(loaded.config.toolPolicy?.denyRisk, ["high"]);
    assert.deepEqual(loaded.config.toolPolicy?.requireApproval, ["list_files"]);
    assert.deepEqual(loaded.config.toolPolicy?.requireApprovalRisk, ["medium", "high"]);
    assert.match(raw, /"openai"/);
    assert.match(raw, /"retry"/);
    assert.match(raw, /"embeddingModel"/);
    assert.match(raw, /"toolPolicy"/);
    assert.match(formatConfigSetResult(modeResult), /Updated openai\.apiMode = chat/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("config can enable, read, and remove automatic context", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-context-"));

  try {
    const disabled = await setConfigValue(workspaceRoot, "context.auto", "off");
    const readDisabled = await getConfigValue(workspaceRoot, "context.auto");
    const enabled = await setConfigValue(workspaceRoot, "context.auto", "YES");
    const loaded = await loadConfig(workspaceRoot);
    const removed = await unsetConfigValue(workspaceRoot, "context.auto");
    const raw = await readFile(join(workspaceRoot, ".ccagent", "config.json"), "utf8");

    assert.equal(disabled.value, "false");
    assert.equal(readDisabled.value, "false");
    assert.equal(enabled.value, "true");
    assert.equal(loaded.config.context?.auto, true);
    assert.equal(removed.existed, true);
    assert.doesNotMatch(raw, /"context"/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("setConfigValue rejects unsupported keys and invalid values", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await assert.rejects(
      setConfigValue(workspaceRoot, "openai.apiMode", "bad"),
      /responses.*chat/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "context.auto", "sometimes"),
      /boolean/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "openai.baseURL", "not a url"),
      /valid URL/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "openai.embeddingModel", " "),
      /cannot be empty/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "openai.retry.maxAttempts", "6"),
      /between 1 and 5/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "openai.retry.baseDelayMs", "1.5"),
      /integer/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "openai.retry.maxDelayMs", "70000"),
      /between 0 and 60000/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "openai.apiKey", "secret"),
      /Unsupported config key/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "toolPolicy.allow", "read_file"),
      /Unsupported config key/,
    );
    await assert.rejects(
      setConfigValue(workspaceRoot, "toolPolicy.denyRisk", "critical"),
      /risk levels/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("getConfigValue reads one parsed config value", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        model: "gpt-test",
        openai: {
          apiMode: "chat",
          baseURL: "https://relay.example/v1",
          embeddingModel: "text-embedding-3-small",
          retry: {
            maxAttempts: 4,
          },
        },
        toolPolicy: {
          deny: ["run_shell", "read_file"],
          denyRisk: ["high"],
          requireApprovalRisk: ["medium"],
        },
      }),
    );

    const existing = await getConfigValue(workspaceRoot, "openai.baseURL");
    const retryAttempts = await getConfigValue(workspaceRoot, "openai.retry.maxAttempts");
    const embeddingModel = await getConfigValue(workspaceRoot, "openai.embeddingModel");
    const deniedTools = await getConfigValue(workspaceRoot, "toolPolicy.deny");
    const deniedRisks = await getConfigValue(workspaceRoot, "toolPolicy.denyRisk");
    const approvalRisks = await getConfigValue(
      workspaceRoot,
      "toolPolicy.requireApprovalRisk",
    );
    const missing = await getConfigValue(workspaceRoot, "model");

    assert.deepEqual(
      {
        exists: existing.exists,
        key: existing.key,
        value: existing.value,
      },
      {
        exists: true,
        key: "openai.baseURL",
        value: "https://relay.example/v1",
      },
    );
    assert.equal(deniedTools.exists, true);
    assert.equal(retryAttempts.exists, true);
    assert.equal(retryAttempts.value, "4");
    assert.equal(embeddingModel.exists, true);
    assert.equal(embeddingModel.value, "text-embedding-3-small");
    assert.equal(deniedTools.value, "run_shell, read_file");
    assert.equal(deniedRisks.exists, true);
    assert.equal(deniedRisks.value, "high");
    assert.equal(approvalRisks.exists, true);
    assert.equal(approvalRisks.value, "medium");
    assert.equal(missing.exists, true);
    assert.equal(missing.value, "gpt-test");
    assert.match(formatConfigGetResult(existing), /openai\.baseURL = https:\/\/relay\.example\/v1/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("getConfigValue reports missing values", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    const result = await getConfigValue(workspaceRoot, "openai.baseURL");

    assert.equal(result.exists, false);
    assert.equal(result.value, undefined);
    assert.match(formatConfigGetResult(result), /openai\.baseURL is not set/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("unsetConfigValue removes one config key without deleting siblings", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        model: "gpt-test",
        openai: {
          apiMode: "chat",
          baseURL: "https://relay.example/v1",
          retry: {
            maxAttempts: 4,
            baseDelayMs: 500,
          },
        },
        autoApprove: {
          shellCommands: ["npm test"],
        },
        toolPolicy: {
          deny: ["run_shell"],
          denyRisk: ["high"],
          requireApproval: ["read_file"],
          requireApprovalRisk: ["medium"],
        },
      }),
    );

    const removed = await unsetConfigValue(workspaceRoot, "openai.baseURL");
    const removedRetry = await unsetConfigValue(workspaceRoot, "openai.retry.maxAttempts");
    const removedPolicy = await unsetConfigValue(workspaceRoot, "toolPolicy.deny");
    const removedRiskPolicy = await unsetConfigValue(workspaceRoot, "toolPolicy.denyRisk");
    const missing = await unsetConfigValue(workspaceRoot, "openai.baseURL");
    const loaded = await loadConfig(workspaceRoot);
    const raw = await readFile(join(workspaceRoot, ".ccagent", "config.json"), "utf8");

    assert.equal(removed.existed, true);
    assert.equal(removedRetry.existed, true);
    assert.equal(removedPolicy.existed, true);
    assert.equal(removedRiskPolicy.existed, true);
    assert.equal(missing.existed, false);
    assert.equal(loaded.config.openai?.apiMode, "chat");
    assert.equal(loaded.config.openai?.baseURL, undefined);
    assert.deepEqual(loaded.config.openai?.retry, {
      baseDelayMs: 500,
    });
    assert.equal(loaded.config.model, "gpt-test");
    assert.deepEqual(loaded.config.autoApprove?.shellCommands, ["npm test"]);
    assert.equal(loaded.config.toolPolicy?.deny, undefined);
    assert.equal(loaded.config.toolPolicy?.denyRisk, undefined);
    assert.deepEqual(loaded.config.toolPolicy?.requireApproval, ["read_file"]);
    assert.deepEqual(loaded.config.toolPolicy?.requireApprovalRisk, ["medium"]);
    assert.match(raw, /"apiMode"/);
    assert.doesNotMatch(raw, /"baseURL"/);
    assert.doesNotMatch(raw, /"maxAttempts"/);
    assert.doesNotMatch(raw, /"deny"/);
    assert.doesNotMatch(raw, /"denyRisk"/);
    assert.match(formatConfigUnsetResult(removed), /Removed openai\.baseURL/);
    assert.match(formatConfigUnsetResult(missing), /Not set openai\.baseURL/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("unsetConfigValue removes empty openai object", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-config-"));

  try {
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        openai: {
          apiMode: "chat",
        },
      }),
    );

    await unsetConfigValue(workspaceRoot, "openai.apiMode");
    const raw = await readFile(join(workspaceRoot, ".ccagent", "config.json"), "utf8");
    const loaded = await loadConfig(workspaceRoot);

    assert.equal(loaded.config.openai, undefined);
    assert.doesNotMatch(raw, /"openai"/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
