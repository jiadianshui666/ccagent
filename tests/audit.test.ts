import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addUsageStats,
  createUsageStats,
  exportAuditData,
  exportAuditReport,
  FileAuditLogger,
  formatAuditCall,
  formatAuditReplay,
  formatAuditSummary,
  formatAuditTimeline,
  formatModelTrace,
  formatProjectCommandHistory,
  formatProjectCommandStats,
  formatRecentToolAudit,
  formatUsageModels,
  formatUsageSummary,
  getToolAuditLogPath,
  type AuditLogger,
  type ToolAuditEvent,
} from "../src/audit.js";
import { Agent } from "../src/agent.js";
import { MockModelClient } from "../src/model.js";

class MemoryAuditLogger implements AuditLogger {
  readonly events: ToolAuditEvent[] = [];

  async record(event: ToolAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

function isToolExecutionAuditEvent(
  event: ToolAuditEvent,
): event is Extract<
  ToolAuditEvent,
  { type: "tool_preflight" | "tool_start" | "tool_approval" | "tool_finish" }
> {
  return (
    event.type === "tool_preflight" ||
    event.type === "tool_start" ||
    event.type === "tool_approval" ||
    event.type === "tool_finish"
  );
}

function isModelTurnAuditEvent(
  event: ToolAuditEvent,
): event is Extract<ToolAuditEvent, { type: "model_turn" }> {
  return event.type === "model_turn";
}

function getExportPath(output: string): string {
  const match = output.match(/^Path: (.+)$/m);
  assert.ok(match, output);

  return match[1] ?? "";
}

test("FileAuditLogger appends tool audit events as JSON Lines", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-file-"));

  try {
    const logger = new FileAuditLogger(workspaceRoot);
    const timestamp = "2026-01-02T03:04:05.000Z";

    await logger.record({
      type: "tool_start",
      timestamp,
      callId: "call-read-1",
      toolName: "read_file",
      inputSummary: '{"path":"package.json"}',
    });

    const logPath = getToolAuditLogPath(workspaceRoot, new Date(timestamp));
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    const event = JSON.parse(lines[0] ?? "{}") as ToolAuditEvent;

    assert.equal(lines.length, 1);
    assert.equal(event.type, "tool_start");
    assert.equal(event.callId, "call-read-1");
    assert.equal(event.toolName, "read_file");
    assert.equal(event.timestamp, timestamp);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("FileAuditLogger redacts secrets from persisted events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-redact-"));

  try {
    const logger = new FileAuditLogger(workspaceRoot);
    const timestamp = "2026-01-02T03:04:05.000Z";

    await logger.record({
      type: "tool_start",
      timestamp,
      callId: "call-redact-1",
      toolName: "run_shell",
      inputSummary: '{"command":"export OPENAI_API_KEY=sk-audit-secret-abcdef1234567890"}',
    });

    const logPath = getToolAuditLogPath(workspaceRoot, new Date(timestamp));
    const raw = await readFile(logPath, "utf8");

    assert.doesNotMatch(raw, /sk-audit-secret/);
    assert.match(raw, /redacted/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatRecentToolAudit reports missing logs and invalid limits", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-format-empty-"));

  try {
    assert.equal(
      await formatRecentToolAudit(workspaceRoot),
      "No tool audit logs found in .ccagent/logs/.",
    );
    assert.match(await formatRecentToolAudit(workspaceRoot, 0), /count must be between 1 and 100/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatRecentToolAudit shows recent events from the latest log", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-format-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "tool_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        toolName: "older_tool",
        inputSummary: "{}",
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          inputSummary: '{"path":"package.json"}',
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:01.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "approved",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:02.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          ok: false,
          summary: "denied",
        }),
        "not-json",
      ].join("\n"),
    );

    const output = await formatRecentToolAudit(workspaceRoot, 2);

    assert.match(output, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(output, /Showing last 2 event\(s\) of 3\./);
    assert.match(output, /Skipped 1 invalid line\(s\)\./);
    assert.match(output, /approval apply_patch callId=call-patch-1 status=approved/);
    assert.match(output, /finish\s+apply_patch callId=call-patch-1 failed denied/);
    assert.doesNotMatch(output, /older_tool/);
    assert.doesNotMatch(output, /read_file input/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatRecentToolAudit can read all audit logs", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-format-all-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "tool_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        toolName: "older_tool",
        inputSummary: "{}",
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      `${JSON.stringify({
        type: "tool_finish",
        timestamp: "2026-01-02T00:00:00.000Z",
        toolName: "read_file",
        ok: true,
        summary: "ok",
      })}\n`,
    );

    const latest = await formatRecentToolAudit(workspaceRoot);
    const all = await formatRecentToolAudit(workspaceRoot, { all: true });

    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Showing last 1 event\(s\) of 1\./);
    assert.doesNotMatch(latest, /older_tool/);
    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /Showing last 2 event\(s\) of 2\./);
    assert.match(all, /start\s+older_tool/);
    assert.match(all, /finish\s+read_file ok ok/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatRecentToolAudit can export audit events as JSON Lines", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-format-jsonl-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "tool_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        toolName: "older_tool",
        inputSummary: "{}",
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          inputSummary: '{"path":"package.json"}',
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:01.000Z",
          toolName: "read_file",
          ok: true,
          summary: "ok",
        }),
      ].join("\n"),
    );

    const latest = await formatRecentToolAudit(workspaceRoot, { jsonl: true });
    const all = await formatRecentToolAudit(workspaceRoot, {
      all: true,
      jsonl: true,
      limit: 2,
    });
    const latestEvents = latest.split("\n").map((line) => JSON.parse(line) as ToolAuditEvent);
    const allEvents = all.split("\n").map((line) => JSON.parse(line) as ToolAuditEvent);

    assert.doesNotMatch(latest, /Tool audit log/);
    assert.equal(latestEvents.length, 2);
    assert.equal(latestEvents[0]?.type, "tool_start");
    assert.equal(latestEvents[0]?.type === "tool_start" ? latestEvents[0].toolName : "", "read_file");
    assert.deepEqual(
      allEvents.map((event) => (event.type === "tool_start" ? event.toolName : event.type)),
      ["read_file", "tool_finish"],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatRecentToolAudit shows project command events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-command-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      `${JSON.stringify({
        type: "project_command",
        timestamp: "2026-01-02T00:00:00.000Z",
        action: "preview",
        commandName: "review",
        requestedName: "r",
        args: "src/agent.ts",
        status: "shown",
        summary: "Expanded project command preview shown.",
      })}\n`,
    );

    const output = await formatRecentToolAudit(workspaceRoot, 1);

    assert.match(output, /command\s+preview review status=shown/);
    assert.match(output, /requested=r/);
    assert.match(output, /args="src\/agent\.ts"/);
    assert.match(output, /Expanded project command preview shown\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatAuditReplay formats recent audit events as a replay", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-replay-"));
  const emptyWorkspace = await mkdtemp(join(tmpdir(), "ccagent-audit-replay-empty-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "tool_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        toolName: "older_tool",
        inputSummary: "{}",
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          inputSummary: '{"path":"package.json"}',
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:01.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "approved",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:02.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          ok: true,
          summary: "patched",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:03.000Z",
          action: "preview",
          commandName: "review",
          requestedName: "r",
          args: "src/agent.ts",
          status: "shown",
          summary: "Expanded project command preview shown.",
        }),
        "not-json",
      ].join("\n"),
    );

    const latest = await formatAuditReplay(workspaceRoot, { limit: 4 });
    const all = await formatAuditReplay(workspaceRoot, { all: true });
    const missing = await formatAuditReplay(emptyWorkspace);
    const invalidLimit = await formatAuditReplay(workspaceRoot, { limit: 0 });

    assert.match(latest, /Audit replay/);
    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Replaying last 4 event\(s\) of 4\./);
    assert.match(latest, /Skipped 1 invalid line\(s\)\./);
    assert.match(latest, /1\. .* tool read_file callId=call-read-1 started with input=\{"path":"package\.json"\}/);
    assert.match(latest, /2\. .* tool apply_patch callId=call-patch-1 approval approved/);
    assert.match(latest, /3\. .* tool apply_patch callId=call-patch-1 finished ok summary=patched/);
    assert.match(latest, /4\. .* project command review preview shown requested=r args="src\/agent\.ts"/);
    assert.doesNotMatch(latest, /older_tool/);
    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /older_tool/);
    assert.equal(missing, "No audit logs found in .ccagent/logs/.");
    assert.match(invalidLimit, /count must be between 1 and 100/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(emptyWorkspace, { recursive: true, force: true });
  }
});

test("formatAuditTimeline groups audit events into tool-call steps", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-timeline-"));
  const emptyWorkspace = await mkdtemp(join(tmpdir(), "ccagent-audit-timeline-empty-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-01T00:00:00.000Z",
          callId: "call-old-1",
          toolName: "older_tool",
          inputSummary: "{}",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-01T00:00:00.500Z",
          callId: "call-old-1",
          toolName: "older_tool",
          ok: true,
          summary: "ok",
        }),
      ].join("\n"),
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          inputSummary: '{"path":"package.json"}',
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:00.250Z",
          callId: "call-read-1",
          toolName: "read_file",
          ok: true,
          summary: "ok",
        }),
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:01.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          inputSummary: '{"patch":"demo"}',
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:02.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "required",
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:03.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "denied",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:04.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          ok: false,
          summary: "denied",
        }),
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:05.000Z",
          callId: "call-shell-1",
          toolName: "run_shell",
          inputSummary: '{"command":"npm test"}',
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:06.000Z",
          action: "preview",
          commandName: "review",
          requestedName: "r",
          args: "src/agent.ts",
          status: "shown",
          summary: "Expanded project command preview shown.",
        }),
        "not-json",
      ].join("\n"),
    );

    const latest = await formatAuditTimeline(workspaceRoot, { limit: 4 });
    const limited = await formatAuditTimeline(workspaceRoot, { limit: 2 });
    const all = await formatAuditTimeline(workspaceRoot, { all: true });
    const missing = await formatAuditTimeline(emptyWorkspace);
    const invalidLimit = await formatAuditTimeline(workspaceRoot, { limit: 0 });

    assert.match(latest, /Audit timeline/);
    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Showing last 4 item\(s\) of 4\./);
    assert.match(latest, /Skipped 1 invalid line\(s\)\./);
    assert.match(
      latest,
      /1\. tool read_file callId=call-read-1 succeeded duration=250ms events=2 approvals=required:0 approved:0 denied:0 input=\{"path":"package\.json"\} summary=ok/,
    );
    assert.match(
      latest,
      /2\. tool apply_patch callId=call-patch-1 failed duration=3000ms events=4 approvals=required:1 approved:0 denied:1 input=\{"patch":"demo"\} summary=denied/,
    );
    assert.match(
      latest,
      /3\. tool run_shell callId=call-shell-1 pending duration=n\/a events=1 approvals=required:0 approved:0 denied:0 input=\{"command":"npm test"\}/,
    );
    assert.match(
      latest,
      /4\. command review preview shown requested=r args="src\/agent\.ts" summary=Expanded project command preview shown\./,
    );
    assert.match(limited, /Showing last 2 item\(s\) of 4\./);
    assert.doesNotMatch(limited, /read_file/);
    assert.match(limited, /run_shell/);
    assert.match(limited, /command review/);
    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /older_tool callId=call-old-1 succeeded duration=500ms/);
    assert.equal(missing, "No audit logs found in .ccagent/logs/.");
    assert.match(invalidLimit, /count must be between 1 and 100/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(emptyWorkspace, { recursive: true, force: true });
  }
});

test("formatModelTrace shows model turn audit events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-model-trace-"));
  const emptyWorkspace = await mkdtemp(join(tmpdir(), "ccagent-model-trace-empty-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const previousInputPrice = process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS;
  const previousOutputPrice = process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS;

  try {
    process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS = "2";
    process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS = "10";
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "model_turn",
        timestamp: "2026-01-01T00:00:00.000Z",
        contentLength: 0,
        durationMs: 5,
        kind: "user",
        modelName: "mock",
        responseId: "mock-old",
        round: 0,
        streamedText: false,
        toolCalls: ["search_files"],
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "model_turn",
          timestamp: "2026-01-02T00:00:00.000Z",
          contentLength: 0,
          durationMs: 42,
          kind: "user",
          modelName: "mock",
          responseId: "mock-needs-list",
          round: 0,
          streamedText: false,
          toolCalls: ["list_files"],
          usageEstimated: true,
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          cachedInputTokens: 3,
        }),
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.010Z",
          callId: "mock-list-files-1",
          toolName: "list_files",
          inputSummary: "{}",
        }),
        JSON.stringify({
          type: "model_turn",
          timestamp: "2026-01-02T00:00:01.000Z",
          contentLength: 20,
          durationMs: 11,
          kind: "tool_outputs",
          modelName: "mock",
          previousResponseId: "mock-needs-list",
          responseId: "mock-final",
          round: 1,
          streamedText: true,
          toolCalls: [],
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        }),
        "not-json",
      ].join("\n"),
    );

    const latest = await formatModelTrace(workspaceRoot);
    const limited = await formatModelTrace(workspaceRoot, { limit: 1 });
    const all = await formatModelTrace(workspaceRoot, { all: true });
    const missingLogs = await formatModelTrace(emptyWorkspace);
    const invalidLimit = await formatModelTrace(workspaceRoot, { limit: 0 });

    assert.match(latest, /Model trace/);
    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Showing last 2 turn\(s\) of 2\./);
    assert.match(latest, /Skipped 1 invalid line\(s\)\./);
    assert.match(
      latest,
      /1\. 2026-01-02T00:00:00\.000Z user\s+round=0 model=mock duration=42ms content=0 streamed=no tokens=in=12,out=4,total=16,cached=3,estimated=yes cost=~\$0\.000064 previous=\(none\) response=mock-needs-list toolCalls=list_files/,
    );
    assert.match(
      latest,
      /2\. 2026-01-02T00:00:01\.000Z tool_outputs round=1 model=mock duration=11ms content=20 streamed=yes tokens=in=100,out=50,total=150 cost=~\$0\.000700 previous=mock-needs-list response=mock-final toolCalls=\(none\)/,
    );
    assert.match(limited, /Showing last 1 turn\(s\) of 2\./);
    assert.doesNotMatch(limited, /mock-needs-list toolCalls=list_files/);
    assert.match(limited, /mock-final/);
    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /mock-old/);
    assert.match(all, /tokens=\(unknown\).*cost=\(not configured\).*response=mock-old/);
    assert.equal(missingLogs, "No audit logs found in .ccagent/logs/.");
    assert.match(invalidLimit, /count must be between 1 and 100/);
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

    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(emptyWorkspace, { recursive: true, force: true });
  }
});

test("formatUsageSummary summarizes model token usage and cost", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-usage-summary-"));
  const emptyWorkspace = await mkdtemp(join(tmpdir(), "ccagent-usage-summary-empty-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const previousInputPrice = process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS;
  const previousOutputPrice = process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS;
  const previousMaxTotalTokens = process.env.CCAGENT_MAX_TOTAL_TOKENS;
  const previousMaxCostUsd = process.env.CCAGENT_MAX_COST_USD;

  try {
    process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS = "2";
    process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS = "10";
    delete process.env.CCAGENT_MAX_TOTAL_TOKENS;
    delete process.env.CCAGENT_MAX_COST_USD;
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "model_turn",
        timestamp: "2026-01-01T00:00:00.000Z",
        contentLength: 10,
        durationMs: 5,
        kind: "user",
        modelName: "old-model",
        responseId: "old-response",
        round: 0,
        streamedText: false,
        toolCalls: [],
        inputTokens: 5,
        outputTokens: 6,
        totalTokens: 11,
        cachedInputTokens: 1,
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "model_turn",
          timestamp: "2026-01-02T00:00:00.000Z",
          contentLength: 0,
          durationMs: 42,
          kind: "user",
          modelName: "relay-model",
          responseId: "needs-list",
          round: 0,
          streamedText: false,
          toolCalls: ["list_files"],
          usageEstimated: true,
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          cachedInputTokens: 3,
        }),
        JSON.stringify({
          type: "model_turn",
          timestamp: "2026-01-02T00:00:01.000Z",
          contentLength: 20,
          durationMs: 11,
          kind: "tool_outputs",
          modelName: "relay-model",
          previousResponseId: "needs-list",
          responseId: "final",
          round: 1,
          streamedText: true,
          toolCalls: [],
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        }),
        JSON.stringify({
          type: "model_turn",
          timestamp: "2026-01-02T00:00:02.000Z",
          contentLength: 5,
          durationMs: 3,
          kind: "user",
          modelName: "other-model",
          responseId: "unknown-usage",
          round: 0,
          streamedText: false,
          toolCalls: [],
        }),
        "not-json",
      ].join("\n"),
    );

    const latest = await formatUsageSummary(workspaceRoot);
    const all = await formatUsageSummary(workspaceRoot, { all: true });
    const missingLogs = await formatUsageSummary(emptyWorkspace);
    const latestModels = await formatUsageModels(workspaceRoot);
    const allModels = await formatUsageModels(workspaceRoot, { all: true });
    const missingModelLogs = await formatUsageModels(emptyWorkspace);

    assert.match(latest, /Usage summary/);
    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Model turns: 3/);
    assert.match(latest, /Turns with token usage: 2/);
    assert.match(latest, /Estimated token turns: 1/);
    assert.match(latest, /Input tokens: 112/);
    assert.match(latest, /Output tokens: 54/);
    assert.match(latest, /Total tokens: 166/);
    assert.match(latest, /Cached input tokens: 3/);
    assert.match(latest, /Cost: ~\$0\.000764 \(2 costed turn\(s\)\)/);
    assert.match(latest, /Budget: \(not configured\)/);
    assert.match(latest, /Average total tokens \/ tokenized turn: 83\.00/);
    assert.match(latest, /Average cost \/ costed turn: ~\$0\.000382/);
    assert.match(latest, /Skipped 1 invalid line\(s\)\./);
    assert.match(
      latest,
      /- relay-model: turns=2 tokenized=2 tokens=in=112,out=54,total=166,cached=3 estimated=1 cost=~\$0\.000764/,
    );
    assert.match(
      latest,
      /- other-model: turns=1 tokenized=0 tokens=in=0,out=0,total=0,cached=0 estimated=0 cost=~\$0\.000000/,
    );
    assert.doesNotMatch(latest, /old-model/);

    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /Model turns: 4/);
    assert.match(all, /Turns with token usage: 3/);
    assert.match(all, /Input tokens: 117/);
    assert.match(all, /Output tokens: 60/);
    assert.match(all, /Total tokens: 177/);
    assert.match(all, /Cached input tokens: 4/);
    assert.match(all, /Cost: ~\$0\.000834 \(3 costed turn\(s\)\)/);
    assert.match(all, /Average total tokens \/ tokenized turn: 59\.00/);
    assert.match(all, /Average cost \/ costed turn: ~\$0\.000278/);
    assert.match(all, /old-model/);
    assert.equal(missingLogs, "No audit logs found in .ccagent/logs/.");

    assert.match(latestModels, /Usage models/);
    assert.match(latestModels, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latestModels, /Models: 2/);
    assert.match(latestModels, /Model turns: 3/);
    assert.match(latestModels, /Turns with token usage: 2/);
    assert.match(latestModels, /Cost: ~\$0\.000764 \(2 costed turn\(s\)\)/);
    assert.match(latestModels, /Budget: \(not configured\)/);
    assert.match(latestModels, /Skipped 1 invalid line\(s\)\./);
    assert.match(
      latestModels,
      /- relay-model: turns=2 tokenized=2 estimated=1 costed=2 tokens=in=112,out=54,total=166,cached=3 avgTotal=83\.00 avgCost=~\$0\.000382 cost=~\$0\.000764/,
    );
    assert.match(
      latestModels,
      /- other-model: turns=1 tokenized=0 estimated=0 costed=0 tokens=in=0,out=0,total=0,cached=0 avgTotal=n\/a avgCost=n\/a cost=~\$0\.000000/,
    );
    assert.doesNotMatch(latestModels, /old-model/);

    assert.match(allModels, /Scope: all logs/);
    assert.match(allModels, /Files: 2/);
    assert.match(allModels, /Models: 3/);
    assert.match(allModels, /Model turns: 4/);
    assert.match(allModels, /Turns with token usage: 3/);
    assert.match(allModels, /Cost: ~\$0\.000834 \(3 costed turn\(s\)\)/);
    assert.match(allModels, /old-model/);
    assert.equal(missingModelLogs, "No audit logs found in .ccagent/logs/.");

    process.env.CCAGENT_MAX_TOTAL_TOKENS = "200";
    process.env.CCAGENT_MAX_COST_USD = "0.001";

    const budgetOk = await formatUsageSummary(workspaceRoot);
    const modelBudgetOk = await formatUsageModels(workspaceRoot);

    assert.match(
      budgetOk,
      /Budget: ok totalTokens=166\/200 cost=~\$0\.000764\/\$0\.001000/,
    );
    assert.match(
      modelBudgetOk,
      /Budget: ok totalTokens=166\/200 cost=~\$0\.000764\/\$0\.001000/,
    );

    process.env.CCAGENT_MAX_TOTAL_TOKENS = "100";
    process.env.CCAGENT_MAX_COST_USD = "0.0007";

    const budgetExceeded = await formatUsageSummary(workspaceRoot);
    const modelBudgetExceeded = await formatUsageModels(workspaceRoot);

    assert.match(
      budgetExceeded,
      /Budget: exceeded totalTokens=166\/100 cost=~\$0\.000764\/\$0\.000700/,
    );
    assert.match(
      modelBudgetExceeded,
      /Budget: exceeded totalTokens=166\/100 cost=~\$0\.000764\/\$0\.000700/,
    );

    process.env.CCAGENT_MAX_TOTAL_TOKENS = "not-a-number";

    assert.match(
      await formatUsageSummary(workspaceRoot),
      /Budget: invalid CCAGENT_MAX_TOTAL_TOKENS/,
    );
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
    await rm(emptyWorkspace, { recursive: true, force: true });
  }
});

test("formatAuditCall filters audit events by callId", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-call-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "tool_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        callId: "call-old-1",
        toolName: "older_tool",
        inputSummary: "{}",
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          inputSummary: '{"patch":"demo"}',
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:01.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "required",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:02.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          ok: true,
          summary: "patched",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:03.000Z",
          action: "preview",
          commandName: "review",
          requestedName: "r",
          args: "src/agent.ts",
          status: "shown",
          summary: "Expanded project command preview shown.",
        }),
      ].join("\n"),
    );

    const latest = await formatAuditCall(workspaceRoot, { callId: "call-patch-1" });
    const all = await formatAuditCall(workspaceRoot, { all: true, callId: "call-old-1" });
    const missing = await formatAuditCall(workspaceRoot, { callId: "missing-call" });
    const usage = await formatAuditCall(workspaceRoot);

    assert.match(latest, /Audit call/);
    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Call ID: call-patch-1/);
    assert.match(latest, /Events: 3/);
    assert.match(latest, /start\s+apply_patch callId=call-patch-1/);
    assert.match(latest, /approval apply_patch callId=call-patch-1 status=required/);
    assert.match(latest, /finish\s+apply_patch callId=call-patch-1 ok patched/);
    assert.doesNotMatch(latest, /project command/);
    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /older_tool callId=call-old-1/);
    assert.match(missing, /\(No audit events matched this callId\.\)/);
    assert.equal(usage, "Usage: /audit-call [--all] <callId>");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatAuditSummary summarizes tool calls by callId", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-summary-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-01T00:00:00.000Z",
          callId: "call-old-1",
          toolName: "search_files",
          inputSummary: '{"query":"Agent"}',
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-01T00:00:01.000Z",
          callId: "call-old-1",
          toolName: "search_files",
          ok: true,
          summary: "ok",
        }),
      ].join("\n"),
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          inputSummary: '{"path":"package.json"}',
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:01.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          ok: true,
          summary: "ok",
        }),
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:02.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          inputSummary: '{"patch":"demo"}',
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:03.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "required",
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:04.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "denied",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:05.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          ok: false,
          summary: "denied",
        }),
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:06.000Z",
          callId: "call-shell-1",
          toolName: "run_shell",
          inputSummary: '{"command":"npm test"}',
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:07.000Z",
          action: "preview",
          commandName: "review",
          requestedName: "r",
          args: "src/agent.ts",
          status: "shown",
          summary: "Expanded project command preview shown.",
        }),
        "not-json",
      ].join("\n"),
    );

    const latest = await formatAuditSummary(workspaceRoot);
    const all = await formatAuditSummary(workspaceRoot, { all: true });

    assert.match(latest, /Audit summary/);
    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Tool calls: 3/);
    assert.match(latest, /Succeeded: 1/);
    assert.match(latest, /Failed: 1/);
    assert.match(latest, /Pending: 1/);
    assert.match(latest, /Approval events: required=1 approved=0 denied=1/);
    assert.match(latest, /Uncorrelated events: 0/);
    assert.match(latest, /Skipped 1 invalid line\(s\)\./);
    assert.match(
      latest,
      /apply_patch: calls=1 succeeded=0 failed=1 pending=0 approvals=1 denied=1 last=2026-01-02T00:00:05\.000Z/,
    );
    assert.match(
      latest,
      /read_file: calls=1 succeeded=1 failed=0 pending=0 approvals=0 denied=0 last=2026-01-02T00:00:01\.000Z/,
    );
    assert.match(
      latest,
      /run_shell: calls=1 succeeded=0 failed=0 pending=1 approvals=0 denied=0 last=2026-01-02T00:00:06\.000Z/,
    );
    assert.doesNotMatch(latest, /search_files/);
    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /Tool calls: 4/);
    assert.match(all, /Succeeded: 2/);
    assert.match(all, /search_files: calls=1 succeeded=1/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("exportAuditData writes audit summary JSON", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-export-summary-"));
  const emptyWorkspace = await mkdtemp(join(tmpdir(), "ccagent-audit-export-empty-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          inputSummary: '{"path":"package.json"}',
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:01.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          ok: true,
          summary: "ok",
        }),
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:02.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          inputSummary: '{"patch":"demo"}',
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:03.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "required",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:04.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          ok: false,
          summary: "denied",
        }),
        "not-json",
      ].join("\n"),
    );

    const output = await exportAuditData(workspaceRoot, { kind: "summary" });
    const exportPath = getExportPath(output);
    const payload = JSON.parse(await readFile(join(workspaceRoot, exportPath), "utf8")) as {
      files: string[];
      invalidLines: number;
      kind: string;
      scope: string;
      summary: {
        approvalEvents: {
          approved: number;
          denied: number;
          required: number;
        };
        calls: number;
        failed: number;
        pending: number;
        succeeded: number;
        tools: Array<{
          calls: number;
          failed: number;
          pending: number;
          succeeded: number;
          toolName: string;
        }>;
      };
    };
    const missing = await exportAuditData(emptyWorkspace, { kind: "summary" });

    assert.match(output, /Exported audit summary/);
    assert.match(exportPath, /^\.ccagent\/exports\/audit-summary-.+\.json$/);
    assert.equal(payload.kind, "summary");
    assert.equal(payload.scope, "latest");
    assert.deepEqual(payload.files, [".ccagent/logs/tool-audit-2026-01-02.jsonl"]);
    assert.equal(payload.invalidLines, 1);
    assert.equal(payload.summary.calls, 2);
    assert.equal(payload.summary.succeeded, 1);
    assert.equal(payload.summary.failed, 1);
    assert.equal(payload.summary.pending, 0);
    assert.deepEqual(payload.summary.approvalEvents, {
      required: 1,
      approved: 0,
      denied: 0,
    });
    assert.deepEqual(
      payload.summary.tools.map((tool) => `${tool.toolName}:${tool.calls}:${tool.succeeded}:${tool.failed}`),
      ["apply_patch:1:0:1", "read_file:1:1:0"],
    );
    assert.equal(missing, "No audit logs found in .ccagent/logs/.");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(emptyWorkspace, { recursive: true, force: true });
  }
});

test("exportAuditData writes call-level audit JSON", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-export-call-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "tool_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        callId: "call-old-1",
        toolName: "search_files",
        inputSummary: '{"query":"Agent"}',
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          inputSummary: '{"path":"package.json"}',
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:01.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          status: "approved",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:02.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          ok: true,
          summary: "ok",
        }),
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:03.000Z",
          callId: "call-other-1",
          toolName: "list_files",
          inputSummary: "{}",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:04.000Z",
          action: "preview",
          commandName: "review",
          requestedName: "r",
          args: "src/agent.ts",
          status: "shown",
          summary: "Expanded project command preview shown.",
        }),
      ].join("\n"),
    );

    const output = await exportAuditData(workspaceRoot, {
      callId: "call-read-1",
      kind: "call",
    });
    const allOutput = await exportAuditData(workspaceRoot, {
      all: true,
      callId: "call-old-1",
      kind: "call",
    });
    const exportPath = getExportPath(output);
    const allExportPath = getExportPath(allOutput);
    const payload = JSON.parse(await readFile(join(workspaceRoot, exportPath), "utf8")) as {
      callId: string;
      events: ToolAuditEvent[];
      files: string[];
      kind: string;
      scope: string;
    };
    const allPayload = JSON.parse(await readFile(join(workspaceRoot, allExportPath), "utf8")) as {
      events: ToolAuditEvent[];
      files: string[];
      scope: string;
    };
    const usage = await exportAuditData(workspaceRoot, { kind: "call" });

    assert.match(output, /Exported audit call/);
    assert.match(exportPath, /^\.ccagent\/exports\/audit-call-call-read-1-.+\.json$/);
    assert.equal(payload.kind, "call");
    assert.equal(payload.scope, "latest");
    assert.deepEqual(payload.files, [".ccagent/logs/tool-audit-2026-01-02.jsonl"]);
    assert.equal(payload.callId, "call-read-1");
    assert.equal(payload.events.length, 3);
    assert.deepEqual(
      payload.events.map((event) => (event.type === "project_command" ? "" : event.callId)),
      ["call-read-1", "call-read-1", "call-read-1"],
    );
    assert.equal(allPayload.scope, "all");
    assert.deepEqual(allPayload.files, [
      ".ccagent/logs/tool-audit-2026-01-01.jsonl",
      ".ccagent/logs/tool-audit-2026-01-02.jsonl",
    ]);
    assert.equal(allPayload.events.length, 1);
    assert.match(usage, /Usage: \/audit-export summary \[--all\]/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("exportAuditReport writes a readable Markdown report", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-report-"));
  const emptyWorkspace = await mkdtemp(join(tmpdir(), "ccagent-audit-report-empty-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "tool_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        callId: "call-old-1",
        toolName: "search_files",
        inputSummary: '{"query":"Agent"}',
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          inputSummary: '{"path":"package.json"}',
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:01.000Z",
          callId: "call-read-1",
          toolName: "read_file",
          ok: true,
          summary: "ok",
        }),
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:02.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          inputSummary: '{"patch":"demo"}',
        }),
        JSON.stringify({
          type: "tool_approval",
          timestamp: "2026-01-02T00:00:03.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          status: "denied",
        }),
        JSON.stringify({
          type: "tool_finish",
          timestamp: "2026-01-02T00:00:04.000Z",
          callId: "call-patch-1",
          toolName: "apply_patch",
          ok: false,
          summary: "denied",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:05.000Z",
          action: "preview",
          commandName: "review",
          requestedName: "r",
          args: "src/agent.ts",
          status: "shown",
          summary: "Expanded project command preview shown.",
        }),
        "not-json",
      ].join("\n"),
    );

    const latestOutput = await exportAuditReport(workspaceRoot);
    const allOutput = await exportAuditReport(workspaceRoot, { all: true });
    const latestPath = getExportPath(latestOutput);
    const allPath = getExportPath(allOutput);
    const latestReport = await readFile(join(workspaceRoot, latestPath), "utf8");
    const allReport = await readFile(join(workspaceRoot, allPath), "utf8");
    const missing = await exportAuditReport(emptyWorkspace);

    assert.match(latestOutput, /Exported audit report/);
    assert.match(latestPath, /^\.ccagent\/reports\/audit-report-.+\.md$/);
    assert.match(latestReport, /# CCAgent Audit Report/);
    assert.match(latestReport, /Scope: latest log/);
    assert.match(latestReport, /Files: 1/);
    assert.match(latestReport, /Events: 6/);
    assert.match(latestReport, /Invalid lines skipped: 1/);
    assert.match(latestReport, /\| apply_patch \| 1 \| 0 \| 1 \| 0 \| 0 \| 1 \|/);
    assert.match(latestReport, /\| read_file \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
    assert.match(latestReport, /\| review \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 1 \|/);
    assert.match(latestReport, /## Recent Events/);
    assert.match(latestReport, /project command review preview shown/);
    assert.match(allReport, /Scope: all logs/);
    assert.match(allReport, /Files: 2/);
    assert.match(allReport, /search_files/);
    assert.equal(missing, "No audit logs found in .ccagent/logs/.");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(emptyWorkspace, { recursive: true, force: true });
  }
});

test("formatProjectCommandHistory filters project command events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-command-history-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          toolName: "read_file",
          inputSummary: "{}",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:01.000Z",
          action: "detail",
          commandName: "review",
          requestedName: "r",
          args: "",
          status: "shown",
          summary: "Project command details shown.",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:02.000Z",
          action: "run",
          commandName: "test",
          requestedName: "test",
          args: "",
          status: "started",
          summary: "Expanded project command sent to agent.",
        }),
      ].join("\n"),
    );

    const all = await formatProjectCommandHistory(workspaceRoot);
    const review = await formatProjectCommandHistory(workspaceRoot, { commandName: "review" });
    const alias = await formatProjectCommandHistory(workspaceRoot, { commandName: "r" });
    const invalidLimit = await formatProjectCommandHistory(workspaceRoot, { limit: 0 });

    assert.match(all, /Project command history/);
    assert.match(all, /Showing last 2 event\(s\) of 2\./);
    assert.match(all, /detail\s+review status=shown requested=r/);
    assert.match(all, /run\s+test status=started requested=test/);
    assert.match(review, /Filter: review/);
    assert.match(review, /Showing last 1 event\(s\) of 1\./);
    assert.doesNotMatch(review, /run\s+test/);
    assert.match(alias, /Filter: r/);
    assert.match(alias, /detail\s+review/);
    assert.match(invalidLimit, /count must be between 1 and 100/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatProjectCommandHistory shows named args and expanded prompt previews", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-command-history-args-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      `${JSON.stringify({
        type: "project_command",
        timestamp: "2026-01-02T00:00:01.000Z",
        action: "preview",
        commandName: "review",
        requestedName: "r",
        args: "--file src/agent.ts --topic security extra notes",
        namedArgs: {
          file: "src/agent.ts",
          topic: "security",
        },
        positionalArgs: "extra notes",
        expandedPromptPreview: "# Review src/agent.ts Focus: security Notes: extra notes",
        status: "shown",
        summary: "Expanded project command preview shown.",
      })}\n`,
    );

    const output = await formatProjectCommandHistory(workspaceRoot, { commandName: "review" });

    assert.match(output, /named=\{"file":"src\/agent\.ts","topic":"security"\}/);
    assert.match(output, /positional="extra notes"/);
    assert.match(output, /expanded="# Review src\/agent\.ts Focus: security Notes: extra notes"/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
test("formatProjectCommandHistory can read all audit logs", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-command-history-all-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "project_command",
        timestamp: "2026-01-01T00:00:01.000Z",
        action: "preview",
        commandName: "review",
        requestedName: "r",
        args: "src/agent.ts",
        status: "shown",
        summary: "Expanded project command preview shown.",
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      `${JSON.stringify({
        type: "project_command",
        timestamp: "2026-01-02T00:00:01.000Z",
        action: "run",
        commandName: "review",
        requestedName: "r",
        args: "",
        status: "blocked",
        summary: "Project command requires arguments: review",
      })}\n`,
    );

    const latest = await formatProjectCommandHistory(workspaceRoot, { commandName: "review" });
    const all = await formatProjectCommandHistory(workspaceRoot, {
      all: true,
      commandName: "review",
    });

    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Showing last 1 event\(s\) of 1\./);
    assert.doesNotMatch(latest, /preview\s+review/);
    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /Showing last 2 event\(s\) of 2\./);
    assert.match(all, /preview\s+review status=shown/);
    assert.match(all, /run\s+review status=blocked/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatProjectCommandStats summarizes project command events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-command-stats-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      [
        JSON.stringify({
          type: "tool_start",
          timestamp: "2026-01-02T00:00:00.000Z",
          toolName: "read_file",
          inputSummary: "{}",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:01.000Z",
          action: "detail",
          commandName: "review",
          requestedName: "r",
          args: "",
          status: "shown",
          summary: "Project command details shown.",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:02.000Z",
          action: "preview",
          commandName: "review",
          requestedName: "r",
          args: "src/agent.ts",
          status: "shown",
          summary: "Expanded project command preview shown.",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:03.000Z",
          action: "run",
          commandName: "review",
          requestedName: "r",
          args: "",
          status: "blocked",
          summary: "Project command requires arguments: review",
        }),
        JSON.stringify({
          type: "project_command",
          timestamp: "2026-01-02T00:00:04.000Z",
          action: "run",
          commandName: "test",
          requestedName: "test",
          args: "",
          status: "started",
          summary: "Expanded project command sent to agent.",
        }),
      ].join("\n"),
    );

    const output = await formatProjectCommandStats(workspaceRoot);

    assert.match(output, /Project command stats/);
    assert.match(output, /Commands: 2/);
    assert.match(output, /Events: 4/);
    assert.match(
      output,
      /review: total=3 detail=1 preview=1 run=1 started=0 blocked=1 denied=0 shown=2 last=2026-01-02T00:00:03\.000Z/,
    );
    assert.match(
      output,
      /test: total=1 detail=0 preview=0 run=1 started=1 blocked=0 denied=0 shown=0 last=2026-01-02T00:00:04\.000Z/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatProjectCommandStats can summarize all audit logs", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-command-stats-all-"));
  const logsDir = join(workspaceRoot, ".ccagent", "logs");

  try {
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "tool-audit-2026-01-01.jsonl"),
      `${JSON.stringify({
        type: "project_command",
        timestamp: "2026-01-01T00:00:01.000Z",
        action: "preview",
        commandName: "review",
        requestedName: "r",
        args: "src/agent.ts",
        status: "shown",
        summary: "Expanded project command preview shown.",
      })}\n`,
    );
    await writeFile(
      join(logsDir, "tool-audit-2026-01-02.jsonl"),
      `${JSON.stringify({
        type: "project_command",
        timestamp: "2026-01-02T00:00:01.000Z",
        action: "run",
        commandName: "review",
        requestedName: "r",
        args: "",
        status: "blocked",
        summary: "Project command requires arguments: review",
      })}\n`,
    );

    const latest = await formatProjectCommandStats(workspaceRoot);
    const all = await formatProjectCommandStats(workspaceRoot, { all: true });

    assert.match(latest, /Path: \.ccagent\/logs\/tool-audit-2026-01-02\.jsonl/);
    assert.match(latest, /Events: 1/);
    assert.match(latest, /review: total=1 detail=0 preview=0 run=1/);
    assert.match(all, /Scope: all logs/);
    assert.match(all, /Files: 2/);
    assert.match(all, /Events: 2/);
    assert.match(all, /review: total=2 detail=0 preview=1 run=1/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent audits successful tool execution", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-agent-"));
  const audit = new MemoryAuditLogger();

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {},
      audit,
    );

    await agent.handleUserMessage("list files");

    const toolEvents = audit.events.filter(isToolExecutionAuditEvent);
    const modelTurns = audit.events.filter(isModelTurnAuditEvent);

    assert.deepEqual(
      toolEvents.map((event) => `${event.type}:${event.toolName}`),
      ["tool_preflight:list_files", "tool_start:list_files", "tool_finish:list_files"],
    );
    assert.equal(toolEvents[0]?.type, "tool_preflight");
    assert.equal(
      toolEvents[0]?.type === "tool_preflight" ? toolEvents[0].callId : "",
      "mock-list-files-1",
    );
    assert.equal(
      toolEvents[0]?.type === "tool_preflight" ? toolEvents[0].risk : "",
      "low",
    );
    assert.equal(
      toolEvents[0]?.type === "tool_preflight" ? toolEvents[0].workspaceImpact : "",
      "read-only",
    );
    assert.equal(
      toolEvents[0]?.type === "tool_preflight" ? toolEvents[0].requiresApproval : true,
      false,
    );
    assert.equal(toolEvents[1]?.type, "tool_start");
    assert.equal(
      toolEvents[1]?.type === "tool_start" ? toolEvents[1].callId : "",
      "mock-list-files-1",
    );
    assert.equal(toolEvents[2]?.type, "tool_finish");
    assert.equal(
      toolEvents[2]?.type === "tool_finish" ? toolEvents[2].callId : "",
      toolEvents[0]?.type === "tool_preflight" ? toolEvents[0].callId : "",
    );
    assert.equal(
      toolEvents[2]?.type === "tool_finish" ? toolEvents[2].ok : false,
      true,
    );
    assert.equal(modelTurns.length, 2);
    assert.deepEqual(
      modelTurns.map((event) => `${event.kind}:${event.round}:${event.toolCalls.join(",")}`),
      ["user:0:list_files", "tool_outputs:1:"],
    );
    assert.equal(modelTurns.every((event) => event.usageEstimated), true);
    assert.equal(modelTurns.every((event) => typeof event.inputTokens === "number"), true);
    assert.equal(modelTurns.every((event) => typeof event.outputTokens === "number"), true);
    assert.equal(
      modelTurns.every(
        (event) =>
          event.totalTokens === (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
      ),
      true,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent audits approval decisions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-audit-approval-"));
  const audit = new MemoryAuditLogger();

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => false,
      undefined,
      undefined,
      {},
      audit,
    );

    await agent.handleUserMessage("patch note.txt hello");

    const toolEvents = audit.events.filter(isToolExecutionAuditEvent);
    const modelTurns = audit.events.filter(isModelTurnAuditEvent);

    assert.deepEqual(
      toolEvents.map((event) =>
        event.type === "tool_approval" ? `${event.type}:${event.status}` : event.type,
      ),
      [
        "tool_preflight",
        "tool_start",
        "tool_approval:required",
        "tool_approval:denied",
        "tool_finish",
      ],
    );
    const callIds = toolEvents.map((event) => event.callId);

    assert.deepEqual(callIds, [
      "mock-apply-patch-1",
      "mock-apply-patch-1",
      "mock-apply-patch-1",
      "mock-apply-patch-1",
      "mock-apply-patch-1",
    ]);
    assert.equal(toolEvents[0]?.type, "tool_preflight");
    assert.equal(
      toolEvents[0]?.type === "tool_preflight" ? toolEvents[0].risk : "",
      "high",
    );
    assert.equal(
      toolEvents[0]?.type === "tool_preflight" ? toolEvents[0].workspaceImpact : "",
      "workspace-write",
    );
    assert.equal(
      toolEvents[0]?.type === "tool_preflight" ? toolEvents[0].requiresApproval : false,
      true,
    );
    assert.equal(
      toolEvents.at(-1)?.type === "tool_finish" ? toolEvents.at(-1)?.ok : true,
      false,
    );
    assert.equal(modelTurns.length, 2);
    assert.deepEqual(
      modelTurns.map((event) => `${event.kind}:${event.round}:${event.toolCalls.join(",")}`),
      ["user:0:apply_patch", "tool_outputs:1:"],
    );
    assert.equal(modelTurns.every((event) => event.usageEstimated), true);
    assert.equal(modelTurns.every((event) => typeof event.totalTokens === "number"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("addUsageStats merges every usage aggregate field", () => {
  const target = createUsageStats();
  Object.assign(target, {
    cachedInputTokens: 2,
    costInputTokens: 10,
    costOutputTokens: 5,
    costedTurns: 1,
    estimatedTurns: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    turns: 1,
    turnsWithUsage: 1,
  });

  const source = createUsageStats();
  Object.assign(source, {
    cachedInputTokens: 20,
    costInputTokens: 100,
    costOutputTokens: 50,
    costedTurns: 1,
    estimatedTurns: 1,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    turns: 1,
    turnsWithUsage: 1,
  });

  addUsageStats(target, source);

  assert.deepEqual(target, {
    cachedInputTokens: 22,
    costInputTokens: 110,
    costOutputTokens: 55,
    costedTurns: 2,
    estimatedTurns: 2,
    inputTokens: 110,
    outputTokens: 55,
    totalTokens: 165,
    turns: 2,
    turnsWithUsage: 2,
  });
});
