import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
  boxText,
  colorizeDiffLines,
  createRichRenderer,
  createRichTheme,
  estimateTextTokens,
  looksLikeDiff,
  stripAnsi,
  truncateLines,
  wrapText,
} from "../src/richRenderer.js";

function captureStream() {
  let captured = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += chunk.toString("utf8");
      callback();
    },
  });

  return {
    stream,
    read: () => captured,
  };
}

test("createRichTheme paints with ANSI codes only when enabled", () => {
  const colored = createRichTheme(true);

  assert.equal(colored.red("error"), "\x1b[31merror\x1b[0m");
  assert.equal(colored.bold("title"), "\x1b[1mtitle\x1b[0m");

  const plain = createRichTheme(false);

  assert.equal(plain.red("error"), "error");
  assert.equal(plain.bold("title"), "title");
});

test("stripAnsi removes color sequences and OSC sequences", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m and \x1b[2mdim\x1b[0m"), "red and dim");
  assert.equal(stripAnsi("plain text"), "plain text");
  assert.equal(stripAnsi("\x1b]0;title\x07visible"), "visible");
});

test("looksLikeDiff detects unified and apply_patch style diffs", () => {
  assert.equal(
    looksLikeDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new"),
    true,
  );
  assert.equal(
    looksLikeDiff("*** Begin Patch\n*** Update File: x\n@@ -1 +1 @@\n-old\n+new"),
    true,
  );
  assert.equal(looksLikeDiff("plain text\nsecond line"), false);
  assert.equal(looksLikeDiff("2+2=4\n3-1=2"), false);
});

test("colorizeDiffLines colors added, removed, and header lines", () => {
  const theme = createRichTheme(true);
  const source = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
  const colored = colorizeDiffLines(source, theme);

  assert.match(colored, /\x1b\[36mdiff --git a\/x b\/x\x1b\[0m/);
  assert.match(colored, /\x1b\[31m-old\x1b\[0m/);
  assert.match(colored, /\x1b\[32m\+new\x1b\[0m/);
  assert.equal(colorizeDiffLines(source, createRichTheme(false)), source);
});

test("truncateLines caps width and reports skipped lines", () => {
  assert.deepEqual(truncateLines("aaa\nbbb\nccc\nddd", 2, 5), {
    text: "aaa\nbbb",
    truncated: 2,
  });
  assert.deepEqual(truncateLines("abcdefgh", 5, 5), {
    text: "ab...",
    truncated: 0,
  });
});

test("wrapText breaks long lines on word boundaries", () => {
  assert.deepEqual(wrapText("one two three four five six", 20), [
    "one two three four",
    "five six",
  ]);
  assert.deepEqual(wrapText("short", 11), ["short"]);
  assert.deepEqual(wrapText("aaaaaaaaaaaaaaaaaaaaaa", 20), [
    "aaaaaaaaaaaaaaaaaaaa",
    "aa",
  ]);
});

test("boxText renders a bordered box with title and truncation footer", () => {
  const theme = createRichTheme(false);
  const box = boxText("line one\nline two\nline three\nline four", {
    theme,
    maxWidth: 40,
    maxLines: 3,
    title: "demo",
  });

  assert.match(box, /^┌─ demo /);
  assert.match(box, /│ line one/);
  assert.doesNotMatch(box, /line four/);
  assert.match(box, /… \(1 more lines\)/);
  assert.match(box, /└─+┘\n$/);

  const empty = boxText("", { theme, maxWidth: 40, title: "demo" });

  assert.match(empty, /\(empty\)/);
});

test("boxText colors diff lines when the content is a diff", () => {
  const box = boxText("*** Begin Patch\n*** Update File: x\n-old\n+new", {
    theme: createRichTheme(true),
    maxWidth: 40,
    title: "details",
  });

  assert.match(box, /\x1b\[31m-old\x1b\[0m/);
  assert.match(box, /\x1b\[32m\+new\x1b\[0m/);
});

test("rich renderer streams marked text blocks, tool blocks, approval panels, and usage lines", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
  });

  await renderer.writeAgentStreamEvent({
    type: "text_delta",
    delta: "\n\nI will check.",
  });
  await renderer.writeAgentStreamEvent({
    type: "text_delta",
    delta: " Continue.",
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_preflight",
    toolName: "run_shell",
    risk: "medium",
    workspaceImpact: "workspace",
    requiresApproval: true,
    deniedByPolicy: false,
    reasons: ["needs approval"],
    summary: "run_shell risk=medium impact=workspace",
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_start",
    toolName: "run_shell",
    inputSummary: '{"command":"npm test"}',
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_approval",
    toolName: "run_shell",
    status: "required",
    message: "Run tool run_shell?",
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_approval",
    toolName: "run_shell",
    status: "approved",
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_result",
    toolName: "run_shell",
    content: "[tool] run_shell -> > ok\n42 passing",
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_finish",
    toolName: "run_shell",
    ok: true,
    summary: "ok (44 chars, exitCode=0)",
  });
  await renderer.writeAgentStreamEvent({
    type: "model_turn",
    budget: "Budget: ok totalTokens=3/100",
    cost: "~$0.000021",
    cumulativeCachedInputTokens: 0,
    cumulativeCost: "~$0.000021",
    cumulativeEstimatedTurns: 1,
    cumulativeInputTokens: 2,
    cumulativeOutputTokens: 1,
    cumulativeTotalTokens: 3,
    cumulativeTurns: 1,
    cumulativeTurnsWithUsage: 1,
    durationMs: 42,
    inputTokens: 2,
    kind: "user",
    modelName: "mock",
    outputTokens: 1,
    round: 0,
    toolCalls: ["run_shell"],
    totalTokens: 3,
    usageEstimated: true,
  });
  await renderer.writeFinalResponse({
    content: "I will check.",
    streamed: true,
  });

  const text = output.read();

  assert.match(text, /● I will check\. Continue\./);
  assert.match(text, /○ run_shell \(risk=medium, impact=workspace\)/);
  assert.match(text, /Approval required: run_shell/);
  assert.match(text, /● run_shell — approved/);
  assert.match(text, /run_shell output/);
  assert.match(text, /42 passing/);
  assert.match(text, /  ok \(44 chars, exitCode=0\)/);
  assert.match(text, /─ model mock · in=2, out=1, total=3/);
  assert.match(text, /\n\n$/);
});

test("rich renderer marks denied approvals and suppresses the duplicate failure summary", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 50,
    theme: createRichTheme(false),
  });

  await renderer.writeAgentStreamEvent({
    type: "tool_start",
    toolName: "run_shell",
    inputSummary: '{"command":"rm -rf ."}',
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_approval",
    toolName: "run_shell",
    status: "required",
    message: "Run tool run_shell?",
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_approval",
    toolName: "run_shell",
    status: "denied",
  });
  await renderer.writeAgentStreamEvent({
    type: "tool_finish",
    toolName: "run_shell",
    ok: false,
    summary: "error: User denied approval for run_shell.",
  });

  const text = output.read();

  assert.match(text, /● run_shell — denied/);
  assert.doesNotMatch(text, /User denied approval/);
});

test("rich renderer banners and non-streamed final responses use marked blocks", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
  });

  await renderer.writeBanner('CCAgent started (mock).');
  await renderer.writeFinalResponse({
    content: "\nHello from CCAgent.",
  });

  const text = output.read();

  assert.match(text, /┌─ CCAgent /);
  assert.match(text, /CCAgent started \(mock\)\./);
  assert.match(text, /● Hello from CCAgent\.\n$/);
});

test("rich renderer prompt status strip shows model, cumulative usage, and policy flags", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
  });

  await renderer.writePromptStatus({ allowEdits: true, useSession: false });

  const first = output.read();

  assert.match(first, /── model - · edits=auto-approve · session=off/);

  await renderer.writeAgentStreamEvent({
    type: "model_turn",
    budget: "Budget: ok totalTokens=321/1000",
    cost: "~$0.0004",
    cumulativeCachedInputTokens: 0,
    cumulativeCost: "~$0.0008 (2 costed turn(s))",
    cumulativeEstimatedTurns: 2,
    cumulativeInputTokens: 400,
    cumulativeOutputTokens: 90,
    cumulativeTotalTokens: 321,
    cumulativeTurns: 2,
    cumulativeTurnsWithUsage: 2,
    durationMs: 1420,
    inputTokens: 200,
    kind: "tool_outputs",
    modelName: "mock",
    outputTokens: 121,
    round: 1,
    toolCalls: [],
    totalTokens: 321,
    usageEstimated: true,
  });

  const beforeTurn = first.length;
  const afterTurn = output.read().slice(beforeTurn);

  assert.match(afterTurn, /cum: 2 turns, 321 tokens, cost=~\$0\.0008 \(2 costed turn\(s\)\)/);

  await renderer.writePromptStatus({ allowEdits: false, useSession: true });

  const second = output.read().slice(beforeTurn + afterTurn.length);

  assert.match(second, /model mock · 2 turns · 321 tokens · cost=~\$0\.0008 \(2 costed turn\(s\)\)/);
  assert.doesNotMatch(second, /edits=auto-approve/);
  assert.doesNotMatch(second, /session=off/);
});

test("rich renderer pins a bottom status bar around prompts and streaming", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
    tickIntervalMs: 60000,
  });

  await renderer.writeMessage("banner-ish");
  await renderer.writePromptStatus({ allowEdits: false, useSession: true });
  await renderer.writePromptLine("CCAgent > ");

  const withPrompt = output.read();

  assert.match(withPrompt, /banner-ish\n/);
  assert.match(withPrompt, /\r\x1b\[2KCCAgent > /);
  assert.match(withPrompt, /CCAgent > \n── model - /);
  assert.ok(withPrompt.endsWith("\x1b[1A\x1b[10C"));

  const beforeStream = withPrompt.length;

  await renderer.writeAgentStreamEvent({
    type: "text_delta",
    delta: "hello\n",
  });

  const streamed = output.read().slice(beforeStream);

  assert.match(streamed, /^\r\x1b\[2K/);
  assert.match(streamed, /● hello\n/);
  assert.match(streamed, /── model - /);
});

test("rich renderer approval detail blocks respect the pinned bar", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
  });

  await renderer.writePromptStatus({ allowEdits: true, useSession: false });
  await renderer.writeRichBlock("line a\nline b", "apply_patch details");

  const text = output.read();

  assert.match(text, /┌─ apply_patch details /);
  assert.match(text, /│ line b/);
  assert.match(text, /── model - · edits=auto-approve · session=off/);
});

test("estimateTextTokens counts CJK glyphs singly and ASCII text by quarters", () => {
  assert.equal(estimateTextTokens("hello world"), 3);
  assert.equal(estimateTextTokens(""), 1);
  assert.equal(estimateTextTokens("\u4f60\u597d"), 2);
  assert.equal(estimateTextTokens("\u4f60\u597d world"), 4);
});

test("rich renderer shows a live outgoing-token estimate while streaming", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
    tickIntervalMs: 60000,
  });

  await renderer.writePromptStatus({ allowEdits: false, useSession: true });
  await renderer.writePromptLine("CCAgent > ");
  const before = output.read().length;

  await renderer.writeAgentStreamEvent({ type: "text_delta", delta: "hello world" });
  const firstDelta = output.read().slice(before);
  assert.match(firstDelta, /out\u22483 tok \u00b7 \d+\.\ds/);

  await renderer.writeAgentStreamEvent({ type: "text_delta", delta: "extra!!" });
  const secondDelta = output.read().slice(before + firstDelta.length);
  assert.match(secondDelta, /out\u22485 tok/);

  await renderer.writeAgentStreamEvent({
    type: "model_turn",
    budget: "(none)",
    cost: "~$0.0008",
    cumulativeCachedInputTokens: 0,
    cumulativeCost: "~$0.0008",
    cumulativeEstimatedTurns: 1,
    cumulativeInputTokens: 200,
    cumulativeOutputTokens: 121,
    cumulativeTotalTokens: 321,
    cumulativeTurns: 1,
    cumulativeTurnsWithUsage: 1,
    durationMs: 34,
    inputTokens: 200,
    kind: "user",
    modelName: "mock",
    outputTokens: 121,
    round: 1,
    toolCalls: [],
    totalTokens: 321,
    usageEstimated: true,
  });

  const afterTurn = output.read().slice(before + firstDelta.length + secondDelta.length);
  assert.doesNotMatch(afterTurn, /out\u2248/);
  assert.match(afterTurn, /321 tokens/);
});

test("rich renderer clears the live estimate when a fresh prompt starts", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
    tickIntervalMs: 60000,
  });

  await renderer.writePromptStatus({ allowEdits: false, useSession: true });
  await renderer.writePromptLine("CCAgent > ");
  output.read();

  await renderer.writeAgentStreamEvent({ type: "text_delta", delta: "again!" });
  const streamed = output.read();
  assert.match(streamed, /out\u22482 tok/);

  await renderer.writePromptLine("CCAgent > ");
  assert.doesNotMatch(output.read().slice(streamed.length), /out\u2248/);
});

test("rich renderer repaints the status bar when the terminal resizes", async () => {
  const output = captureStream();
  const stream = output.stream as Writable & {
    columns?: number;
    isTTY?: boolean;
    on?: (event: string, listener: () => void) => unknown;
  };

  let onResize: (() => void) | undefined;
  stream.isTTY = true;
  stream.on = (event, listener) => {
    if (event === "resize") {
      onResize = listener;
    }
  };
  stream.columns = 60;

  const renderer = createRichRenderer(stream, { theme: createRichTheme(false) });
  await renderer.writePromptStatus({ allowEdits: false, useSession: true });
  assert.equal(output.read().length, 60);

  stream.columns = 40;
  onResize?.();
  const resized = output.read();
  assert.match(resized, /\r\x1b\[2K/);
  const resizedBar = resized.slice(resized.indexOf("\x1b[2K") + 4);
  assert.equal(resizedBar.length, 40);

  await renderer.writePromptLine("CCAgent > ");
  const beforePrompt = output.read().length;

  stream.columns = 50;
  onResize?.();
  const promptResized = output.read().slice(beforePrompt);
  assert.match(promptResized, /\x1b7\x1b\[1B\r\x1b\[2K/);
  assert.ok(promptResized.endsWith("\x1b8"));
  const promptBar = promptResized.slice(promptResized.indexOf("\x1b[2K") + 4, -2);
  assert.equal(promptBar.length, 50);
});

test("rich renderer ticks the elapsed timer while streaming stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000000 });

  try {
    const output = captureStream();
    const renderer = createRichRenderer(output.stream, {
      columns: 60,
      theme: createRichTheme(false),
      tickIntervalMs: 500,
    });

    await renderer.writePromptStatus({ allowEdits: false, useSession: true });
    await renderer.writePromptLine("CCAgent > ");
    output.read();

    await renderer.writeAgentStreamEvent({ type: "text_delta", delta: "hello" });
    const began = output.read();
    assert.match(began, /out\u22482 tok \u00b7 0\.0s/);

    t.mock.timers.tick(2500);
    const ticked = output.read().slice(began.length);
    assert.match(ticked, /out\u22482 tok \u00b7 2\.5s/);
  } finally {
    t.mock.timers.reset();
  }
});

test("rich renderer shows the configured model and local badge before any turn", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
  });

  await renderer.writePromptStatus({
    allowEdits: false,
    useSession: true,
    modelName: "mock",
    local: true,
  });

  assert.match(output.read(), /model mock \(local\)/);
});

test("rich renderer shows the live turn model as soon as streaming starts", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
    tickIntervalMs: 60000,
  });

  await renderer.writePromptStatus({
    allowEdits: false,
    useSession: true,
    modelName: "configured",
  });
  await renderer.writePromptLine("CCAgent > ");
  const before = output.read().length;

  await renderer.writeAgentStreamEvent({
    type: "turn_start",
    kind: "user",
    modelName: "live-model",
    round: 0,
  });
  const started = output.read().slice(before);

  assert.match(started, /model live-model/);
  assert.doesNotMatch(started, /model configured/);

  await renderer.writeAgentStreamEvent({ type: "text_delta", delta: "hi" });
  const streamed = output.read().slice(before + started.length);

  assert.match(streamed, /model live-model/);
});

test("rich renderer ignores resize events before the status bar is active", async () => {
  const output = captureStream();
  const stream = output.stream as Writable & {
    isTTY?: boolean;
    on?: (event: string, listener: () => void) => unknown;
  };

  let onResize: (() => void) | undefined;
  stream.isTTY = true;
  stream.on = (event, listener) => {
    if (event === "resize") {
      onResize = listener;
    }
  };

  createRichRenderer(stream, { theme: createRichTheme(false) });
  onResize?.();
  assert.equal(output.read(), "");
});

test("rich renderer draws a dim shortcut hints line above the prompt", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(true),
    tickIntervalMs: 60000,
  });

  await renderer.writePromptStatus({
    allowEdits: false,
    useSession: true,
    hints: ["/help", "/model"],
  });
  await renderer.writePromptLine("CCAgent > ");

  const text = output.read();

  assert.match(text, /\x1b\[2m \/help  \/model \x1b\[0m\n/);
  assert.match(text, /CCAgent > \n/);
  assert.ok(text.endsWith("\x1b[1A\x1b[10C"));
});

test("rich renderer redraws the pinned hints line in place while typing", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
    tickIntervalMs: 60000,
  });

  await renderer.writePromptStatus({
    allowEdits: false,
    useSession: true,
    hints: ["/help"],
  });
  await renderer.writePromptLine("CCAgent > ");
  const before = output.read().length;

  renderer.redrawHints(["/he", "/help", "/hello"]);
  assert.equal(output.read().slice(before), "\x1b7\x1b[1A\r\x1b[2K /he  /help  /hello \x1b8");

  renderer.redrawHints([]);
  assert.ok(output.read().endsWith("\x1b7\x1b[1A\r\x1b[2K\x1b8"));
});

test("rich renderer ignores hint redraws while no prompt is pinned", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 60,
    theme: createRichTheme(false),
  });

  await renderer.writePromptStatus({
    allowEdits: false,
    useSession: true,
    hints: ["/help"],
  });
  const before = output.read();

  renderer.redrawHints(["/help", "/model"]);
  assert.equal(output.read(), before);
});

test("rich renderer repaints the hints line together with the bar on resize", async () => {
  const output = captureStream();
  const stream = output.stream as Writable & {
    columns?: number;
    isTTY?: boolean;
    on?: (event: string, listener: () => void) => unknown;
  };

  let onResize: (() => void) | undefined;
  stream.isTTY = true;
  stream.on = (event, listener) => {
    if (event === "resize") {
      onResize = listener;
    }
  };
  stream.columns = 60;

  const renderer = createRichRenderer(stream, { theme: createRichTheme(false) });
  await renderer.writePromptStatus({
    allowEdits: false,
    useSession: true,
    hints: ["/help"],
  });
  await renderer.writePromptLine("CCAgent > ");
  output.read();

  stream.columns = 50;
  onResize?.();
  const resized = output.read();

  assert.match(resized, /\x1b7\x1b\[1A\r\x1b\[2K \/help \x1b\[2B\r\x1b\[2K/);
  assert.ok(resized.endsWith("\x1b8"));
});

test("rich renderer colors badge states and the live token spinner", async () => {
  const output = captureStream();
  const renderer = createRichRenderer(output.stream, {
    columns: 70,
    theme: createRichTheme(true),
    tickIntervalMs: 60000,
  });

  await renderer.writePromptStatus({
    allowEdits: true,
    useSession: false,
    modelName: "mock",
    local: true,
  });
  await renderer.writePromptLine("CCAgent > ");
  const before = output.read().length;

  await renderer.writeAgentStreamEvent({ type: "text_delta", delta: "hi" });
  const streamed = output.read().slice(before);

  assert.match(streamed, /\x1b\[90m \(local\)\x1b\[0m/);
  assert.match(streamed, /\x1b\[32medits=auto-approve\x1b\[0m/);
  assert.match(streamed, /\x1b\[33msession=off\x1b\[0m/);
  assert.match(streamed, /\x1b\[36m[\u2800-\u28ff] out\u2248\d+ tok\x1b\[0m/);
  assert.match(streamed, /\x1b\[36m\d+\.\ds\x1b\[0m/);
});

test("rich renderer advances the braille spinner with the live timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000000 });

  try {
    const output = captureStream();
    const renderer = createRichRenderer(output.stream, {
      columns: 60,
      theme: createRichTheme(false),
      tickIntervalMs: 500,
    });

    await renderer.writePromptStatus({ allowEdits: false, useSession: true });
    await renderer.writePromptLine("CCAgent > ");
    output.read();

    await renderer.writeAgentStreamEvent({ type: "text_delta", delta: "hello" });
    const began = output.read();
    assert.match(began, /\u280b out\u22482 tok \u00b7 0\.0s/);

    t.mock.timers.tick(1500);
    const ticked = output.read().slice(began.length);
    assert.match(ticked, /\u2838 out\u22482 tok \u00b7 1\.5s/);
  } finally {
    t.mock.timers.reset();
  }
});
