import { formatPlan, isPlanStepStatus, replacePlanSteps, type PlanStepInput } from "../plan.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_PLAN_STEPS = 12;

export class UpdatePlanTool implements Tool {
  readonly name = "update_plan";
  readonly description =
    "Replace the current task plan with ordered steps. Use this for multi-step coding tasks and keep at most one step in_progress.";
  readonly parameters = {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Ordered task steps that should replace the current plan.",
        minItems: 0,
        maxItems: MAX_PLAN_STEPS,
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Short task step text.",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Current status for this step.",
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!context.updatePlan) {
      return {
        ok: false,
        error: "Plan updates are not available in this context.",
      };
    }

    const parsed = parsePlanStepInputs(input.steps);

    if (!parsed.ok) {
      return parsed;
    }

    const plan = replacePlanSteps(parsed.steps);
    context.updatePlan(plan);

    return {
      ok: true,
      content: formatPlan(plan),
      metadata: {
        count: plan.steps.length,
        inProgressCount: plan.steps.filter((step) => step.status === "in_progress").length,
      },
    };
  }
}

function parsePlanStepInputs(value: unknown):
  | {
      ok: true;
      steps: PlanStepInput[];
    }
  | {
      ok: false;
      error: string;
    } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: "Expected input.steps to be an array.",
    };
  }

  if (value.length > MAX_PLAN_STEPS) {
    return {
      ok: false,
      error: `Plan can contain at most ${MAX_PLAN_STEPS} steps.`,
    };
  }

  const steps: PlanStepInput[] = [];

  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        error: `Expected steps[${index}] to be an object.`,
      };
    }

    const source = item as Record<string, unknown>;

    if (typeof source.content !== "string" || source.content.trim().length === 0) {
      return {
        ok: false,
        error: `Expected steps[${index}].content to be a non-empty string.`,
      };
    }

    if (!isPlanStepStatus(source.status)) {
      return {
        ok: false,
        error: `Expected steps[${index}].status to be pending, in_progress, or completed.`,
      };
    }

    steps.push({
      content: source.content.trim(),
      status: source.status,
    });
  }

  const inProgressCount = steps.filter((step) => step.status === "in_progress").length;

  if (inProgressCount > 1) {
    return {
      ok: false,
      error: "Expected at most one in_progress step.",
    };
  }

  return {
    ok: true,
    steps,
  };
}
