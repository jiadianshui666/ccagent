import type {
  SessionPatchRecord,
  SessionVerificationFailureRecord,
  SessionVerificationTargetRecord,
} from "./session.js";
import type { PlanState } from "./plan.js";

export type TaskStateStatus = "active" | "blocked" | "complete";
export type TaskStateFileMode = "keep" | "replace" | "merge" | "clear";

export type TaskState = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  objective: string;
  status: TaskStateStatus;
  summary: string;
  currentStep?: string;
  files: string[];
  lastPatch?: TaskStatePatchRecord;
  lastVerification?: TaskStateVerificationRecord;
};

export type TaskStatePatchRecord = {
  appliedAt: string;
  paths: string[];
  snapshotPath?: string;
};

export type TaskStateVerificationRecord = {
  command: string;
  ok: boolean;
  paths: string[];
  recordedAt: string;
  summary: string[];
  exitCode?: number;
};

export type TaskStateUpdate = {
  currentStep?: string;
  fileMode?: TaskStateFileMode;
  files?: string[];
  objective?: string;
  status?: TaskStateStatus;
  summary?: string;
};

export type TaskResumePromptInput = {
  lastPatch?: SessionPatchRecord;
  lastVerificationFailure?: SessionVerificationFailureRecord;
  lastVerificationTarget?: SessionVerificationTargetRecord;
  plan?: PlanState;
  taskState?: TaskState;
};

const MAX_TASK_FILES = 32;
const MAX_TASK_SUMMARY_CHARS = 1200;
const MAX_TASK_TEXT_CHARS = 300;
const VALID_TASK_STATUSES = new Set<TaskStateStatus>(["active", "blocked", "complete"]);
const VALID_FILE_MODES = new Set<TaskStateFileMode>(["keep", "replace", "merge", "clear"]);

export function isTaskStateStatus(value: unknown): value is TaskStateStatus {
  return typeof value === "string" && VALID_TASK_STATUSES.has(value as TaskStateStatus);
}

export function isTaskStateFileMode(value: unknown): value is TaskStateFileMode {
  return typeof value === "string" && VALID_FILE_MODES.has(value as TaskStateFileMode);
}

export function updateTaskState(current: TaskState | undefined, update: TaskStateUpdate): TaskState | undefined {
  const now = new Date().toISOString();
  const objective = normalizeTaskText(update.objective, MAX_TASK_TEXT_CHARS) ?? current?.objective ?? "";
  const summary = normalizeTaskText(update.summary, MAX_TASK_SUMMARY_CHARS) ?? current?.summary ?? "";
  const currentStep = normalizeTaskText(update.currentStep, MAX_TASK_TEXT_CHARS) ?? current?.currentStep;
  const status = update.status ?? current?.status ?? "active";
  const files = updateTaskFiles(current?.files ?? [], update.files ?? [], update.fileMode ?? "keep");

  if (!objective) {
    return undefined;
  }

  return {
    version: 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    objective,
    status,
    summary,
    ...(currentStep ? { currentStep } : {}),
    files,
    ...(current?.lastPatch ? { lastPatch: current.lastPatch } : {}),
    ...(current?.lastVerification ? { lastVerification: current.lastVerification } : {}),
  };
}

export function recordTaskPatch(
  current: TaskState | undefined,
  patch: SessionPatchRecord | undefined,
): TaskState | undefined {
  if (!current || !patch) {
    return current;
  }

  const files = updateTaskFiles(current.files, patch.paths, "merge");

  return {
    ...current,
    files,
    lastPatch: {
      appliedAt: patch.appliedAt,
      paths: patch.paths,
      ...(patch.snapshotPath ? { snapshotPath: patch.snapshotPath } : {}),
    },
    status: current.status === "complete" ? "active" : current.status,
    updatedAt: new Date().toISOString(),
  };
}

export function recordTaskVerificationFailure(
  current: TaskState | undefined,
  failure: SessionVerificationFailureRecord,
): TaskState | undefined {
  return recordTaskVerification(current, {
    command: failure.command,
    exitCode: failure.exitCode,
    ok: false,
    paths: failure.paths,
    recordedAt: failure.failedAt,
    summary: failure.summary,
  });
}

export function recordTaskVerificationTargetCleared(
  current: TaskState | undefined,
): TaskState | undefined {
  if (!current?.lastVerification) {
    return current;
  }

  return {
    ...current,
    updatedAt: new Date().toISOString(),
  };
}

export function recordTaskVerificationSuccess(
  current: TaskState | undefined,
  target: SessionVerificationTargetRecord,
  summary: string[] = ["Verification passed."],
): TaskState | undefined {
  return recordTaskVerification(current, {
    command: target.command,
    ok: true,
    paths: target.paths,
    recordedAt: new Date().toISOString(),
    summary,
  });
}

export function parseTaskState(value: unknown, warnings: string[]): TaskState | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring session taskState because it is not an object.");
    return undefined;
  }

  const source = value as Record<string, unknown>;

  if (typeof source.objective !== "string" || source.objective.trim().length === 0) {
    warnings.push("Ignoring session taskState because objective is missing.");
    return undefined;
  }

  if (!isTaskStateStatus(source.status)) {
    warnings.push("Ignoring session taskState because status is invalid.");
    return undefined;
  }

  return {
    version: 1,
    createdAt: typeof source.createdAt === "string" ? source.createdAt : new Date().toISOString(),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
    objective: truncateOneLine(source.objective.trim(), MAX_TASK_TEXT_CHARS),
    status: source.status,
    summary: typeof source.summary === "string" ? truncateOneLine(source.summary.trim(), MAX_TASK_SUMMARY_CHARS) : "",
    ...(typeof source.currentStep === "string" && source.currentStep.trim()
      ? { currentStep: truncateOneLine(source.currentStep.trim(), MAX_TASK_TEXT_CHARS) }
      : {}),
    files: parseTaskFiles(source.files),
    ...(parseTaskPatch(source.lastPatch) ? { lastPatch: parseTaskPatch(source.lastPatch) } : {}),
    ...(parseTaskVerification(source.lastVerification)
      ? { lastVerification: parseTaskVerification(source.lastVerification) }
      : {}),
  };
}

export function formatTaskState(taskState: TaskState | undefined): string {
  if (!taskState) {
    return [
      "Task state is empty.",
      "Use /task-state set <objective> to start a persistent task checkpoint.",
    ].join("\n");
  }

  const lines = [
    "Task state",
    `Status: ${taskState.status}`,
    `Objective: ${taskState.objective}`,
    `Current step: ${taskState.currentStep ?? "(none)"}`,
    `Summary: ${taskState.summary || "(none)"}`,
    `Updated: ${taskState.updatedAt}`,
    `Files: ${taskState.files.length > 0 ? taskState.files.join(", ") : "(none)"}`,
  ];

  if (taskState.lastPatch) {
    lines.push(
      `Last patch: ${taskState.lastPatch.paths.length > 0 ? taskState.lastPatch.paths.join(", ") : "(unknown)"} at ${taskState.lastPatch.appliedAt}`,
    );

    if (taskState.lastPatch.snapshotPath) {
      lines.push(`Last patch snapshot: ${taskState.lastPatch.snapshotPath}`);
    }
  }

  if (taskState.lastVerification) {
    lines.push(
      `Last verification: ${taskState.lastVerification.ok ? "passed" : "failed"} ${taskState.lastVerification.command} at ${taskState.lastVerification.recordedAt}`,
    );

    if (taskState.lastVerification.summary.length > 0) {
      lines.push("Verification summary:");
      lines.push(...taskState.lastVerification.summary.map((line) => `- ${line}`));
    }
  }

  return lines.join("\n");
}

export function formatTaskResumePrompt(input: TaskResumePromptInput): string {
  if (!input.taskState) {
    return [
      "Task resume prompt is unavailable.",
      "Use /task-state set <objective> to start a persistent task checkpoint.",
    ].join("\n");
  }

  const taskState = input.taskState;
  const planSteps = input.plan?.steps ?? [];
  const lastVerification = input.lastVerificationFailure
    ? {
        command: input.lastVerificationFailure.command,
        ok: false,
        paths: input.lastVerificationFailure.paths,
        recordedAt: input.lastVerificationFailure.failedAt,
        summary: input.lastVerificationFailure.summary,
      }
    : taskState.lastVerification;
  const lastPatch = input.lastPatch
    ? {
        appliedAt: input.lastPatch.appliedAt,
        paths: input.lastPatch.paths,
        snapshotPath: input.lastPatch.snapshotPath,
      }
    : taskState.lastPatch;
  const files = normalizeTaskFiles([
    ...taskState.files,
    ...(lastPatch?.paths ?? []),
    ...(lastVerification?.paths ?? []),
    ...(input.lastVerificationTarget?.paths ?? []),
  ]);
  const lines = [
    "Task resume prompt",
    "",
    "Use this context to continue the interrupted coding task. Inspect relevant files before editing, keep the plan current, and run verification before calling the task complete.",
    "",
    "Objective:",
    taskState.objective,
    "",
    "Status:",
    taskState.status,
    "",
    "Current step:",
    taskState.currentStep ?? "(none)",
    "",
    "Summary:",
    taskState.summary || "(none)",
    "",
    "Plan:",
  ];

  if (planSteps.length === 0) {
    lines.push("- (none)");
  } else {
    lines.push(
      ...planSteps.map((step) => `- ${formatPlanStepStatus(step.status)} ${step.id}. ${step.content}`),
    );
  }

  lines.push("", "Relevant files:");

  if (files.length === 0) {
    lines.push("- (none)");
  } else {
    lines.push(...files.map((file) => `- ${file}`));
  }

  lines.push("", "Last patch:");

  if (!lastPatch) {
    lines.push("- (none)");
  } else {
    lines.push(`- paths: ${lastPatch.paths.length > 0 ? lastPatch.paths.join(", ") : "(unknown)"}`);
    lines.push(`- appliedAt: ${lastPatch.appliedAt}`);

    if (lastPatch.snapshotPath) {
      lines.push(`- snapshot: ${lastPatch.snapshotPath}`);
    }
  }

  lines.push("", "Last verification:");

  if (!lastVerification) {
    lines.push("- (none)");
  } else {
    lines.push(`- status: ${lastVerification.ok ? "passed" : "failed"}`);
    lines.push(`- command: ${lastVerification.command}`);
    lines.push(`- recordedAt: ${lastVerification.recordedAt}`);

    if (lastVerification.summary.length > 0) {
      lines.push("- summary:");
      lines.push(...lastVerification.summary.map((line) => `  - ${line}`));
    }
  }

  if (input.lastVerificationTarget && !input.lastVerificationFailure) {
    lines.push("", "Verification rerun target:");
    lines.push(`- command: ${input.lastVerificationTarget.command}`);
    lines.push(`- recordedAt: ${input.lastVerificationTarget.recordedAt}`);
    lines.push(
      `- paths: ${
        input.lastVerificationTarget.paths.length > 0
          ? input.lastVerificationTarget.paths.join(", ")
          : "(unknown)"
      }`,
    );
  }

  lines.push(
    "",
    "Next action:",
    taskState.status === "blocked" || lastVerification?.ok === false
      ? "Repair the failing verification or blocker first, then rerun verification."
      : "Continue from the current step, update task state as work changes, then verify.",
  );

  return lines.join("\n");
}

function recordTaskVerification(
  current: TaskState | undefined,
  verification: TaskStateVerificationRecord,
): TaskState | undefined {
  if (!current) {
    return current;
  }

  return {
    ...current,
    files: updateTaskFiles(current.files, verification.paths, "merge"),
    lastVerification: {
      command: verification.command,
      ok: verification.ok,
      paths: verification.paths,
      recordedAt: verification.recordedAt,
      summary: verification.summary.map((line) => truncateOneLine(line, MAX_TASK_TEXT_CHARS)).slice(0, 8),
      ...(verification.exitCode !== undefined ? { exitCode: verification.exitCode } : {}),
    },
    status: verification.ok && current.status === "blocked"
      ? "active"
      : verification.ok
        ? current.status
        : "blocked",
    updatedAt: new Date().toISOString(),
  };
}

function formatPlanStepStatus(status: string): string {
  if (status === "completed") {
    return "[x]";
  }

  if (status === "in_progress") {
    return "[>]";
  }

  return "[ ]";
}

function updateTaskFiles(existing: string[], incoming: string[], mode: TaskStateFileMode): string[] {
  if (mode === "clear") {
    return [];
  }

  const normalizedIncoming = normalizeTaskFiles(incoming);

  if (mode === "replace") {
    return normalizedIncoming;
  }

  if (mode === "merge") {
    return normalizeTaskFiles([...existing, ...normalizedIncoming]);
  }

  return existing;
}

function parseTaskFiles(value: unknown): string[] {
  return Array.isArray(value)
    ? normalizeTaskFiles(value.filter((item): item is string => typeof item === "string"))
    : [];
}

function normalizeTaskFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].slice(0, MAX_TASK_FILES);
}

function parseTaskPatch(value: unknown): TaskStatePatchRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;

  if (typeof source.appliedAt !== "string") {
    return undefined;
  }

  return {
    appliedAt: source.appliedAt,
    paths: parseTaskFiles(source.paths),
    ...(typeof source.snapshotPath === "string" ? { snapshotPath: source.snapshotPath } : {}),
  };
}

function parseTaskVerification(value: unknown): TaskStateVerificationRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;

  if (typeof source.command !== "string" || typeof source.recordedAt !== "string") {
    return undefined;
  }

  return {
    command: source.command,
    ok: source.ok === true,
    paths: parseTaskFiles(source.paths),
    recordedAt: source.recordedAt,
    summary: Array.isArray(source.summary)
      ? source.summary.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof source.exitCode === "number" && Number.isFinite(source.exitCode) ? { exitCode: source.exitCode } : {}),
  };
}

function normalizeTaskText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  return truncateOneLine(trimmed, maxLength);
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
