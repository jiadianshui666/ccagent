import type { Tool, ToolContext, ToolResult } from "./types.js";

export class RunSubagentsTool implements Tool {
  readonly name = "run_subagents";
  readonly description =
    "Delegate several independent research or scoped editing tasks to parallel subagents and return their concise results. Use this to search, read, summarize, or edit across several files at once without polluting the main conversation. Subagents are read-only unless write is true, which enables disjoint file edits with conflict detection.";
  readonly parameters = {
    type: "object",
    properties: {
      prompts: {
        type: "array",
        items: { type: "string" },
        description:
          "Self-contained research or edit tasks to run in parallel, such as locating definitions or editing different files.",
      },
      write: {
        type: "boolean",
        description:
          "When true, allow each subagent to edit files. Set this only when the tasks target disjoint files; overlapping writes are detected and reported as an error.",
      },
    },
    required: ["prompts", "write"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawPrompts = input.prompts;

    if (!Array.isArray(rawPrompts) || rawPrompts.length === 0) {
      return { ok: false, error: "Expected input.prompts to be a non-empty array of strings." };
    }

    const prompts = rawPrompts.map((prompt) => (typeof prompt === "string" ? prompt.trim() : ""));

    if (prompts.some((prompt) => prompt.length === 0)) {
      return {
        ok: false,
        error: "Expected input.prompts to be an array of non-empty strings.",
      };
    }

    if (input.write !== undefined && typeof input.write !== "boolean") {
      return { ok: false, error: "Expected input.write to be a boolean when provided." };
    }

    if (!context.runSubagents) {
      return { ok: false, error: "Parallel subagent execution is not available in this context." };
    }

    try {
      const results = await context.runSubagents(prompts, { write: input.write === true });
      const content = results
        .map((result, index) => `## Subagent ${index + 1}\n${result}`)
        .join("\n\n");
      return { ok: true, content };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Parallel subagents failed: ${reason}` };
    }
  }
}