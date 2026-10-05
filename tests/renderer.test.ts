import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
  createJsonLinesRenderer,
  createTerminalRenderer,
  renderAgentStreamEvent,
  renderFinalResponse,
  renderJsonLine,
} from "../src/renderer.js";

test("renderAgentStreamEvent formats text deltas without decoration", () => {
  assert.equal(
    renderAgentStreamEvent({
      type: "text_delta",
      delta: "hello",
    }),
    "hello",
  );
});

test("renderAgentStreamEvent hides turn_start metadata for terminal output", () => {
  assert.equal(
    renderAgentStreamEvent({
      type: "turn_start",
      kind: "user",
      modelName: "mock",
      round: 0,
    }),
    "",
  );
});

test("renderAgentStreamEvent formats tool lifecycle events", () => {
  assert.equal(
    renderAgentStreamEvent({
      type: "tool_preflight",
      toolName: "list_files",
      callId: "call-list-1",
      deniedByPolicy: false,
      reasons: ["tool only reads workspace or git state"],
      requiresApproval: false,
      risk: "low",
      summary: "list_files risk=low impact=read-only",
      workspaceImpact: "read-only",
    }),
    "\n[tool:preflight] list_files risk=low impact=read-only approval=no denied=no\n",
  );

  assert.equal(
    renderAgentStreamEvent({
      type: "tool_start",
      toolName: "list_files",
      inputSummary: '{"path":".","maxDepth":1}',
    }),
    '\n[tool:start] list_files {"path":".","maxDepth":1}\n',
  );

  assert.equal(
    renderAgentStreamEvent({
      type: "tool_approval",
      toolName: "apply_patch",
      status: "approved",
    }),
    "[tool:approval] apply_patch approved\n",
  );

  assert.equal(
    renderAgentStreamEvent({
      type: "tool_approval",
      toolName: "apply_patch",
      status: "required",
      message: [
        "Apply this patch:",
        "Files: demo.txt",
        "Changes: +1 -0",
        "",
        "Preview:",
        "diff --git a/demo.txt b/demo.txt",
        "+hello",
      ].join("\n"),
    }),
    "[tool:approval] apply_patch required\nApply this patch:\nFiles: demo.txt\nChanges: +1 -0\n",
  );

  assert.equal(
    renderAgentStreamEvent({
      type: "tool_finish",
      toolName: "run_shell",
      ok: true,
      summary: "ok (44 chars, exitCode=0)",
    }),
    "[tool:finish] run_shell ok (44 chars, exitCode=0)\n",
  );
});

test("renderAgentStreamEvent formats tool results and messages", () => {
  assert.equal(
    renderAgentStreamEvent({
      type: "tool_result",
      toolName: "read_file",
      content: "[tool] read_file -> {}",
    }),
    "\n[tool] read_file -> {}\n\n",
  );

  assert.equal(
    renderAgentStreamEvent({
      type: "message",
      content: "done",
    }),
    "done\n",
  );
});

test("renderAgentStreamEvent formats model turn usage", () => {
  assert.equal(
    renderAgentStreamEvent({
      type: "model_turn",
      budget: "Budget: ok totalTokens=18/100",
      cachedInputTokens: 2,
      cost: "~$0.000070",
      cumulativeCachedInputTokens: 2,
      cumulativeCost: "~$0.000070 (1 costed turn(s))",
      cumulativeEstimatedTurns: 1,
      cumulativeInputTokens: 10,
      cumulativeOutputTokens: 8,
      cumulativeTotalTokens: 18,
      cumulativeTurns: 1,
      cumulativeTurnsWithUsage: 1,
      durationMs: 42,
      inputTokens: 10,
      kind: "user",
      modelName: "mock",
      outputTokens: 8,
      responseId: "mock-text",
      round: 0,
      toolCalls: [],
      totalTokens: 18,
      usageEstimated: true,
    }),
    "\n[model] user round=0 model=mock duration=42ms tokens=in=10,out=8,total=18,cached=2,estimated=yes cost=~$0.000070 cumulative=turns:1,total:18,cost:~$0.000070 (1 costed turn(s)) Budget: ok totalTokens=18/100\n",
  );
});

test("createTerminalRenderer writes rendered events to the output stream", async () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString("utf8");
      callback();
    },
  });
  const renderer = createTerminalRenderer(stream);

  await renderer.writeAgentStreamEvent({
    type: "tool_finish",
    toolName: "list_files",
    ok: true,
    summary: "ok (12 chars, count=1)",
  });

  assert.equal(output, "[tool:finish] list_files ok (12 chars, count=1)\n");
});

test("renderFinalResponse prints only a newline after streamed terminal output", () => {
  assert.equal(renderFinalResponse({ content: "hello", streamed: true }), "\n");
  assert.equal(renderFinalResponse({ content: "hello" }), "hello\n");
});

test("renderJsonLine formats events and final responses as JSON Lines", () => {
  assert.equal(
    renderJsonLine({
      type: "tool_preflight",
      toolName: "list_files",
      deniedByPolicy: false,
      reasons: ["tool only reads workspace or git state"],
      requiresApproval: false,
      risk: "low",
      summary: "list_files risk=low impact=read-only",
      workspaceImpact: "read-only",
    }),
    '{"type":"tool_preflight","toolName":"list_files","deniedByPolicy":false,"reasons":["tool only reads workspace or git state"],"requiresApproval":false,"risk":"low","summary":"list_files risk=low impact=read-only","workspaceImpact":"read-only"}\n',
  );

  assert.equal(
    renderJsonLine({
      type: "tool_start",
      toolName: "list_files",
      inputSummary: '{"path":"."}',
    }),
    '{"type":"tool_start","toolName":"list_files","inputSummary":"{\\"path\\":\\".\\"}"}\n',
  );

  assert.equal(
    renderJsonLine({
      type: "final_response",
      content: "done",
      streamed: true,
    }),
    '{"type":"final_response","content":"done","streamed":true}\n',
  );
});

test("createJsonLinesRenderer writes JSON Lines to the output stream", async () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString("utf8");
      callback();
    },
  });
  const renderer = createJsonLinesRenderer(stream);

  await renderer.writeFinalResponse({
    content: "done",
    streamed: true,
  });

  assert.equal(output, '{"type":"final_response","content":"done","streamed":true}\n');
});
