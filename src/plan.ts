export type PlanStepStatus = "pending" | "in_progress" | "completed";

export type PlanStepInput = {
  content: string;
  status: PlanStepStatus;
};

export type PlanStep = {
  id: number;
  content: string;
  status: PlanStepStatus;
  createdAt: string;
  updatedAt: string;
};

export type PlanState = {
  nextId: number;
  steps: PlanStep[];
};

const VALID_STATUSES = new Set<PlanStepStatus>(["pending", "in_progress", "completed"]);

export function createEmptyPlan(): PlanState {
  return {
    nextId: 1,
    steps: [],
  };
}

export function parsePlan(value: unknown, warnings: string[]): PlanState {
  if (value === undefined) {
    return createEmptyPlan();
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring session plan because plan is not an object.");
    return createEmptyPlan();
  }

  const source = value as Record<string, unknown>;
  const steps = parsePlanSteps(source.steps, warnings);
  const maxId = steps.reduce((highest, step) => Math.max(highest, step.id), 0);
  const parsedNextId =
    typeof source.nextId === "number" && Number.isInteger(source.nextId) && source.nextId > 0
      ? source.nextId
      : maxId + 1;

  return {
    nextId: Math.max(parsedNextId, maxId + 1, 1),
    steps,
  };
}

export function formatPlan(plan: PlanState): string {
  if (plan.steps.length === 0) {
    return "Plan is empty. Use /plan add <step> to create one.";
  }

  return [
    "Current plan:",
    ...plan.steps.map((step) => `${formatStatus(step.status)} ${step.id}. ${step.content}`),
  ].join("\n");
}

export function addPlanStep(plan: PlanState, content: string): PlanState {
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return plan;
  }

  const now = new Date().toISOString();

  return {
    nextId: plan.nextId + 1,
    steps: [
      ...plan.steps,
      {
        id: plan.nextId,
        content: trimmed,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

export function clearPlan(): PlanState {
  return createEmptyPlan();
}

export function replacePlanSteps(steps: PlanStepInput[]): PlanState {
  const now = new Date().toISOString();
  const nextSteps = steps.map((step, index) => ({
    id: index + 1,
    content: step.content.trim(),
    status: step.status,
    createdAt: now,
    updatedAt: now,
  }));

  return {
    nextId: nextSteps.length + 1,
    steps: nextSteps,
  };
}

export function removePlanStep(plan: PlanState, id: number): PlanState | null {
  const nextSteps = plan.steps.filter((step) => step.id !== id);

  if (nextSteps.length === plan.steps.length) {
    return null;
  }

  return {
    ...plan,
    steps: nextSteps,
  };
}

export function setPlanStepStatus(
  plan: PlanState,
  id: number,
  status: PlanStepStatus,
): PlanState | null {
  if (!plan.steps.some((step) => step.id === id)) {
    return null;
  }

  const now = new Date().toISOString();

  return {
    ...plan,
    steps: plan.steps.map((step) => {
      if (step.id === id) {
        return {
          ...step,
          status,
          updatedAt: now,
        };
      }

      if (status === "in_progress" && step.status === "in_progress") {
        return {
          ...step,
          status: "pending",
          updatedAt: now,
        };
      }

      return step;
    }),
  };
}

function parsePlanSteps(value: unknown, warnings: string[]): PlanStep[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    warnings.push("Ignoring session plan steps because plan.steps is not an array.");
    return [];
  }

  return value.filter((step): step is PlanStep => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      warnings.push("Ignoring an invalid plan step.");
      return false;
    }

    const source = step as Record<string, unknown>;
    const valid =
      typeof source.id === "number" &&
      Number.isInteger(source.id) &&
      source.id > 0 &&
      typeof source.content === "string" &&
      source.content.trim().length > 0 &&
      typeof source.status === "string" &&
      VALID_STATUSES.has(source.status as PlanStepStatus) &&
      typeof source.createdAt === "string" &&
      typeof source.updatedAt === "string";

    if (!valid) {
      warnings.push("Ignoring a plan step with invalid fields.");
    }

    return valid;
  });
}

export function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as PlanStepStatus);
}

function formatStatus(status: PlanStepStatus): string {
  if (status === "completed") {
    return "[x]";
  }

  if (status === "in_progress") {
    return "[>]";
  }

  return "[ ]";
}
