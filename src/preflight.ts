export type ToolRiskLevel = "low" | "medium" | "high";

export type ToolWorkspaceImpact = "read-only" | "plan-only" | "workspace-write" | "shell" | "unknown";

export type ToolPreflight = {
  deniedByPolicy: boolean;
  requiresApproval: boolean;
  risk: ToolRiskLevel;
  summary: string;
  reasons: string[];
  workspaceImpact: ToolWorkspaceImpact;
};

export type ToolPreflightInput = {
  deniedByPolicy?: boolean;
  input: Record<string, unknown>;
  requiresApproval?: boolean;
  toolName: string;
};

const READ_ONLY_TOOLS = new Set([
  "list_files",
  "list_patch_snapshots",
  "list_symbols",
  "context_index_status",
  "patch_snapshot_history",
  "read_file",
  "search_files",
  "search_context_index",
  "search_semantic_index",
  "search_symbols",
  "semantic_index_status",
  "show_patch_snapshot",
  "suggest_context",
  "suggest_verification",
  "workspace_info",
  "git_status",
  "git_diff",
]);

export function createToolPreflight(input: ToolPreflightInput): ToolPreflight {
  const deniedByPolicy = Boolean(input.deniedByPolicy);
  const requiresApproval = Boolean(input.requiresApproval);
  const base = getBaseToolRisk(input.toolName, input.input);
  const reasons = [...base.reasons];
  let risk = base.risk;

  if (deniedByPolicy) {
    risk = "high";
    reasons.unshift("tool is disabled by project policy");
  } else if (requiresApproval && risk === "low") {
    risk = "medium";
    reasons.push("approval is required before execution");
  }

  return {
    deniedByPolicy,
    requiresApproval,
    risk,
    summary: formatToolPreflightSummary(input.toolName, risk, base.workspaceImpact),
    reasons,
    workspaceImpact: base.workspaceImpact,
  };
}

export function formatToolPreflight(preflight: ToolPreflight): string {
  return [
    `Risk: ${preflight.risk}`,
    `Workspace impact: ${preflight.workspaceImpact}`,
    `Approval required: ${preflight.requiresApproval ? "yes" : "no"}`,
    `Denied by policy: ${preflight.deniedByPolicy ? "yes" : "no"}`,
    "Reasons:",
    ...preflight.reasons.map((reason) => `- ${reason}`),
  ].join("\n");
}

function getBaseToolRisk(
  toolName: string,
  input: Record<string, unknown>,
): {
  risk: ToolRiskLevel;
  reasons: string[];
  workspaceImpact: ToolWorkspaceImpact;
} {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return {
      risk: "low",
      reasons: ["tool only reads workspace or git state"],
      workspaceImpact: "read-only",
    };
  }

  if (toolName === "update_plan" || toolName === "update_task_state") {
    return {
      risk: "low",
      reasons: [`tool only updates the in-memory ${toolName === "update_plan" ? "task plan" : "task state"}`],
      workspaceImpact: "plan-only",
    };
  }

  if (toolName === "build_context_index") {
    return {
      risk: "low",
      reasons: ["tool writes local context index metadata under .ccagent/index"],
      workspaceImpact: "workspace-write",
    };
  }

  if (toolName === "build_semantic_index") {
    return {
      risk: "low",
      reasons: ["tool writes local semantic index metadata under .ccagent/index"],
      workspaceImpact: "workspace-write",
    };
  }

  if (
    toolName === "apply_patch" ||
    toolName === "reverse_patch" ||
    toolName === "edit" ||
    toolName === "restore_patch_snapshot"
  ) {
    return {
      risk: "high",
      reasons: [
        formatWorkspaceWriteReason(toolName),
        formatWorkspaceWriteDetail(toolName, input),
      ].filter(Boolean),
      workspaceImpact: "workspace-write",
    };
  }

  if (toolName === "run_shell") {
    return {
      risk: "high",
      reasons: [
        "tool can run arbitrary shell commands",
        formatShellCommandReason(input.command),
      ].filter(Boolean),
      workspaceImpact: "shell",
    };
  }

  return {
    risk: "medium",
    reasons: ["tool has no known risk profile"],
    workspaceImpact: "unknown",
  };
}

function formatToolPreflightSummary(
  toolName: string,
  risk: ToolRiskLevel,
  workspaceImpact: ToolWorkspaceImpact,
): string {
  return `${toolName} risk=${risk} impact=${workspaceImpact}`;
}

function formatWorkspaceWriteReason(toolName: string): string {
  if (toolName === "reverse_patch") {
    return "tool can reverse file changes in the workspace";
  }

  if (toolName === "restore_patch_snapshot") {
    return "tool can restore or delete files in the workspace";
  }

  return "tool can modify files in the workspace";
}

function formatWorkspaceWriteDetail(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "restore_patch_snapshot") {
    return formatRestorePathReason(input.path);
  }

  if (toolName === "edit") {
    return formatEditPathReason(input.path);
  }

  return formatPatchSizeReason(input.patch);
}

function formatEditPathReason(value: unknown): string {
  if (typeof value !== "string") {
    return "edit path input is missing or invalid";
  }

  const path = value.trim();

  if (path.length === 0) {
    return "edit path is empty";
  }

  return `edit path: ${truncate(path, 160)}`;
}

function formatRestorePathReason(value: unknown): string {
  if (typeof value !== "string") {
    return "restore path input is missing or invalid";
  }

  const path = value.trim();

  if (path.length === 0) {
    return "restore path is empty";
  }

  return `restore path: ${truncate(path, 160)}`;
}

function formatPatchSizeReason(value: unknown): string {
  if (typeof value !== "string") {
    return "patch input is missing or invalid";
  }

  return `patch size is ${Buffer.byteLength(value, "utf8")} bytes`;
}

function formatShellCommandReason(value: unknown): string {
  if (typeof value !== "string") {
    return "shell command input is missing or invalid";
  }

  const command = value.trim();

  if (command.length === 0) {
    return "shell command is empty";
  }

  return `command: ${truncate(command, 160)}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...[truncated]`;
}
