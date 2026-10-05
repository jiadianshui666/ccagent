import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, type AgentStreamEvent } from "../src/agent.js";
import type { ModelClient, ModelResult, ModelToolCall, ModelTurnInput } from "../src/model.js";

class ScriptedModelClient implements ModelClient {
  readonly name = "scripted";
  private turnCount = 0;
  private readonly observedOutputs: string[] = [];

  constructor(private readonly script: ModelToolCall[]) {}

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    this.turnCount += 1;

    if (input.toolOutputs && input.toolOutputs.length > 0) {
      this.observedOutputs.push(`${input.toolOutputs.length}:${input.toolOutputs.map((item) => item.callId).join(",")}`);

      return {
        content: `observed:${input.toolOutputs.length} order:${input.toolOutputs.map((item) => item.callId).join(",")}`,
        responseId: "scripted-final",
        toolCalls: [],
        usage: { totalTokens: 10 + this.turnCount, estimated: true },
      };
    }

    return {
      content: "",
      responseId: "scripted-tools",
      toolCalls: this.script,
      usage: { totalTokens: 5, estimated: true },
    };
  }

  observed(): string[] {
    return this.observedOutputs;
  }
}

test("Agent runs consecutive safe read-only tool calls in parallel with ordered events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-parallel-"));

  try {
    await writeFile(join(workspaceRoot, "sample.txt"), "hello\n", "utf8");
    const events: AgentStreamEvent[] = [];
    const model = new ScriptedModelClient([
      {
        callId: "call-list",
        name: "list_files",
        arguments: { path: ".", maxDepth: 1 },
        rawArguments: JSON.stringify({ path: ".", maxDepth: 1 }),
      },
      {
        callId: "call-workspace",
        name: "workspace_info",
        arguments: {},
        rawArguments: "{}",
      },
      {
        callId: "call-read",
        name: "read_file",
        arguments: { path: "sample.txt" },
        rawArguments: JSON.stringify({ path: "sample.txt" }),
      },
    ]);
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);
    const response = await agent.handleUserMessage("inspect the workspace", {
      onStreamEvent: (event) => {
        events.push(event);
      },
    });

    assert.match(
      response.content,
      /observed:3 order:call-list,call-workspace,call-read$/,
    );
    assert.deepEqual(model.observed(), ["3:call-list,call-workspace,call-read"]);

    const startIndexes = ["call-list", "call-workspace", "call-read"].map((callId) =>
      events.findIndex(
        (event) => event.type === "tool_start" && event.callId === callId,
      ),
    );
    const finishIndexes = ["call-list", "call-workspace", "call-read"].map((callId) =>
      events.findIndex(
        (event) => event.type === "tool_finish" && event.callId === callId,
      ),
    );

    for (const index of [...startIndexes, ...finishIndexes]) {
      assert.notEqual(index, -1);
    }

    const lastStart = Math.max(...startIndexes);
    const firstFinish = Math.min(...finishIndexes);

    assert.ok(
      lastStart < firstFinish,
      "all tool starts must be emitted before any finish (parallel batch)",
    );

    const results = events.filter((event) => event.type === "tool_result");

    assert.deepEqual(
      results.map((event) => (event.type === "tool_result" ? event.callId : "")),
      ["call-list", "call-workspace", "call-read"],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent falls back to serial execution when a tool call needs approval", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-parallel-mixed-"));

  try {
    const events: AgentStreamEvent[] = [];
    const model = new ScriptedModelClient([
      {
        callId: "call-safe",
        name: "list_files",
        arguments: { path: ".", maxDepth: 1 },
        rawArguments: JSON.stringify({ path: ".", maxDepth: 1 }),
      },
      {
        callId: "call-shell",
        name: "run_shell",
        arguments: { command: "echo mixed-ok" },
        rawArguments: JSON.stringify({ command: "echo mixed-ok" }),
      },
    ]);
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);
    const response = await agent.handleUserMessage("list files and echo", {
      onStreamEvent: (event) => {
        events.push(event);
      },
    });

    assert.match(response.content, /observed:2/);

    const safeFinish = events.findIndex(
      (event) => event.type === "tool_finish" && event.callId === "call-safe",
    );
    const shellStart = events.findIndex(
      (event) => event.type === "tool_start" && event.callId === "call-shell",
    );
    const shellApproval = events.findIndex(
      (event) => event.type === "tool_approval" && event.callId === "call-shell",
    );

    assert.notEqual(safeFinish, -1);
    assert.notEqual(shellApproval, -1);
    assert.ok(
      safeFinish < shellStart,
      "the approval-gated tool starts only after the safe tool finishes (serial fallback)",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
