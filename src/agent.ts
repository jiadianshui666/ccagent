import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createModelClient,
  type ModelClient,
  type ModelStreamEvent,
  type ModelToolDefinition,
  type ModelToolOutput,
  type ModelTurnInput,
  type ModelUsage,
} from "./model.js";
import {
  addUsageRecord,
  addUsageStats,
  createUsageStats,
  formatAggregateCost,
  formatUsageBudget,
  noopAuditLogger,
  type AuditLogger,
  type ModelTurnAuditEventInput,
  type ToolAuditEventInput,
  type UsageRecord,
  type UsageStats,
} from "./audit.js";
import {
  Conversation,
  DEFAULT_CONVERSATION_HISTORY_LIMIT,
  type ConversationCompactResult,
  type ConversationStatus,
} from "./conversation.js";
import { noopDebugLogger, type DebugLogger } from "./debug.js";
import {
  prepareAutomaticTaskContext,
  type AutomaticTaskContext,
} from "./taskContext.js";
import {
  formatRetrievalEval,
  formatRetrievalEvalInit,
  formatRetrievalEvalJson,
  formatRetrievalEvalManifestStatus,
  getRetrievalEvalManifestStatus,
  initRetrievalEvalManifest,
  runRetrievalEval,
} from "./retrievalEval.js";
import {
  createToolPreflight,
  type ToolPreflight,
  type ToolRiskLevel,
  type ToolWorkspaceImpact,
} from "./preflight.js";
import {
  evaluateWritePathPolicy,
  evaluateWritePathsPolicy,
  extractPatchPaths,
  isSafeWorkspacePath,
  type WritePathPolicyEvaluation,
} from "./pathPolicy.js";
import {
  addPlanStep,
  clearPlan,
  createEmptyPlan,
  formatPlan,
  removePlanStep,
  setPlanStepStatus,
  type PlanStepStatus,
} from "./plan.js";
import { createDefaultToolRegistry, ToolRegistry } from "./tools/registry.js";
import type { Tool, ToolContext, ToolResult, RunSubagentsOptions } from "./tools/types.js";
import {
  createEmptySession,
  type SessionData,
  type SessionPatchRecord,
  type SessionVerificationFailureRecord,
  type SessionVerificationRunRecord,
  type SessionVerificationTargetRecord,
} from "./session.js";
import {
  formatTaskState,
  formatTaskResumePrompt,
  isTaskStateFileMode,
  isTaskStateStatus,
  recordTaskPatch,
  recordTaskVerificationFailure,
  recordTaskVerificationSuccess,
  updateTaskState,
  type TaskState,
  type TaskStateFileMode,
  type TaskStateStatus,
  type TaskStateUpdate,
} from "./taskState.js";

export type AgentResponse = {
  content: string;
  streamed?: boolean;
  usage?: UsageStats;
};

export type AgentStreamEvent =
  | {
      type: "text_delta";
      delta: string;
    }
  | {
      type: "turn_start";
      kind: "user" | "tool_outputs";
      modelName: string;
      round: number;
    }
  | {
      type: "tool_preflight";
      callId?: string;
      deniedByPolicy: boolean;
      reasons: string[];
      requiresApproval: boolean;
      risk: ToolRiskLevel;
      summary: string;
      toolName: string;
      workspaceImpact: ToolWorkspaceImpact;
    }
  | {
      type: "tool_start";
      callId?: string;
      inputSummary: string;
      toolName: string;
    }
  | {
      type: "tool_approval";
      callId?: string;
      message?: string;
      status: "required" | "approved" | "denied";
      toolName: string;
    }
  | {
      type: "tool_finish";
      callId?: string;
      ok: boolean;
      summary: string;
      toolName: string;
    }
  | {
      type: "model_turn";
      budget: string;
      cachedInputTokens?: number;
      cost: string;
      cumulativeCachedInputTokens: number;
      cumulativeCost: string;
      cumulativeEstimatedTurns: number;
      cumulativeInputTokens: number;
      cumulativeOutputTokens: number;
      cumulativeTotalTokens: number;
      cumulativeTurns: number;
      cumulativeTurnsWithUsage: number;
      durationMs: number;
      inputTokens?: number;
      kind: "user" | "tool_outputs";
      modelName: string;
      outputTokens?: number;
      responseId?: string;
      round: number;
      toolCalls: string[];
      totalTokens?: number;
      usageEstimated?: boolean;
    }
  | {
      type: "tool_result";
      callId?: string;
      content: string;
      toolName: string;
    }
  | {
      type: "message";
      content: string;
    };

export type AgentStreamHandler = (event: AgentStreamEvent) => void | Promise<void>;

export type AgentHandleOptions = {
  onStreamEvent?: AgentStreamHandler;
  signal?: AbortSignal;
};

export type AgentContextOptions = {
  enabled?: boolean;
  maxChars?: number;
  maxFiles?: number;
  refreshIntervalMs?: number;
};

export type ToolApprovalRequest = {
  toolName: string;
  input: Record<string, unknown>;
  message: string;
};

export type ToolApproval = (request: ToolApprovalRequest) => Promise<boolean>;

export type ToolPolicy = {
  allowWritePaths?: string[];
  denyRiskLevels?: ToolRiskLevel[];
  denyTools?: string[];
  denyWritePaths?: string[];
  requireApprovalRiskLevels?: ToolRiskLevel[];
  requireApprovalTools?: string[];
};

const MAX_TOOL_ROUNDS = 6;
const DEFAULT_CONTEXT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_REPAIR_LOOP_ATTEMPTS = 2;
const MAX_REPAIR_LOOP_ATTEMPTS = 5;
const DEFAULT_VERIFICATION_STABILITY_RUNS = 3;
const MAX_VERIFICATION_STABILITY_RUNS = 10;

async function denyToolApproval(): Promise<boolean> {
  return false;
}

export class Agent {
  private readonly conversation = new Conversation();
  private readonly localCallIdPrefix = `local-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  private plan = createEmptyPlan();
  private lastResponseId: string | undefined;
  private lastPatch: SessionPatchRecord | undefined;
  private lastVerificationFailure: SessionVerificationFailureRecord | undefined;
  private lastVerificationRun: SessionVerificationRunRecord | undefined;
  private lastVerificationTarget: SessionVerificationTargetRecord | undefined;
  private taskState: TaskState | undefined;
  private localToolCallCount = 0;
  private automaticContextPrepared = false;
  private automaticContextInvalidated = true;
  private automaticContextLastRefreshAt = 0;
  private readonly usageTotals: UsageStats = createUsageStats();
  private readonly writtenPaths = new Set<string>();
  private depth = 0;

  constructor(
    private readonly model: ModelClient = createModelClient(),
    private readonly tools: ToolRegistry = createDefaultToolRegistry(),
    private readonly workspaceRoot: string = process.cwd(),
    private readonly approveTool: ToolApproval = denyToolApproval,
    private readonly debug: DebugLogger = noopDebugLogger,
    private readonly verifyCommand?: string,
    private readonly toolPolicy: ToolPolicy = {},
    private readonly auditLogger: AuditLogger = noopAuditLogger,
    private readonly automaticContextOptions: AgentContextOptions = {},
  ) {}

  get modelName(): string {
    return this.model.name;
  }

  get toolCount(): number {
    return this.tools.list().length;
  }

  loadSession(session: SessionData): void {
    const compacted = this.conversation.load(session.messages);
    this.plan = session.plan;
    this.lastResponseId = compacted ? undefined : session.lastResponseId;
    this.lastPatch = session.lastPatch;
    this.lastVerificationFailure = session.lastVerificationFailure;
    this.lastVerificationRun = session.lastVerificationRun;
    this.lastVerificationTarget = session.lastVerificationTarget;
    this.taskState = session.taskState;
    const messages = this.conversation.snapshot();
    this.model.restoreConversation?.(messages);
    this.debug("agent.session.loaded", {
      compacted: Boolean(compacted),
      loadedMessages: session.messages.length,
      messages: messages.length,
      planSteps: session.plan.steps.length,
      hasLastResponseId: Boolean(this.lastResponseId),
      hasLastPatch: Boolean(session.lastPatch),
      hasLastVerificationFailure: Boolean(session.lastVerificationFailure),
      hasLastVerificationRun: Boolean(session.lastVerificationRun),
      hasLastVerificationTarget: Boolean(session.lastVerificationTarget),
      hasTaskState: Boolean(session.taskState),
    });
  }

  snapshotSession(): SessionData {
    const base = createEmptySession(this.modelName);

    return {
      ...base,
      modelName: this.modelName,
      lastResponseId: this.lastResponseId,
      lastPatch: this.lastPatch,
      lastVerificationFailure: this.lastVerificationFailure,
      lastVerificationRun: this.lastVerificationRun,
      lastVerificationTarget: this.lastVerificationTarget,
      taskState: this.taskState,
      messages: this.conversation.snapshot(),
      plan: this.plan,
    };
  }

  snapshotUsage(): UsageStats {
    return { ...this.usageTotals };
  }

  snapshotWrittenPaths(): string[] {
    return [...this.writtenPaths].sort();
  }

  setTraceDepth(depth: number): void {
    this.depth = Math.max(0, Math.floor(depth));
  }

  async handleUserMessage(
    message: string,
    options: AgentHandleOptions = {},
  ): Promise<AgentResponse> {
    if (message === "/history" || message.startsWith("/history ")) {
      return {
        content: this.handleHistoryCommand(message),
      };
    }

    if (message === "/compact-status") {
      return {
        content: formatConversationStatus(this.conversation.status()),
      };
    }

    if (message === "/compact") {
      const compacted = this.conversation.compact();

      if (!compacted) {
        return {
          content: [
            "Conversation compaction not needed.",
            "",
            formatConversationStatus(this.conversation.status()),
          ].join("\n"),
        };
      }

      this.applyConversationCompaction(compacted);

      return {
        content: formatConversationCompaction(compacted),
      };
    }

    if (message === "/clear") {
      this.conversation.clear();
      this.plan = clearPlan();
      this.lastResponseId = undefined;
      this.lastPatch = undefined;
      this.lastVerificationFailure = undefined;
      this.lastVerificationRun = undefined;
      this.lastVerificationTarget = undefined;
      this.taskState = undefined;
      this.model.reset?.();

      return {
        content: "Conversation history and plan cleared. Task state cleared.",
      };
    }

    if (message === "/plan" || message.startsWith("/plan ")) {
      return {
        content: this.handlePlanCommand(message),
      };
    }

    if (message === "/task-state" || message.startsWith("/task-state ")) {
      return {
        content: this.handleTaskStateCommand(message),
      };
    }

    if (message === "/tools" || message.startsWith("/tools ")) {
      return {
        content: this.handleToolsCommand(message),
      };
    }

    if (message === "/tool" || message.startsWith("/tool ")) {
      return {
        content: this.handleToolDetailsCommand(message),
      };
    }

    if (message === "/ls" || message.startsWith("/ls ")) {
      return this.listFilesFromCommand(message.slice("/ls".length), 1);
    }

    if (message === "/tree" || message.startsWith("/tree ")) {
      return this.listFilesFromCommand(message.slice("/tree".length), 3);
    }

    if (message === "/status") {
      return this.gitStatus();
    }

    if (message === "/diff") {
      return this.gitDiff();
    }

    const userCompaction = this.conversation.add("user", message);

    if (message.startsWith("/read ")) {
      return this.rememberResponse(
        await this.readFile(message.slice("/read ".length)),
        userCompaction,
      );
    }

    if (message.startsWith("/search ")) {
      return this.rememberResponse(
        await this.searchFiles(message.slice("/search ".length)),
        userCompaction,
      );
    }

    if (message.startsWith("/suggest-context ")) {
      return this.rememberResponse(
        await this.suggestContext(message.slice("/suggest-context ".length)),
        userCompaction,
      );
    }

    if (message === "/symbols" || message.startsWith("/symbols ")) {
      return this.rememberResponse(
        await this.handleSymbolsCommand(message.slice("/symbols".length).trim()),
        userCompaction,
      );
    }

    if (message === "/index" || message.startsWith("/index ")) {
      return this.rememberResponse(
        await this.handleContextIndexCommand(message.slice("/index".length).trim()),
        userCompaction,
      );
    }

    if (message === "/verify-suggest" || message.startsWith("/verify-suggest ")) {
      return this.rememberResponse(
        await this.suggestVerification(message.slice("/verify-suggest".length).trim()),
        userCompaction,
      );
    }

    if (message === "/verify-run" || message.startsWith("/verify-run ")) {
      return this.rememberResponse(
        await this.runSuggestedVerification(message.slice("/verify-run".length).trim()),
        userCompaction,
      );
    }

    if (message === "/verify-last") {
      return this.rememberResponse(await this.runLastPatchVerification(), userCompaction);
    }

    if (message === "/verify-failure") {
      return this.rememberResponse(this.showLastVerificationFailure(), userCompaction);
    }

    if (message === "/verify-rerun") {
      return this.rememberResponse(await this.rerunLastVerificationFailure(), userCompaction);
    }

    if (message === "/verify-stability" || message.startsWith("/verify-stability ")) {
      return this.rememberResponse(
        await this.checkVerificationStability(message.slice("/verify-stability".length).trim()),
        userCompaction,
      );
    }

    if (message === "/verify-clear") {
      return this.rememberResponse(this.clearVerificationState(), userCompaction);
    }

    if (message === "/repair-last") {
      return this.rememberResponse(
        await this.repairLastVerificationFailure(options.onStreamEvent),
        userCompaction,
      );
    }

    if (message === "/repair-run") {
      return this.rememberResponse(
        await this.repairAndRerunLastVerificationFailure(options.onStreamEvent),
        userCompaction,
      );
    }

    if (message === "/repair-loop" || message.startsWith("/repair-loop ")) {
      return this.rememberResponse(
        await this.repairLoopLastVerificationFailure(
          message.slice("/repair-loop".length).trim(),
          options.onStreamEvent,
        ),
        userCompaction,
      );
    }

    if (message === "/repair-preview") {
      return this.rememberResponse(this.previewLastVerificationRepair(), userCompaction);
    }

    if (message.startsWith("/run ")) {
      return this.rememberResponse(
        await this.runShell(message.slice("/run ".length)),
        userCompaction,
      );
    }

    if (message.startsWith("/apply_patch_file ")) {
      return this.rememberResponse(
        await this.applyPatchFile(message.slice("/apply_patch_file ".length)),
        userCompaction,
      );
    }

    if (message === "/undo") {
      return this.rememberResponse(await this.undoLastPatch(), userCompaction);
    }

    if (message === "/snapshots" || message.startsWith("/snapshots ")) {
      return this.rememberResponse(
        await this.handlePatchSnapshotsCommand(message.slice("/snapshots".length).trim()),
        userCompaction,
      );
    }

    try {
      if (userCompaction) {
        this.applyConversationCompaction(userCompaction, {
          excludeLastUserMessage: message,
        });
      }

      return await this.runAgentLoop(message, options.onStreamEvent, options.signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      return {
        content: `Model call failed: ${reason}`,
      };
    }
  }

  private async runAgentLoop(
    message: string,
    onStreamEvent?: AgentStreamHandler,
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    const toolDefinitions = this.getModelToolDefinitions();
    const automaticContext = await this.prepareAutomaticContext(message);
    const events: string[] = [];
    let streamed = false;
    const emit = async (event: AgentStreamEvent): Promise<void> => {
      if (!onStreamEvent) {
        return;
      }

      streamed = true;
      await onStreamEvent(event);
    };
    this.debug("model.turn.request", {
      kind: "user",
      model: this.modelName,
      previousResponseId: this.lastResponseId ?? null,
      toolCount: toolDefinitions.length,
      messageLength: message.length,
    });
    await emit({
      type: "turn_start",
      kind: "user",
      modelName: this.modelName,
      round: 0,
    });
    let turn = await this.createModelTurn(
      {
        ...(automaticContext ? { workspaceContext: automaticContext.content } : {}),
        userMessage: message,
        previousResponseId: this.lastResponseId,
        ...(signal ? { signal } : {}),
        tools: toolDefinitions,
      },
      onStreamEvent ? emit : undefined,
      {
        kind: "user",
        round: 0,
      },
    );
    let result = turn.result;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      this.debug("model.turn.result", {
        round,
        responseId: result.responseId ?? null,
        toolCalls: result.toolCalls.map((toolCall) => toolCall.name),
        contentLength: result.content.length,
      });

      if (result.toolCalls.length === 0) {
        this.lastResponseId = result.responseId ?? this.lastResponseId;
        const content = [...events, result.content].filter(Boolean).join("\n\n");

        if (result.content.length > 0 && onStreamEvent && !turn.streamedText) {
          await emit({
            type: "text_delta",
            delta: result.content,
          });
        }

        this.syncAfterAssistantMessage(content);
        return {
          content,
          streamed,
          usage: this.snapshotUsage(),
        };
      }

      const toolOutputs: ModelToolOutput[] = [];

      let callIndex = 0;

      while (callIndex < result.toolCalls.length) {
        const toolCall = result.toolCalls[callIndex] as (typeof result.toolCalls)[number];

        if (toolCall.parseError || !this.isParallelSafeToolCall(toolCall)) {
          const output = await this.executeModelToolCall(
            toolCall,
            onStreamEvent ? emit : undefined,
          );
          toolOutputs.push({
            callId: toolCall.callId,
            output,
          });
          this.debug("tool.output", {
            round,
            name: toolCall.name,
            outputLength: output.length,
          });
          const toolEvent = `[tool] ${toolCall.name} -> ${output}`;
          events.push(toolEvent);
          await emit({
            type: "tool_result",
            callId: toolCall.callId,
            content: toolEvent,
            toolName: toolCall.name,
          });
          callIndex += 1;
          continue;
        }

        const batch = [toolCall];

        while (callIndex + batch.length < result.toolCalls.length) {
          const nextCall = result.toolCalls[callIndex + batch.length];

          if (!nextCall || nextCall.parseError || !this.isParallelSafeToolCall(nextCall)) {
            break;
          }

          batch.push(nextCall);
        }

        for (const batchedCall of batch) {
          this.debug("tool.call", {
            round,
            name: batchedCall.name,
            arguments: batchedCall.arguments,
            parallel: true,
          });
        }

        const parallelOutputs = await Promise.all(
          batch.map((batchedCall) =>
            this.executeParallelSafeToolCall(batchedCall, onStreamEvent ? emit : undefined),
          ),
        );

        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          const batchedCall = batch[batchIndex];
          const output = parallelOutputs[batchIndex] ?? "null";
          toolOutputs.push({
            callId: batchedCall.callId,
            output,
          });
          this.debug("tool.output", {
            round,
            name: batchedCall.name,
            outputLength: output.length,
            parallel: true,
          });
          const toolEvent = `[tool] ${batchedCall.name} -> ${output}`;
          events.push(toolEvent);
          await emit({
            type: "tool_result",
            callId: batchedCall.callId,
            content: toolEvent,
            toolName: batchedCall.name,
          });
        }

        callIndex += batch.length;
      }

      this.debug("model.turn.request", {
        kind: "tool_outputs",
        model: this.modelName,
        previousResponseId: result.responseId ?? null,
        toolOutputCount: toolOutputs.length,
      });
      await emit({
        type: "turn_start",
        kind: "tool_outputs",
        modelName: this.modelName,
        round: round + 1,
      });
      turn = await this.createModelTurn(
        {
          previousResponseId: result.responseId,
          toolOutputs,
          ...(signal ? { signal } : {}),
          tools: toolDefinitions,
        },
        onStreamEvent ? emit : undefined,
        {
          kind: "tool_outputs",
          round: round + 1,
        },
      );
      result = turn.result;
    }

    const stopMessage = "Stopped because the tool loop reached its limit.";
    const content = [...events, stopMessage].join("\n\n");

    await emit({
      type: "message",
      content: stopMessage,
    });

    this.syncAfterAssistantMessage(content);
    return {
      content,
      streamed,
      usage: this.snapshotUsage(),
    };
  }

  private async createModelTurn(
    input: ModelTurnInput,
    onStreamEvent?: AgentStreamHandler,
    audit?: {
      kind: "user" | "tool_outputs";
      round: number;
    },
  ): Promise<{ result: Awaited<ReturnType<ModelClient["createTurn"]>>; streamedText: boolean }> {
    const startedAt = Date.now();

    if (!onStreamEvent || !this.model.createTurnStream) {
      const result = await this.model.createTurn(input);
      const durationMs = Date.now() - startedAt;

      await this.recordModelTurnAudit(input, result, false, durationMs, audit);
      await this.recordAndEmitModelTurnUsage(result, durationMs, audit, onStreamEvent);

      return {
        result,
        streamedText: false,
      };
    }

    let streamedText = false;
    const result = await this.model.createTurnStream(input, async (event) => {
      if (event.type === "text_delta" && event.delta.length > 0) {
        streamedText = true;
        await onStreamEvent(toAgentStreamEvent(event));
      }
    });
    const durationMs = Date.now() - startedAt;

    await this.recordModelTurnAudit(input, result, streamedText, durationMs, audit);
    await this.recordAndEmitModelTurnUsage(result, durationMs, audit, onStreamEvent);

    return {
      result,
      streamedText,
    };
  }

  private async prepareAutomaticContext(message: string): Promise<AutomaticTaskContext | null> {
    if (this.automaticContextOptions.enabled !== true) {
      return null;
    }

    const now = Date.now();
    const refreshIntervalMs = this.automaticContextOptions.refreshIntervalMs
      ?? DEFAULT_CONTEXT_REFRESH_INTERVAL_MS;
    const shouldRefresh = !this.automaticContextPrepared
      || this.automaticContextInvalidated
      || now - this.automaticContextLastRefreshAt >= Math.max(0, refreshIntervalMs);

    try {
      const context = await prepareAutomaticTaskContext(this.workspaceRoot, message, {
        maxChars: this.automaticContextOptions.maxChars,
        maxFiles: this.automaticContextOptions.maxFiles,
        refresh: shouldRefresh,
      });
      this.automaticContextPrepared = true;
      this.automaticContextInvalidated = false;
      this.automaticContextLastRefreshAt = Date.now();
      this.debug("context.automatic", {
        cacheStatus: context?.cacheStatus ?? "missing",
        files: context?.files ?? [],
        retrievalMode: context?.retrievalMode ?? "none",
        refreshed: context?.refreshed ?? shouldRefresh,
        semanticFiles: context?.semanticFiles ?? 0,
        staleFiles: context?.staleFiles ?? 0,
      });
      return context;
    } catch (error) {
      this.automaticContextPrepared = true;
      this.automaticContextInvalidated = false;
      this.automaticContextLastRefreshAt = Date.now();
      this.debug("context.automatic.failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private invalidateAutomaticContext(reason: string): void {
    if (this.automaticContextOptions.enabled !== true) {
      return;
    }

    this.automaticContextInvalidated = true;
    this.debug("context.automatic.invalidated", { reason });
  }

  private rememberResponse(
    response: AgentResponse,
    priorCompaction: ConversationCompactResult | null = null,
  ): AgentResponse {
    const responseCompaction = this.conversation.add("assistant", response.content);

    if (priorCompaction || responseCompaction) {
      this.applyConversationCompaction(responseCompaction ?? priorCompaction);
    }

    return response;
  }

  private syncAfterAssistantMessage(content: string): void {
    const compacted = this.conversation.add("assistant", content);

    if (compacted) {
      this.applyConversationCompaction(compacted);
    }
  }

  private applyConversationCompaction(
    compacted: ConversationCompactResult | null,
    options: {
      excludeLastUserMessage?: string;
    } = {},
  ): void {
    if (!compacted) {
      return;
    }

    let messages = this.conversation.snapshot();
    let excludedLastUserMessage = false;

    if (options.excludeLastUserMessage !== undefined) {
      const lastMessage = messages.at(-1);

      if (lastMessage?.role === "user" && lastMessage.content === options.excludeLastUserMessage) {
        messages = messages.slice(0, -1);
        excludedLastUserMessage = true;
      }
    }

    this.lastResponseId = undefined;
    this.model.restoreConversation?.(messages);
    this.debug("conversation.compact", {
      ...compacted,
      excludedLastUserMessage,
      restoredMessages: messages.length,
    });
  }

  private handlePlanCommand(message: string): string {
    const command = message.slice("/plan".length).trim();

    if (command.length === 0 || command === "show") {
      return formatPlan(this.plan);
    }

    if (command === "clear") {
      this.plan = clearPlan();
      this.debug("plan.clear");
      return formatPlan(this.plan);
    }

    if (command.startsWith("add ")) {
      const content = command.slice("add ".length).trim();

      if (content.length === 0) {
        return "Plan step cannot be empty.";
      }

      this.plan = addPlanStep(this.plan, content);
      this.debug("plan.add", { content });
      return formatPlan(this.plan);
    }

    if (command.startsWith("start ")) {
      return this.updatePlanStepFromCommand(command.slice("start ".length), "in_progress");
    }

    if (command.startsWith("doing ")) {
      return this.updatePlanStepFromCommand(command.slice("doing ".length), "in_progress");
    }

    if (command.startsWith("done ")) {
      return this.updatePlanStepFromCommand(command.slice("done ".length), "completed");
    }

    if (command.startsWith("pending ")) {
      return this.updatePlanStepFromCommand(command.slice("pending ".length), "pending");
    }

    if (command.startsWith("drop ")) {
      const id = parsePlanStepId(command.slice("drop ".length));

      if (id === null) {
        return "Expected a numeric plan step id. Example: /plan drop 2";
      }

      const nextPlan = removePlanStep(this.plan, id);

      if (!nextPlan) {
        return `Plan step not found: ${id}`;
      }

      this.plan = nextPlan;
      this.debug("plan.drop", { id });
      return formatPlan(this.plan);
    }

    return [
      "Unknown plan command.",
      "Usage:",
      "  /plan",
      "  /plan add <step>",
      "  /plan start <id>",
      "  /plan done <id>",
      "  /plan pending <id>",
      "  /plan drop <id>",
      "  /plan clear",
    ].join("\n");
  }

  private handleTaskStateCommand(message: string): string {
    const command = message.slice("/task-state".length).trim();

    if (command.length === 0 || command === "show") {
      return formatTaskState(this.taskState);
    }

    if (command === "resume" || command === "prompt") {
      return formatTaskResumePrompt({
        lastPatch: this.lastPatch,
        lastVerificationFailure: this.lastVerificationFailure,
        lastVerificationTarget: this.lastVerificationTarget,
        plan: this.plan,
        taskState: this.taskState,
      });
    }

    if (command === "clear") {
      this.taskState = undefined;
      this.debug("task_state.clear");
      return formatTaskState(this.taskState);
    }

    if (command.startsWith("set ")) {
      return this.updateTaskStateFromCommand({
        objective: command.slice("set ".length),
        status: "active",
      });
    }

    if (command.startsWith("status ")) {
      const status = command.slice("status ".length).trim();

      if (!isTaskStateStatus(status)) {
        return "Expected task status: active, blocked, or complete.";
      }

      return this.updateTaskStateFromCommand({ status });
    }

    if (command.startsWith("step ")) {
      return this.updateTaskStateFromCommand({
        currentStep: command.slice("step ".length),
      });
    }

    if (command.startsWith("note ")) {
      return this.updateTaskStateFromCommand({
        summary: command.slice("note ".length),
      });
    }

    if (command.startsWith("files ")) {
      const raw = command.slice("files ".length).trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      let fileMode: TaskStateFileMode = "replace";
      let files = parts;

      if (parts[0]?.startsWith("--mode=")) {
        const mode = parts[0].slice("--mode=".length);

        if (!isTaskStateFileMode(mode)) {
          return "Expected file mode: keep, replace, merge, or clear.";
        }

        fileMode = mode;
        files = parts.slice(1);
      }

      return this.updateTaskStateFromCommand({
        fileMode,
        files,
      });
    }

    return [
      "Unknown task-state command.",
      "Usage:",
      "  /task-state",
      "  /task-state resume",
      "  /task-state set <objective>",
      "  /task-state status <active|blocked|complete>",
      "  /task-state step <current step>",
      "  /task-state note <summary>",
      "  /task-state files [--mode=replace|merge|clear] <paths...>",
      "  /task-state clear",
    ].join("\n");
  }

  private updateTaskStateFromCommand(update: TaskStateUpdate): string {
    const next = this.applyTaskStateUpdate(update);

    if (!next) {
      return "Task objective is required first. Use /task-state set <objective>.";
    }

    return formatTaskState(this.taskState);
  }

  private applyTaskStateUpdate(update: TaskStateUpdate): TaskState | undefined {
    const next = updateTaskState(this.taskState, update);

    if (!next) {
      return undefined;
    }

    this.taskState = next;
    this.debug("task_state.update", {
      files: next.files.length,
      status: next.status,
    });

    return next;
  }

  private handleHistoryCommand(message: string): string {
    const request = message.slice("/history".length).trim();

    if (request.length === 0) {
      return this.conversation.format({ limit: DEFAULT_CONVERSATION_HISTORY_LIMIT });
    }

    if (request === "--all") {
      return this.conversation.format();
    }

    if (!/^\d+$/.test(request)) {
      return formatHistoryUsage();
    }

    const limit = Number(request);

    if (limit < 1 || limit > 100) {
      return formatHistoryUsage();
    }

    return this.conversation.format({ limit });
  }

  private updatePlanStepFromCommand(rawId: string, status: PlanStepStatus): string {
    const id = parsePlanStepId(rawId);

    if (id === null) {
      return `Expected a numeric plan step id. Example: /plan ${statusToCommand(status)} 1`;
    }

    const nextPlan = setPlanStepStatus(this.plan, id, status);

    if (!nextPlan) {
      return `Plan step not found: ${id}`;
    }

    this.plan = nextPlan;
    this.debug("plan.status", { id, status });
    return formatPlan(this.plan);
  }

  private getModelToolDefinitions(): ModelToolDefinition[] {
    return this.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private handleToolsCommand(message: string): string {
    const request = message.slice("/tools".length).trim();

    if (request.length === 0) {
      return this.formatToolsSummary();
    }

    if (request === "--verbose") {
      return this.formatToolsVerbose();
    }

    return [
      "Usage: /tools [--verbose]",
      "       /tool <name>",
    ].join("\n");
  }

  private formatToolsSummary(): string {
    const groups = new Map<string, Tool[]>();

    for (const tool of this.tools.list()) {
      const groupName = this.formatToolGroupName(this.getToolBasePreflight(tool.name).workspaceImpact);
      const groupTools = groups.get(groupName) ?? [];

      groupTools.push(tool);
      groups.set(groupName, groupTools);
    }

    const lines = [
      "Tools summary",
      "Use /tools --verbose for descriptions, or /tool <name> for schema and policy details.",
      "",
    ];

    for (const [groupName, tools] of groups) {
      lines.push(`${groupName}:`);

      for (const tool of tools) {
        const preflight = this.getToolBasePreflight(tool.name);
        lines.push(
          `  ${tool.name.padEnd(18)} risk=${preflight.risk} behavior=${this.formatToolBehaviorTag(tool.name)}`,
        );
      }

      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  private formatToolsVerbose(): string {
    return [
      "Tools verbose",
      "Use /tool <name> for full parameter schema and policy details.",
      "",
      ...this.tools.list().flatMap((tool) => {
        const preflight = this.getToolBasePreflight(tool.name);

        return [
          `- ${tool.name}`,
          `  description: ${tool.description}`,
          `  risk: ${preflight.risk}`,
          `  workspace impact: ${preflight.workspaceImpact}`,
          `  behavior: ${this.formatToolEffectiveBehavior(tool.name)}`,
        ];
      }),
    ].join("\n");
  }

  private formatToolGroupName(workspaceImpact: ToolPreflight["workspaceImpact"]): string {
    if (workspaceImpact === "read-only") {
      return "Read-only tools";
    }

    if (workspaceImpact === "plan-only") {
      return "Plan tools";
    }

    if (workspaceImpact === "workspace-write") {
      return "Workspace edit tools";
    }

    if (workspaceImpact === "shell") {
      return "Shell tools";
    }

    return "Other tools";
  }

  private formatToolBehaviorTag(name: string): string {
    const tool = this.tools.get(name);
    const basePreflight = this.getToolBasePreflight(name);

    if (this.isToolDenied(name) || this.isToolRiskDenied(basePreflight.risk)) {
      return "blocked";
    }

    if (
      (isPatchTool(name) && this.hasWritePathPolicy()) ||
      tool?.approvalMessage ||
      this.isToolApprovalRequired(name) ||
      this.isToolRiskApprovalRequired(basePreflight.risk)
    ) {
      return "approval";
    }

    return "auto";
  }

  private handleToolDetailsCommand(message: string): string {
    const name = message.slice("/tool".length).trim();

    if (name.length === 0) {
      return [
        "Usage: /tool <name>",
        "",
        "Available tools:",
        ...this.tools.list().map((tool) => `- ${tool.name}`),
      ].join("\n");
    }

    const tool = this.tools.get(name);

    if (!tool) {
      return [
        `Unknown tool: ${name}`,
        "",
        "Available tools:",
        ...this.tools.list().map((availableTool) => `- ${availableTool.name}`),
      ].join("\n");
    }

    const basePreflight = this.getToolBasePreflight(tool.name);
    const deniedByToolName = this.isToolDenied(tool.name);
    const deniedByRisk = this.isToolRiskDenied(basePreflight.risk);
    const approvalByToolName = this.isToolApprovalRequired(tool.name);
    const approvalByRisk = this.isToolRiskApprovalRequired(basePreflight.risk);

    return [
      `Tool: ${tool.name}`,
      `Description: ${tool.description}`,
      "",
      "Policy:",
      `- base risk: ${basePreflight.risk}`,
      `- workspace impact: ${basePreflight.workspaceImpact}`,
      `- denied: ${deniedByToolName || deniedByRisk ? "yes" : "no"}`,
      `- denied by tool policy: ${deniedByToolName ? "yes" : "no"}`,
      `- denied by risk policy: ${deniedByRisk ? "yes" : "no"}`,
      `- approval required by policy: ${approvalByToolName || approvalByRisk ? "yes" : "no"}`,
      `- approval required by tool policy: ${approvalByToolName ? "yes" : "no"}`,
      `- approval required by risk policy: ${approvalByRisk ? "yes" : "no"}`,
      `- built-in approval prompt: ${tool.approvalMessage ? "yes" : "no"}`,
      `- effective behavior: ${this.formatToolEffectiveBehavior(tool.name)}`,
      "",
      "Parameters:",
      JSON.stringify(tool.parameters, null, 2),
    ].join("\n");
  }

  private async executeModelToolCall(toolCall: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    rawArguments: string;
    parseError?: string;
  }, onStreamEvent?: AgentStreamHandler): Promise<string> {
    const callId = toolCall.callId || this.createLocalCallId(toolCall.name);

    if (toolCall.parseError) {
      const inputSummary = truncateForDisplay(toolCall.rawArguments, 300);
      const preflight = createToolPreflight({
        input: {
          rawArguments: toolCall.rawArguments,
        },
        toolName: toolCall.name,
      });
      const result: ToolResult = {
        ok: false,
        error: `Invalid tool arguments: ${toolCall.parseError}`,
      };

      await emitToolPreflight(onStreamEvent, toolCall.name, preflight, callId);
      await this.recordAudit({
        type: "tool_preflight",
        callId,
        toolName: toolCall.name,
        ...preflight,
      });
      await emitToolStart(onStreamEvent, toolCall.name, inputSummary, callId);
      await this.recordAudit({
        type: "tool_start",
        callId,
        toolName: toolCall.name,
        inputSummary,
      });
      await emitToolFinish(onStreamEvent, toolCall.name, result, callId);
      await this.recordAudit({
        type: "tool_finish",
        callId,
        toolName: toolCall.name,
        ok: false,
        summary: formatToolResultSummary(result),
      });

      return JSON.stringify({
        ok: false,
        error: `Invalid tool arguments: ${toolCall.parseError}`,
        rawArguments: toolCall.rawArguments,
      });
    }

    const result = await this.executeTool(
      toolCall.name,
      toolCall.arguments,
      onStreamEvent,
      callId,
    );

    return JSON.stringify(result, null, 2);
  }

  private isParallelSafeToolCall(toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  }): boolean {
    const basePreflight = createToolPreflight({
      input: toolCall.arguments,
      toolName: toolCall.name,
    });

    if (basePreflight.workspaceImpact !== "read-only") {
      return false;
    }

    if (this.isToolDenied(toolCall.name) || this.isToolRiskDenied(basePreflight.risk)) {
      return false;
    }

    if (
      this.isToolApprovalRequired(toolCall.name) ||
      this.isToolRiskApprovalRequired(basePreflight.risk)
    ) {
      return false;
    }

    const tool = this.tools.get(toolCall.name);

    return !tool?.approvalMessage?.(toolCall.arguments);
  }

  private async executeParallelSafeToolCall(
    toolCall: {
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    },
    onStreamEvent?: AgentStreamHandler,
  ): Promise<string> {
    const name = toolCall.name;
    const input = toolCall.arguments;
    const callId = toolCall.callId || this.createLocalCallId(name);
    const inputSummary = formatToolInputSummary(input);
    const preflight = createToolPreflight({
      input,
      toolName: name,
    });

    this.debug("tool.execute", { name, input, parallel: true });
    await emitToolPreflight(onStreamEvent, name, preflight, callId);
    await this.recordAudit({
      type: "tool_preflight",
      callId,
      toolName: name,
      ...preflight,
    });
    await emitToolStart(onStreamEvent, name, inputSummary, callId);
    await this.recordAudit({
      type: "tool_start",
      callId,
      toolName: name,
      inputSummary,
    });

    const result = await this.tools.execute(name, input, this.buildToolContext());
    await emitToolFinish(onStreamEvent, name, result, callId);
    await this.recordAudit({
      type: "tool_finish",
      callId,
      toolName: name,
      ok: result.ok,
      summary: formatToolResultSummary(result),
    });
    this.debug("tool.result", summarizeToolResult(name, result));

    return JSON.stringify(result, null, 2);
  }

  private buildToolContext(): ToolContext {
    return {
      workspaceRoot: this.workspaceRoot,
      updatePlan: (plan) => {
        this.plan = plan;
        this.debug("plan.update_tool", {
          steps: plan.steps.length,
          inProgressCount: plan.steps.filter((step) => step.status === "in_progress").length,
        });
      },
      updateTaskState: (update) => this.applyTaskStateUpdate(update),
      runSubagent: (prompt) => this.runSubagent(prompt),
      runSubagents: (prompts, options) => this.runSubagents(prompts, options),
    };
  }

  private buildSubagentToolRegistry(writable = true): ToolRegistry {
    const writableTools = new Set(["edit", "apply_patch", "reverse_patch"]);
    const tools = createDefaultToolRegistry()
      .list()
      .filter((tool) => {
        const preflight = createToolPreflight({ toolName: tool.name, input: {} });
        return (
          preflight.workspaceImpact === "read-only" ||
          (writable && writableTools.has(tool.name))
        );
      });

    return new ToolRegistry(tools);
  }

  private async runSubagent(prompt: string): Promise<string> {
    const childModel = this.model.createChild?.() ?? this.model;
    const child = new Agent(
      childModel,
      this.buildSubagentToolRegistry(),
      this.workspaceRoot,
      this.approveTool,
      this.debug,
      undefined,
      undefined,
      this.auditLogger,
    );
    child.setTraceDepth(this.depth + 1);
    const response = await child.handleUserMessage(buildSubagentPrompt(prompt));
    this.adoptSubagentPatch(child);
    this.adoptSubagentUsage(child);
    return response.content;
  }

  private async runSubagents(
    prompts: string[],
    options: RunSubagentsOptions = {},
  ): Promise<string[]> {
    const write = options.write === true;
    const children = await Promise.all(
      prompts.map(async (prompt) => {
        const childModel = this.model.createChild?.() ?? this.model;
        const child = new Agent(
          childModel,
          this.buildSubagentToolRegistry(write),
          this.workspaceRoot,
          this.approveTool,
          this.debug,
          undefined,
          undefined,
          this.auditLogger,
        );
        child.setTraceDepth(this.depth + 1);
        const response = await child.handleUserMessage(buildSubagentPrompt(prompt));
        return { child, content: response.content };
      }),
    );

    for (const { child } of children) {
      this.adoptSubagentUsage(child);
    }

    if (write) {
      const conflicts = detectWrittenPathConflicts(
        children.map(({ child }) => child.snapshotWrittenPaths()),
      );

      if (conflicts.length > 0) {
        throw new Error(
          `Parallel subagents wrote conflicting paths: ${conflicts.join(", ")}. Re-run those edits serially.`,
        );
      }

      for (const { child } of children) {
        this.adoptSubagentPatch(child);
      }
    }

    return children.map(({ content }) => content);
  }

  private adoptSubagentPatch(child: Agent): void {
    const lastPatch = child.snapshotSession().lastPatch;

    if (!lastPatch) {
      return;
    }

    this.lastPatch = lastPatch;
    this.taskState = recordTaskPatch(this.taskState, lastPatch);
    this.debug("subagent.patch_adopted", { paths: lastPatch.paths });
  }

  private adoptSubagentUsage(child: Agent): void {
    const usage = child.snapshotUsage();

    addUsageStats(this.usageTotals, usage);
    this.debug("subagent.usage_adopted", {
      turns: usage.turns,
      totalTokens: usage.totalTokens,
    });
  }

  private async executeTool(
    name: string,
    input: Record<string, unknown>,
    onStreamEvent?: AgentStreamHandler,
    callId = this.createLocalCallId(name),
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    const inputSummary = formatToolInputSummary(input);
    const basePreflight = createToolPreflight({
      input,
      toolName: name,
    });
    const writePathPolicy = this.evaluateWritePathPolicy(name, input);
    const deniedByPolicy =
      this.isToolDenied(name) ||
      this.isToolRiskDenied(basePreflight.risk) ||
      !writePathPolicy.ok;
    const approvalMessage =
      tool?.approvalMessage?.(input) ??
      (this.isToolApprovalRequired(name) || this.isToolRiskApprovalRequired(basePreflight.risk)
        ? formatPolicyApprovalMessage(name, input)
        : null);
    const preflight = createToolPreflight({
      deniedByPolicy,
      input,
      requiresApproval: Boolean(approvalMessage),
      toolName: name,
    });

    this.debug("tool.execute", { name, input });
    await emitToolPreflight(onStreamEvent, name, preflight, callId);
    await this.recordAudit({
      type: "tool_preflight",
      callId,
      toolName: name,
      ...preflight,
    });
    await emitToolStart(onStreamEvent, name, inputSummary, callId);
    await this.recordAudit({
      type: "tool_start",
      callId,
      toolName: name,
      inputSummary,
    });

    if (deniedByPolicy) {
      const deniedByPolicyResult: ToolResult = {
        ok: false,
        error: formatPolicyDeniedError(name, writePathPolicy),
      };
      this.debug("tool.policy.denied", { name, writePathPolicy });
      await emitToolFinish(onStreamEvent, name, deniedByPolicyResult, callId);
      await this.recordAudit({
        type: "tool_finish",
        callId,
        toolName: name,
        ok: false,
        summary: formatToolResultSummary(deniedByPolicyResult),
      });
      return deniedByPolicyResult;
    }

    if (approvalMessage) {
      this.debug("tool.approval.required", { name });
      await emitToolApproval(onStreamEvent, name, "required", approvalMessage, callId);
      await this.recordAudit({
        type: "tool_approval",
        callId,
        toolName: name,
        status: "required",
      });
      const approved = await this.approveTool({
        toolName: name,
        input,
        message: approvalMessage,
      });
      this.debug("tool.approval.result", { name, approved });
      await emitToolApproval(onStreamEvent, name, approved ? "approved" : "denied", undefined, callId);
      await this.recordAudit({
        type: "tool_approval",
        callId,
        toolName: name,
        status: approved ? "approved" : "denied",
      });

      if (!approved) {
        const deniedResult: ToolResult = {
          ok: false,
          error: `User denied approval for ${name}.`,
        };
        await emitToolFinish(onStreamEvent, name, deniedResult, callId);
        await this.recordAudit({
          type: "tool_finish",
          callId,
          toolName: name,
          ok: false,
          summary: formatToolResultSummary(deniedResult),
        });
        return deniedResult;
      }
    }

    const result = await this.tools.execute(name, input, this.buildToolContext());
    await emitToolFinish(onStreamEvent, name, result, callId);
    await this.recordAudit({
      type: "tool_finish",
      callId,
      toolName: name,
      ok: result.ok,
      summary: formatToolResultSummary(result),
    });
    let finalResult = result;

    if (!result.ok) {
      finalResult = await this.refreshStaleEditContext(name, input, result);
    }

    if ((name === "apply_patch" || name === "edit") && result.ok) {
      finalResult = this.verifyCommand
        ? await this.runVerificationAfterPatch(result, onStreamEvent)
        : await this.appendSuggestedVerificationAfterPatch(result);
    }

    if (result.ok) {
      const patch =
        name === "apply_patch" && typeof input.patch === "string"
          ? input.patch
          : name === "edit" && typeof result.metadata?.patch === "string"
            ? result.metadata.patch
            : undefined;

      if (patch) {
        this.rememberPatch(patch, result.metadata);
      }
    }

    if (name === "reverse_patch" && result.ok) {
      this.lastPatch = undefined;
    }

    if (name === "restore_patch_snapshot" && result.ok) {
      this.lastPatch = undefined;
    }

    if (
      result.ok &&
      (basePreflight.workspaceImpact === "workspace-write" || basePreflight.workspaceImpact === "shell")
    ) {
      this.invalidateAutomaticContext(`${name} succeeded`);
    }

    this.debug("tool.result", summarizeToolResult(name, finalResult));
    return finalResult;
  }

  private async refreshStaleEditContext(
    name: string,
    input: Record<string, unknown>,
    result: ToolResult,
  ): Promise<ToolResult> {
    if (result.ok) {
      return result;
    }

    const stale = /hunks did not match|not found|matches \d+ locations|does not exist in index/i.test(result.error);

    if (!stale) {
      return result;
    }

    const paths = this.collectEditPaths(name, input);

    if (paths.length === 0) {
      return result;
    }

    const workspaceRoot = resolve(this.workspaceRoot);
    const target = paths[0];

    if (!isSafeWorkspacePath(workspaceRoot, target)) {
      return result;
    }

    try {
      const content = await readFile(resolve(workspaceRoot, target), "utf8");

      return {
        ok: false,
        error: [
          result.error,
          "",
          `Reread current content of ${target} for a corrected retry:`,
          truncateForDisplay(content, 12000),
        ].join("\n"),
      };
    } catch {
      return result;
    }
  }

  private collectEditPaths(name: string, input: Record<string, unknown>): string[] {
    if (name === "edit" && typeof input.path === "string" && input.path.trim().length > 0) {
      return [input.path.trim()];
    }

    if ((name === "apply_patch" || name === "reverse_patch") && typeof input.patch === "string") {
      return extractPatchPaths(input.patch);
    }

    return [];
  }

  private async appendSuggestedVerificationAfterPatch(patchResult: ToolResult): Promise<ToolResult> {
    if (!patchResult.ok) {
      return patchResult;
    }

    const paths = Array.isArray(patchResult.metadata?.paths)
      ? patchResult.metadata.paths.filter((path): path is string => typeof path === "string")
      : [];
    const suggested = await this.tools.execute(
      "suggest_verification",
      { paths },
      {
        workspaceRoot: this.workspaceRoot,
        updatePlan: (plan) => {
          this.plan = plan;
        },
        updateTaskState: (update) => this.applyTaskStateUpdate(update),
      },
    );

    if (!suggested.ok) {
      return {
        ok: true,
        content: [
          patchResult.content,
          "",
          "Verification suggestions failed:",
          suggested.error,
        ].join("\n"),
        metadata: {
          ...patchResult.metadata,
          verificationSuggestions: {
            ok: false,
            error: suggested.error,
          },
        },
      };
    }

    const commandText = paths.length > 0 ? `/verify-run ${paths.join(" ")}` : "/verify-run";

    return {
      ok: true,
      content: [
        patchResult.content,
        "",
        "Suggested verification:",
        suggested.content,
        "",
        `Run suggested commands with approval: ${commandText}`,
      ].join("\n"),
      metadata: {
        ...patchResult.metadata,
        verificationSuggestions: {
          commandCount: suggested.metadata?.commandCount ?? 0,
          commands: suggested.metadata?.commands ?? [],
          ok: true,
          source: suggested.metadata?.source ?? "unknown",
        },
      },
    };
  }

  private async runVerificationAfterPatch(
    patchResult: ToolResult,
    onStreamEvent?: AgentStreamHandler,
  ): Promise<ToolResult> {
    if (!patchResult.ok || !this.verifyCommand) {
      return patchResult;
    }

    this.debug("verification.run", { command: this.verifyCommand });
    const callId = this.createLocalCallId("run_shell");
    const input = { command: this.verifyCommand };
    const inputSummary = formatToolInputSummary(input);
    const basePreflight = createToolPreflight({
      input,
      toolName: "run_shell",
    });
    const deniedByPolicy =
      this.isToolDenied("run_shell") || this.isToolRiskDenied(basePreflight.risk);
    const preflight = createToolPreflight({
      deniedByPolicy,
      input,
      toolName: "run_shell",
    });
    await emitToolPreflight(onStreamEvent, "run_shell", preflight, callId);
    await this.recordAudit({
      type: "tool_preflight",
      callId,
      toolName: "run_shell",
      ...preflight,
    });
    await this.recordAudit({
      type: "tool_start",
      callId,
      toolName: "run_shell",
      inputSummary,
    });
    await emitToolStart(onStreamEvent, "run_shell", inputSummary, callId);

    if (deniedByPolicy) {
      const deniedResult: ToolResult = {
        ok: false,
        error: "Verification command was blocked by tool policy.",
      };
      await emitToolFinish(onStreamEvent, "run_shell", deniedResult, callId);
      await this.recordAudit({
        type: "tool_finish",
        callId,
        toolName: "run_shell",
        ok: false,
        summary: formatToolResultSummary(deniedResult),
      });
      this.debug("verification.policy.denied", { command: this.verifyCommand });

      return {
        ok: true,
        content: [
          patchResult.content,
          "",
          "Verification blocked by policy:",
          deniedResult.error,
        ].join("\n"),
        metadata: {
          ...patchResult.metadata,
          verification: {
            command: this.verifyCommand,
            ok: false,
            error: deniedResult.error,
          },
        },
      };
    }

    const verifyResult = await this.tools.execute(
      "run_shell",
      input,
      {
        workspaceRoot: this.workspaceRoot,
        updatePlan: (plan) => {
          this.plan = plan;
        },
        updateTaskState: (update) => this.applyTaskStateUpdate(update),
      },
    );
    await emitToolFinish(onStreamEvent, "run_shell", verifyResult, callId);
    await this.recordAudit({
      type: "tool_finish",
      callId,
      toolName: "run_shell",
      ok: verifyResult.ok,
      summary: formatToolResultSummary(verifyResult),
    });
    this.debug("verification.result", summarizeToolResult("run_shell", verifyResult));

    if (!verifyResult.ok) {
      return {
        ok: true,
        content: [
          patchResult.content,
          "",
          "Verification failed to start:",
          verifyResult.error,
        ].join("\n"),
        metadata: {
          ...patchResult.metadata,
          verification: {
            command: this.verifyCommand,
            ok: false,
            error: verifyResult.error,
          },
        },
      };
    }

    const paths = Array.isArray(patchResult.metadata?.paths)
      ? patchResult.metadata.paths.filter((path): path is string => typeof path === "string")
      : [];
    this.taskState = recordTaskVerificationSuccess(this.taskState, {
      command: this.verifyCommand,
      paths,
      recordedAt: new Date().toISOString(),
    });

    return {
      ok: true,
      content: [
        patchResult.content,
        "",
        "Verification command:",
        this.verifyCommand,
        "",
        verifyResult.content,
      ].join("\n"),
      metadata: {
        ...patchResult.metadata,
        verification: {
          command: this.verifyCommand,
          ok: true,
          metadata: verifyResult.metadata ?? {},
        },
      },
    };
  }

  private async readFile(path: string): Promise<AgentResponse> {
    const result = await this.executeTool("read_file", { path });

    if (!result.ok) {
      return {
        content: `Tool read_file failed: ${result.error}`,
      };
    }

    const displayPath =
      typeof result.metadata?.path === "string" ? result.metadata.path : path.trim();

    return {
      content: `Tool read_file succeeded: ${displayPath}\n\n${result.content}`,
    };
  }

  private async searchFiles(query: string): Promise<AgentResponse> {
    const result = await this.executeTool("search_files", { query });

    if (!result.ok) {
      return {
        content: `Tool search_files failed: ${result.error}`,
      };
    }

    return {
      content: `Tool search_files succeeded:\n\n${result.content}`,
    };
  }

  private async suggestContext(query: string): Promise<AgentResponse> {
    const result = await this.executeTool("suggest_context", { query });

    if (!result.ok) {
      return {
        content: `Tool suggest_context failed: ${result.error}`,
      };
    }

    return {
      content: `Tool suggest_context succeeded:\n\n${result.content}`,
    };
  }

  private async suggestVerification(request: string): Promise<AgentResponse> {
    const paths = request.split(/\s+/).filter(Boolean);
    const result = await this.executeTool("suggest_verification", { paths });

    if (!result.ok) {
      return {
        content: `Tool suggest_verification failed: ${result.error}`,
      };
    }

    return {
      content: `Tool suggest_verification succeeded:\n\n${result.content}`,
    };
  }

  private async runSuggestedVerification(request: string): Promise<AgentResponse> {
    const paths = request.split(/\s+/).filter(Boolean);
    const suggested = await this.executeTool("suggest_verification", { paths });

    if (!suggested.ok) {
      return {
        content: `Tool suggest_verification failed: ${suggested.error}`,
      };
    }

    const suggestions = extractVerificationSuggestions(suggested.metadata);
    const lines = [
      "Verification run",
      "",
      suggested.content,
      "",
    ];

    if (suggestions.length === 0) {
      lines.push("Run results: (no commands to run)");

      return {
        content: lines.join("\n"),
      };
    }

    lines.push("Run results:");

    for (const [index, suggestion] of suggestions.entries()) {
      const result = await this.executeTool("run_shell", { command: suggestion.command });
      const number = index + 1;

      lines.push(`${number}. ${suggestion.command}`);
      lines.push(`   reason: ${suggestion.reason || "(none)"}`);

      if (!result.ok) {
        lines.push("   status: failed to start");
        lines.push(`   error: ${result.error}`);
        lines.push("");
        lines.push(`Stopped after command ${number}.`);

        return {
          content: lines.join("\n"),
        };
      }

      const exitCode = typeof result.metadata?.exitCode === "number" ? result.metadata.exitCode : null;
      const passed = exitCode === 0;
      this.rememberVerificationRun(suggestion.command, paths, passed, exitCode);
      lines.push(`   status: ${passed ? "passed" : `failed (exitCode=${exitCode ?? "unknown"})`}`);

      if (!passed) {
        const failure = this.rememberVerificationFailure(
          suggestion.command,
          paths,
          result.content,
          exitCode,
        );

        lines.push("   failure summary:");
        lines.push(...failure.summary.map((line) => `   - ${line}`));

        if (failure.remediation.length > 0) {
          lines.push("   remediation:");
          lines.push(...failure.remediation.map((line) => `   - ${line}`));
        }
      }

      lines.push("   output:");
      lines.push(indentBlock(truncateForDisplay(result.content, 4000), "   "));

      if (!passed) {
        lines.push("");
        lines.push(`Stopped after command ${number}.`);

        return {
          content: lines.join("\n"),
        };
      }
    }

    lines.push("");
    lines.push(`Verification run passed: ${suggestions.length}/${suggestions.length} command(s).`);
    const lastSuggestion = suggestions[suggestions.length - 1];
    if (lastSuggestion) {
      this.taskState = recordTaskVerificationSuccess(this.taskState, {
        command: lastSuggestion.command,
        paths,
        recordedAt: new Date().toISOString(),
      });
    }
    this.lastVerificationFailure = undefined;
    this.lastVerificationTarget = undefined;

    return {
      content: lines.join("\n"),
    };
  }

  private async runLastPatchVerification(): Promise<AgentResponse> {
    if (!this.lastPatch) {
      return {
        content: "No last patch to verify. Apply a patch first, or use /verify-run [paths...].",
      };
    }

    if (this.lastPatch.paths.length === 0) {
      return {
        content: "The last patch did not record changed paths. Use /verify-run [paths...] instead.",
      };
    }

    const result = await this.runSuggestedVerification(this.lastPatch.paths.join(" "));

    return {
      content: [
        "Last patch verification",
        `Paths: ${this.lastPatch.paths.join(", ")}`,
        ...(this.lastPatch.snapshotPath ? [`Snapshot: ${this.lastPatch.snapshotPath}`] : []),
        "",
        result.content,
      ].join("\n"),
    };
  }

  private async rerunLastVerificationFailure(): Promise<AgentResponse> {
    const target = this.lastVerificationFailure
      ? {
          command: this.lastVerificationFailure.command,
          paths: this.lastVerificationFailure.paths,
          recordedAt: this.lastVerificationFailure.failedAt,
          label: "Previous failed at",
        }
      : this.lastVerificationTarget
        ? {
            command: this.lastVerificationTarget.command,
            paths: this.lastVerificationTarget.paths,
            recordedAt: this.lastVerificationTarget.recordedAt,
            label: "Target recorded at",
          }
        : undefined;

    if (!target) {
      return {
        content: "No verification failure to rerun. Run /verify-run [paths...] or /verify-last first.",
      };
    }

    const result = await this.executeTool("run_shell", { command: target.command });
    const lines = [
      "Verification rerun",
      "",
      `Command: ${target.command}`,
      `${target.label}: ${target.recordedAt}`,
      `Paths: ${target.paths.length > 0 ? target.paths.join(", ") : "(unknown)"}`,
      "",
      "Run result:",
    ];

    if (!result.ok) {
      lines.push("status: failed to start");
      lines.push(`error: ${result.error}`);

      return {
        content: lines.join("\n"),
      };
    }

    const exitCode = typeof result.metadata?.exitCode === "number" ? result.metadata.exitCode : null;
    const passed = exitCode === 0;
    this.rememberVerificationRun(target.command, target.paths, passed, exitCode);

    lines.push(`status: ${passed ? "passed" : `failed (exitCode=${exitCode ?? "unknown"})`}`);

    if (!passed) {
      const failure = this.rememberVerificationFailure(
        target.command,
        target.paths,
        result.content,
        exitCode,
      );

      lines.push("");
      lines.push("failure summary:");
      lines.push(...failure.summary.map((line) => `- ${line}`));

      if (failure.remediation.length > 0) {
        lines.push("");
        lines.push("remediation:");
        lines.push(...failure.remediation.map((line) => `- ${line}`));
      }
    } else {
      this.taskState = recordTaskVerificationSuccess(this.taskState, {
        command: target.command,
        paths: target.paths,
        recordedAt: new Date().toISOString(),
      });
      this.lastVerificationFailure = undefined;
      this.lastVerificationTarget = undefined;
      lines.push("Last verification failure cleared.");
    }

    lines.push("");
    lines.push("output:");
    lines.push(indentBlock(truncateForDisplay(result.content, 4000), "  "));

    return {
      content: lines.join("\n"),
    };
  }

  private async checkVerificationStability(request: string): Promise<AgentResponse> {
    const runs = parseVerificationStabilityRuns(request);

    if (typeof runs === "string") {
      return {
        content: runs,
      };
    }

    const initialFailure = this.lastVerificationFailure;
    const target = initialFailure
      ? {
          baseline: "failed" as const,
          command: initialFailure.command,
          paths: initialFailure.paths,
          recordedAt: initialFailure.failedAt,
        }
      : this.lastVerificationTarget
        ? {
            baseline: "target" as const,
            command: this.lastVerificationTarget.command,
            paths: this.lastVerificationTarget.paths,
            recordedAt: this.lastVerificationTarget.recordedAt,
          }
        : this.lastVerificationRun
          ? {
              baseline: this.lastVerificationRun.status,
              command: this.lastVerificationRun.command,
              paths: this.lastVerificationRun.paths,
              recordedAt: this.lastVerificationRun.recordedAt,
            }
          : undefined;

    if (!target) {
      return {
        content: "No verification command to check. Run /verify-run [paths...] or /verify-last first.",
      };
    }

    const lines = [
      "Verification stability check",
      "",
      `Command: ${target.command}`,
      `Baseline: ${target.baseline === "failed"
        ? "failed verification"
        : target.baseline === "passed"
          ? "passed verification"
          : "stored rerun target"}`,
      `Additional runs: ${runs}`,
      `Paths: ${target.paths.length > 0 ? target.paths.join(", ") : "(unknown)"}`,
      "",
      "Run results:",
    ];
    let passed = target.baseline === "passed" ? 1 : 0;
    let failed = target.baseline === "failed" ? 1 : 0;
    let latestFailedOutput = initialFailure?.output ?? "";
    let latestFailedExitCode = initialFailure?.exitCode ?? null;

    for (let index = 0; index < runs; index += 1) {
      const result = await this.executeTool("run_shell", { command: target.command });
      const number = index + 1;

      if (!result.ok) {
        lines.push(`${number}. failed to start: ${result.error}`);
        lines.push("");
        lines.push("Classification: inconclusive");
        lines.push("The command could not be started; no stability state was recorded.");

        return {
          content: lines.join("\n"),
        };
      }

      const exitCode = typeof result.metadata?.exitCode === "number" ? result.metadata.exitCode : null;
      const ok = exitCode === 0;
      this.rememberVerificationRun(target.command, target.paths, ok, exitCode);

      if (ok) {
        passed += 1;
      } else {
        failed += 1;
        latestFailedOutput = result.content;
        latestFailedExitCode = exitCode;
      }

      lines.push(`${number}. ${ok ? "passed" : `failed (exitCode=${exitCode ?? "unknown"})`}`);
    }

    const totalRuns = runs + (target.baseline === "target" ? 0 : 1);
    lines.push("");
    lines.push(
      `Summary: ${passed} passed, ${failed} failed (${totalRuns} total${target.baseline === "target" ? "" : " including baseline"}).`,
    );

    if (passed > 0 && failed > 0) {
      const failure = initialFailure ?? this.rememberVerificationFailure(
        target.command,
        target.paths,
        latestFailedOutput,
        latestFailedExitCode,
      );
      failure.stability = {
        baseline: target.baseline,
        checkedAt: new Date().toISOString(),
        failed,
        passed,
        runs: totalRuns,
        status: "flaky",
      };
      failure.summary = uniqueStrings([
        ...failure.summary,
        `stability: flaky (${passed} passed, ${failed} failed across ${totalRuns} runs)`,
      ]);
      failure.remediation = uniqueStrings([
        "Do not repair source code from this signal yet; isolate shared state, timing, ordering, network, and environment dependencies first.",
        ...failure.remediation,
      ]);
      this.lastVerificationFailure = failure;
      this.lastVerificationTarget = {
        command: target.command,
        paths: target.paths,
        recordedAt: target.recordedAt,
      };
      this.taskState = recordTaskVerificationFailure(this.taskState, failure);
      lines.push("Classification: flaky");
      lines.push("Repair is blocked until a fresh verification run produces a stable failure.");
    } else if (failed > 0) {
      const failure = this.rememberVerificationFailure(
        target.command,
        target.paths,
        latestFailedOutput,
        latestFailedExitCode,
      );
      failure.stability = {
        baseline: target.baseline,
        checkedAt: new Date().toISOString(),
        failed,
        passed,
        runs: totalRuns,
        status: "stable_failure",
      };
      failure.summary = uniqueStrings([
        ...failure.summary,
        `stability: stable failure (${failed}/${totalRuns} failed)`,
      ]);
      this.lastVerificationFailure = failure;
      this.taskState = recordTaskVerificationFailure(this.taskState, failure);
      lines.push("Classification: stable failure");
      lines.push("The failure is reproducible; /repair-preview and /repair-last may use it as repair evidence.");
    } else {
      this.taskState = recordTaskVerificationSuccess(this.taskState, {
        command: target.command,
        paths: target.paths,
        recordedAt: new Date().toISOString(),
      });
      this.lastVerificationFailure = undefined;
      this.lastVerificationTarget = undefined;
      lines.push("Classification: stable pass");
      lines.push("All additional runs passed; verification state was cleared.");
    }

    return {
      content: lines.join("\n"),
    };
  }

  private async repairLastVerificationFailure(
    onStreamEvent?: AgentStreamHandler,
    additionalContext: string[] = [],
  ): Promise<AgentResponse> {
    if (!this.lastVerificationFailure) {
      return {
        content: "No verification failure to repair. Run /verify-run [paths...] or /verify-last first.",
      };
    }

    const flakyBlock = this.formatFlakyRepairBlock();

    if (flakyBlock) {
      return flakyBlock;
    }

    const environmentBlock = this.formatEnvironmentRepairBlock();

    if (environmentBlock) {
      return environmentBlock;
    }

    try {
      const initialContext = await this.readInitialRepairContext(this.lastVerificationFailure, onStreamEvent);

      return await this.runAgentLoop(
        buildVerificationRepairPrompt(
          this.lastVerificationFailure,
          this.lastPatch,
          [...initialContext.promptContext, ...additionalContext],
        ),
        onStreamEvent,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      return {
        content: `Model call failed: ${reason}`,
      };
    }
  }

  private clearVerificationState(): AgentResponse {
    const hadFailure = Boolean(this.lastVerificationFailure);
    const hadRun = Boolean(this.lastVerificationRun);
    const hadTarget = Boolean(this.lastVerificationTarget);

    this.lastVerificationFailure = undefined;
    this.lastVerificationRun = undefined;
    this.lastVerificationTarget = undefined;

    if (!hadFailure && !hadRun && !hadTarget) {
      return {
        content: "No verification failure or rerun target to clear.",
      };
    }

    return {
      content: [
        "Verification state cleared.",
        `Cleared failure: ${hadFailure ? "yes" : "no"}`,
        `Cleared recent run: ${hadRun ? "yes" : "no"}`,
        `Cleared rerun target: ${hadTarget ? "yes" : "no"}`,
      ].join("\n"),
    };
  }

  private async repairAndRerunLastVerificationFailure(
    onStreamEvent?: AgentStreamHandler,
  ): Promise<AgentResponse> {
    if (!this.lastVerificationFailure) {
      return {
        content: "No verification failure to repair and rerun. Run /verify-run [paths...] or /verify-last first.",
      };
    }

    const flakyBlock = this.formatFlakyRepairBlock();

    if (flakyBlock) {
      return flakyBlock;
    }

    const environmentBlock = this.formatEnvironmentRepairBlock();

    if (environmentBlock) {
      return environmentBlock;
    }

    const repair = await this.repairLastVerificationFailure(onStreamEvent);
    const verification = await this.rerunLastVerificationFailure();

    return {
      content: [
        "Repair run",
        "",
        "Repair:",
        indentBlock(repair.content, "  "),
        "",
        "Verification:",
        indentBlock(verification.content, "  "),
      ].join("\n"),
      streamed: repair.streamed,
    };
  }

  private async repairLoopLastVerificationFailure(
    request: string,
    onStreamEvent?: AgentStreamHandler,
  ): Promise<AgentResponse> {
    const attempts = parseRepairLoopAttempts(request);

    if (typeof attempts === "string") {
      return {
        content: attempts,
      };
    }

    if (!this.lastVerificationFailure) {
      return {
        content: "No verification failure to repair loop. Run /verify-run [paths...] or /verify-last first.",
      };
    }

    const flakyBlock = this.formatFlakyRepairBlock();

    if (flakyBlock) {
      return flakyBlock;
    }

    const environmentBlock = this.formatEnvironmentRepairBlock();

    if (environmentBlock) {
      return environmentBlock;
    }

    const lines = [
      "Repair loop",
      "",
      `Max attempts: ${attempts}`,
    ];
    let streamed = false;
    let passed = false;
    let completedAttempts = 0;
    const additionalRepairContext: string[] = [];

    for (let index = 0; index < attempts; index += 1) {
      if (!this.lastVerificationFailure) {
        lines.push("");
        lines.push("Stopped: no failure details remain to repair.");
        break;
      }

      const number = index + 1;
      completedAttempts = number;
      lines.push("");
      lines.push(`Attempt ${number}/${attempts}`);

      const patchBeforeRepair = this.lastPatch;
      const repair = await this.repairLastVerificationFailure(onStreamEvent, additionalRepairContext);
      streamed = streamed || Boolean(repair.streamed);
      const patchAfterRepair = this.lastPatch;
      const patchApplied = patchAfterRepair !== patchBeforeRepair;
      const patchAttempted = repair.content.includes("[tool] apply_patch");
      lines.push("Repair:");
      lines.push(indentBlock(repair.content, "  "));
      lines.push("Patch:");
      lines.push(`  applied: ${patchApplied ? "yes" : "no"}`);

      if (patchApplied && patchAfterRepair) {
        lines.push(`  paths: ${patchAfterRepair.paths.length > 0 ? patchAfterRepair.paths.join(", ") : "(unknown)"}`);

        if (patchAfterRepair.snapshotPath) {
          lines.push(`  snapshot: ${patchAfterRepair.snapshotPath}`);
        }
      }

      const verification = await this.rerunLastVerificationFailure();
      lines.push("Verification:");
      lines.push(indentBlock(verification.content, "  "));

      if (!this.lastVerificationFailure && !this.lastVerificationTarget) {
        passed = true;
        lines.push("");
        lines.push(`Repair loop passed after ${number} attempt(s).`);
        break;
      }

      if (!patchApplied) {
        lines.push("");

        if (patchAttempted && number < attempts) {
          const reread = await this.rereadSuggestedPatchFailureFiles(repair.content, onStreamEvent);

          if (reread.displayLines.length > 0) {
            lines.push("Automatic reread:");
            lines.push(...reread.displayLines.map((line) => `  ${line}`));
          }

          if (reread.promptContext) {
            additionalRepairContext.push(reread.promptContext);
          }

          lines.push(`Continuing: repair attempt ${number} tried a patch, but it did not apply.`);
          continue;
        }

        lines.push(`Stopped: repair attempt ${number} did not apply a patch, and verification is still failing.`);
        break;
      }

      if (number < attempts) {
        lines.push("");
        lines.push(`Continuing: repair attempt ${number} applied a patch, but verification is still failing.`);
      }
    }

    if (!passed) {
      lines.push("");
      lines.push(`Repair loop stopped after ${completedAttempts} attempt(s); verification is still failing.`);
    }

    return {
      content: lines.join("\n"),
      streamed,
    };
  }

  private async rereadSuggestedPatchFailureFiles(
    repairContent: string,
    onStreamEvent?: AgentStreamHandler,
  ): Promise<{
    displayLines: string[];
    promptContext?: string;
  }> {
    const paths = extractSuggestedNextReadPaths(repairContent).slice(0, 5);

    if (paths.length === 0) {
      return {
        displayLines: [],
      };
    }

    const readContext = await this.readRepairContextFiles(
      paths,
      "Automatic reread after failed patch:",
      "Use these current file contents before generating another patch.",
      onStreamEvent,
    );

    return {
      displayLines: readContext.displayLines,
      promptContext: readContext.promptContext,
    };
  }

  private async readInitialRepairContext(
    failure: SessionVerificationFailureRecord,
    onStreamEvent?: AgentStreamHandler,
  ): Promise<{
    displayLines: string[];
    promptContext: string[];
  }> {
    const paths = extractInitialRepairReadPaths(failure).slice(0, 5);

    if (paths.length === 0) {
      return {
        displayLines: [],
        promptContext: [],
      };
    }

    const readContext = await this.readRepairContextFiles(
      paths,
      "Initial repair file context:",
      "Use these current file contents before writing the first repair patch.",
      onStreamEvent,
    );

    return {
      displayLines: readContext.displayLines,
      promptContext: readContext.promptContext ? [readContext.promptContext] : [],
    };
  }

  private async readRepairContextFiles(
    paths: string[],
    heading: string,
    instruction: string,
    onStreamEvent?: AgentStreamHandler,
  ): Promise<{
    displayLines: string[];
    promptContext?: string;
  }> {
    const displayLines: string[] = [];
    const promptBlocks = [heading, instruction];

    for (const path of paths) {
      const result = await this.executeTool("read_file", { path }, onStreamEvent);

      if (!result.ok) {
        displayLines.push(`${path}: failed (${result.error})`);
        promptBlocks.push([
          `Path: ${path}`,
          "Read failed:",
          result.error,
        ].join("\n"));
        continue;
      }

      displayLines.push(`${path}: read ${result.content.length} chars`);
      promptBlocks.push([
        `Path: ${path}`,
        "Current content:",
        truncateForDisplay(result.content, 4000),
      ].join("\n"));
    }

    return {
      displayLines,
      promptContext: promptBlocks.join("\n\n"),
    };
  }

  private previewLastVerificationRepair(): AgentResponse {
    if (!this.lastVerificationFailure) {
      return {
        content: "No verification failure to preview. Run /verify-run [paths...] or /verify-last first.",
      };
    }

    if (this.lastVerificationFailure.stability?.status === "flaky") {
      return {
        content: [
          "Repair preview blocked: the verification result is flaky.",
          `Observed ${this.lastVerificationFailure.stability.passed} passed and ${this.lastVerificationFailure.stability.failed} failed run(s).`,
          "Stabilize or isolate the test/environment before generating a source repair prompt.",
        ].join("\n"),
      };
    }

    return {
      content: [
        "Repair preview",
        "",
        buildVerificationRepairPrompt(this.lastVerificationFailure, this.lastPatch),
      ].join("\n"),
    };
  }

  private formatFlakyRepairBlock(): AgentResponse | undefined {
    const stability = this.lastVerificationFailure?.stability;

    if (stability?.status !== "flaky") {
      return undefined;
    }

    return {
      content: [
        "Repair blocked: the verification result is flaky.",
        `Observed ${stability.passed} passed and ${stability.failed} failed run(s).`,
        "Stabilize or isolate the test/environment first, then rerun /verify-run before editing source code.",
      ].join("\n"),
    };
  }

  private formatEnvironmentRepairBlock(): AgentResponse | undefined {
    const diagnosis = this.lastVerificationFailure?.diagnosis;

    if (diagnosis?.category !== "environment") {
      return undefined;
    }

    return {
      content: [
        `Repair blocked: verification indicates ${diagnosis.label}.`,
        "Resolve or explicitly verify the environment prerequisite before asking the agent to edit repository files.",
        "Use /repair-preview to inspect the recorded environment-specific remediation without applying a patch.",
      ].join("\n"),
    };
  }

  private showLastVerificationFailure(): AgentResponse {
    if (!this.lastVerificationFailure) {
      if (this.lastVerificationTarget) {
        return {
          content: [
            "No verification failure recorded.",
            "",
            `Rerun target: ${this.lastVerificationTarget.command}`,
            `Target recorded at: ${this.lastVerificationTarget.recordedAt}`,
            `Paths: ${this.lastVerificationTarget.paths.length > 0 ? this.lastVerificationTarget.paths.join(", ") : "(unknown)"}`,
            "",
            "Use /verify-rerun to rerun the repair verification target.",
          ].join("\n"),
        };
      }

      return {
        content: "No verification failure recorded. Run /verify-run [paths...] or /verify-last first.",
      };
    }

    const failure = this.lastVerificationFailure;

    return {
      content: [
        "Last verification failure",
        "",
        `Command: ${failure.command}`,
        `Failed at: ${failure.failedAt}`,
        `Paths: ${failure.paths.length > 0 ? failure.paths.join(", ") : "(unknown)"}`,
        `Exit code: ${failure.exitCode ?? "(unknown)"}`,
        ...(failure.diagnosis
          ? [`Diagnosis: ${failure.diagnosis.category}/${failure.diagnosis.label}`]
          : []),
        `Locations: ${failure.locations.length > 0 ? failure.locations.join(", ") : "(none)"}`,
        ...(failure.stability
          ? [`Stability: ${failure.stability.status} (${failure.stability.passed} passed, ${failure.stability.failed} failed)`]
          : []),
        "",
        "Summary:",
        ...(failure.summary.length > 0 ? failure.summary.map((line) => `- ${line}`) : ["- (none)"]),
        "",
        "Remediation:",
        ...(failure.remediation.length > 0
          ? failure.remediation.map((line) => `- ${line}`)
          : ["- (none)"]),
        "",
        "Output:",
        indentBlock(truncateForDisplay(failure.output, 2000), "  "),
        "",
        "Next:",
        ...(failure.stability?.status === "flaky"
          ? ["- Stabilize or isolate the flaky test/environment before repairing source code."]
          : [
              "- Use /verify-stability to check whether the failure is reproducible.",
              "- Use /repair-preview to inspect the repair prompt.",
              "- Use /repair-last to ask the agent to repair it.",
            ]),
      ].join("\n"),
    };
  }

  private async handleSymbolsCommand(request: string): Promise<AgentResponse> {
    const parts = request.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "list";

    if (action === "list") {
      const parsedLimit = parts[1] ? Number(parts[1]) : 50;
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
      const result = await this.executeTool("list_symbols", { limit });

      if (!result.ok) {
        return {
          content: `Tool list_symbols failed: ${result.error}`,
        };
      }

      return {
        content: `Tool list_symbols succeeded:\n\n${result.content}`,
      };
    }

    if (action === "search") {
      const { limit, query } = parseSymbolSearchRequest(parts.slice(1));

      if (!query) {
        return {
          content: formatSymbolsUsage(),
        };
      }

      const result = await this.executeTool("search_symbols", { query, limit });

      if (!result.ok) {
        return {
          content: `Tool search_symbols failed: ${result.error}`,
        };
      }

      return {
        content: `Tool search_symbols succeeded:\n\n${result.content}`,
      };
    }

    if (/^\d+$/.test(action)) {
      const result = await this.executeTool("list_symbols", { limit: Number(action) });

      if (!result.ok) {
        return {
          content: `Tool list_symbols failed: ${result.error}`,
        };
      }

      return {
        content: `Tool list_symbols succeeded:\n\n${result.content}`,
      };
    }

    return {
      content: formatSymbolsUsage(),
    };
  }

  private async handleContextIndexCommand(request: string): Promise<AgentResponse> {
    const parts = request.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "status";

    if (action === "semantic" || action === "vector") {
      return this.handleSemanticIndexCommand(parts.slice(1));
    }

    if (action === "eval") {
      return this.handleRetrievalEvalCommand(parts.slice(1));
    }

    if (action === "status") {
      const result = await this.executeTool("context_index_status", {});

      if (!result.ok) {
        return {
          content: `Tool context_index_status failed: ${result.error}`,
        };
      }

      return {
        content: `Tool context_index_status succeeded:\n\n${result.content}`,
      };
    }

    if (action === "build" || action === "refresh") {
      const result = await this.executeTool("build_context_index", {});

      if (!result.ok) {
        return {
          content: `Tool build_context_index failed: ${result.error}`,
        };
      }

      return {
        content: `Tool build_context_index succeeded:\n\n${result.content}`,
      };
    }

    if (action === "search") {
      const { limit, query } = parseIndexSearchRequest(parts.slice(1));

      if (!query) {
        return {
          content: formatContextIndexUsage(),
        };
      }

      const result = await this.executeTool("search_context_index", { query, limit });

      if (!result.ok) {
        return {
          content: `Tool search_context_index failed: ${result.error}`,
        };
      }

      return {
        content: `Tool search_context_index succeeded:\n\n${result.content}`,
      };
    }

    return {
      content: formatContextIndexUsage(),
    };
  }

  private async handleRetrievalEvalCommand(parts: string[]): Promise<AgentResponse> {
    const action = parts[0] ?? "status";

    if (action === "init") {
      if (parts.length > 1) {
        return { content: formatContextIndexUsage() };
      }

      try {
        return {
          content: formatRetrievalEvalInit(await initRetrievalEvalManifest(this.workspaceRoot)),
        };
      } catch (error) {
        return {
          content: `Retrieval eval init failed: ${formatError(error)}`,
        };
      }
    }

    if (action === "status") {
      if (parts.length > 1) {
        return { content: formatContextIndexUsage() };
      }

      try {
        return {
          content: formatRetrievalEvalManifestStatus(
            await getRetrievalEvalManifestStatus(this.workspaceRoot),
          ),
        };
      } catch (error) {
        return {
          content: `Retrieval eval status failed: ${formatError(error)}`,
        };
      }
    }

    if (action === "run" || action === "search") {
      const json = parts.includes("--json");
      const extraParts = parts.filter((part) => part !== "--json");

      if (extraParts.length > 1) {
        return { content: formatContextIndexUsage() };
      }

      try {
        const result = await runRetrievalEval(this.workspaceRoot);
        return {
          content: json ? formatRetrievalEvalJson(result) : formatRetrievalEval(result),
        };
      } catch (error) {
        return {
          content: `Retrieval eval failed: ${formatError(error)}`,
        };
      }
    }

    return {
      content: formatContextIndexUsage(),
    };
  }

  private async handleSemanticIndexCommand(parts: string[]): Promise<AgentResponse> {
    const action = parts[0] ?? "status";

    if (action === "status") {
      const result = await this.executeTool("semantic_index_status", {});

      if (!result.ok) {
        return {
          content: `Tool semantic_index_status failed: ${result.error}`,
        };
      }

      return {
        content: `Tool semantic_index_status succeeded:\n\n${result.content}`,
      };
    }

    if (action === "build" || action === "refresh") {
      const result = await this.executeTool("build_semantic_index", {});

      if (!result.ok) {
        return {
          content: `Tool build_semantic_index failed: ${result.error}`,
        };
      }

      return {
        content: `Tool build_semantic_index succeeded:\n\n${result.content}`,
      };
    }

    if (action === "search") {
      const { limit, query } = parseIndexSearchRequest(parts.slice(1));

      if (!query) {
        return {
          content: formatContextIndexUsage(),
        };
      }

      const result = await this.executeTool("search_semantic_index", { query, limit });

      if (!result.ok) {
        return {
          content: `Tool search_semantic_index failed: ${result.error}`,
        };
      }

      return {
        content: `Tool search_semantic_index succeeded:\n\n${result.content}`,
      };
    }

    return {
      content: formatContextIndexUsage(),
    };
  }

  private async runShell(command: string): Promise<AgentResponse> {
    const result = await this.executeTool("run_shell", { command });

    if (!result.ok) {
      return {
        content: `Tool run_shell failed: ${result.error}`,
      };
    }

    return {
      content: `Tool run_shell succeeded:\n\n${result.content}`,
    };
  }

  private async applyPatchFile(path: string): Promise<AgentResponse> {
    const patchFile = await this.executeTool("read_file", { path });

    if (!patchFile.ok) {
      return {
        content: `Tool read_file failed: ${patchFile.error}`,
      };
    }

    const result = await this.executeTool("apply_patch", { patch: patchFile.content });

    if (!result.ok) {
      return {
        content: `Tool apply_patch failed: ${result.error}`,
      };
    }

    return {
      content: `Tool apply_patch succeeded:\n\n${result.content}`,
    };
  }

  private async undoLastPatch(): Promise<AgentResponse> {
    if (!this.lastPatch) {
      return {
        content: "No patch to undo.",
      };
    }

    const paths = this.lastPatch.paths;
    const result = await this.executeTool("reverse_patch", {
      patch: this.lastPatch.patch,
    });

    if (!result.ok) {
      return {
        content: `Tool reverse_patch failed: ${result.error}`,
      };
    }

    return {
      content: [
        `Undo succeeded for ${paths.length > 0 ? paths.join(", ") : "the last patch"}.`,
        "",
        result.content,
      ].join("\n"),
    };
  }

  private async handlePatchSnapshotsCommand(request: string): Promise<AgentResponse> {
    const parts = request.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "list";

    if (action === "history") {
      const parsedLimit = parts[1] ? Number(parts[1]) : 10;
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
      const result = await this.executeTool("patch_snapshot_history", { limit });

      if (!result.ok) {
        return {
          content: `Tool patch_snapshot_history failed: ${result.error}`,
        };
      }

      return {
        content: `Tool patch_snapshot_history succeeded:\n\n${result.content}`,
      };
    }

    if (action === "list") {
      const parsedLimit = parts[1] ? Number(parts[1]) : 10;
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
      const result = await this.executeTool("list_patch_snapshots", { limit });

      if (!result.ok) {
        return {
          content: `Tool list_patch_snapshots failed: ${result.error}`,
        };
      }

      return {
        content: `Tool list_patch_snapshots succeeded:\n\n${result.content}`,
      };
    }

    if (action === "show") {
      const snapshotPath = parts.slice(1).join(" ");

      if (!snapshotPath) {
        return {
          content: formatPatchSnapshotsUsage(),
        };
      }

      const result = await this.executeTool("show_patch_snapshot", { snapshotPath });

      if (!result.ok) {
        return {
          content: `Tool show_patch_snapshot failed: ${result.error}`,
        };
      }

      return {
        content: `Tool show_patch_snapshot succeeded:\n\n${result.content}`,
      };
    }

    if (action === "restore") {
      const snapshotPath = parts[1] ?? "";
      const path = parts.slice(2).join(" ");

      if (!snapshotPath || !path) {
        return {
          content: formatPatchSnapshotsUsage(),
        };
      }

      const result = await this.executeTool("restore_patch_snapshot", { snapshotPath, path });

      if (!result.ok) {
        return {
          content: `Tool restore_patch_snapshot failed: ${result.error}`,
        };
      }

      return {
        content: `Tool restore_patch_snapshot succeeded:\n\n${result.content}`,
      };
    }

    return {
      content: formatPatchSnapshotsUsage(),
    };
  }

  private async listFilesFromCommand(args: string, defaultDepth: number): Promise<AgentResponse> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const path = parts[0] ?? ".";
    const parsedDepth = parts[1] ? Number(parts[1]) : defaultDepth;
    const maxDepth = Number.isFinite(parsedDepth) ? parsedDepth : defaultDepth;

    return this.listFiles(path, maxDepth);
  }

  private async listFiles(path: string, maxDepth: number): Promise<AgentResponse> {
    const result = await this.executeTool("list_files", { path, maxDepth });

    if (!result.ok) {
      return {
        content: `Tool list_files failed: ${result.error}`,
      };
    }

    return {
      content: `Tool list_files succeeded:\n\n${result.content}`,
    };
  }

  private async gitStatus(): Promise<AgentResponse> {
    const result = await this.executeTool("git_status", {});

    if (!result.ok) {
      return {
        content: `Tool git_status failed: ${result.error}`,
      };
    }

    return {
      content: `Tool git_status succeeded:\n\n${result.content}`,
    };
  }

  private async gitDiff(): Promise<AgentResponse> {
    const result = await this.executeTool("git_diff", {});

    if (!result.ok) {
      return {
        content: `Tool git_diff failed: ${result.error}`,
      };
    }

    return {
      content: `Tool git_diff succeeded:\n\n${result.content}`,
    };
  }

  private rememberPatch(patch: string, metadata: Record<string, unknown> | undefined): void {
    const paths = Array.isArray(metadata?.paths)
      ? metadata.paths.filter((path): path is string => typeof path === "string")
      : [];
    const snapshotPath = typeof metadata?.snapshotPath === "string" ? metadata.snapshotPath : undefined;

    for (const path of paths) {
      this.writtenPaths.add(path);
    }

    this.lastPatch = {
      patch,
      paths,
      appliedAt: new Date().toISOString(),
      ...(snapshotPath ? { snapshotPath } : {}),
    };
    this.taskState = recordTaskPatch(this.taskState, this.lastPatch);
    this.lastVerificationFailure = undefined;
    this.debug("patch.remember", {
      paths,
      snapshotPath: snapshotPath ?? null,
      bytes: Buffer.byteLength(patch, "utf8"),
    });
  }

  private rememberVerificationFailure(
    command: string,
    paths: string[],
    output: string,
    exitCode: number | null,
  ): SessionVerificationFailureRecord {
    const failedAt = new Date().toISOString();
    const diagnosis = classifyVerificationFailure(parseShellOutputSections(output));
    const failure = {
      command,
      ...(diagnosis ? { diagnosis: { category: diagnosis.category, label: diagnosis.label } } : {}),
      paths,
      failedAt,
      summary: summarizeVerificationFailure(output, exitCode),
      remediation: suggestVerificationRemediation(output),
      locations: extractVerificationFailureLocations(parseShellOutputSections(output)),
      output: truncateForDisplay(output, 8000),
      ...(exitCode !== null ? { exitCode } : {}),
    };

    this.lastVerificationFailure = failure;
    this.lastVerificationTarget = {
      command,
      paths,
      recordedAt: failedAt,
    };
    this.taskState = recordTaskVerificationFailure(this.taskState, failure);

    return failure;
  }

  private rememberVerificationRun(
    command: string,
    paths: string[],
    passed: boolean,
    exitCode: number | null,
  ): void {
    this.lastVerificationRun = {
      command,
      paths,
      recordedAt: new Date().toISOString(),
      status: passed ? "passed" : "failed",
      ...(exitCode !== null ? { exitCode } : {}),
    };
  }

  private isToolDenied(name: string): boolean {
    return this.toolPolicy.denyTools?.includes(name) ?? false;
  }

  private isToolRiskDenied(risk: ToolRiskLevel): boolean {
    return this.toolPolicy.denyRiskLevels?.includes(risk) ?? false;
  }

  private isToolApprovalRequired(name: string): boolean {
    return this.toolPolicy.requireApprovalTools?.includes(name) ?? false;
  }

  private isToolRiskApprovalRequired(risk: ToolRiskLevel): boolean {
    return this.toolPolicy.requireApprovalRiskLevels?.includes(risk) ?? false;
  }

  private evaluateWritePathPolicy(
    name: string,
    input: Record<string, unknown>,
  ): WritePathPolicyEvaluation {
    if (isPatchTool(name) && typeof input.patch === "string") {
      return evaluateWritePathPolicy(input.patch, {
        allowWritePaths: this.toolPolicy.allowWritePaths,
        denyWritePaths: this.toolPolicy.denyWritePaths,
      });
    }

    if (name === "restore_patch_snapshot" && typeof input.path === "string") {
      return evaluateWritePathsPolicy(
        [input.path],
        {
          allowWritePaths: this.toolPolicy.allowWritePaths,
          denyWritePaths: this.toolPolicy.denyWritePaths,
        },
        {
          missingPathReason: "Snapshot restore does not declare a writable path, but toolPolicy.allowWritePaths is set.",
        },
      );
    }

    if (name === "edit" && typeof input.path === "string") {
      return evaluateWritePathsPolicy(
        [input.path],
        {
          allowWritePaths: this.toolPolicy.allowWritePaths,
          denyWritePaths: this.toolPolicy.denyWritePaths,
        },
        {
          missingPathReason: "Edit does not declare a writable path, but toolPolicy.allowWritePaths is set.",
        },
      );
    }

    return {
      ok: true,
      paths: [],
    };
  }

  private getToolBasePreflight(name: string): ToolPreflight {
    return createToolPreflight({
      input: {},
      toolName: name,
    });
  }

  private formatToolEffectiveBehavior(name: string): string {
    const tool = this.tools.get(name);
    const basePreflight = this.getToolBasePreflight(name);

    if (this.isToolDenied(name) || this.isToolRiskDenied(basePreflight.risk)) {
      return "blocked by project policy";
    }

    if (isWorkspaceWriteTool(name) && this.hasWritePathPolicy()) {
      return "asks for approval before execution; some paths may be blocked by project policy";
    }

    if (tool?.approvalMessage) {
      return "asks for approval before execution";
    }

    if (this.isToolApprovalRequired(name) || this.isToolRiskApprovalRequired(basePreflight.risk)) {
      return "asks for approval because of project policy";
    }

    return "runs without approval";
  }

  private hasWritePathPolicy(): boolean {
    return (
      (this.toolPolicy.allowWritePaths?.length ?? 0) > 0 ||
      (this.toolPolicy.denyWritePaths?.length ?? 0) > 0
    );
  }

  private async recordAudit(event: ToolAuditEventInput | ModelTurnAuditEventInput): Promise<void> {
    try {
      await this.auditLogger.record({
        timestamp: new Date().toISOString(),
        ...(this.depth > 0 ? { depth: this.depth } : {}),
        ...event,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.debug("audit.write_failed", { reason });
    }
  }

  private async recordModelTurnAudit(
    input: ModelTurnInput,
    result: Awaited<ReturnType<ModelClient["createTurn"]>>,
    streamedText: boolean,
    durationMs: number,
    audit:
      | {
          kind: "user" | "tool_outputs";
          round: number;
        }
      | undefined,
  ): Promise<void> {
    if (!audit) {
      return;
    }

    await this.recordAudit({
      type: "model_turn",
      contentLength: result.content.length,
      durationMs,
      kind: audit.kind,
      modelName: this.modelName,
      ...(input.previousResponseId ? { previousResponseId: input.previousResponseId } : {}),
      ...(result.responseId ? { responseId: result.responseId } : {}),
      round: audit.round,
      streamedText,
      toolCalls: result.toolCalls.map((toolCall) => toolCall.name),
      ...(result.usage?.estimated ? { usageEstimated: true } : {}),
      ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
      ...(result.usage?.totalTokens !== undefined ? { totalTokens: result.usage.totalTokens } : {}),
      ...(result.usage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: result.usage.cachedInputTokens }
        : {}),
    });
  }

  private async recordAndEmitModelTurnUsage(
    result: Awaited<ReturnType<ModelClient["createTurn"]>>,
    durationMs: number,
    audit:
      | {
          kind: "user" | "tool_outputs";
          round: number;
        }
      | undefined,
    onStreamEvent?: AgentStreamHandler,
  ): Promise<void> {
    const usageRecord = modelUsageToUsageRecord(result.usage);
    const turnStats = createUsageStats();

    addUsageRecord(turnStats, usageRecord);
    addUsageRecord(this.usageTotals, usageRecord);

    if (!audit || !onStreamEvent) {
      return;
    }

    await onStreamEvent({
      type: "model_turn",
      budget: formatUsageBudget(this.usageTotals),
      ...(result.usage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: result.usage.cachedInputTokens }
        : {}),
      cost: formatAggregateCost(turnStats, false),
      cumulativeCachedInputTokens: this.usageTotals.cachedInputTokens,
      cumulativeCost: formatAggregateCost(this.usageTotals, true),
      cumulativeEstimatedTurns: this.usageTotals.estimatedTurns,
      cumulativeInputTokens: this.usageTotals.inputTokens,
      cumulativeOutputTokens: this.usageTotals.outputTokens,
      cumulativeTotalTokens: this.usageTotals.totalTokens,
      cumulativeTurns: this.usageTotals.turns,
      cumulativeTurnsWithUsage: this.usageTotals.turnsWithUsage,
      durationMs,
      ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      kind: audit.kind,
      modelName: this.modelName,
      ...(result.usage?.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
      ...(result.responseId ? { responseId: result.responseId } : {}),
      round: audit.round,
      toolCalls: result.toolCalls.map((toolCall) => toolCall.name),
      ...(result.usage?.totalTokens !== undefined ? { totalTokens: result.usage.totalTokens } : {}),
      ...(result.usage?.estimated ? { usageEstimated: true } : {}),
    });
  }

  private createLocalCallId(name: string): string {
    this.localToolCallCount += 1;
    const normalizedName = name.replace(/[^a-zA-Z0-9_-]+/g, "_");
    return `${this.localCallIdPrefix}-${this.localToolCallCount}-${normalizedName}`;
  }
}

async function emitToolStart(
  onStreamEvent: AgentStreamHandler | undefined,
  toolName: string,
  inputSummary: string,
  callId?: string,
): Promise<void> {
  await onStreamEvent?.({
    type: "tool_start",
    callId,
    inputSummary,
    toolName,
  });
}

async function emitToolPreflight(
  onStreamEvent: AgentStreamHandler | undefined,
  toolName: string,
  preflight: ToolPreflight,
  callId?: string,
): Promise<void> {
  await onStreamEvent?.({
    type: "tool_preflight",
    callId,
    deniedByPolicy: preflight.deniedByPolicy,
    reasons: preflight.reasons,
    requiresApproval: preflight.requiresApproval,
    risk: preflight.risk,
    summary: preflight.summary,
    toolName,
    workspaceImpact: preflight.workspaceImpact,
  });
}

function summarizeToolResult(name: string, result: ToolResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      name,
      ok: false,
      error: result.error,
    };
  }

  return {
    name,
    ok: true,
    contentLength: result.content.length,
    metadata: result.metadata ?? {},
  };
}

async function emitToolApproval(
  onStreamEvent: AgentStreamHandler | undefined,
  toolName: string,
  status: "required" | "approved" | "denied",
  message?: string,
  callId?: string,
): Promise<void> {
  await onStreamEvent?.({
    type: "tool_approval",
    callId,
    message,
    status,
    toolName,
  });
}

async function emitToolFinish(
  onStreamEvent: AgentStreamHandler | undefined,
  toolName: string,
  result: ToolResult,
  callId?: string,
): Promise<void> {
  await onStreamEvent?.({
    type: "tool_finish",
    callId,
    ok: result.ok,
    summary: formatToolResultSummary(result),
    toolName,
  });
}

function formatToolInputSummary(input: Record<string, unknown>): string {
  return truncateForDisplay(JSON.stringify(input), 300);
}

function formatToolResultSummary(result: ToolResult): string {
  if (!result.ok) {
    return truncateForDisplay(result.error, 300);
  }

  const details = [`${result.content.length} chars`];

  if (typeof result.metadata?.exitCode === "number") {
    details.push(`exitCode=${result.metadata.exitCode}`);
  }

  if (typeof result.metadata?.count === "number") {
    details.push(`count=${result.metadata.count}`);
  }

  if (Array.isArray(result.metadata?.paths)) {
    details.push(`paths=${result.metadata.paths.length}`);
  }

  if (typeof result.metadata?.snapshotPath === "string") {
    details.push("snapshot=yes");
  }

  return `ok (${details.join(", ")})`;
}

function truncateForDisplay(value: string | undefined, maxLength: number): string {
  const source = value ?? "";

  if (source.length <= maxLength) {
    return source;
  }

  return `${source.slice(0, maxLength)}...[truncated]`;
}

function formatPolicyApprovalMessage(name: string, input: Record<string, unknown>): string {
  return [
    `Run tool ${name}?`,
    "Tool approval is required by project policy.",
    "",
    "Input:",
    truncateForDisplay(JSON.stringify(input, null, 2), 6000),
  ].join("\n");
}

function formatPolicyDeniedError(
  name: string,
  writePathPolicy: WritePathPolicyEvaluation,
): string {
  if (!writePathPolicy.ok) {
    return writePathPolicy.reason;
  }

  return `Tool is disabled by policy: ${name}.`;
}

function isPatchTool(name: string): boolean {
  return name === "apply_patch" || name === "reverse_patch";
}

function buildSubagentPrompt(prompt: string): string {
  return [
    "You are a focused subagent helping a parent coding agent inside this workspace.",
    "Locate target files directly with read_file or search_files; avoid a full list_files scan.",
    "You may edit files with edit or apply_patch when the task requires it; keep edits minimal and scoped.",
    "Stop once done and return a concise factual summary without restating these instructions.",
    "",
    "Task:",
    prompt,
  ].join("\n");
}

export function detectWrittenPathConflicts(pathSets: string[][]): string[] {
  const writersByPath = new Map<string, number>();

  for (const paths of pathSets) {
    for (const path of new Set(paths)) {
      writersByPath.set(path, (writersByPath.get(path) ?? 0) + 1);
    }
  }

  return [...writersByPath.entries()]
    .filter(([, writerCount]) => writerCount > 1)
    .map(([path]) => path)
    .sort();
}

function isWorkspaceWriteTool(name: string): boolean {
  return isPatchTool(name) || name === "restore_patch_snapshot" || name === "edit";
}

function formatPatchSnapshotsUsage(): string {
  return [
    "Usage: /snapshots [list] [limit]",
    "       /snapshots history [limit]",
    "       /snapshots show <snapshot-file>",
    "       /snapshots restore <snapshot-file> <path>",
  ].join("\n");
}

function formatSymbolsUsage(): string {
  return [
    "Usage: /symbols [list] [limit]",
    "       /symbols search <query> [limit]",
  ].join("\n");
}

function formatContextIndexUsage(): string {
  return [
    "Usage: /index [status]",
    "       /index build",
    "       /index search <query> [limit]",
    "       /index eval [status]",
    "       /index eval init",
    "       /index eval run [--json]",
    "       /index semantic [status]",
    "       /index semantic build",
    "       /index semantic search <query> [limit]",
  ].join("\n");
}

function parseRepairLoopAttempts(request: string): number | string {
  const trimmed = request.trim();

  if (trimmed.length === 0) {
    return DEFAULT_REPAIR_LOOP_ATTEMPTS;
  }

  if (!/^\d+$/.test(trimmed)) {
    return `Usage: /repair-loop [attempts]\nAttempts must be a number from 1 to ${MAX_REPAIR_LOOP_ATTEMPTS}.`;
  }

  const attempts = Number(trimmed);

  if (attempts < 1 || attempts > MAX_REPAIR_LOOP_ATTEMPTS) {
    return `Usage: /repair-loop [attempts]\nAttempts must be a number from 1 to ${MAX_REPAIR_LOOP_ATTEMPTS}.`;
  }

  return attempts;
}

function parseVerificationStabilityRuns(request: string): number | string {
  const trimmed = request.trim();

  if (trimmed.length === 0) {
    return DEFAULT_VERIFICATION_STABILITY_RUNS;
  }

  if (!/^\d+$/.test(trimmed)) {
    return `Usage: /verify-stability [runs]\nRuns must be a number from 1 to ${MAX_VERIFICATION_STABILITY_RUNS}.`;
  }

  const runs = Number(trimmed);

  if (runs < 1 || runs > MAX_VERIFICATION_STABILITY_RUNS) {
    return `Usage: /verify-stability [runs]\nRuns must be a number from 1 to ${MAX_VERIFICATION_STABILITY_RUNS}.`;
  }

  return runs;
}

function extractVerificationSuggestions(metadata: Record<string, unknown> | undefined): Array<{
  command: string;
  reason: string;
}> {
  const rawSuggestions = metadata?.suggestions;

  if (Array.isArray(rawSuggestions)) {
    return rawSuggestions.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }

      const command = (item as Record<string, unknown>).command;
      const reason = (item as Record<string, unknown>).reason;

      if (typeof command !== "string" || command.trim().length === 0) {
        return [];
      }

      return [{
        command: command.trim(),
        reason: typeof reason === "string" ? reason : "",
      }];
    });
  }

  const rawCommands = metadata?.commands;

  if (!Array.isArray(rawCommands)) {
    return [];
  }

  return rawCommands.flatMap((command) => (
    typeof command === "string" && command.trim().length > 0
      ? [{ command: command.trim(), reason: "" }]
      : []
  ));
}

function indentBlock(value: string, prefix: string): string {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function buildVerificationRepairPrompt(
  failure: SessionVerificationFailureRecord,
  recentPatch?: SessionPatchRecord,
  additionalContext: string[] = [],
): string {
  return [
    "Repair the most recent verification failure.",
    "",
    `Failed command: ${failure.command}`,
    `Changed paths: ${failure.paths.length > 0 ? failure.paths.join(", ") : "(unknown)"}`,
    ...(recentPatch
      ? [`Recent patch paths: ${recentPatch.paths.length > 0 ? recentPatch.paths.join(", ") : "(unknown)"}`]
      : []),
    ...(recentPatch?.snapshotPath ? [`Recent patch snapshot: ${recentPatch.snapshotPath}`] : []),
    ...(failure.exitCode !== undefined ? [`Exit code: ${failure.exitCode}`] : []),
    ...(failure.diagnosis
      ? [`Verification diagnosis: ${failure.diagnosis.category}/${failure.diagnosis.label}`]
      : []),
    ...(failure.stability
      ? [`Verification stability: ${failure.stability.status} (${failure.stability.passed} passed, ${failure.stability.failed} failed across ${failure.stability.runs} runs)`]
      : []),
    ...(failure.locations.length > 0 ? [`Inspect first: ${failure.locations.join(", ")}`] : []),
    `Failed at: ${failure.failedAt}`,
    "",
    "Failure summary:",
    ...(failure.summary.length > 0 ? failure.summary.map((line) => `- ${line}`) : ["- (none)"]),
    "",
    "Remediation hints:",
    ...(failure.remediation.length > 0
      ? failure.remediation.map((line) => `- ${line}`)
      : ["- Rerun the failed command with the smallest focused scope and inspect the first non-empty stderr line."]),
    "",
    "Repair strategy:",
    ...buildVerificationRepairStrategy(failure).map((line) => `- ${line}`),
    ...(additionalContext.length > 0
      ? [
          "",
          "Additional repair context:",
          ...additionalContext.flatMap((block, index) => [
            `Context ${index + 1}:`,
            indentBlock(block, "  "),
          ]),
        ]
      : []),
    "",
    "Captured output:",
    failure.output || "(none)",
    "",
    "Instructions:",
    "- Inspect the relevant files before editing.",
    ...(recentPatch
      ? ["- Recent patch paths may already have changed; reread current file contents before writing another patch and avoid stale hunks."]
      : []),
    "- Make the smallest safe patch that addresses the failure.",
    "- Use apply_patch for edits; do not use shell commands to edit files.",
    "- After editing, suggest or run the focused verification command.",
  ].join("\n");
}

function extractSuggestedNextReadPaths(content: string): string[] {
  const normalized = content
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n");
  const paths: string[] = [];
  let inSection = false;

  for (const line of normalized.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === "suggested next reads:") {
      inSection = true;
      continue;
    }

    if (!inSection) {
      continue;
    }

    const match = /^-\s+read_file\s+(.+)$/.exec(trimmed);

    if (match) {
      const path = match[1]?.trim().replace(/^["']|["']$/g, "");

      if (path && !path.startsWith("-")) {
        paths.push(path);
      }

      continue;
    }

    if (trimmed.length > 0 && !trimmed.startsWith("-")) {
      inSection = false;
    }
  }

  return uniqueStrings(paths);
}

function extractInitialRepairReadPaths(failure: SessionVerificationFailureRecord): string[] {
  const locationPaths = failure.locations.flatMap((location) => {
    const path = extractPathFromFailureLocation(location);
    return path ? [path] : [];
  });
  const commandPaths = extractRepairCommandFilePaths(`${failure.command}\n${failure.output}`);
  const failurePaths = failure.paths.filter((path) => path.trim().length > 0 && path !== "(unknown)");

  return uniqueStrings([...locationPaths, ...commandPaths, ...failurePaths]);
}

function extractRepairCommandFilePaths(value: string): string[] {
  const paths: string[] = [];

  for (const token of value.split(/\s+/)) {
    const withoutLocation = token
      .replace(/^[('"`]+/, "")
      .replace(/[)'"`,;]+$/, "")
      .replace(/:\d+(?::\d+)?$/, "");
    const normalized = withoutLocation.replaceAll("\\", "/").replace(/^\.\//, "");

    if (
      normalized.length === 0 ||
      normalized.includes(":") ||
      normalized.startsWith("/") ||
      normalized.startsWith("../") ||
      !/^(?:[\w@.-]+\/)+[\w@.-]+\.(?:[cm]?[jt]sx?|json)$/i.test(normalized)
    ) {
      continue;
    }

    const lower = normalized.toLowerCase();

    if (
      lower.startsWith("node_modules/") ||
      lower.startsWith("dist/") ||
      lower.startsWith("build/") ||
      lower.startsWith("coverage/") ||
      lower.startsWith(".ccagent/")
    ) {
      continue;
    }

    paths.push(normalized);
  }

  return uniqueStrings(paths);
}

function extractPathFromFailureLocation(location: string): string | undefined {
  const normalized = location.trim().replaceAll("\\", "/");

  if (normalized.length === 0) {
    return undefined;
  }

  const parenLocation = /^(.+?)\(\d+,\d+\)/.exec(normalized);

  if (parenLocation?.[1]) {
    return parenLocation[1];
  }

  const lineColumnLocation = /^(.+):\d+:\d+$/.exec(normalized);

  if (lineColumnLocation?.[1]) {
    return lineColumnLocation[1];
  }

  const lineOnlyLocation = /^(.+):\d+$/.exec(normalized);

  if (lineOnlyLocation?.[1]) {
    return lineOnlyLocation[1];
  }

  return normalized;
}

function buildVerificationRepairStrategy(failure: SessionVerificationFailureRecord): string[] {
  const sections = parseShellOutputSections(failure.output);
  const likelyFailure = classifyVerificationFailure(sections);
  const environmentFailure = likelyFailure?.category === "environment";
  const text = [...sections.stderrLines, ...sections.stdoutLines]
    .map(stripAnsi)
    .join("\n");
  const strategy = [
    "Use the failed command as the acceptance check and keep edits limited to the smallest failing surface.",
  ];

  if (!environmentFailure && failure.locations.length > 0) {
    strategy.push(`Inspect ${failure.locations.join(", ")} before editing; prefer the first reported location unless later output proves it is a follow-on error.`);
  } else if (!environmentFailure && failure.paths.length > 0) {
    strategy.push(`Start from the changed path(s): ${failure.paths.join(", ")}.`);
  }

  if (likelyFailure?.label === "missing environment variable") {
    strategy.push("Treat this as an environment/configuration failure, not evidence of an application-code defect.");
    strategy.push("Set the required variable in the current shell or CI secret store and confirm the intended .env loader runs in this command context.");
    strategy.push("Do not hardcode secret values, commit .env files, or weaken validation merely to make the command pass.");
  } else if (likelyFailure?.label === "port already in use") {
    strategy.push("Treat this as a runtime resource conflict before changing application behavior.");
    strategy.push("Identify the process listening on the requested port, stop the stale process or configure an available port, then rerun the exact command.");
    strategy.push("Do not remove server startup checks or silently ignore bind failures.");
  } else if (likelyFailure?.label === "local service readiness/startup failure") {
    strategy.push("Treat this as a local service startup synchronization defect, not an external network outage.");
    strategy.push("Wait for an explicit ready/listening signal or poll the health endpoint with a bounded deadline and short backoff before running dependent assertions.");
    strategy.push("Preserve the final startup error and clean up the server or child process in finally; do not use a fixed long sleep, unbounded retries, disabled health assertions, or swallowed failures.");
  } else if (likelyFailure?.label === "network/DNS dependency failure") {
    strategy.push("Treat this as an external dependency or network-path failure before editing application source.");
    strategy.push("Verify the hostname/base URL, DNS, proxy, VPN, TLS, and remote service health from the same shell environment.");
    strategy.push("Do not disable TLS verification, swallow connection errors, or replace real integrations with hardcoded success responses.");
  } else if (likelyFailure?.label === "missing system command") {
    strategy.push("Treat this as a toolchain/PATH failure before changing product code.");
    strategy.push("Confirm the command is installed and visible on PATH in the same shell; prefer the project's declared package script or local binary when available.");
    strategy.push("Do not replace application behavior merely because a required developer tool is unavailable.");
  } else if (likelyFailure?.label === "process cleanup/lifecycle failure") {
    strategy.push("Treat completed assertions followed by a timeout or open-handle warning as a process lifecycle defect.");
    strategy.push("Inspect server, listener, socket, timer, worker, and child-process setup; close or clear each owned resource and await asynchronous teardown in finally, afterEach, or afterAll.");
    strategy.push("Do not force process.exit(0), increase the verification timeout, suppress open-handle warnings, or terminate unrelated machine processes to make the check appear green.");
  } else if (likelyFailure?.label === "TypeScript compile/typecheck failure") {
    strategy.push("Fix the first TypeScript diagnostic before chasing secondary errors.");

    if (/TS2307|Cannot find module/i.test(text)) {
      strategy.push("For unresolved imports, verify the relative path, exported symbol, installed package, and tsconfig path aliases.");
    } else if (/TS2322|TS2345|not assignable to/i.test(text)) {
      strategy.push("For assignability errors, align the real value, function argument, or type definition; avoid suppressions and broad casts.");
    } else if (/TS2339|Property .* does not exist/i.test(text)) {
      strategy.push("For missing properties, check renamed APIs, required narrowing, and the object that should own the property.");
    } else if (/TS2554|Expected \d+ arguments?/i.test(text)) {
      strategy.push("For argument count errors, compare the call site and function signature, then update both contract and callers consistently.");
    }
  } else if (
    likelyFailure?.label === "Node test runner failure" ||
    likelyFailure?.label === "Jest test failure" ||
    likelyFailure?.label === "Vitest test failure"
  ) {
    strategy.push("Treat the failing test name and assertion diff as the behavioral contract.");
    strategy.push("Patch source behavior before changing tests, unless the captured output clearly shows the test contract is outdated.");
    strategy.push("After editing, rerun the smallest failing test command before broader verification.");
  } else if (likelyFailure?.label === "npm script failure") {
    strategy.push("Inspect package.json scripts and the child command output; fix the underlying script or command before changing npm configuration.");
  } else if (likelyFailure?.label === "command output reported an error") {
    strategy.push("Reproduce the exact command and fix the first important stderr/stdout line before broadening scope.");
  } else {
    strategy.push("If the output is ambiguous, rerun the failed command with a narrower scope or more verbose logging before editing.");
  }

  strategy.push(
    environmentFailure
      ? "Only edit repository configuration when the captured evidence proves that configuration is wrong; otherwise report the environment action required."
      : "Do not edit generated artifacts, snapshots, or unrelated formatting unless the failure points there.",
  );

  return uniqueStrings(strategy).slice(0, 7);
}

function summarizeVerificationFailure(content: string, exitCode: number | null): string[] {
  const sections = parseShellOutputSections(content);
  const summary = [`exitCode: ${exitCode ?? sections.exitCode ?? "unknown"}`];
  const likelyFailure = classifyVerificationFailure(sections);
  const locations = extractVerificationFailureLocations(sections);
  const stderrLines = selectImportantOutputLines(sections.stderrLines, { preferAny: true });
  const stdoutLines = selectImportantOutputLines(sections.stdoutLines, { preferAny: false });

  if (likelyFailure) {
    summary.push(`likely: ${likelyFailure.label}`);
    summary.push(`next: ${likelyFailure.next}`);
  }

  if (locations.length > 0) {
    summary.push(`inspect: ${locations.join(", ")}`);
  }

  for (const line of stderrLines) {
    summary.push(`stderr: ${line}`);
  }

  const remaining = Math.max(0, 6 - summary.length);

  for (const line of stdoutLines.slice(0, remaining)) {
    summary.push(`stdout: ${line}`);
  }

  if (summary.length === 1) {
    summary.push("no stderr/stdout details captured");
  }

  return summary.slice(0, 6);
}

function suggestVerificationRemediation(content: string): string[] {
  const sections = parseShellOutputSections(content);
  const likelyFailure = classifyVerificationFailure(sections);
  const locations = extractVerificationFailureLocations(sections);
  const text = [...sections.stderrLines, ...sections.stdoutLines]
    .map(stripAnsi)
    .join("\n");
  const suggestions: string[] = [];

  if (locations[0] && likelyFailure?.category !== "environment") {
    suggestions.push(`start with ${locations[0]}; inspect the nearby code and keep the next edit scoped to the smallest failing area`);
  }

  if (likelyFailure?.label === "missing environment variable") {
    const names = extractEnvironmentVariableNames(text);
    suggestions.push(
      `set the required environment variable${names.length > 0 ? ` (${names.join(", ")})` : ""} in the current shell or CI secret store, then rerun the exact command`,
    );
    suggestions.push("verify the intended .env loader and working directory; do not hardcode secret values or commit local environment files");
  } else if (likelyFailure?.label === "port already in use") {
    suggestions.push("identify the process listening on the requested port, stop the stale process or select an available port, then rerun");
    suggestions.push("keep bind failures visible; do not remove startup checks or silently ignore EADDRINUSE");
  } else if (likelyFailure?.label === "local service readiness/startup failure") {
    const endpoint = extractLocalServiceEndpoint(text);
    suggestions.push(`add a bounded readiness probe${endpoint ? ` for ${endpoint}` : " for the local service"} using an explicit ready/listening signal or health retries until a deadline`);
    suggestions.push("start dependent assertions only after readiness succeeds, preserve the last connection/startup error, and always clean up the service in finally");
    suggestions.push("do not replace readiness with a fixed long sleep, retry forever, disable the health assertion, or swallow the final failure");
  } else if (likelyFailure?.label === "network/DNS dependency failure") {
    suggestions.push("check the hostname or base URL, DNS resolution, proxy/VPN settings, TLS trust, and remote service availability from this shell");
    suggestions.push("retry after the dependency is reachable; do not disable TLS verification or hide connection failures in application code");
  } else if (likelyFailure?.label === "missing system command") {
    const command = extractMissingSystemCommand(text);
    suggestions.push(
      `install or enable the missing command${command ? ` (${command})` : ""} and confirm it is visible on PATH in the same shell`,
    );
    suggestions.push("prefer the repository's declared local dependency or package script before changing application source");
  } else if (likelyFailure?.label === "process cleanup/lifecycle failure") {
    suggestions.push("inspect the reported test or startup fixture for servers, listeners, sockets, timers, workers, and child processes that remain active after assertions finish");
    suggestions.push("close or clear owned resources and await asynchronous teardown in finally, afterEach, or afterAll, then rerun the exact command");
    suggestions.push("do not use process.exit(0), extend the timeout, suppress open-handle warnings, or kill unrelated machine processes as a substitute for cleanup");
  } else if (likelyFailure?.label === "TypeScript compile/typecheck failure") {
    if (/TS2307|Cannot find module/i.test(text)) {
      suggestions.push("fix the unresolved import first: verify the relative path, exported symbol, package install, or tsconfig path alias");
    } else if (/TS2322|TS2345|not assignable to/i.test(text)) {
      suggestions.push("align the value or argument with the expected type; prefer a real type/value fix over a broad cast");
    } else if (/TS2339|Property .* does not exist/i.test(text)) {
      suggestions.push("check whether the property was renamed, needs narrowing, or belongs on a different object type");
    } else if (/TS2554|Expected \d+ arguments?/i.test(text)) {
      suggestions.push("compare the function signature with the call site, then update the call or the signature consistently");
    } else {
      suggestions.push("fix the first TypeScript diagnostic before chasing follow-on errors, then rerun the same typecheck command");
    }
  } else if (
    likelyFailure?.label === "Node test runner failure" ||
    likelyFailure?.label === "Jest test failure" ||
    likelyFailure?.label === "Vitest test failure"
  ) {
    suggestions.push("rerun the smallest failing test if possible, then inspect the assertion diff before editing implementation code");

    if (/AssertionError|expected|actual|Received|Expected/i.test(text)) {
      suggestions.push("identify the expected behavior from the test name and assertion, then fix source behavior unless the test contract is wrong");
    }
  } else if (likelyFailure?.label === "npm script failure") {
    if (/Missing script/i.test(text)) {
      suggestions.push("run npm run to list available scripts, then update the verification command or add the missing package.json script");
    } else {
      suggestions.push("read the first npm ERR line and the child command output; fix the underlying command before changing npm config");
    }
  } else if (likelyFailure?.label === "command output reported an error") {
    suggestions.push("reproduce the exact failed command, then use the first important stderr/stdout line as the smallest symptom to fix");
  }

  if (suggestions.length === 0) {
    suggestions.push("rerun the failed command with the smallest focused scope and inspect the first non-empty stderr line");
  }

  return uniqueStrings(suggestions).slice(0, 4);
}

function classifyVerificationFailure(sections: {
  stderrLines: string[];
  stdoutLines: string[];
}): { category: "code" | "environment"; label: string; next: string } | undefined {
  const text = [...sections.stderrLines, ...sections.stdoutLines]
    .map(stripAnsi)
    .join("\n");

  if (isMissingEnvironmentVariableFailure(text)) {
    return {
      category: "environment",
      label: "missing environment variable",
      next: "set the required variable in the current shell or CI secret store, verify environment loading, then rerun",
    };
  }

  if (/EADDRINUSE|address already in use|port\s+\d+\s+(?:is\s+)?(?:already\s+)?(?:in use|occupied)/i.test(text)) {
    return {
      category: "environment",
      label: "port already in use",
      next: "identify the listening process or select an available port, then rerun the exact command",
    };
  }

  if (isMissingSystemCommandFailure(text)) {
    return {
      category: "environment",
      label: "missing system command",
      next: "install or enable the command on PATH in the same shell, then rerun the project command",
    };
  }

  if (isLocalServiceReadinessFailure(text)) {
    return {
      category: "code",
      label: "local service readiness/startup failure",
      next: "wait for a bounded local ready/health signal before dependent checks, preserve failures, and clean up the service",
    };
  }

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network is unreachable|unable to resolve host|could not resolve host|socket hang up|fetch failed/i.test(text)) {
    return {
      category: "environment",
      label: "network/DNS dependency failure",
      next: "verify the endpoint, DNS, proxy/VPN, TLS, and remote service health from the same environment",
    };
  }

  if (isProcessCleanupFailure(text)) {
    return {
      category: "code",
      label: "process cleanup/lifecycle failure",
      next: "close and await the leaked server, timer, worker, socket, or child process in teardown, then rerun",
    };
  }

  if (/error TS\d+:/i.test(text) || /Found \d+ errors?/i.test(text)) {
    return {
      category: "code",
      label: "TypeScript compile/typecheck failure",
      next: "open the reported file and line, fix the type error, then rerun typecheck",
    };
  }

  if (/ERR_TEST_FAILURE|# Subtest:|^not ok \d+/im.test(text)) {
    return {
      category: "code",
      label: "Node test runner failure",
      next: "inspect the failing subtest/assertion, fix the behavior, then rerun the focused test",
    };
  }

  if (/Test Suites:.*failed|Jest/i.test(text)) {
    return {
      category: "code",
      label: "Jest test failure",
      next: "inspect the failed suite/test name and assertion diff, then rerun that Jest test",
    };
  }

  if (/Vitest|Test Files.*failed|Tests.*failed/i.test(text)) {
    return {
      category: "code",
      label: "Vitest test failure",
      next: "inspect the failed test file/name and assertion diff, then rerun that Vitest test",
    };
  }

  if (/npm ERR!|ELIFECYCLE|Missing script/i.test(text)) {
    return {
      category: "code",
      label: "npm script failure",
      next: "check package.json scripts and the npm error above, then rerun the intended script",
    };
  }

  if (/\b(error|failed|failure|exception|fatal)\b/i.test(text)) {
    return {
      category: "code",
      label: "command output reported an error",
      next: "inspect the key stderr/stdout line above and rerun the smallest failing command",
    };
  }

  return undefined;
}

function isMissingEnvironmentVariableFailure(text: string): boolean {
  return (
    /(?:missing|required|unset|not set|undefined)[^\n]{0,100}(?:environment variable|env(?:ironment)?\s+var(?:iable)?)/i.test(text) ||
    /(?:environment variable|env(?:ironment)?\s+var(?:iable)?)[^\n]{0,100}(?:missing|required|unset|not set|undefined)/i.test(text) ||
    /process\.env\.[A-Z_][A-Z0-9_]*[^\n]{0,80}(?:missing|required|not set|undefined)/i.test(text)
  );
}

function extractEnvironmentVariableNames(text: string): string[] {
  const names: string[] = [];
  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /(?:environment variable|env(?:ironment)?\s+var(?:iable)?)[\s:'"`=]+([A-Z_][A-Z0-9_]*)/gi,
    /\b([A-Z][A-Z0-9_]{2,})\b[^\n]{0,40}(?:is required|is missing|is not set|must be set)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];

      if (name) {
        names.push(name.toUpperCase());
      }
    }
  }

  return uniqueStrings(names).slice(0, 5);
}

function isMissingSystemCommandFailure(text: string): boolean {
  return (
    /spawn\s+[^\s]+\s+ENOENT/i.test(text) ||
    /(?:^|\n)(?:\/bin\/sh:\s*)?[^\s:]+:\s*(?:command not found|not found)\s*$/im.test(text) ||
    /'[^']+' is not recognized as an internal or external command/i.test(text) ||
    /The term ['"]?[^'"\s]+['"]? is not recognized as the name of a cmdlet/i.test(text)
  );
}

function extractMissingSystemCommand(text: string): string | undefined {
  return (
    /spawn\s+([^\s]+)\s+ENOENT/i.exec(text)?.[1] ??
    /(?:^|\n)(?:\/bin\/sh:\s*)?([^\s:]+):\s*(?:command not found|not found)\s*$/im.exec(text)?.[1] ??
    /'([^']+)' is not recognized as an internal or external command/i.exec(text)?.[1] ??
    /The term ['"]?([^'"\s]+)['"]? is not recognized as the name of a cmdlet/i.exec(text)?.[1]
  );
}

function isLocalServiceReadinessFailure(text: string): boolean {
  const hasLocalEndpoint = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d{1,5})?(?:\/[^\s'"`)]*)?/i.test(text);
  const hasConnectionFailure =
    /\bECONNREFUSED\b|connection refused|connect(?:ion)? failed|fetch failed|timed out while waiting|timed out waiting/i.test(text);
  const hasReadinessSignal = /\b(?:health(?:\s+check)?|readiness|ready)\b/i.test(text);
  const hasStartupSignal =
    /\b(?:startup|starting|launch(?:ed|ing)?|spawn(?:ed|ing)?|boot(?:ed|ing)?|waiting for (?:the )?(?:local )?(?:service|server))\b/i.test(text);

  return hasLocalEndpoint && hasConnectionFailure && hasReadinessSignal && hasStartupSignal;
}

function extractLocalServiceEndpoint(text: string): string | undefined {
  const endpoint = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:\/[^\s'"`)]*)?/i.exec(text)?.[0];

  return endpoint?.replace(/[.,;]+$/, "");
}

function isProcessCleanupFailure(text: string): boolean {
  const explicitLifecycleSignal =
    /Jest did not exit .*test run has completed/i.test(text) ||
    /worker process has failed to exit gracefully/i.test(text) ||
    /(?:open handles?|active handles?).{0,120}(?:keeping|preventing|remain|still|exit)/is.test(text) ||
    /(?:server|listener|socket|timer|interval|worker|child process).{0,100}(?:was not closed|was not stopped|still running|still active|leaked)/is.test(text);

  if (explicitLifecycleSignal) {
    return true;
  }

  const timedOut = /\[ccagent\] command timed out after \d+ms/i.test(text);
  const workCompleted =
    /(?:all\s+)?(?:tests?|assertions?)\s+(?:have\s+)?(?:passed|completed|finished)/i.test(text) ||
    /test run has completed/i.test(text) ||
    /\b\d+\s+(?:tests?\s+)?passing\b/i.test(text);
  const cleanupSignal =
    /(?:cleanup|tear(?:down|\s+down)|open handle|server|listener|socket|timer|interval|worker|child process)/i.test(text);

  return timedOut && workCompleted && cleanupSignal;
}

function extractVerificationFailureLocations(sections: {
  stderrLines: string[];
  stdoutLines: string[];
}): string[] {
  const text = [...sections.stderrLines, ...sections.stdoutLines]
    .map(stripAnsi)
    .join("\n");
  const locations: string[] = [];
  const parenPattern = /((?:[A-Za-z]:)?[\w./\\-]+\.[A-Za-z][\w.-]*)\((\d+),(\d+)\)/g;
  const colonPattern = /((?:[A-Za-z]:)?[\w./\\-]+\.[A-Za-z][\w.-]*):(\d+)(?::(\d+))?/g;
  const stackPathPattern = /^\s*-\s*(.+\.[A-Za-z][\w.-]*)\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = parenPattern.exec(text)) !== null) {
    const [, path, line, column] = match;
    addVerificationLocation(locations, path, line, column);
  }

  while ((match = colonPattern.exec(text)) !== null) {
    const [, path, line, column] = match;
    addVerificationLocation(locations, path, line, column);
  }

  while ((match = stackPathPattern.exec(text)) !== null) {
    const [, path] = match;
    addVerificationLocationPath(locations, path);
  }

  return locations.slice(0, 3);
}

function addVerificationLocation(
  locations: string[],
  path: string | undefined,
  line: string | undefined,
  column: string | undefined,
): void {
  if (!path || !line || isIgnoredFailureLocationPath(path)) {
    return;
  }

  const normalizedPath = path.replaceAll("\\", "/");
  const location = `${normalizedPath}:${line}${column ? `:${column}` : ""}`;

  if (!locations.includes(location)) {
    locations.push(location);
  }
}

function addVerificationLocationPath(
  locations: string[],
  path: string | undefined,
): void {
  if (!path || isIgnoredFailureLocationPath(path)) {
    return;
  }

  const normalizedPath = path.replaceAll("\\", "/");

  if (!locations.includes(normalizedPath)) {
    locations.push(normalizedPath);
  }
}

function isIgnoredFailureLocationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();

  return normalized.startsWith("node:") || normalized.includes("/node_modules/");
}

function parseShellOutputSections(content: string): {
  exitCode?: string;
  stderrLines: string[];
  stdoutLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let section: "stdout" | "stderr" | null = null;
  let exitCode: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trimEnd();

    if (line.startsWith("exitCode:")) {
      exitCode = line.slice("exitCode:".length).trim();
      section = null;
      continue;
    }

    if (line === "stdout:") {
      section = "stdout";
      continue;
    }

    if (line === "stderr:") {
      section = "stderr";
      continue;
    }

    if (section === "stdout") {
      stdoutLines.push(line);
    } else if (section === "stderr") {
      stderrLines.push(line);
    }
  }

  return {
    ...(exitCode ? { exitCode } : {}),
    stderrLines,
    stdoutLines,
  };
}

function selectImportantOutputLines(
  lines: string[],
  options: { preferAny: boolean },
): string[] {
  const cleaned = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "(empty)")
    .filter((line) => !line.startsWith("> "));
  const important = cleaned.filter(isImportantFailureLine);
  const selected = important.length > 0 || !options.preferAny ? important : cleaned;
  const fallback = selected.length > 0 ? selected : options.preferAny ? [] : cleaned.slice(-3);

  return uniqueStrings(fallback)
    .slice(0, 4)
    .map((line) => truncateForDisplay(line, 220));
}

function isImportantFailureLine(line: string): boolean {
  return /\b(error|failed|failure|exception|traceback|assert|fatal|not found|cannot|denied|timed out)\b/i.test(line) ||
    /\b(ERR!|ELIFECYCLE|SyntaxError|TypeError|ReferenceError|AssertionError)\b/.test(line) ||
    /^[x✖✗]\s/.test(line);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSymbolSearchRequest(parts: string[]): { limit: number; query: string } {
  const lastPart = parts.at(-1);
  const hasLimit = lastPart !== undefined && /^\d+$/.test(lastPart);
  const limit = hasLimit ? Number(lastPart) : 20;
  const queryParts = hasLimit ? parts.slice(0, -1) : parts;

  return {
    limit,
    query: queryParts.join(" ").trim(),
  };
}

function parseIndexSearchRequest(parts: string[]): { limit: number; query: string } {
  const lastPart = parts.at(-1);
  const hasLimit = lastPart !== undefined && /^\d+$/.test(lastPart);
  const limit = hasLimit ? Number(lastPart) : 10;
  const queryParts = hasLimit ? parts.slice(0, -1) : parts;

  return {
    limit,
    query: queryParts.join(" ").trim(),
  };
}

function toAgentStreamEvent(event: ModelStreamEvent): AgentStreamEvent {
  return {
    type: "text_delta",
    delta: event.delta,
  };
}

function modelUsageToUsageRecord(usage: ModelUsage | undefined): UsageRecord {
  if (!usage) {
    return {};
  }

  return {
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(usage.estimated ? { usageEstimated: true } : {}),
  };
}

function formatConversationCompaction(result: ConversationCompactResult): string {
  return [
    "Conversation compacted.",
    `Reason: ${result.reason}`,
    `Messages: ${result.beforeMessages} -> ${result.afterMessages}`,
    `Summarized messages: ${result.summarizedMessages}`,
    `Recent messages kept: ${result.keptMessages}`,
    `Summary chars: ${result.summaryChars}`,
    "Model history was restored from the compacted local conversation.",
  ].join("\n");
}

function formatConversationStatus(status: ConversationStatus): string {
  return [
    "Conversation compaction status",
    `Messages: ${status.messageCount}`,
    `Total chars: ${status.totalChars}`,
    `Has summary: ${formatYesNo(status.hasSummary)}`,
    `Summary chars: ${status.summaryChars}`,
    `Can compact now: ${formatYesNo(status.canCompact)}`,
    `Auto trigger: more than ${status.compactTriggerMessages} messages`,
    `Keep recent messages: ${status.keepRecentMessages}`,
    `Legacy hard cap: ${status.maxMessages}`,
  ].join("\n");
}

function formatYesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function parsePlanStepId(value: string): number | null {
  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function formatHistoryUsage(): string {
  return [
    "Usage: /history [count]",
    "       /history --all",
    "count must be between 1 and 100.",
  ].join("\n");
}

function statusToCommand(status: PlanStepStatus): string {
  if (status === "completed") {
    return "done";
  }

  if (status === "in_progress") {
    return "start";
  }

  return "pending";
}
