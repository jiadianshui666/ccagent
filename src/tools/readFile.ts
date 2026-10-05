import { stat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_FILE_BYTES = 64 * 1024;

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relativePath = relative(workspaceRoot, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly description = "Read a text file from the current workspace.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file inside the workspace.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.path !== "string") {
      return {
        ok: false,
        error: "Expected input.path to be a string.",
      };
    }

    const requestedPath = input.path.trim();

    if (requestedPath.length === 0) {
      return {
        ok: false,
        error: "Missing file path.",
      };
    }

    const workspaceRoot = resolve(context.workspaceRoot);
    const targetPath = resolve(workspaceRoot, requestedPath);

    if (!isInsideWorkspace(workspaceRoot, targetPath)) {
      return {
        ok: false,
        error: "Refusing to read files outside the workspace.",
      };
    }

    let fileStat;

    try {
      fileStat = await stat(targetPath);
    } catch {
      return {
        ok: false,
        error: `File not found: ${requestedPath}`,
      };
    }

    if (!fileStat.isFile()) {
      return {
        ok: false,
        error: `Path is not a file: ${requestedPath}`,
      };
    }

    if (fileStat.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `File is too large to read safely (${fileStat.size} bytes).`,
      };
    }

    const content = await readFile(targetPath, "utf8");

    return {
      ok: true,
      content,
      metadata: {
        path: relative(workspaceRoot, targetPath),
        bytes: fileStat.size,
      },
    };
  }
}
