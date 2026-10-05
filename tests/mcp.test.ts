import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  formatMcpPromptResult,
  formatMcpPrompts,
  formatMcpResourceReadResult,
  formatMcpResourceTemplates,
  formatMcpResources,
  formatMcpReloadResult,
  formatMcpStatus,
  formatMcpTools,
  loadMcpTools,
  parseMcpCommand,
} from "../src/mcp.js";
import { buildOpenAIResponsesTools } from "../src/model.js";
import { ToolRegistry } from "../src/tools/registry.js";

test("loadMcpTools discovers and executes a stdio MCP tool", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-mcp-"));

  try {
    const loaded = await loadMcpTools({
      enabled: true,
      servers: {
        fixture: {
          args: [resolve("tests/fixtures/mcp-test-server.mjs")],
          command: process.execPath,
          timeoutMs: 10_000,
        },
      },
    }, workspaceRoot, ["list_files"]);

    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.servers, [{ name: "fixture", toolCount: 1 }]);
    assert.deepEqual(loaded.serverStatuses, [{
      command: process.execPath,
      name: "fixture",
      promptCount: 1,
      resourceCount: 1,
      status: "connected",
      templateCount: 1,
      toolCount: 1,
    }]);
    assert.deepEqual(loaded.toolStatuses, [{
      description: "Echoes text with an optional suffix.",
      name: "mcp_fixture_echo_text",
      serverName: "fixture",
      toolName: "echo_text",
    }]);
    assert.deepEqual(loaded.resources, [{
      description: "A text resource used by CCAgent MCP tests.",
      mimeType: "text/plain",
      name: "Fixture guide",
      serverName: "fixture",
      uri: "fixture://guide",
    }]);
    assert.deepEqual(loaded.prompts, [{
      arguments: [{
        description: "Message to include in the prompt.",
        name: "message",
        required: true,
      }],
      description: "Builds a fixture prompt from one message.",
      name: "echo_prompt",
      serverName: "fixture",
    }]);
    assert.deepEqual(loaded.templates, [{
      description: "Reads one fixture documentation topic.",
      mimeType: "text/plain",
      name: "Fixture topic",
      serverName: "fixture",
      uriTemplate: "fixture://docs/{topic}",
    }]);
    assert.equal(loaded.tools.length, 1);
    const tool = loaded.tools[0];

    assert.equal(tool?.name, "mcp_fixture_echo_text");
    assert.match(tool?.description ?? "", /Echoes text/);
    assert.deepEqual(tool?.parameters.required, ["message", "suffix"]);
    assert.deepEqual(tool?.parameters.additionalProperties, false);
    assert.match(tool?.approvalMessage?.({ message: "hello", suffix: null }) ?? "", /external MCP tool/);
    assert.deepEqual(buildOpenAIResponsesTools([tool!]), [{
      type: "function",
      name: "mcp_fixture_echo_text",
      description: "MCP server fixture: Echoes text with an optional suffix.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
          suffix: {
            anyOf: [
              { type: "string" },
              { type: "null" },
            ],
          },
        },
        required: ["message", "suffix"],
        additionalProperties: false,
      },
      strict: true,
    }]);

    const result = await tool?.execute(
      { message: "hello", suffix: null },
      { workspaceRoot },
    );

    assert.deepEqual(result, {
      ok: true,
      content: "hello",
      metadata: {
        mcpServer: "fixture",
        mcpTool: "echo_text",
      },
    });
    assert.match(formatMcpStatus(loaded, true), /fixture: status=connected, tools=1/);
    assert.match(formatMcpTools(loaded), /mcp_fixture_echo_text \(fixture\.echo_text\)/);
    assert.match(formatMcpResources(loaded), /Fixture guide \(fixture:\/\/guide\)/);
    assert.match(formatMcpPrompts(loaded), /fixture\.echo_prompt/);
    assert.match(formatMcpResourceTemplates(loaded), /fixture:\/\/docs\/\{topic\}/);
    assert.deepEqual(JSON.parse(formatMcpStatus(loaded, true, true)), {
      connectedServers: 1,
      configuredServers: 1,
      enabled: true,
      promptCount: 1,
      resourceCount: 1,
      servers: loaded.serverStatuses,
      templateCount: 1,
      toolCount: 1,
      warnings: [],
    });
    assert.deepEqual(JSON.parse(formatMcpTools(loaded, true)), {
      count: 1,
      tools: loaded.toolStatuses,
    });
    assert.match(formatMcpReloadResult(loaded, true), /MCP reloaded/);
    assert.deepEqual(JSON.parse(formatMcpReloadResult(loaded, true, [], true)), {
      reloaded: true,
      connectedServers: 1,
      configuredServers: 1,
      enabled: true,
      promptCount: 1,
      resourceCount: 1,
      servers: loaded.serverStatuses,
      templateCount: 1,
      toolCount: 1,
      warnings: [],
      configWarnings: [],
    });

    const resource = await loaded.manager.readResource("fixture", "fixture://guide");
    assert.deepEqual(resource, {
      ok: true,
      content: "Fixture resource content.",
      mimeTypes: ["text/plain"],
      serverName: "fixture",
      uri: "fixture://guide",
    });
    assert.match(formatMcpResourceReadResult(resource), /Fixture resource content\./);
    const prompt = await loaded.manager.getPrompt("fixture", "echo_prompt", {
      message: "hello",
    });
    assert.deepEqual(prompt, {
      ok: true,
      description: "Fixture prompt result.",
      messages: [{
        content: "Fixture prompt: hello",
        role: "user",
      }],
      name: "echo_prompt",
      serverName: "fixture",
    });
    assert.match(formatMcpPromptResult(prompt), /Fixture prompt: hello/);
    assert.deepEqual(
      await loaded.manager.readResource("missing", "fixture://guide"),
      {
        ok: false,
        error: 'MCP server "missing" is not connected.',
        serverName: "missing",
        uri: "fixture://guide",
      },
    );

    const registry = new ToolRegistry([tool!]);
    assert.equal(registry.get("mcp_fixture_echo_text"), tool);
    registry.replace([]);
    assert.equal(registry.get("mcp_fixture_echo_text"), undefined);
    await loaded.manager.close();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadMcpTools isolates unavailable servers", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-mcp-failure-"));

  try {
    const loaded = await loadMcpTools({
      enabled: true,
      servers: {
        missing: {
          command: "ccagent-missing-mcp-server",
          timeoutMs: 1_000,
        },
      },
    }, workspaceRoot);

    assert.deepEqual(loaded.tools, []);
    assert.deepEqual(loaded.servers, []);
    assert.deepEqual(loaded.toolStatuses, []);
    assert.equal(loaded.serverStatuses[0]?.status, "unavailable");
    assert.equal(loaded.serverStatuses[0]?.promptCount, 0);
    assert.equal(loaded.serverStatuses[0]?.resourceCount, 0);
    assert.equal(loaded.serverStatuses[0]?.templateCount, 0);
    assert.ok((loaded.serverStatuses[0]?.error?.length ?? 0) > 0);
    assert.match(loaded.warnings.join("\n"), /MCP server "missing" is unavailable/);
    assert.ok(loaded.warnings[0]?.endsWith(loaded.serverStatuses[0]?.error ?? "missing error"));
    await loaded.manager.close();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadMcpTools accepts a resources-only MCP server", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-mcp-resources-only-"));

  try {
    const loaded = await loadMcpTools({
      enabled: true,
      servers: {
        resources: {
          args: [resolve("tests/fixtures/mcp-test-server.mjs")],
          command: process.execPath,
          env: {
            MCP_FIXTURE_RESOURCES_ONLY: "1",
          },
          timeoutMs: 10_000,
        },
      },
    }, workspaceRoot);

    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.servers, [{ name: "resources", toolCount: 0 }]);
    assert.equal(loaded.serverStatuses[0]?.status, "connected");
    assert.equal(loaded.serverStatuses[0]?.promptCount, 0);
    assert.equal(loaded.serverStatuses[0]?.resourceCount, 1);
    assert.equal(loaded.serverStatuses[0]?.templateCount, 1);
    assert.deepEqual(loaded.tools, []);
    assert.equal(loaded.resources[0]?.uri, "fixture://guide");
    assert.equal(
      (await loaded.manager.readResource("resources", "fixture://guide")).ok,
      true,
    );
    await loaded.manager.close();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadMcpTools retains disabled configured server status without starting it", async () => {
  const loaded = await loadMcpTools({
    enabled: false,
    servers: {
      disabled: {
        command: "ccagent-disabled-mcp-server",
      },
    },
  }, process.cwd());

  assert.deepEqual(loaded.serverStatuses, [{
    command: "ccagent-disabled-mcp-server",
    name: "disabled",
    promptCount: 0,
    resourceCount: 0,
    status: "disabled",
    templateCount: 0,
    toolCount: 0,
  }]);
  assert.equal(loaded.tools.length, 0);
  await loaded.manager.close();
});

test("parseMcpCommand accepts MCP status, catalog, and reload forms", () => {
  assert.deepEqual(parseMcpCommand(""), { action: "status", json: false });
  assert.deepEqual(parseMcpCommand("status --json"), { action: "status", json: true });
  assert.deepEqual(parseMcpCommand("tools --json"), { action: "tools", json: true });
  assert.deepEqual(parseMcpCommand("reload --json"), { action: "reload", json: true });
  assert.deepEqual(parseMcpCommand("resources --json"), { action: "resources", json: true });
  assert.deepEqual(parseMcpCommand("prompts --json"), { action: "prompts", json: true });
  assert.deepEqual(parseMcpCommand("templates --json"), { action: "templates", json: true });
  assert.deepEqual(parseMcpCommand("read fixture fixture://guide --json"), {
    action: "read",
    json: true,
    serverName: "fixture",
    uri: "fixture://guide",
  });
  assert.deepEqual(parseMcpCommand('prompt fixture echo_prompt {"message": "hello world"} --json'), {
    action: "prompt",
    arguments: { message: "hello world" },
    json: true,
    name: "echo_prompt",
    serverName: "fixture",
  });
  assert.deepEqual(parseMcpCommand("prompt fixture echo_prompt []"), {
    error: "MCP prompt arguments must be a JSON object with string values.",
  });
  assert.deepEqual(parseMcpCommand("tools extra"), {
    error: "Usage: /mcp [status|tools|resources|templates|prompts|reload] [--json] | /mcp read <server> <uri> [--json] | /mcp prompt <server> <name> [arguments-json] [--json]",
  });
});
