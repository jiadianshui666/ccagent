import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, type AgentStreamEvent } from "../src/agent.js";
import { MockModelClient } from "../src/model.js";

test("Agent streams model text while returning the complete response", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-stream-"));

  try {
    const events: AgentStreamEvent[] = [];
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("hello", {
      onStreamEvent: (event) => {
        events.push(event);
      },
    });

    const streamedText = events
      .filter((event): event is Extract<AgentStreamEvent, { type: "text_delta" }> => {
        return event.type === "text_delta";
      })
      .map((event) => event.delta)
      .join("");

    assert.equal(response.streamed, true);
    assert.equal(response.content, "[mock model] You said: hello");
    assert.equal(streamedText, response.content);
    assert.equal(agent.snapshotSession().messages.at(-1)?.content, response.content);

    const turnStarts = events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "turn_start" }> =>
        event.type === "turn_start",
    );

    assert.equal(turnStarts.length, 1);
    assert.equal(turnStarts[0]?.kind, "user");
    assert.equal(turnStarts[0]?.round, 0);
    assert.equal(turnStarts[0]?.modelName, "mock");
    assert.ok(
      events.findIndex((event) => event.type === "turn_start") <
        events.findIndex((event) => event.type === "text_delta"),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent streams tool events during tool workflows", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-stream-tools-"));
  const previousInputPrice = process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS;
  const previousOutputPrice = process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS;
  const previousMaxTotalTokens = process.env.CCAGENT_MAX_TOTAL_TOKENS;
  const previousMaxCostUsd = process.env.CCAGENT_MAX_COST_USD;

  try {
    process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS = "2";
    process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS = "10";
    process.env.CCAGENT_MAX_TOTAL_TOKENS = "1";
    process.env.CCAGENT_MAX_COST_USD = "1";
    const events: AgentStreamEvent[] = [];
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("list files", {
      onStreamEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(response.streamed, true);
    assert.deepEqual(
      events.filter((event) => event.type === "tool_preflight").map((event) => event.toolName),
      ["list_files"],
    );
    assert.deepEqual(events.filter((event) => event.type === "tool_start").map((event) => event.toolName), [
      "list_files",
    ]);
    assert.deepEqual(events.filter((event) => event.type === "tool_finish").map((event) => event.toolName), [
      "list_files",
    ]);
    const startEvent = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "tool_start" }> =>
        event.type === "tool_start",
    );
    const preflightEvent = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "tool_preflight" }> =>
        event.type === "tool_preflight",
    );
    const finishEvent = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "tool_finish" }> =>
        event.type === "tool_finish",
    );

    assert.equal(preflightEvent?.callId, "mock-list-files-1");
    assert.equal(preflightEvent?.risk, "low");
    assert.equal(preflightEvent?.workspaceImpact, "read-only");
    assert.equal(preflightEvent?.requiresApproval, false);
    assert.equal(preflightEvent?.deniedByPolicy, false);
    assert.equal(startEvent?.callId, "mock-list-files-1");
    assert.equal(finishEvent?.callId, "mock-list-files-1");
    assert.ok(
      events.findIndex((event) => event.type === "tool_preflight") <
        events.findIndex((event) => event.type === "tool_start"),
    );
    const modelTurns = events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "model_turn" }> =>
        event.type === "model_turn",
    );

    assert.equal(modelTurns.length, 2);
    assert.equal(modelTurns[0]?.kind, "user");
    assert.equal(modelTurns[0]?.round, 0);
    assert.deepEqual(modelTurns[0]?.toolCalls, ["list_files"]);
    assert.equal(modelTurns[0]?.usageEstimated, true);
    assert.equal(typeof modelTurns[0]?.inputTokens, "number");
    assert.equal(typeof modelTurns[0]?.outputTokens, "number");
    assert.equal(typeof modelTurns[0]?.totalTokens, "number");
    assert.match(modelTurns[0]?.cost ?? "", /^~\$/);
    assert.equal(modelTurns[0]?.cumulativeTurns, 1);
    assert.equal(modelTurns[0]?.cumulativeTotalTokens, modelTurns[0]?.totalTokens);
    assert.match(
      modelTurns[0]?.budget ?? "",
      /^Budget: exceeded totalTokens=\d+\/1 cost=~\$\d+\.\d{6}\/\$1\.000000$/,
    );
    assert.equal(modelTurns[1]?.kind, "tool_outputs");
    assert.equal(modelTurns[1]?.round, 1);
    assert.equal(modelTurns[1]?.cumulativeTurns, 2);
    const toolStarts = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "turn_start" }> =>
          event.type === "turn_start",
      )
      .map((event) => ({ kind: event.kind, round: event.round, modelName: event.modelName }));

    assert.deepEqual(toolStarts, [
      { kind: "user", round: 0, modelName: "mock" },
      { kind: "tool_outputs", round: 1, modelName: "mock" },
    ]);
    assert.ok(
      (modelTurns[1]?.cumulativeTotalTokens ?? 0) > (modelTurns[0]?.cumulativeTotalTokens ?? 0),
    );
    assert.equal(events.some((event) => event.type === "tool_result"), true);
    assert.match(response.content, /\[tool\] list_files ->/);
    assert.match(response.content, /I used the tool and got this observation/);
  } finally {
    if (previousInputPrice === undefined) {
      delete process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS;
    } else {
      process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS = previousInputPrice;
    }

    if (previousOutputPrice === undefined) {
      delete process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS;
    } else {
      process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS = previousOutputPrice;
    }

    if (previousMaxTotalTokens === undefined) {
      delete process.env.CCAGENT_MAX_TOTAL_TOKENS;
    } else {
      process.env.CCAGENT_MAX_TOTAL_TOKENS = previousMaxTotalTokens;
    }

    if (previousMaxCostUsd === undefined) {
      delete process.env.CCAGENT_MAX_COST_USD;
    } else {
      process.env.CCAGENT_MAX_COST_USD = previousMaxCostUsd;
    }

    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent streams approval status for approval-gated tools", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-stream-approval-"));

  try {
    const events: AgentStreamEvent[] = [];
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => false,
    );

    const response = await agent.handleUserMessage("patch note.txt hello", {
      onStreamEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(response.streamed, true);
    const preflightEvent = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "tool_preflight" }> =>
        event.type === "tool_preflight",
    );

    assert.equal(preflightEvent?.toolName, "apply_patch");
    assert.equal(preflightEvent?.risk, "high");
    assert.equal(preflightEvent?.workspaceImpact, "workspace-write");
    assert.equal(preflightEvent?.requiresApproval, true);
    assert.equal(preflightEvent?.deniedByPolicy, false);
    assert.ok(
      events.findIndex((event) => event.type === "tool_preflight") <
        events.findIndex((event) => event.type === "tool_start"),
    );
    assert.deepEqual(
      events.filter((event) => event.type === "tool_approval").map((event) => event.status),
      ["required", "denied"],
    );
    const requiredApproval = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "tool_approval" }> =>
        event.type === "tool_approval" && event.status === "required",
    );

    assert.match(requiredApproval?.message ?? "", /Files: note\.txt/);
    assert.match(requiredApproval?.message ?? "", /Changes: \+1 -0/);
    assert.equal(
      events.some(
        (event) =>
          event.type === "tool_finish" &&
          event.toolName === "apply_patch" &&
          event.ok === false,
      ),
      true,
    );
    assert.match(response.content, /User denied approval for apply_patch/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent reports aborted model turns as failures", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-stream-abort-"));

  try {
    const controller = new AbortController();
    controller.abort();
    const events: AgentStreamEvent[] = [];
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("hello", {
      onStreamEvent: (event) => {
        events.push(event);
      },
      signal: controller.signal,
    });

    assert.match(response.content, /^Model call failed:/);
    assert.match(response.content, /aborted/i);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
