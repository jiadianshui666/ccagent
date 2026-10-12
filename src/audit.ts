import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { redactSecrets } from "./secrets.js";

export type ToolAuditEvent =
  | {
      type: "tool_preflight";
      timestamp: string;
      callId?: string;
      depth?: number;
      spanId?: string;
      parentCallId?: string;
      toolName: string;
      risk: "low" | "medium" | "high";
      workspaceImpact: "read-only" | "plan-only" | "workspace-write" | "shell" | "unknown";
      requiresApproval: boolean;
      deniedByPolicy: boolean;
      summary: string;
      reasons: string[];
    }
  | {
      type: "tool_start";
      timestamp: string;
      callId?: string;
      depth?: number;
      spanId?: string;
      parentCallId?: string;
      toolName: string;
      inputSummary: string;
    }
  | {
      type: "tool_approval";
      timestamp: string;
      callId?: string;
      depth?: number;
      spanId?: string;
      parentCallId?: string;
      toolName: string;
      status: "required" | "approved" | "denied";
    }
  | {
      type: "tool_finish";
      timestamp: string;
      callId?: string;
      depth?: number;
      spanId?: string;
      parentCallId?: string;
      toolName: string;
      ok: boolean;
      summary: string;
    }
  | {
      type: "project_command";
      timestamp: string;
      action: "detail" | "preview" | "run";
      commandName: string;
      requestedName: string;
      args: string;
      namedArgs?: Record<string, string>;
      positionalArgs?: string;
      expandedPromptPreview?: string;
      status: "shown" | "started" | "blocked" | "denied";
      summary: string;
    }
  | {
      type: "model_turn";
      timestamp: string;
      contentLength: number;
      durationMs: number;
      kind: "user" | "tool_outputs";
      modelName: string;
      previousResponseId?: string;
      responseId?: string;
      round: number;
      streamedText: boolean;
      depth?: number;
      spanId?: string;
      parentCallId?: string;
      toolCalls: string[];
      usageEstimated?: boolean;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
    };

export type ToolAuditEventInput =
  | Omit<Extract<ToolAuditEvent, { type: "tool_preflight" }>, "timestamp">
  | Omit<Extract<ToolAuditEvent, { type: "tool_start" }>, "timestamp">
  | Omit<Extract<ToolAuditEvent, { type: "tool_approval" }>, "timestamp">
  | Omit<Extract<ToolAuditEvent, { type: "tool_finish" }>, "timestamp">;

export type ProjectCommandAuditEventInput = Omit<
  Extract<ToolAuditEvent, { type: "project_command" }>,
  "timestamp"
>;

export type ModelTurnAuditEventInput = Omit<
  Extract<ToolAuditEvent, { type: "model_turn" }>,
  "timestamp"
>;

type ToolExecutionAuditEvent = Extract<
  ToolAuditEvent,
  { type: "tool_preflight" | "tool_start" | "tool_approval" | "tool_finish" }
>;

export interface AuditLogger {
  record(event: ToolAuditEvent): Promise<void>;
}

export const noopAuditLogger: AuditLogger = {
  async record() {},
};

export class FileAuditLogger implements AuditLogger {
  constructor(private readonly workspaceRoot: string) {}

  async record(event: ToolAuditEvent): Promise<void> {
    const path = getToolAuditLogPath(this.workspaceRoot, new Date(event.timestamp));
    await mkdir(join(this.workspaceRoot, ".ccagent", "logs"), { recursive: true });
    await appendFile(path, `${redactSecrets(JSON.stringify(event))}\n`, "utf8");
  }
}

export function getToolAuditLogPath(workspaceRoot: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return join(workspaceRoot, ".ccagent", "logs", `tool-audit-${day}.jsonl`);
}

export type FormatRecentToolAuditOptions = {
  all?: boolean;
  jsonl?: boolean;
  limit?: number;
};

export async function formatRecentToolAudit(
  workspaceRoot: string,
  limitOrOptions: number | FormatRecentToolAuditOptions = 20,
): Promise<string> {
  const options =
    typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const limit = options.limit ?? 20;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return "Usage: /audit [--all] [--jsonl] [count]\ncount must be between 1 and 100.";
  }

  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No tool audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const shownEvents = parsed.events.slice(-limit);

  if (options.jsonl) {
    return shownEvents.map((event) => JSON.stringify(event)).join("\n");
  }

  const lines = [
    "Tool audit log",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Showing last ${shownEvents.length} event(s) of ${parsed.events.length}.`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("");

  for (const event of shownEvents) {
    lines.push(formatAuditEventLine(event));
  }

  if (shownEvents.length === 0) {
    lines.push("(No valid audit events in this log.)");
  }

  return lines.join("\n");
}

export type FormatAuditReplayOptions = {
  all?: boolean;
  limit?: number;
};

export type FormatAuditTimelineOptions = {
  all?: boolean;
  limit?: number;
};

export type FormatModelTraceOptions = {
  all?: boolean;
  limit?: number;
};

export type FormatUsageSummaryOptions = {
  all?: boolean;
};

export type FormatUsageModelsOptions = {
  all?: boolean;
};

export async function formatAuditReplay(
  workspaceRoot: string,
  options: FormatAuditReplayOptions = {},
): Promise<string> {
  const limit = options.limit ?? 20;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return "Usage: /audit-replay [--all] [count]\ncount must be between 1 and 100.";
  }

  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const shownEvents = parsed.events.slice(-limit);
  const lines = [
    "Audit replay",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Replaying last ${shownEvents.length} event(s) of ${parsed.events.length}.`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("");

  shownEvents.forEach((event, index) => {
    lines.push(`${index + 1}. ${formatAuditReplayLine(event)}`);
  });

  if (shownEvents.length === 0) {
    lines.push("(No valid audit events in this log.)");
  }

  return lines.join("\n");
}

export async function formatAuditTimeline(
  workspaceRoot: string,
  options: FormatAuditTimelineOptions = {},
): Promise<string> {
  const limit = options.limit ?? 20;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return "Usage: /audit-timeline [--all] [count]\ncount must be between 1 and 100.";
  }

  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const items = collectAuditTimelineItems(parsed.events);
  const shownItems = items.slice(-limit);
  const lines = [
    "Audit timeline",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Showing last ${shownItems.length} item(s) of ${items.length}.`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("");

  shownItems.forEach((item, index) => {
    lines.push(`${index + 1}. ${formatAuditTimelineItem(item)}`);
  });

  if (shownItems.length === 0) {
    lines.push("(No audit timeline items in this log.)");
  }

  return lines.join("\n");
}

export async function formatModelTrace(
  workspaceRoot: string,
  options: FormatModelTraceOptions = {},
): Promise<string> {
  const limit = options.limit ?? 20;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return "Usage: /model-trace [--all] [count]\ncount must be between 1 and 100.";
  }

  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const turns = parsed.events.filter(
    (event): event is Extract<ToolAuditEvent, { type: "model_turn" }> =>
      event.type === "model_turn",
  );
  const shownTurns = turns.slice(-limit);
  const lines = [
    "Model trace",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Showing last ${shownTurns.length} turn(s) of ${turns.length}.`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("");

  shownTurns.forEach((turn, index) => {
    lines.push(`${index + 1}. ${formatModelTurnLine(turn)}`);
  });

  if (shownTurns.length === 0) {
    lines.push("(No model turn audit events in this log.)");
  }

  return lines.join("\n");
}

export async function formatUsageSummary(
  workspaceRoot: string,
  options: FormatUsageSummaryOptions = {},
): Promise<string> {
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const summary = collectUsageSummary(parsed.events);
  const modelEntries = [...summary.models.entries()].sort(
    ([leftName, left], [rightName, right]) =>
      right.turns - left.turns || leftName.localeCompare(rightName),
  );
  const lines = [
    "Usage summary",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Model turns: ${summary.turns}`,
    `Turns with token usage: ${summary.turnsWithUsage}`,
    `Estimated token turns: ${summary.estimatedTurns}`,
    `Input tokens: ${summary.inputTokens}`,
    `Output tokens: ${summary.outputTokens}`,
    `Total tokens: ${summary.totalTokens}`,
    `Cached input tokens: ${summary.cachedInputTokens}`,
    `Cost: ${formatAggregateCost(summary, true)}`,
    formatUsageBudget(summary),
    `Average total tokens / tokenized turn: ${formatAverage(summary.totalTokens, summary.turnsWithUsage)}`,
    `Average cost / costed turn: ${formatAverageCost(summary)}`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("", "Models:");

  if (modelEntries.length === 0) {
    lines.push("(No model turn audit events in this log.)");
  } else {
    for (const [modelName, stats] of modelEntries) {
      lines.push(
        `- ${modelName}: turns=${stats.turns} tokenized=${stats.turnsWithUsage} tokens=in=${stats.inputTokens},out=${stats.outputTokens},total=${stats.totalTokens},cached=${stats.cachedInputTokens} estimated=${stats.estimatedTurns} cost=${formatAggregateCost(stats, false)}`,
      );
    }
  }

  return lines.join("\n");
}

export async function formatUsageModels(
  workspaceRoot: string,
  options: FormatUsageModelsOptions = {},
): Promise<string> {
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const summary = collectUsageSummary(parsed.events);
  const modelEntries = [...summary.models.entries()].sort(
    ([leftName, left], [rightName, right]) =>
      right.totalTokens - left.totalTokens ||
      right.turns - left.turns ||
      leftName.localeCompare(rightName),
  );
  const lines = [
    "Usage models",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Models: ${modelEntries.length}`,
    `Model turns: ${summary.turns}`,
    `Turns with token usage: ${summary.turnsWithUsage}`,
    `Cost: ${formatAggregateCost(summary, true)}`,
    formatUsageBudget(summary),
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("");

  if (modelEntries.length === 0) {
    lines.push("(No model turn audit events in this log.)");
  } else {
    for (const [modelName, stats] of modelEntries) {
      lines.push(
        `- ${modelName}: turns=${stats.turns} tokenized=${stats.turnsWithUsage} estimated=${stats.estimatedTurns} costed=${stats.costedTurns} tokens=in=${stats.inputTokens},out=${stats.outputTokens},total=${stats.totalTokens},cached=${stats.cachedInputTokens} avgTotal=${formatAverage(stats.totalTokens, stats.turnsWithUsage)} avgCost=${formatAverageCost(stats)} cost=${formatAggregateCost(stats, false)}`,
      );
    }
  }

  return lines.join("\n");
}

export type AuditSpanNode = {
  id: string;
  kind: "agent" | "tool" | "model";
  label: string;
  depth: number;
  spanId?: string;
  parentCallId?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  status?: string;
  round?: number;
  usage?: UsageRecord;
  children: AuditSpanNode[];
};

export type FormatAuditSpanTreeOptions = {
  all?: boolean;
  json?: boolean;
};

export async function formatAuditSpanTree(
  workspaceRoot: string,
  options: FormatAuditSpanTreeOptions = {},
): Promise<string> {
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const root = buildAuditSpanTree(parsed.events);

  return options.json ? JSON.stringify(root, null, 2) : formatAuditSpanTreeText(root);
}

function buildAuditSpanTree(events: ToolAuditEvent[]): AuditSpanNode {
  const agents = new Map<string, AuditSpanNode>();
  const toolNodes = new Map<string, AuditSpanNode>();
  const agentParentCallId = new Map<string, string>();

  for (const event of events) {
    if ("spanId" in event && event.spanId && event.parentCallId) {
      agentParentCallId.set(event.spanId, event.parentCallId);
    }
  }

  const getAgent = (spanId: string | undefined): AuditSpanNode => {
    const key = spanId ?? "";
    let node = agents.get(key);

    if (!node) {
      const parentCallId = spanId ? agentParentCallId.get(spanId) : undefined;

      node = {
        id: spanId ?? "main",
        kind: "agent",
        label: spanId ?? "main agent",
        depth: spanId === undefined ? 0 : 1,
        ...(spanId ? { spanId } : {}),
        ...(parentCallId ? { parentCallId } : {}),
        children: [],
      };
      agents.set(key, node);
    }

    return node;
  };

  for (const event of events) {
    if (event.type !== "model_turn") {
      continue;
    }

    getAgent(event.spanId).children.push({
      id: `turn-${event.round}`,
      kind: "model",
      label: "model",
      depth: (event.depth ?? 0) + 1,
      round: event.round,
      ...(event.spanId ? { spanId: event.spanId } : {}),
      startedAt: offsetIso(event.timestamp, -event.durationMs),
      finishedAt: event.timestamp,
      durationMs: event.durationMs,
      ...(event.inputTokens !== undefined || event.outputTokens !== undefined || event.totalTokens !== undefined
        ? {
            usage: {
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
              ...(event.totalTokens !== undefined ? { totalTokens: event.totalTokens } : {}),
            },
          }
        : {}),
      children: [],
    });
  }

  for (const event of events) {
    if (!isToolExecutionAuditEvent(event)) {
      continue;
    }

    const callId = event.callId ?? "";
    let node = toolNodes.get(callId);

    if (!node) {
      node = {
        id: callId || "legacy",
        kind: "tool",
        label: event.toolName,
        depth: (event.depth ?? 0) + 1,
        ...(event.spanId ? { spanId: event.spanId } : {}),
        ...(event.parentCallId ? { parentCallId: event.parentCallId } : {}),
        children: [],
      };
      toolNodes.set(callId, node);
    }

    node.label = event.toolName;

    if (event.type === "tool_start") {
      node.startedAt = event.timestamp;
    } else if (event.type === "tool_finish") {
      node.finishedAt = event.timestamp;
      node.status = event.ok ? "ok" : "failed";
    }
  }

  for (const node of toolNodes.values()) {
    finalizeSpanDuration(node);
    getAgent(node.spanId).children.push(node);
  }

  for (const agent of agents.values()) {
    if (agent.parentCallId) {
      const parentTool = toolNodes.get(agent.parentCallId);

      if (parentTool) {
        parentTool.children.push(agent);
      }
    }
  }

  const root =
    agents.get("") ??
    ({
      id: "main",
      kind: "agent",
      label: "main agent",
      depth: 0,
      children: [],
    } satisfies AuditSpanNode);

  sortSpanNodes(root);
  return root;
}

function finalizeSpanDuration(node: AuditSpanNode): void {
  if (node.startedAt && node.finishedAt) {
    const start = Date.parse(node.startedAt);
    const end = Date.parse(node.finishedAt);

    if (Number.isFinite(start) && Number.isFinite(end)) {
      node.durationMs = end - start;
    }
  }
}

function sortSpanNodes(node: AuditSpanNode): void {
  node.children.sort((left, right) =>
    (left.startedAt ?? left.finishedAt ?? "").localeCompare(right.startedAt ?? right.finishedAt ?? ""),
  );

  for (const child of node.children) {
    sortSpanNodes(child);
  }
}

function offsetIso(timestamp: string, offsetMs: number): string | undefined {
  const ms = Date.parse(timestamp);

  return Number.isFinite(ms) ? new Date(ms + offsetMs).toISOString() : undefined;
}

function formatAuditSpanTreeText(root: AuditSpanNode): string {
  const lines: string[] = [];

  const walk = (node: AuditSpanNode, level: number): void => {
    lines.push(`${"  ".repeat(level)}${formatSpanNode(node)}`);

    for (const child of node.children) {
      walk(child, level + 1);
    }
  };

  walk(root, 0);
  return lines.join("\n");
}

function formatSpanNode(node: AuditSpanNode): string {
  const parts = [`[${node.kind}] ${node.label}`];

  if (node.spanId) {
    parts.push(`span=${node.spanId}`);
  }

  if (node.round !== undefined) {
    parts.push(`round=${node.round}`);
  }

  if (node.durationMs !== undefined) {
    parts.push(`${node.durationMs}ms`);
  }

  if (node.status) {
    parts.push(node.status);
  }

  if (node.usage?.totalTokens !== undefined) {
    parts.push(`totalTokens=${node.usage.totalTokens}`);
  }

  return parts.join(" ");
}

export type FormatAuditCallOptions = {
  all?: boolean;
  callId?: string;
};

export async function formatAuditCall(
  workspaceRoot: string,
  options: FormatAuditCallOptions = {},
): Promise<string> {
  const callId = options.callId?.trim();

  if (!callId) {
    return "Usage: /audit-call [--all] <callId>";
  }

  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const callEvents = parsed.events.filter(
    (event): event is ToolExecutionAuditEvent =>
      isToolExecutionAuditEvent(event) && event.callId === callId,
  );
  const lines = [
    "Audit call",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Call ID: ${callId}`,
    `Events: ${callEvents.length}`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("");

  for (const event of callEvents) {
    lines.push(formatAuditEventLine(event));
  }

  if (callEvents.length === 0) {
    lines.push("(No audit events matched this callId.)");
  }

  return lines.join("\n");
}

export type FormatAuditSummaryOptions = {
  all?: boolean;
};

export type ExportAuditOptions =
  | {
      all?: boolean;
      kind: "summary";
    }
  | {
      all?: boolean;
      callId?: string;
      kind: "call";
    };

export type ExportAuditReportOptions = {
  all?: boolean;
};

export async function formatAuditSummary(
  workspaceRoot: string,
  options: FormatAuditSummaryOptions = {},
): Promise<string> {
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const summary = collectToolCallSummary(parsed.events);
  const toolEntries = [...summary.tools.entries()].sort(
    ([leftName, left], [rightName, right]) =>
      right.calls - left.calls || leftName.localeCompare(rightName),
  );
  const lines = [
    "Audit summary",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Tool calls: ${summary.calls}`,
    `Succeeded: ${summary.succeeded}`,
    `Failed: ${summary.failed}`,
    `Pending: ${summary.pending}`,
    `Approval events: required=${summary.approvalRequired} approved=${summary.approvalApproved} denied=${summary.approvalDenied}`,
    `Uncorrelated events: ${summary.uncorrelatedEvents}`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("", "Tools:");

  if (toolEntries.length === 0) {
    lines.push("(No tool audit events in this log.)");
  } else {
    for (const [toolName, stats] of toolEntries) {
      lines.push(
        `- ${toolName}: calls=${stats.calls} succeeded=${stats.succeeded} failed=${stats.failed} pending=${stats.pending} approvals=${stats.approvalRequired} denied=${stats.approvalDenied} last=${stats.lastTimestamp}`,
      );
    }
  }

  return lines.join("\n");
}

export async function exportAuditData(
  workspaceRoot: string,
  options: ExportAuditOptions,
): Promise<string> {
  if (options.kind === "call" && !options.callId?.trim()) {
    return "Usage: /audit-export summary [--all]\n       /audit-export call [--all] <callId>";
  }

  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const exportedAt = new Date().toISOString();
  const exportDir = join(workspaceRoot, ".ccagent", "exports");
  await mkdir(exportDir, { recursive: true });

  if (options.kind === "summary") {
    const summary = serializeToolCallSummary(collectToolCallSummary(parsed.events));
    const fileName = `audit-summary-${formatExportTimestamp(exportedAt)}.json`;
    const payload = {
      kind: "summary",
      scope: options.all ? "all" : "latest",
      exportedAt,
      files: logFiles.map((file) => `.ccagent/logs/${file}`),
      invalidLines: parsed.invalidLines,
      summary,
    };

    await writeJsonExport(join(exportDir, fileName), payload);

    return [
      "Exported audit summary",
      `Path: .ccagent/exports/${fileName}`,
      `Files: ${logFiles.length}`,
    ].join("\n");
  }

  const callId = options.callId?.trim() ?? "";
  const events = parsed.events.filter(
    (event): event is ToolExecutionAuditEvent =>
      isToolExecutionAuditEvent(event) && event.callId === callId,
  );
  const fileName = `audit-call-${sanitizeFileNamePart(callId)}-${formatExportTimestamp(exportedAt)}.json`;
  const payload = {
    kind: "call",
    scope: options.all ? "all" : "latest",
    exportedAt,
    files: logFiles.map((file) => `.ccagent/logs/${file}`),
    invalidLines: parsed.invalidLines,
    callId,
    events,
  };

  await writeJsonExport(join(exportDir, fileName), payload);

  return [
    "Exported audit call",
    `Path: .ccagent/exports/${fileName}`,
    `Call ID: ${callId}`,
    `Events: ${events.length}`,
  ].join("\n");
}

let nextAuditReportExportSequence = 1;

export async function exportAuditReport(
  workspaceRoot: string,
  options: ExportAuditReportOptions = {},
): Promise<string> {
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const exportedAt = new Date().toISOString();
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileName = `audit-report-${formatExportTimestamp(exportedAt)}-${nextAuditReportExportSequence++}.md`;
  const content = buildAuditMarkdownReport({
    all: options.all,
    events: parsed.events,
    exportedAt,
    invalidLines: parsed.invalidLines,
    logFiles,
  });

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, fileName), content, "utf8");

  return [
    "Exported audit report",
    `Path: .ccagent/reports/${fileName}`,
    `Files: ${logFiles.length}`,
    `Events: ${parsed.events.length}`,
  ].join("\n");
}

export type FormatProjectCommandHistoryOptions = {
  all?: boolean;
  commandName?: string;
  limit?: number;
};

export async function formatProjectCommandHistory(
  workspaceRoot: string,
  options: FormatProjectCommandHistoryOptions = {},
): Promise<string> {
  const limit = options.limit ?? 20;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return "Usage: /command-history [--all] [name] [count]\ncount must be between 1 and 100.";
  }

  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const commandName = options.commandName?.trim();
  const commandEvents = parsed.events.filter(
    (event): event is Extract<ToolAuditEvent, { type: "project_command" }> =>
      event.type === "project_command" &&
      (!commandName || event.commandName === commandName || event.requestedName === commandName),
  );
  const shownEvents = commandEvents.slice(-limit);
  const lines = [
    "Project command history",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    ...(commandName ? [`Filter: ${commandName}`] : []),
    `Showing last ${shownEvents.length} event(s) of ${commandEvents.length}.`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("");

  for (const event of shownEvents) {
    lines.push(formatProjectCommandEventLine(event));
  }

  if (shownEvents.length === 0) {
    lines.push(
      commandName
        ? "(No matching project command audit events.)"
        : "(No project command audit events in this log.)",
    );
  }

  return lines.join("\n");
}

type ProjectCommandStats = {
  blocked: number;
  denied: number;
  detail: number;
  lastTimestamp: string;
  preview: number;
  run: number;
  shown: number;
  started: number;
  total: number;
};

type ToolCallAggregate = {
  approvalApproved: number;
  approvalDenied: number;
  approvalRequired: number;
  eventCount: number;
  finishedAt?: string;
  lastTimestamp: string;
  ok?: boolean;
  preflightRisk?: "low" | "medium" | "high";
  startedAt?: string;
  toolName: string;
};

type ToolStats = {
  approvalDenied: number;
  approvalRequired: number;
  calls: number;
  failed: number;
  lastTimestamp: string;
  pending: number;
  succeeded: number;
};

type ToolCallSummary = {
  approvalApproved: number;
  approvalDenied: number;
  approvalRequired: number;
  calls: number;
  failed: number;
  pending: number;
  succeeded: number;
  tools: Map<string, ToolStats>;
  uncorrelatedEvents: number;
};

export type UsageRecord = {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  usageEstimated?: boolean;
};

export type UsageStats = {
  cachedInputTokens: number;
  costInputTokens: number;
  costOutputTokens: number;
  costedTurns: number;
  estimatedTurns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  turnsWithUsage: number;
};

type UsageSummary = UsageStats & {
  models: Map<string, UsageStats>;
};

type AuditTimelineItem =
  | ProjectCommandTimelineItem
  | ToolCallTimelineItem;

type ProjectCommandTimelineItem = Extract<ToolAuditEvent, { type: "project_command" }> & {
  kind: "project_command";
};

type ToolCallTimelineItem = {
  approvalApproved: number;
  approvalDenied: number;
  approvalRequired: number;
  callId?: string;
  depth?: number;
  spanId?: string;
  parentCallId?: string;
  eventCount: number;
  finishedAt?: string;
  inputSummary?: string;
  kind: "tool_call";
  lastTimestamp: string;
  ok?: boolean;
  preflightRisk?: "low" | "medium" | "high";
  preflightSummary?: string;
  workspaceImpact?: "read-only" | "plan-only" | "workspace-write" | "shell" | "unknown";
  startedAt?: string;
  summary?: string;
  toolName: string;
};

export type FormatProjectCommandStatsOptions = {
  all?: boolean;
};

export async function formatProjectCommandStats(
  workspaceRoot: string,
  options: FormatProjectCommandStatsOptions = {},
): Promise<string> {
  const logsDir = join(workspaceRoot, ".ccagent", "logs");
  const logFiles = options.all ? await findAuditLogs(logsDir) : await findLatestAuditLogAsList(logsDir);

  if (logFiles.length === 0) {
    return "No audit logs found in .ccagent/logs/.";
  }

  const parsed = await readAuditLogs(logsDir, logFiles);
  const stats = collectProjectCommandStats(parsed.events);
  const entries = [...stats.entries()].sort(([left], [right]) => left.localeCompare(right));
  const totalEvents = entries.reduce((sum, [, value]) => sum + value.total, 0);
  const lines = [
    "Project command stats",
    ...(options.all
      ? [`Scope: all logs`, `Files: ${logFiles.length}`]
      : [`Path: .ccagent/logs/${basename(logFiles[0] ?? "")}`]),
    `Commands: ${entries.length}`,
    `Events: ${totalEvents}`,
  ];

  if (parsed.invalidLines > 0) {
    lines.push(`Skipped ${parsed.invalidLines} invalid line(s).`);
  }

  lines.push("");

  if (entries.length === 0) {
    lines.push("(No project command audit events in this log.)");
  } else {
    for (const [commandName, value] of entries) {
      lines.push(
        `- ${commandName}: total=${value.total} detail=${value.detail} preview=${value.preview} run=${value.run} started=${value.started} blocked=${value.blocked} denied=${value.denied} shown=${value.shown} last=${value.lastTimestamp}`,
      );
    }
  }

  return lines.join("\n");
}

async function findLatestAuditLogAsList(logsDir: string): Promise<string[]> {
  return (await findAuditLogs(logsDir)).slice(-1);
}

async function findAuditLogs(logsDir: string): Promise<string[]> {
  let entries: string[];

  try {
    entries = await readdir(logsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => /^tool-audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))
    .sort();
}

async function readAuditLogs(
  logsDir: string,
  logFiles: string[],
): Promise<{
  events: ToolAuditEvent[];
  invalidLines: number;
}> {
  const events: ToolAuditEvent[] = [];
  let invalidLines = 0;

  for (const logFile of logFiles) {
    const parsed = parseAuditLog(await readFile(join(logsDir, logFile), "utf8"));
    events.push(...parsed.events);
    invalidLines += parsed.invalidLines;
  }

  return { events, invalidLines };
}

function parseAuditLog(content: string): {
  events: ToolAuditEvent[];
  invalidLines: number;
} {
  const events: ToolAuditEvent[] = [];
  let invalidLines = 0;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const event = parseToolAuditEvent(JSON.parse(line));

      if (event) {
        events.push(event);
      } else {
        invalidLines += 1;
      }
    } catch {
      invalidLines += 1;
    }
  }

  return { events, invalidLines };
}

function parseToolAuditEvent(value: unknown): ToolAuditEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.type === "tool_preflight" &&
    typeof value.timestamp === "string" &&
    typeof value.toolName === "string" &&
    isToolRisk(value.risk) &&
    isWorkspaceImpact(value.workspaceImpact) &&
    typeof value.requiresApproval === "boolean" &&
    typeof value.deniedByPolicy === "boolean" &&
    typeof value.summary === "string" &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === "string")
  ) {
    const callId = parseOptionalString(value.callId);
    const depth = parseOptionalNonNegativeInteger(value.depth);
    const spanId = parseOptionalString(value.spanId);
    const parentCallId = parseOptionalString(value.parentCallId);

    return {
      type: "tool_preflight",
      timestamp: value.timestamp,
      ...(callId ? { callId } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(spanId ? { spanId } : {}),
      ...(parentCallId ? { parentCallId } : {}),
      toolName: value.toolName,
      risk: value.risk,
      workspaceImpact: value.workspaceImpact,
      requiresApproval: value.requiresApproval,
      deniedByPolicy: value.deniedByPolicy,
      summary: value.summary,
      reasons: value.reasons,
    };
  }

  if (
    value.type === "tool_start" &&
    typeof value.timestamp === "string" &&
    typeof value.toolName === "string" &&
    typeof value.inputSummary === "string"
  ) {
    const callId = parseOptionalString(value.callId);
    const depth = parseOptionalNonNegativeInteger(value.depth);
    const spanId = parseOptionalString(value.spanId);
    const parentCallId = parseOptionalString(value.parentCallId);

    return {
      type: "tool_start",
      timestamp: value.timestamp,
      ...(callId ? { callId } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(spanId ? { spanId } : {}),
      ...(parentCallId ? { parentCallId } : {}),
      toolName: value.toolName,
      inputSummary: value.inputSummary,
    };
  }

  if (
    value.type === "tool_approval" &&
    typeof value.timestamp === "string" &&
    typeof value.toolName === "string" &&
    (value.status === "required" || value.status === "approved" || value.status === "denied")
  ) {
    const callId = parseOptionalString(value.callId);
    const depth = parseOptionalNonNegativeInteger(value.depth);
    const spanId = parseOptionalString(value.spanId);
    const parentCallId = parseOptionalString(value.parentCallId);

    return {
      type: "tool_approval",
      timestamp: value.timestamp,
      ...(callId ? { callId } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(spanId ? { spanId } : {}),
      ...(parentCallId ? { parentCallId } : {}),
      toolName: value.toolName,
      status: value.status,
    };
  }

  if (
    value.type === "tool_finish" &&
    typeof value.timestamp === "string" &&
    typeof value.toolName === "string" &&
    typeof value.ok === "boolean" &&
    typeof value.summary === "string"
  ) {
    const callId = parseOptionalString(value.callId);
    const depth = parseOptionalNonNegativeInteger(value.depth);
    const spanId = parseOptionalString(value.spanId);
    const parentCallId = parseOptionalString(value.parentCallId);

    return {
      type: "tool_finish",
      timestamp: value.timestamp,
      ...(callId ? { callId } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(spanId ? { spanId } : {}),
      ...(parentCallId ? { parentCallId } : {}),
      toolName: value.toolName,
      ok: value.ok,
      summary: value.summary,
    };
  }

  if (
    value.type === "project_command" &&
    typeof value.timestamp === "string" &&
    (value.action === "detail" || value.action === "preview" || value.action === "run") &&
    typeof value.commandName === "string" &&
    typeof value.requestedName === "string" &&
    typeof value.args === "string" &&
    (value.status === "shown" ||
      value.status === "started" ||
      value.status === "blocked" ||
      value.status === "denied") &&
    typeof value.summary === "string"
  ) {
    const namedArgs = parseOptionalStringRecord(value.namedArgs);
    const positionalArgs = parseOptionalString(value.positionalArgs);
    const expandedPromptPreview = parseOptionalString(value.expandedPromptPreview);

    return {
      type: "project_command",
      timestamp: value.timestamp,
      action: value.action,
      commandName: value.commandName,
      requestedName: value.requestedName,
      args: value.args,
      ...(namedArgs ? { namedArgs } : {}),
      ...(positionalArgs !== undefined ? { positionalArgs } : {}),
      ...(expandedPromptPreview ? { expandedPromptPreview } : {}),
      status: value.status,
      summary: value.summary,
    };
  }

  if (
    value.type === "model_turn" &&
    typeof value.timestamp === "string" &&
    typeof value.contentLength === "number" &&
    typeof value.durationMs === "number" &&
    (value.kind === "user" || value.kind === "tool_outputs") &&
    typeof value.modelName === "string" &&
    typeof value.round === "number" &&
    typeof value.streamedText === "boolean" &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every((toolCall) => typeof toolCall === "string")
  ) {
    const previousResponseId = parseOptionalString(value.previousResponseId);
    const responseId = parseOptionalString(value.responseId);
    const inputTokens = parseOptionalNonNegativeInteger(value.inputTokens);
    const outputTokens = parseOptionalNonNegativeInteger(value.outputTokens);
    const totalTokens = parseOptionalNonNegativeInteger(value.totalTokens);
    const cachedInputTokens = parseOptionalNonNegativeInteger(value.cachedInputTokens);
    const depth = parseOptionalNonNegativeInteger(value.depth);
    const spanId = parseOptionalString(value.spanId);
    const parentCallId = parseOptionalString(value.parentCallId);

    return {
      type: "model_turn",
      timestamp: value.timestamp,
      contentLength: value.contentLength,
      durationMs: value.durationMs,
      kind: value.kind,
      modelName: value.modelName,
      ...(previousResponseId ? { previousResponseId } : {}),
      ...(responseId ? { responseId } : {}),
      round: value.round,
      streamedText: value.streamedText,
      ...(depth !== undefined ? { depth } : {}),
      ...(spanId ? { spanId } : {}),
      ...(parentCallId ? { parentCallId } : {}),
      toolCalls: value.toolCalls,
      ...(value.usageEstimated === true ? { usageEstimated: true } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    };
  }

  return null;
}

function formatAuditEventLine(event: ToolAuditEvent): string {
  const prefix = formatDepthPrefix(eventDepth(event));

  if (event.type === "tool_preflight") {
    return `${prefix}${event.timestamp} preflight ${event.toolName}${formatCallId(event.callId)} risk=${event.risk} impact=${event.workspaceImpact} approval=${event.requiresApproval ? "yes" : "no"} denied=${event.deniedByPolicy ? "yes" : "no"} ${truncate(event.reasons.join("; "))}`;
  }

  if (event.type === "tool_start") {
    return `${prefix}${event.timestamp} start    ${event.toolName}${formatCallId(event.callId)} input=${truncate(event.inputSummary)}`;
  }

  if (event.type === "tool_approval") {
    return `${prefix}${event.timestamp} approval ${event.toolName}${formatCallId(event.callId)} status=${event.status}`;
  }

  if (event.type === "project_command") {
    return `${prefix}${event.timestamp} command  ${event.action} ${event.commandName} status=${event.status} requested=${event.requestedName} ${formatProjectCommandAuditFields(event)} ${truncate(event.summary)}`;
  }

  if (event.type === "model_turn") {
    return `${prefix}${event.timestamp} model   ${event.kind} round=${event.round} duration=${event.durationMs}ms content=${event.contentLength} ${formatTokenUsage(event)} toolCalls=${formatToolCallList(event.toolCalls)} responseId=${event.responseId ?? "(none)"}`;
  }

  return `${prefix}${event.timestamp} finish   ${event.toolName}${formatCallId(event.callId)} ${event.ok ? "ok" : "failed"} ${truncate(
    event.summary,
  )}`;
}

function formatAuditReplayLine(event: ToolAuditEvent): string {
  const prefix = formatDepthPrefix(eventDepth(event));

  if (event.type === "tool_preflight") {
    return `${prefix}${event.timestamp} tool ${event.toolName}${formatCallId(event.callId)} preflight risk=${event.risk} impact=${event.workspaceImpact} approval=${event.requiresApproval ? "yes" : "no"} denied=${event.deniedByPolicy ? "yes" : "no"} reasons=${truncate(event.reasons.join("; "))}`;
  }

  if (event.type === "tool_start") {
    return `${prefix}${event.timestamp} tool ${event.toolName}${formatCallId(event.callId)} started with input=${truncate(
      event.inputSummary,
    )}`;
  }

  if (event.type === "tool_approval") {
    return `${prefix}${event.timestamp} tool ${event.toolName}${formatCallId(event.callId)} approval ${event.status}`;
  }

  if (event.type === "project_command") {
    return `${prefix}${event.timestamp} project command ${event.commandName} ${event.action} ${event.status} requested=${event.requestedName} ${formatProjectCommandAuditFields(event)} summary=${truncate(event.summary)}`;
  }

  if (event.type === "model_turn") {
    return `${prefix}${event.timestamp} model turn ${event.kind} round=${event.round} model=${event.modelName} duration=${event.durationMs}ms contentLength=${event.contentLength} ${formatTokenUsage(event)} toolCalls=${formatToolCallList(event.toolCalls)} responseId=${event.responseId ?? "(none)"}`;
  }

  return `${prefix}${event.timestamp} tool ${event.toolName}${formatCallId(event.callId)} finished ${event.ok ? "ok" : "failed"} summary=${truncate(
    event.summary,
  )}`;
}

function formatModelTurnLine(event: Extract<ToolAuditEvent, { type: "model_turn" }>): string {
  const prefix = formatDepthPrefix(event.depth ?? 0);
  const span = event.spanId ? ` span=${event.spanId}` : "";

  return `${prefix}${event.timestamp} ${event.kind.padEnd(12)} round=${event.round} model=${event.modelName}${span} duration=${event.durationMs}ms content=${event.contentLength} streamed=${event.streamedText ? "yes" : "no"} ${formatTokenUsage(event)} ${formatEstimatedCost(event)} previous=${event.previousResponseId ?? "(none)"} response=${event.responseId ?? "(none)"} toolCalls=${formatToolCallList(event.toolCalls)}`;
}

function formatProjectCommandEventLine(
  event: Extract<ToolAuditEvent, { type: "project_command" }>,
): string {
  return `${event.timestamp} ${event.action.padEnd(7)} ${event.commandName} status=${event.status} requested=${event.requestedName} ${formatProjectCommandAuditFields(event)} ${truncate(event.summary)}`;
}

function formatDepthPrefix(depth: number): string {
  return depth > 0 ? "  ".repeat(depth) : "";
}

function eventDepth(event: ToolAuditEvent): number {
  return "depth" in event && typeof event.depth === "number" ? event.depth : 0;
}

function collectAuditTimelineItems(events: ToolAuditEvent[]): AuditTimelineItem[] {
  const items: Array<AuditTimelineItem | { key: string; kind: "tool_call_ref" }> = [];
  const calls = new Map<string, ToolCallTimelineItem>();
  let legacyCounter = 0;

  for (const event of events) {
    if (event.type === "project_command") {
      items.push({
        ...event,
        kind: "project_command",
      });
      continue;
    }

    if (!isToolExecutionAuditEvent(event)) {
      continue;
    }

    const callId = event.callId;
    const key = callId ?? `legacy-${legacyCounter}`;

    if (!callId) {
      legacyCounter += 1;
    }

    let current = calls.get(key);

    if (!current) {
      current = {
        approvalApproved: 0,
        approvalDenied: 0,
        approvalRequired: 0,
        ...(callId ? { callId } : {}),
        depth: event.depth ?? 0,
        ...(event.spanId ? { spanId: event.spanId } : {}),
        ...(event.parentCallId ? { parentCallId: event.parentCallId } : {}),
        eventCount: 0,
        kind: "tool_call",
        lastTimestamp: event.timestamp,
        toolName: event.toolName,
      };
      calls.set(key, current);
      items.push({
        kind: "tool_call_ref",
        key,
      });
    }

    current.eventCount += 1;
    current.toolName = event.toolName || current.toolName;

    if (event.depth !== undefined) {
      current.depth = event.depth;
    }

    if (event.spanId) {
      current.spanId = event.spanId;
    }

    if (event.parentCallId) {
      current.parentCallId = event.parentCallId;
    }

    if (event.timestamp >= current.lastTimestamp) {
      current.lastTimestamp = event.timestamp;
    }

    if (event.type === "tool_preflight") {
      current.preflightRisk = event.risk;
      current.preflightSummary = event.summary;
      current.workspaceImpact = event.workspaceImpact;
      current.toolName = event.toolName;
    } else if (event.type === "tool_start") {
      current.startedAt = event.timestamp;
      current.inputSummary = event.inputSummary;
      current.toolName = event.toolName;
    } else if (event.type === "tool_approval") {
      if (event.status === "required") {
        current.approvalRequired += 1;
      } else if (event.status === "approved") {
        current.approvalApproved += 1;
      } else {
        current.approvalDenied += 1;
      }
    } else {
      current.finishedAt = event.timestamp;
      current.ok = event.ok;
      current.summary = event.summary;
      current.toolName = event.toolName;
    }
  }

  return items
    .map((item) => (item.kind === "tool_call_ref" ? calls.get(item.key) : item))
    .filter((item): item is AuditTimelineItem => Boolean(item));
}

function formatAuditTimelineItem(item: AuditTimelineItem): string {
  if (item.kind === "project_command") {
    return `command ${item.commandName} ${item.action} ${item.status} requested=${item.requestedName} ${formatProjectCommandAuditFields(item)} summary=${truncate(item.summary)}`;
  }

  const status = item.finishedAt === undefined ? "pending" : item.ok ? "succeeded" : "failed";
  const duration = formatDuration(item.startedAt, item.finishedAt);
  const parts = [
    `${formatDepthPrefix(item.depth ?? 0)}tool ${item.toolName}${formatCallId(item.callId)}`,
    status,
    `duration=${duration}`,
    `events=${item.eventCount}`,
    `approvals=required:${item.approvalRequired} approved:${item.approvalApproved} denied:${item.approvalDenied}`,
  ];

  if (item.preflightRisk) {
    parts.push(`risk=${item.preflightRisk}`);
  }

  if (item.workspaceImpact) {
    parts.push(`impact=${item.workspaceImpact}`);
  }

  if (item.spanId) {
    parts.push(`span=${item.spanId}`);
  }

  if (item.parentCallId) {
    parts.push(`parent=${item.parentCallId}`);
  }

  if (item.inputSummary) {
    parts.push(`input=${truncate(item.inputSummary)}`);
  }

  if (item.summary) {
    parts.push(`summary=${truncate(item.summary)}`);
  }

  return parts.join(" ");
}

function collectProjectCommandStats(events: ToolAuditEvent[]): Map<string, ProjectCommandStats> {
  const stats = new Map<string, ProjectCommandStats>();

  for (const event of events) {
    if (event.type !== "project_command") {
      continue;
    }

    const current =
      stats.get(event.commandName) ??
      {
        blocked: 0,
        denied: 0,
        detail: 0,
        lastTimestamp: event.timestamp,
        preview: 0,
        run: 0,
        shown: 0,
        started: 0,
        total: 0,
      };

    current.total += 1;
    current[event.action] += 1;
    current[event.status] += 1;

    if (event.timestamp >= current.lastTimestamp) {
      current.lastTimestamp = event.timestamp;
    }

    stats.set(event.commandName, current);
  }

  return stats;
}

function collectUsageSummary(events: ToolAuditEvent[]): UsageSummary {
  const summary: UsageSummary = {
    ...createUsageStats(),
    models: new Map<string, UsageStats>(),
  };

  for (const event of events) {
    if (event.type !== "model_turn") {
      continue;
    }

    addUsageEvent(summary, event);

    const modelStats = summary.models.get(event.modelName) ?? createUsageStats();
    addUsageEvent(modelStats, event);
    summary.models.set(event.modelName, modelStats);
  }

  return summary;
}

export function createUsageStats(): UsageStats {
  return {
    cachedInputTokens: 0,
    costInputTokens: 0,
    costOutputTokens: 0,
    costedTurns: 0,
    estimatedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
    turnsWithUsage: 0,
  };
}

function addUsageEvent(
  stats: UsageStats,
  event: Extract<ToolAuditEvent, { type: "model_turn" }>,
): void {
  addUsageRecord(stats, event);
}

export function addUsageRecord(stats: UsageStats, record: UsageRecord): void {
  const hasUsage =
    record.inputTokens !== undefined ||
    record.outputTokens !== undefined ||
    record.totalTokens !== undefined ||
    record.cachedInputTokens !== undefined;
  const totalTokens =
    record.totalTokens ??
    (record.inputTokens !== undefined && record.outputTokens !== undefined
      ? record.inputTokens + record.outputTokens
      : undefined);

  stats.turns += 1;

  if (hasUsage) {
    stats.turnsWithUsage += 1;
  }

  if (record.usageEstimated) {
    stats.estimatedTurns += 1;
  }

  if (record.inputTokens !== undefined) {
    stats.inputTokens += record.inputTokens;
  }

  if (record.outputTokens !== undefined) {
    stats.outputTokens += record.outputTokens;
  }

  if (totalTokens !== undefined) {
    stats.totalTokens += totalTokens;
  }

  if (record.cachedInputTokens !== undefined) {
    stats.cachedInputTokens += record.cachedInputTokens;
  }

  if (record.inputTokens !== undefined && record.outputTokens !== undefined) {
    stats.costedTurns += 1;
    stats.costInputTokens += record.inputTokens;
    stats.costOutputTokens += record.outputTokens;
  }
}

export function addUsageStats(target: UsageStats, source: UsageStats): void {
  target.cachedInputTokens += source.cachedInputTokens;
  target.costInputTokens += source.costInputTokens;
  target.costOutputTokens += source.costOutputTokens;
  target.costedTurns += source.costedTurns;
  target.estimatedTurns += source.estimatedTurns;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.turns += source.turns;
  target.turnsWithUsage += source.turnsWithUsage;
}

function collectToolCallSummary(events: ToolAuditEvent[]): ToolCallSummary {
  const calls = new Map<string, ToolCallAggregate>();
  let legacyCounter = 0;
  let uncorrelatedEvents = 0;

  for (const event of events) {
    if (!isToolExecutionAuditEvent(event)) {
      continue;
    }

    const callId = event.callId;
    const key = callId ?? `legacy-${legacyCounter}`;

    if (!callId) {
      legacyCounter += 1;
      uncorrelatedEvents += 1;
    }

    const current =
      calls.get(key) ??
      {
        approvalApproved: 0,
        approvalDenied: 0,
        approvalRequired: 0,
        eventCount: 0,
        lastTimestamp: event.timestamp,
        toolName: event.toolName,
      };

    current.eventCount += 1;
    current.toolName = current.toolName || event.toolName;

    if (event.timestamp >= current.lastTimestamp) {
      current.lastTimestamp = event.timestamp;
    }

    if (event.type === "tool_preflight") {
      current.preflightRisk = event.risk;
      current.toolName = event.toolName;
    } else if (event.type === "tool_start") {
      current.startedAt = event.timestamp;
      current.toolName = event.toolName;
    } else if (event.type === "tool_approval") {
      if (event.status === "required") {
        current.approvalRequired += 1;
      } else if (event.status === "approved") {
        current.approvalApproved += 1;
      } else {
        current.approvalDenied += 1;
      }
    } else {
      current.finishedAt = event.timestamp;
      current.ok = event.ok;
      current.toolName = event.toolName;
    }

    calls.set(key, current);
  }

  const summary: ToolCallSummary = {
    approvalApproved: 0,
    approvalDenied: 0,
    approvalRequired: 0,
    calls: calls.size,
    failed: 0,
    pending: 0,
    succeeded: 0,
    tools: new Map<string, ToolStats>(),
    uncorrelatedEvents,
  };

  for (const call of calls.values()) {
    summary.approvalApproved += call.approvalApproved;
    summary.approvalDenied += call.approvalDenied;
    summary.approvalRequired += call.approvalRequired;

    if (call.finishedAt === undefined) {
      summary.pending += 1;
    } else if (call.ok) {
      summary.succeeded += 1;
    } else {
      summary.failed += 1;
    }

    const toolStats =
      summary.tools.get(call.toolName) ??
      {
        approvalDenied: 0,
        approvalRequired: 0,
        calls: 0,
        failed: 0,
        lastTimestamp: call.lastTimestamp,
        pending: 0,
        succeeded: 0,
      };

    toolStats.calls += 1;
    toolStats.approvalDenied += call.approvalDenied;
    toolStats.approvalRequired += call.approvalRequired;

    if (call.finishedAt === undefined) {
      toolStats.pending += 1;
    } else if (call.ok) {
      toolStats.succeeded += 1;
    } else {
      toolStats.failed += 1;
    }

    if (call.lastTimestamp >= toolStats.lastTimestamp) {
      toolStats.lastTimestamp = call.lastTimestamp;
    }

    summary.tools.set(call.toolName, toolStats);
  }

  return summary;
}

function serializeToolCallSummary(summary: ToolCallSummary): {
  approvalEvents: {
    approved: number;
    denied: number;
    required: number;
  };
  calls: number;
  failed: number;
  pending: number;
  succeeded: number;
  tools: Array<ToolStats & { toolName: string }>;
  uncorrelatedEvents: number;
} {
  return {
    calls: summary.calls,
    succeeded: summary.succeeded,
    failed: summary.failed,
    pending: summary.pending,
    approvalEvents: {
      required: summary.approvalRequired,
      approved: summary.approvalApproved,
      denied: summary.approvalDenied,
    },
    uncorrelatedEvents: summary.uncorrelatedEvents,
    tools: [...summary.tools.entries()]
      .sort(
        ([leftName, left], [rightName, right]) =>
          right.calls - left.calls || leftName.localeCompare(rightName),
      )
      .map(([toolName, stats]) => ({ toolName, ...stats })),
  };
}

async function writeJsonExport(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildAuditMarkdownReport(input: {
  all?: boolean;
  events: ToolAuditEvent[];
  exportedAt: string;
  invalidLines: number;
  logFiles: string[];
}): string {
  const toolSummary = serializeToolCallSummary(collectToolCallSummary(input.events));
  const commandStats = [...collectProjectCommandStats(input.events).entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const recentEvents = input.events.slice(-20);
  const lines = [
    "# CCAgent Audit Report",
    "",
    `Generated: ${input.exportedAt}`,
    `Scope: ${input.all ? "all logs" : "latest log"}`,
    `Files: ${input.logFiles.length}`,
    `Events: ${input.events.length}`,
    `Invalid lines skipped: ${input.invalidLines}`,
    "",
    "## Log Files",
    "",
    ...input.logFiles.map((file) => `- .ccagent/logs/${file}`),
    "",
    "## Tool Calls",
    "",
    `- Total calls: ${toolSummary.calls}`,
    `- Succeeded: ${toolSummary.succeeded}`,
    `- Failed: ${toolSummary.failed}`,
    `- Pending: ${toolSummary.pending}`,
    `- Approval events: required=${toolSummary.approvalEvents.required} approved=${toolSummary.approvalEvents.approved} denied=${toolSummary.approvalEvents.denied}`,
    `- Uncorrelated events: ${toolSummary.uncorrelatedEvents}`,
    "",
    "| Tool | Calls | Succeeded | Failed | Pending | Approvals | Denied | Last |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  if (toolSummary.tools.length === 0) {
    lines.push("| (none) | 0 | 0 | 0 | 0 | 0 | 0 |  |");
  } else {
    for (const tool of toolSummary.tools) {
      lines.push(
        `| ${escapeMarkdownTableCell(tool.toolName)} | ${tool.calls} | ${tool.succeeded} | ${tool.failed} | ${tool.pending} | ${tool.approvalRequired} | ${tool.approvalDenied} | ${escapeMarkdownTableCell(tool.lastTimestamp)} |`,
      );
    }
  }

  lines.push(
    "",
    "## Project Commands",
    "",
    "| Command | Events | Detail | Preview | Run | Started | Blocked | Denied | Shown | Last |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );

  if (commandStats.length === 0) {
    lines.push("| (none) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |  |");
  } else {
    for (const [commandName, stats] of commandStats) {
      lines.push(
        `| ${escapeMarkdownTableCell(commandName)} | ${stats.total} | ${stats.detail} | ${stats.preview} | ${stats.run} | ${stats.started} | ${stats.blocked} | ${stats.denied} | ${stats.shown} | ${escapeMarkdownTableCell(stats.lastTimestamp)} |`,
      );
    }
  }

  lines.push("", "## Recent Events", "");

  if (recentEvents.length === 0) {
    lines.push("(No valid audit events.)");
  } else {
    recentEvents.forEach((event, index) => {
      lines.push(`${index + 1}. ${formatAuditReplayLine(event)}`);
    });
  }

  return `${lines.join("\n")}\n`;
}

function formatExportTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function sanitizeFileNamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (sanitized || "call").slice(0, 80);
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatDuration(startedAt: string | undefined, finishedAt: string | undefined): string {
  if (!startedAt || !finishedAt) {
    return "n/a";
  }

  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);

  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs < startedMs) {
    return "n/a";
  }

  return `${finishedMs - startedMs}ms`;
}

function truncate(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatProjectCommandAuditFields(
  event: Extract<ToolAuditEvent, { type: "project_command" }>,
): string {
  const parts = [`args=${truncate(JSON.stringify(event.args))}`];

  if (event.namedArgs && Object.keys(event.namedArgs).length > 0) {
    parts.push(`named=${truncate(JSON.stringify(event.namedArgs))}`);
  }

  if (event.positionalArgs !== undefined) {
    parts.push(`positional=${truncate(JSON.stringify(event.positionalArgs))}`);
  }

  if (event.expandedPromptPreview) {
    parts.push(`expanded=${truncate(JSON.stringify(event.expandedPromptPreview))}`);
  }

  return parts.join(" ");
}

function formatCallId(callId: string | undefined): string {
  return callId ? ` callId=${callId}` : "";
}

function formatToolCallList(toolCalls: string[]): string {
  return toolCalls.length > 0 ? toolCalls.join(",") : "(none)";
}

function formatTokenUsage(event: Extract<ToolAuditEvent, { type: "model_turn" }>): string {
  if (
    event.inputTokens === undefined &&
    event.outputTokens === undefined &&
    event.totalTokens === undefined &&
    event.cachedInputTokens === undefined
  ) {
    return "tokens=(unknown)";
  }

  const parts = [
    `in=${formatOptionalNumber(event.inputTokens)}`,
    `out=${formatOptionalNumber(event.outputTokens)}`,
    `total=${formatOptionalNumber(event.totalTokens)}`,
  ];

  if (event.cachedInputTokens !== undefined) {
    parts.push(`cached=${event.cachedInputTokens}`);
  }

  if (event.usageEstimated) {
    parts.push("estimated=yes");
  }

  return `tokens=${parts.join(",")}`;
}

function formatEstimatedCost(event: Extract<ToolAuditEvent, { type: "model_turn" }>): string {
  const inputUsdPerMillion = parseOptionalPositiveNumber(process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS);
  const outputUsdPerMillion = parseOptionalPositiveNumber(
    process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS,
  );

  if (
    inputUsdPerMillion === undefined ||
    outputUsdPerMillion === undefined ||
    event.inputTokens === undefined ||
    event.outputTokens === undefined
  ) {
    return "cost=(not configured)";
  }

  const costUsd =
    (event.inputTokens * inputUsdPerMillion + event.outputTokens * outputUsdPerMillion) /
    1_000_000;

  return `cost=~$${costUsd.toFixed(6)}`;
}

export function formatAggregateCost(stats: UsageStats, includeTurns: boolean): string {
  const costUsd = calculateAggregateCostUsd(stats);

  if (costUsd === undefined) {
    return "(not configured)";
  }

  const formatted = `~$${costUsd.toFixed(6)}`;

  return includeTurns ? `${formatted} (${stats.costedTurns} costed turn(s))` : formatted;
}

export function isUsageBudgetExceeded(stats: UsageStats): boolean {
  const totalTokenBudget = parseOptionalNonNegativeIntegerText(process.env.CCAGENT_MAX_TOTAL_TOKENS);
  const costBudgetUsd = parseOptionalNonNegativeNumberText(process.env.CCAGENT_MAX_COST_USD);

  if (totalTokenBudget !== undefined && stats.totalTokens > totalTokenBudget) {
    return true;
  }

  if (costBudgetUsd !== undefined) {
    const costUsd = calculateAggregateCostUsd(stats);

    if (costUsd !== undefined && costUsd > costBudgetUsd) {
      return true;
    }
  }

  return false;
}

export function formatUsageBudget(stats: UsageStats): string {
  const totalTokenBudgetText = process.env.CCAGENT_MAX_TOTAL_TOKENS;
  const costBudgetText = process.env.CCAGENT_MAX_COST_USD;
  const totalTokenBudget = parseOptionalNonNegativeIntegerText(totalTokenBudgetText);
  const costBudgetUsd = parseOptionalNonNegativeNumberText(costBudgetText);
  const invalidNames = [
    totalTokenBudgetText !== undefined && totalTokenBudget === undefined
      ? "CCAGENT_MAX_TOTAL_TOKENS"
      : "",
    costBudgetText !== undefined && costBudgetUsd === undefined ? "CCAGENT_MAX_COST_USD" : "",
  ].filter(Boolean);

  if (invalidNames.length > 0) {
    return `Budget: invalid ${invalidNames.join(", ")}`;
  }

  if (totalTokenBudget === undefined && costBudgetUsd === undefined) {
    return "Budget: (not configured)";
  }

  const parts: string[] = [];
  let exceeded = false;
  let incomplete = false;

  if (totalTokenBudget !== undefined) {
    if (stats.totalTokens > totalTokenBudget) {
      exceeded = true;
    }

    parts.push(`totalTokens=${stats.totalTokens}/${totalTokenBudget}`);
  }

  if (costBudgetUsd !== undefined) {
    const costUsd = calculateAggregateCostUsd(stats);

    if (costUsd === undefined) {
      incomplete = true;
      parts.push(`cost=(not configured)/$${costBudgetUsd.toFixed(6)}`);
    } else {
      if (costUsd > costBudgetUsd) {
        exceeded = true;
      }

      parts.push(`cost=~$${costUsd.toFixed(6)}/$${costBudgetUsd.toFixed(6)}`);
    }
  }

  const status = exceeded ? "exceeded" : incomplete ? "incomplete" : "ok";

  return `Budget: ${status} ${parts.join(" ")}`;
}

function formatAverage(value: number, count: number): string {
  if (count <= 0) {
    return "n/a";
  }

  return (value / count).toFixed(2);
}

function formatAverageCost(stats: UsageStats): string {
  const costUsd = calculateAggregateCostUsd(stats);

  if (costUsd === undefined) {
    return "(not configured)";
  }

  if (stats.costedTurns <= 0) {
    return "n/a";
  }

  return `~$${(costUsd / stats.costedTurns).toFixed(6)}`;
}

function calculateAggregateCostUsd(stats: UsageStats): number | undefined {
  const inputUsdPerMillion = parseOptionalPositiveNumber(process.env.CCAGENT_INPUT_USD_PER_1M_TOKENS);
  const outputUsdPerMillion = parseOptionalPositiveNumber(
    process.env.CCAGENT_OUTPUT_USD_PER_1M_TOKENS,
  );

  if (inputUsdPerMillion === undefined || outputUsdPerMillion === undefined) {
    return undefined;
  }

  return (
    (stats.costInputTokens * inputUsdPerMillion +
      stats.costOutputTokens * outputUsdPerMillion) /
    1_000_000
  );
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "?" : String(value);
}

function parseOptionalPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value.trim());

  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function parseOptionalNonNegativeIntegerText(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  return Number(normalized);
}

function parseOptionalNonNegativeNumberText(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  const parsed = Number(normalized);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function isToolExecutionAuditEvent(event: ToolAuditEvent): event is ToolExecutionAuditEvent {
  return (
    event.type === "tool_preflight" ||
    event.type === "tool_start" ||
    event.type === "tool_approval" ||
    event.type === "tool_finish"
  );
}

function isToolRisk(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function isWorkspaceImpact(
  value: unknown,
): value is "read-only" | "plan-only" | "workspace-write" | "shell" | "unknown" {
  return (
    value === "read-only" ||
    value === "plan-only" ||
    value === "workspace-write" ||
    value === "shell" ||
    value === "unknown"
  );
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOptionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
