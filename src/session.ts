import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationMessage } from "./conversation.js";
import { createEmptyPlan, formatPlan, parsePlan, type PlanState } from "./plan.js";
import { formatTaskState, parseTaskState, type TaskState } from "./taskState.js";

export type SessionData = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  modelName: string;
  lastResponseId?: string;
  lastPatch?: SessionPatchRecord;
  lastVerificationFailure?: SessionVerificationFailureRecord;
  lastVerificationRun?: SessionVerificationRunRecord;
  lastVerificationTarget?: SessionVerificationTargetRecord;
  taskState?: TaskState;
  messages: ConversationMessage[];
  plan: PlanState;
};

export type SessionPatchRecord = {
  patch: string;
  paths: string[];
  appliedAt: string;
  snapshotPath?: string;
};

export type SessionVerificationFailureRecord = {
  command: string;
  diagnosis?: SessionVerificationDiagnosis;
  paths: string[];
  failedAt: string;
  summary: string[];
  remediation: string[];
  locations: string[];
  output: string;
  exitCode?: number;
  stability?: SessionVerificationStabilityRecord;
};

export type SessionVerificationDiagnosis = {
  category: "code" | "environment";
  label: string;
};

export type SessionVerificationStabilityRecord = {
  baseline: "failed" | "passed" | "target";
  checkedAt: string;
  failed: number;
  passed: number;
  runs: number;
  status: "flaky" | "stable_failure";
};

export type SessionVerificationRunRecord = {
  command: string;
  paths: string[];
  recordedAt: string;
  status: "failed" | "passed";
  exitCode?: number;
};

export type SessionVerificationTargetRecord = {
  command: string;
  paths: string[];
  recordedAt: string;
};

export type LoadedSession = {
  path: string;
  exists: boolean;
  session: SessionData;
  warnings: string[];
};

export type SessionCheckpointSummary = {
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  modelName: string;
  messageCount: number;
  planStepCount: number;
  lastPatchPaths: string[];
};

export type LoadedSessionCheckpoints = {
  dir: string;
  checkpoints: SessionCheckpointSummary[];
  warnings: string[];
};

const SESSION_DIR = ".ccagent/sessions";
const CURRENT_SESSION_FILE = "current.json";
const CHECKPOINT_DIR = "checkpoints";
const CHECKPOINT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const CHECKPOINT_LOAD_BACKUP_PREFIX = "before-load-";
export const DEFAULT_SESSION_DETAIL_MESSAGE_LIMIT = 8;
const CHECKPOINT_DETAIL_MESSAGE_CHARS = 500;
const CHECKPOINT_DIFF_MESSAGE_LIMIT = 8;
const CHECKPOINT_DIFF_MESSAGE_CHARS = 300;
const SESSION_STATS_LARGEST_MESSAGES = 5;
const SESSION_SEARCH_LIMIT = 10;
const SESSION_SEARCH_CONTEXT_CHARS = 80;

export class SessionStore {
  readonly path: string;
  readonly checkpointDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.path = join(workspaceRoot, SESSION_DIR, CURRENT_SESSION_FILE);
    this.checkpointDir = join(workspaceRoot, SESSION_DIR, CHECKPOINT_DIR);
  }

  async load(modelName: string): Promise<LoadedSession> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const warnings: string[] = [];
      const session = parseSession(parsed, modelName, warnings);

      return {
        path: this.path,
        exists: true,
        session,
        warnings,
      };
    } catch (error) {
      if (isFileNotFound(error)) {
        return {
          path: this.path,
          exists: false,
          session: createEmptySession(modelName),
          warnings: [],
        };
      }

      const reason = error instanceof Error ? error.message : String(error);

      return {
        path: this.path,
        exists: false,
        session: createEmptySession(modelName),
        warnings: [`Failed to load session: ${reason}`],
      };
    }
  }

  async save(session: SessionData): Promise<void> {
    await writeSessionFile(this.path, session);
  }

  checkpointPath(name: string): string {
    return join(this.checkpointDir, `${name}.json`);
  }

  async saveCheckpoint(name: string, session: SessionData): Promise<{ name: string; path: string }> {
    assertValidSessionCheckpointName(name);

    const path = this.checkpointPath(name);
    await writeSessionFile(path, session);

    return {
      name,
      path,
    };
  }

  async loadCheckpoint(name: string, modelName: string): Promise<LoadedSession> {
    assertValidSessionCheckpointName(name);

    const path = this.checkpointPath(name);

    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const warnings: string[] = [];
      const session = parseSession(parsed, modelName, warnings);

      return {
        path,
        exists: true,
        session,
        warnings,
      };
    } catch (error) {
      if (isFileNotFound(error)) {
        return {
          path,
          exists: false,
          session: createEmptySession(modelName),
          warnings: [],
        };
      }

      const reason = error instanceof Error ? error.message : String(error);

      return {
        path,
        exists: false,
        session: createEmptySession(modelName),
        warnings: [`Failed to load session checkpoint ${name}: ${reason}`],
      };
    }
  }

  async listCheckpoints(modelName: string): Promise<LoadedSessionCheckpoints> {
    try {
      const entries = await readdir(this.checkpointDir, { withFileTypes: true });
      const checkpoints: SessionCheckpointSummary[] = [];
      const warnings: string[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const name = entry.name.slice(0, -".json".length);

        if (!isValidSessionCheckpointName(name)) {
          warnings.push(`Ignoring invalid session checkpoint filename: ${entry.name}`);
          continue;
        }

        const loaded = await this.loadCheckpoint(name, modelName);

        if (!loaded.exists) {
          warnings.push(...loaded.warnings);
          continue;
        }

        checkpoints.push(toCheckpointSummary(name, loaded));
        warnings.push(...loaded.warnings.map((warning) => `${name}: ${warning}`));
      }

      return {
        dir: this.checkpointDir,
        checkpoints: checkpoints.sort((left, right) => left.name.localeCompare(right.name)),
        warnings,
      };
    } catch (error) {
      if (isFileNotFound(error)) {
        return {
          dir: this.checkpointDir,
          checkpoints: [],
          warnings: [],
        };
      }

      const reason = error instanceof Error ? error.message : String(error);

      return {
        dir: this.checkpointDir,
        checkpoints: [],
        warnings: [`Failed to list session checkpoints: ${reason}`],
      };
    }
  }

  async deleteCheckpoint(name: string): Promise<{ name: string; path: string; deleted: boolean }> {
    assertValidSessionCheckpointName(name);

    const path = this.checkpointPath(name);

    try {
      await unlink(path);

      return {
        name,
        path,
        deleted: true,
      };
    } catch (error) {
      if (isFileNotFound(error)) {
        return {
          name,
          path,
          deleted: false,
        };
      }

      throw error;
    }
  }
}

export function createEmptySession(modelName: string): SessionData {
  const now = new Date().toISOString();

  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    modelName,
    messages: [],
    plan: createEmptyPlan(),
  };
}

export function formatLoadedSession(loaded: LoadedSession): string {
  const lines = [
    `Session path: ${loaded.path}`,
    `Session loaded: ${loaded.exists ? "yes" : "no"}`,
    `Messages: ${loaded.session.messages.length}`,
    `Plan steps: ${loaded.session.plan.steps.length}`,
    `Model at save time: ${loaded.session.modelName}`,
    `Last response id: ${loaded.session.lastResponseId ?? "(none)"}`,
    `Last patch: ${
      loaded.session.lastPatch
        ? loaded.session.lastPatch.paths.join(", ") || "(unknown paths)"
        : "(none)"
    }`,
    `Last patch snapshot: ${loaded.session.lastPatch?.snapshotPath ?? "(none)"}`,
    `Last verification failure: ${
      loaded.session.lastVerificationFailure
        ? loaded.session.lastVerificationFailure.command
        : "(none)"
    }`,
    `Last verification run: ${
      loaded.session.lastVerificationRun
        ? `${loaded.session.lastVerificationRun.command} (${loaded.session.lastVerificationRun.status})`
        : "(none)"
    }`,
    `Last verification target: ${
      loaded.session.lastVerificationTarget
        ? loaded.session.lastVerificationTarget.command
        : "(none)"
    }`,
    `Task state: ${formatTaskStateBrief(loaded.session.taskState)}`,
  ];

  if (loaded.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...loaded.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function formatSessionCheckpoints(loaded: LoadedSessionCheckpoints): string {
  const lines = [`Session checkpoints: ${loaded.dir}`];

  if (loaded.checkpoints.length === 0) {
    lines.push("No session checkpoints found.");
  } else {
    for (const checkpoint of loaded.checkpoints) {
      lines.push(
        `- ${checkpoint.name}: messages=${checkpoint.messageCount} plan=${checkpoint.planStepCount} model=${checkpoint.modelName} updated=${checkpoint.updatedAt}`,
      );

      if (checkpoint.lastPatchPaths.length > 0) {
        lines.push(`  last patch: ${checkpoint.lastPatchPaths.join(", ")}`);
      }
    }
  }

  if (loaded.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...loaded.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function formatSessionCheckpointBackups(loaded: LoadedSessionCheckpoints): string {
  const backupCheckpoints = loaded.checkpoints.filter((checkpoint) =>
    isCheckpointLoadBackupName(checkpoint.name),
  );

  return formatSessionCheckpoints({
    ...loaded,
    checkpoints: backupCheckpoints,
    warnings:
      backupCheckpoints.length === 0
        ? [...loaded.warnings, "No before-load checkpoint backups found."]
        : loaded.warnings,
  }).replace("Session checkpoints:", "Session checkpoint backups:");
}

export function isCheckpointLoadBackupName(name: string): boolean {
  return name.startsWith(CHECKPOINT_LOAD_BACKUP_PREFIX);
}

export function formatSessionCheckpointDetails(
  name: string,
  loaded: LoadedSession,
  options: { messageLimit?: number } = {},
): string {
  return formatSessionDetails(`Session checkpoint: ${name}`, loaded, options);
}

export function formatSessionDetails(
  title: string,
  loaded: LoadedSession,
  options: { messageLimit?: number } = {},
): string {
  const messages = loaded.session.messages;
  const messageLimit = normalizeMessageLimit(options.messageLimit);
  const recentMessages = messages.slice(-messageLimit);
  const skippedMessages = messages.length - recentMessages.length;
  const lines = [
    title,
    formatLoadedSession(loaded),
    "",
    "Plan:",
    indentLines(formatPlan(loaded.session.plan)),
    "",
    "Task state:",
    indentLines(formatTaskState(loaded.session.taskState)),
    "",
    `Recent messages: ${recentMessages.length} of ${messages.length}`,
  ];

  if (skippedMessages > 0) {
    lines.push(`  ... ${skippedMessages} older message(s) omitted`);
  }

  if (recentMessages.length === 0) {
    lines.push("  (none)");
  } else {
    recentMessages.forEach((message, index) => {
      const number = skippedMessages + index + 1;
      lines.push(`  ${number}. ${message.role}: ${truncateOneLine(message.content, CHECKPOINT_DETAIL_MESSAGE_CHARS)}`);
    });
  }

  return lines.join("\n");
}

function normalizeMessageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SESSION_DETAIL_MESSAGE_LIMIT;
  }

  return Math.max(1, Math.floor(value));
}

export function formatSessionStats(title: string, loaded: LoadedSession): string {
  const messages = loaded.session.messages;
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const totalChars = messages.reduce((total, message) => total + message.content.length, 0);
  const userChars = userMessages.reduce((total, message) => total + message.content.length, 0);
  const assistantChars = assistantMessages.reduce((total, message) => total + message.content.length, 0);
  const planCounts = countPlanStatuses(loaded.session.plan);
  const largestMessages = messages
    .map((message, index) => ({
      chars: message.content.length,
      index: index + 1,
      role: message.role,
    }))
    .sort((left, right) => right.chars - left.chars)
    .slice(0, SESSION_STATS_LARGEST_MESSAGES);
  const lines = [
    title,
    `Session path: ${loaded.path}`,
    `Session loaded: ${loaded.exists ? "yes" : "no"}`,
    `Model at save time: ${loaded.session.modelName}`,
    "",
    "Messages:",
    `- total: ${messages.length}`,
    `- user: ${userMessages.length} (${userChars} chars, ~${estimateTokens(userChars)} tokens)`,
    `- assistant: ${assistantMessages.length} (${assistantChars} chars, ~${estimateTokens(assistantChars)} tokens)`,
    `- all chars: ${totalChars}`,
    `- estimated tokens: ~${estimateTokens(totalChars)}`,
    "",
    "Plan:",
    `- steps: ${loaded.session.plan.steps.length}`,
    `- pending: ${planCounts.pending}`,
    `- in progress: ${planCounts.inProgress}`,
    `- completed: ${planCounts.completed}`,
    "",
    "Task state:",
    `- ${formatTaskStateBrief(loaded.session.taskState)}`,
    "",
    "Largest messages:",
  ];

  if (largestMessages.length === 0) {
    lines.push("- (none)");
  } else {
    lines.push(
      ...largestMessages.map(
        (message) => `- ${message.index}. ${message.role}: ${message.chars} chars (~${estimateTokens(message.chars)} tokens)`,
      ),
    );
  }

  if (loaded.warnings.length > 0) {
    lines.push("", "Warnings:", ...loaded.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function formatSessionSearch(title: string, loaded: LoadedSession, query: string): string {
  const normalizedQuery = query.trim();

  if (normalizedQuery.length === 0) {
    return "Usage: /session search <query>";
  }

  const lowerQuery = normalizedQuery.toLowerCase();
  const matches = loaded.session.messages
    .map((message, index) => {
      const matchIndex = message.content.toLowerCase().indexOf(lowerQuery);

      if (matchIndex < 0) {
        return null;
      }

      return {
        index: index + 1,
        matchIndex,
        message,
      };
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match));
  const shownMatches = matches.slice(0, SESSION_SEARCH_LIMIT);
  const lines = [
    title,
    `Query: ${normalizedQuery}`,
    `Matches: ${matches.length}`,
  ];

  if (matches.length > shownMatches.length) {
    lines.push(`Showing first ${shownMatches.length}.`);
  }

  if (shownMatches.length === 0) {
    lines.push("No matching session messages found.");
  } else {
    lines.push(
      ...shownMatches.map(
        (match) =>
          `- ${match.index}. ${match.message.role}: ${formatSearchSnippet(match.message.content, match.matchIndex, normalizedQuery.length)}`,
      ),
    );
  }

  return lines.join("\n");
}

export function formatSessionCheckpointDiff(
  leftName: string,
  left: LoadedSession,
  rightName: string,
  right: LoadedSession,
): string {
  const commonMessages = countCommonMessagePrefix(left.session.messages, right.session.messages);
  const rightNewMessages = right.session.messages.slice(commonMessages);
  const recentRightNewMessages = rightNewMessages.slice(-CHECKPOINT_DIFF_MESSAGE_LIMIT);
  const omittedRightNewMessages = rightNewMessages.length - recentRightNewMessages.length;
  const lines = [
    `Session checkpoint diff: ${leftName} -> ${rightName}`,
    `Left path: ${left.path}`,
    `Right path: ${right.path}`,
    "",
    "Summary:",
    `- messages: ${left.session.messages.length} -> ${right.session.messages.length} (${formatSignedNumber(right.session.messages.length - left.session.messages.length)})`,
    `- common message prefix: ${commonMessages}`,
    `- plan steps: ${left.session.plan.steps.length} -> ${right.session.plan.steps.length} (${formatSignedNumber(right.session.plan.steps.length - left.session.plan.steps.length)})`,
    `- model: ${left.session.modelName} -> ${right.session.modelName}`,
    `- last response id: ${left.session.lastResponseId ?? "(none)"} -> ${right.session.lastResponseId ?? "(none)"}`,
    `- last patch: ${formatPatchPaths(left.session.lastPatch?.paths)} -> ${formatPatchPaths(right.session.lastPatch?.paths)}`,
    `- last patch snapshot: ${left.session.lastPatch?.snapshotPath ?? "(none)"} -> ${right.session.lastPatch?.snapshotPath ?? "(none)"}`,
    `- task state: ${formatTaskStateBrief(left.session.taskState)} -> ${formatTaskStateBrief(right.session.taskState)}`,
    "",
    "Plan changes:",
    ...formatPlanDiff(left.session.plan, right.session.plan),
    "",
    `Messages added after common prefix: ${rightNewMessages.length}`,
  ];

  if (omittedRightNewMessages > 0) {
    lines.push(`  ... ${omittedRightNewMessages} older added message(s) omitted`);
  }

  if (recentRightNewMessages.length === 0) {
    lines.push("  (none)");
  } else {
    recentRightNewMessages.forEach((message, index) => {
      const number = commonMessages + omittedRightNewMessages + index + 1;
      lines.push(`  + ${number}. ${message.role}: ${truncateOneLine(message.content, CHECKPOINT_DIFF_MESSAGE_CHARS)}`);
    });
  }

  const warnings = [
    ...left.warnings.map((warning) => `${leftName}: ${warning}`),
    ...right.warnings.map((warning) => `${rightName}: ${warning}`),
  ];

  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function formatSessionCheckpointNameRules(): string {
  return "Checkpoint names may contain only letters, numbers, dashes, and underscores, up to 64 characters.";
}

export function isValidSessionCheckpointName(name: string): boolean {
  return CHECKPOINT_NAME_PATTERN.test(name);
}

function parseSession(value: unknown, modelName: string, warnings: string[]): SessionData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Session root must be an object. Starting a new session.");
    return createEmptySession(modelName);
  }

  const source = value as Record<string, unknown>;
  const now = new Date().toISOString();
  const messages = parseMessages(source.messages, warnings);
  const plan = parsePlan(source.plan, warnings);
  const lastPatch = parseLastPatch(source.lastPatch, warnings);
  const lastVerificationFailure = parseLastVerificationFailure(
    source.lastVerificationFailure,
    warnings,
  );
  const lastVerificationRun = parseLastVerificationRun(source.lastVerificationRun, warnings);
  const lastVerificationTarget = parseLastVerificationTarget(
    source.lastVerificationTarget,
    warnings,
  );
  const taskState = parseTaskState(source.taskState, warnings);

  return {
    version: 1,
    createdAt: typeof source.createdAt === "string" ? source.createdAt : now,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : now,
    modelName: typeof source.modelName === "string" ? source.modelName : modelName,
    lastResponseId: typeof source.lastResponseId === "string" ? source.lastResponseId : undefined,
    lastPatch,
    lastVerificationFailure,
    lastVerificationRun,
    lastVerificationTarget,
    taskState,
    messages,
    plan,
  };
}

function parseLastPatch(value: unknown, warnings: string[]): SessionPatchRecord | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring session lastPatch because it is not an object.");
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const patch = source.patch;
  const paths = source.paths;
  const appliedAt = source.appliedAt;
  const snapshotPath = source.snapshotPath;

  if (typeof patch !== "string" || patch.trim().length === 0) {
    warnings.push("Ignoring session lastPatch because patch is missing.");
    return undefined;
  }

  return {
    patch,
    paths: Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === "string")
      : [],
    appliedAt: typeof appliedAt === "string" ? appliedAt : new Date().toISOString(),
    ...(typeof snapshotPath === "string" ? { snapshotPath } : {}),
  };
}

function parseLastVerificationFailure(
  value: unknown,
  warnings: string[],
): SessionVerificationFailureRecord | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring session lastVerificationFailure because it is not an object.");
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const command = source.command;
  const failedAt = source.failedAt;
  const output = source.output;
  const exitCode = source.exitCode;
  const stability = parseVerificationStability(source.stability);
  const diagnosis = parseVerificationDiagnosis(source.diagnosis);

  if (typeof command !== "string" || command.trim().length === 0) {
    warnings.push("Ignoring session lastVerificationFailure because command is missing.");
    return undefined;
  }

  return {
    command,
    ...(diagnosis ? { diagnosis } : {}),
    paths: parseStringArray(source.paths),
    failedAt: typeof failedAt === "string" ? failedAt : new Date().toISOString(),
    summary: parseStringArray(source.summary),
    remediation: parseStringArray(source.remediation),
    locations: parseStringArray(source.locations),
    output: typeof output === "string" ? output : "",
    ...(typeof exitCode === "number" && Number.isFinite(exitCode) ? { exitCode } : {}),
    ...(stability ? { stability } : {}),
  };
}

function parseVerificationDiagnosis(value: unknown): SessionVerificationDiagnosis | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;

  if (
    (source.category !== "code" && source.category !== "environment") ||
    typeof source.label !== "string" ||
    source.label.trim().length === 0
  ) {
    return undefined;
  }

  return {
    category: source.category,
    label: source.label,
  };
}

function parseVerificationStability(value: unknown): SessionVerificationStabilityRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const baseline = source.baseline;
  const status = source.status;
  const runs = source.runs;
  const passed = source.passed;
  const failed = source.failed;

  if (
    (baseline !== "failed" && baseline !== "passed" && baseline !== "target") ||
    (status !== "flaky" && status !== "stable_failure") ||
    !Number.isInteger(runs) ||
    !Number.isInteger(passed) ||
    !Number.isInteger(failed) ||
    (runs as number) < 1 ||
    (passed as number) < 0 ||
    (failed as number) < 0 ||
    (passed as number) + (failed as number) !== runs
  ) {
    return undefined;
  }

  return {
    baseline,
    checkedAt: typeof source.checkedAt === "string" ? source.checkedAt : new Date().toISOString(),
    failed: failed as number,
    passed: passed as number,
    runs: runs as number,
    status,
  };
}

function parseLastVerificationRun(
  value: unknown,
  warnings: string[],
): SessionVerificationRunRecord | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring session lastVerificationRun because it is not an object.");
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const command = source.command;
  const status = source.status;

  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    (status !== "failed" && status !== "passed")
  ) {
    warnings.push("Ignoring session lastVerificationRun because command or status is invalid.");
    return undefined;
  }

  return {
    command,
    paths: parseStringArray(source.paths),
    recordedAt: typeof source.recordedAt === "string" ? source.recordedAt : new Date().toISOString(),
    status,
    ...(typeof source.exitCode === "number" && Number.isFinite(source.exitCode)
      ? { exitCode: source.exitCode }
      : {}),
  };
}

function parseLastVerificationTarget(
  value: unknown,
  warnings: string[],
): SessionVerificationTargetRecord | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring session lastVerificationTarget because it is not an object.");
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const command = source.command;
  const recordedAt = source.recordedAt;

  if (typeof command !== "string" || command.trim().length === 0) {
    warnings.push("Ignoring session lastVerificationTarget because command is missing.");
    return undefined;
  }

  return {
    command,
    paths: parseStringArray(source.paths),
    recordedAt: typeof recordedAt === "string" ? recordedAt : new Date().toISOString(),
  };
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseMessages(value: unknown, warnings: string[]): ConversationMessage[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    warnings.push("Ignoring session messages because messages is not an array.");
    return [];
  }

  return value.filter((message): message is ConversationMessage => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      warnings.push("Ignoring an invalid session message.");
      return false;
    }

    const source = message as Record<string, unknown>;
    const role = source.role;
    const content = source.content;
    const valid = (role === "user" || role === "assistant") && typeof content === "string";

    if (!valid) {
      warnings.push("Ignoring a session message with invalid role or content.");
    }

    return valid;
  });
}

async function writeSessionFile(path: string, session: SessionData): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function assertValidSessionCheckpointName(name: string): void {
  if (!isValidSessionCheckpointName(name)) {
    throw new Error(formatSessionCheckpointNameRules());
  }
}

function toCheckpointSummary(name: string, loaded: LoadedSession): SessionCheckpointSummary {
  return {
    name,
    path: loaded.path,
    createdAt: loaded.session.createdAt,
    updatedAt: loaded.session.updatedAt,
    modelName: loaded.session.modelName,
    messageCount: loaded.session.messages.length,
    planStepCount: loaded.session.plan.steps.length,
    lastPatchPaths: loaded.session.lastPatch?.paths ?? [],
  };
}

function countCommonMessagePrefix(left: ConversationMessage[], right: ConversationMessage[]): number {
  const max = Math.min(left.length, right.length);

  for (let index = 0; index < max; index += 1) {
    const leftMessage = left[index];
    const rightMessage = right[index];

    if (!leftMessage || !rightMessage) {
      return index;
    }

    if (leftMessage.role !== rightMessage.role || leftMessage.content !== rightMessage.content) {
      return index;
    }
  }

  return max;
}

function formatPlanDiff(left: PlanState, right: PlanState): string[] {
  if (left.steps.length === 0 && right.steps.length === 0) {
    return ["  (none)"];
  }

  const rightStepsById = new Map(right.steps.map((step) => [step.id, step]));
  const leftStepIds = new Set(left.steps.map((step) => step.id));
  const lines: string[] = [];

  for (const leftStep of left.steps) {
    const rightStep = rightStepsById.get(leftStep.id);

    if (!rightStep) {
      lines.push(`  - ${leftStep.id}. ${leftStep.content} [${leftStep.status}]`);
      continue;
    }

    if (leftStep.content !== rightStep.content || leftStep.status !== rightStep.status) {
      lines.push(
        `  * ${leftStep.id}. ${leftStep.content} [${leftStep.status}] -> ${rightStep.content} [${rightStep.status}]`,
      );
    }
  }

  for (const rightStep of right.steps) {
    if (!leftStepIds.has(rightStep.id)) {
      lines.push(`  + ${rightStep.id}. ${rightStep.content} [${rightStep.status}]`);
    }
  }

  return lines.length > 0 ? lines : ["  (none)"];
}

function formatSignedNumber(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function formatPatchPaths(paths: string[] | undefined): string {
  if (!paths || paths.length === 0) {
    return "(none)";
  }

  return paths.join(", ");
}

function formatTaskStateBrief(taskState: TaskState | undefined): string {
  if (!taskState) {
    return "(none)";
  }

  return `${taskState.status} - ${truncateOneLine(taskState.objective, 120)}`;
}

function countPlanStatuses(plan: PlanState): { completed: number; inProgress: number; pending: number } {
  return plan.steps.reduce(
    (counts, step) => {
      if (step.status === "completed") {
        counts.completed += 1;
      } else if (step.status === "in_progress") {
        counts.inProgress += 1;
      } else {
        counts.pending += 1;
      }

      return counts;
    },
    {
      completed: 0,
      inProgress: 0,
      pending: 0,
    },
  );
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function formatSearchSnippet(content: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - SESSION_SEARCH_CONTEXT_CHARS);
  const end = Math.min(content.length, matchIndex + queryLength + SESSION_SEARCH_CONTEXT_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";

  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function indentLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
