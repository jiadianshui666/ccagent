import type { Tool, ToolContext, ToolResult } from "./types.js";

export class RunSubagentTool implements Tool {
  readonly name = "run_subagent";
  readonly description =
    "Delegate an isolated research or editing task to a subagent and return its concise result. Use this to search, read, summarize, or make scoped edits across several files without polluting the main conversation.";
  readonly parameters = {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Self-contained research task for the subagent, such as locating a definition or summarizing several files.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
      return { ok: false, error: "Expected input.prompt to be a non-empty string." };
    }

    if (!context.runSubagent) {
      return { ok: false, error: "Subagent execution is not available in this context." };
    }

    try {
      const content = await context.runSubagent(input.prompt.trim());
      return { ok: true, content };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Subagent failed: ${reason}` };
    }
  }
}