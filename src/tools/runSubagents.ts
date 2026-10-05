import type { Tool, ToolContext, ToolResult } from "./types.js";

export class RunSubagentsTool implements Tool {
  readonly name = "run_subagents";
  readonly description =
    "Delegate several independent read-only research tasks to parallel subagents and return their concise results. Use this to search, read, or summarize across multiple files or questions at once without polluting the main conversation. Each subagent is read-only and cannot edit files.";
  readonly parameters = {
    type: "object",
    properties: {
      prompts: {
        type: "array",
        items: { type: "string" },
        description:
          "Self-contained read-only research tasks to run in parallel, such as locating definitions or summarizing different files.",
      },
    },
    required: ["prompts"],
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

    if (!context.runSubagents) {
      return { ok: false, error: "Parallel subagent execution is not available in this context." };
    }

    try {
      const results = await context.runSubagents(prompts);
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