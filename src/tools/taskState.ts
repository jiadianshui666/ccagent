import {
  formatTaskState,
  isTaskStateFileMode,
  isTaskStateStatus,
  type TaskStateUpdate,
} from "../taskState.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_TOOL_TASK_FILES = 32;

export class UpdateTaskStateTool implements Tool {
  readonly name = "update_task_state";
  readonly description =
    "Persist a compact task checkpoint with objective, status, current step, files, and summary for long-running coding work.";
  readonly parameters = {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "Task objective. Use an empty string to keep the current objective.",
      },
      status: {
        type: "string",
        enum: ["", "active", "blocked", "complete"],
        description: "Task status. Use an empty string to keep the current status.",
      },
      currentStep: {
        type: "string",
        description: "Current task step. Use an empty string to keep the current step.",
      },
      summary: {
        type: "string",
        description: "Compact task summary. Use an empty string to keep the current summary.",
      },
      files: {
        type: "array",
        description: "Files relevant to the task.",
        maxItems: MAX_TOOL_TASK_FILES,
        items: {
          type: "string",
        },
      },
      fileMode: {
        type: "string",
        enum: ["keep", "replace", "merge", "clear"],
        description: "How to apply files to the existing task file list.",
      },
    },
    required: ["objective", "status", "currentStep", "summary", "files", "fileMode"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!context.updateTaskState) {
      return {
        ok: false,
        error: "Task state updates are not available in this context.",
      };
    }

    const parsed = parseTaskStateUpdate(input);

    if (!parsed.ok) {
      return parsed;
    }

    const taskState = context.updateTaskState(parsed.update);

    if (!taskState) {
      return {
        ok: false,
        error: "Task objective is required when no task state exists.",
      };
    }

    return {
      ok: true,
      content: formatTaskState(taskState),
      metadata: {
        files: taskState.files,
        status: taskState.status,
      },
    };
  }
}

function parseTaskStateUpdate(input: Record<string, unknown>):
  | {
      ok: true;
      update: TaskStateUpdate;
    }
  | {
      ok: false;
      error: string;
    } {
  if (typeof input.objective !== "string") {
    return {
      ok: false,
      error: "Expected input.objective to be a string.",
    };
  }

  if (typeof input.status !== "string" || (input.status !== "" && !isTaskStateStatus(input.status))) {
    return {
      ok: false,
      error: "Expected input.status to be empty, active, blocked, or complete.",
    };
  }

  if (typeof input.currentStep !== "string") {
    return {
      ok: false,
      error: "Expected input.currentStep to be a string.",
    };
  }

  if (typeof input.summary !== "string") {
    return {
      ok: false,
      error: "Expected input.summary to be a string.",
    };
  }

  if (!Array.isArray(input.files) || !input.files.every((file) => typeof file === "string")) {
    return {
      ok: false,
      error: "Expected input.files to be an array of strings.",
    };
  }

  if (input.files.length > MAX_TOOL_TASK_FILES) {
    return {
      ok: false,
      error: `Task state can track at most ${MAX_TOOL_TASK_FILES} files.`,
    };
  }

  if (!isTaskStateFileMode(input.fileMode)) {
    return {
      ok: false,
      error: "Expected input.fileMode to be keep, replace, merge, or clear.",
    };
  }

  return {
    ok: true,
    update: {
      ...(input.objective.trim() ? { objective: input.objective } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.currentStep.trim() ? { currentStep: input.currentStep } : {}),
      ...(input.summary.trim() ? { summary: input.summary } : {}),
      fileMode: input.fileMode,
      files: input.files,
    },
  };
}
