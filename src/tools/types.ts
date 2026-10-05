import type { PlanState } from "../plan.js";
import type { TaskState, TaskStateUpdate } from "../taskState.js";

export type ToolContext = {
  workspaceRoot: string;
  updatePlan?: (plan: PlanState) => void;
  updateTaskState?: (update: TaskStateUpdate) => TaskState | undefined;
  runSubagent?: (prompt: string) => Promise<string>;
  runSubagents?: (prompts: string[]) => Promise<string[]>;
};

export type ToolParameterSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean;
};

export type ToolResult =
  | {
      ok: true;
      content: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
  approvalMessage?(input: Record<string, unknown>): string | null;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
