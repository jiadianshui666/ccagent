import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 128 * 1024;

export class GitDiffTool implements Tool {
  readonly name = "git_diff";
  readonly description = "Show unstaged Git diff for the current workspace.";
  readonly parameters = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  } as const;

  async execute(_input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const workspaceRoot = resolve(context.workspaceRoot);

    try {
      const { stdout } = await execFileAsync("git", ["diff", "--"], {
        cwd: workspaceRoot,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });

      return {
        ok: true,
        content: stdout.trimEnd() || "No unstaged changes.",
      };
    } catch (error) {
      if (isGitNotRepositoryError(error)) {
        return {
          ok: false,
          error: "Current workspace is not a Git repository.",
        };
      }

      const reason = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        error: `Git diff failed: ${reason}`,
      };
    }
  }
}

function isGitNotRepositoryError(error: unknown): boolean {
  const stderr =
    error instanceof Error && "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.toLowerCase()
      : "";

  return (
    stderr.includes("not a git repository") || stderr.includes("not a git command")
  );
}
