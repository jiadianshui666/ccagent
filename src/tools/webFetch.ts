import { fetchWebPage } from "../web.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export class WebFetchTool implements Tool {
  readonly name = "web_fetch";
  readonly description =
    "Fetch a web page over HTTP(S) and return its readable plain text. Use this to retrieve the contents of a specific URL. HTML is stripped, content is size-capped, and private or local network addresses are refused.";
  readonly parameters = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Absolute http(s) URL to fetch.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const url = typeof input.url === "string" ? input.url.trim() : "";

    if (url.length === 0) {
      return { ok: false, error: "Expected input.url to be a non-empty string." };
    }

    try {
      const page = await fetchWebPage(url);

      return {
        ok: true,
        content: [
          ...(page.title ? [`Title: ${page.title}`] : []),
          page.text,
          ...(page.truncated ? ["(content truncated)"] : []),
        ].join("\n\n"),
        metadata: {
          title: page.title,
          url: page.url,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `web_fetch failed: ${reason}` };
    }
  }
}