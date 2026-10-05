import { searchWeb } from "../web.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly description =
    "Search the web via DuckDuckGo and return a short list of results (title, URL, snippet). Use this to discover relevant pages for a question, then retrieve one with web_fetch.";
  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const query = typeof input.query === "string" ? input.query.trim() : "";

    if (query.length === 0) {
      return { ok: false, error: "Expected input.query to be a non-empty string." };
    }

    try {
      const results = await searchWeb(query);
      const content =
        results
          .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`)
          .join("\n\n") || "No results found.";

      return {
        ok: true,
        content,
        metadata: { results: results.length },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `web_search failed: ${reason}` };
    }
  }
}