import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_RESULTS = 50;
const MAX_OUTPUT_BYTES = 64 * 1024;

export class SearchFilesTool implements Tool {
  readonly name = "search_files";
  readonly description = "Search text in workspace files using ripgrep.";
  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text or regular expression to search for in the workspace.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.query !== "string") {
      return {
        ok: false,
        error: "Expected input.query to be a string.",
      };
    }

    const query = input.query.trim();

    if (query.length === 0) {
      return {
        ok: false,
        error: "Missing search query.",
      };
    }

    const workspaceRoot = resolve(context.workspaceRoot);
    const args = [
      "--line-number",
      "--column",
      "--no-heading",
      "--color",
      "never",
      "--smart-case",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!.git/**",
      query,
      ".",
    ];

    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd: workspaceRoot,
        maxBuffer: MAX_OUTPUT_BYTES,
      });

      const matches = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, MAX_RESULTS);

      if (matches.length === 0) {
        return {
          ok: true,
          content: "No matches found.",
          metadata: {
            query,
            count: 0,
          },
        };
      }

      return {
        ok: true,
        content: matches.join("\n"),
        metadata: {
          query,
          count: matches.length,
          truncated: stdout.split(/\r?\n/).filter(Boolean).length > matches.length,
        },
      };
    } catch (error) {
      if (isExecError(error) && error.code === 1) {
        return {
          ok: true,
          content: "No matches found.",
          metadata: {
            query,
            count: 0,
          },
        };
      }

      const reason = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        error: `Search failed: ${reason}`,
      };
    }
  }
}

function isExecError(error: unknown): error is Error & { code?: number } {
  return error instanceof Error && "code" in error;
}
