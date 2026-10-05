import { readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_DEPTH = 5;
const MAX_ENTRIES = 200;
const EXCLUDED_NAMES = new Set([".git", "node_modules", "dist"]);
const EXCLUDED_RELATIVE_PATHS = new Set([".ccagent/history", ".ccagent/sessions", ".ccagent/logs"]);

type ListedEntry = {
  depth: number;
  name: string;
  isDirectory: boolean;
};

export class ListFilesTool implements Tool {
  readonly name = "list_files";
  readonly description = "List files and directories in the current workspace.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative directory path inside the workspace.",
      },
      maxDepth: {
        type: "number",
        description: "Maximum directory depth to list, from 0 to 5.",
      },
    },
    required: ["path", "maxDepth"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.path !== "string") {
      return {
        ok: false,
        error: "Expected input.path to be a string.",
      };
    }

    if (typeof input.maxDepth !== "number" || !Number.isFinite(input.maxDepth)) {
      return {
        ok: false,
        error: "Expected input.maxDepth to be a number.",
      };
    }

    const requestedPath = input.path.trim() || ".";
    const maxDepth = clampDepth(input.maxDepth);
    const workspaceRoot = resolve(context.workspaceRoot);
    const targetPath = resolve(workspaceRoot, requestedPath);

    if (!isInsideWorkspace(workspaceRoot, targetPath)) {
      return {
        ok: false,
        error: "Refusing to list files outside the workspace.",
      };
    }

    let targetStat;

    try {
      targetStat = await stat(targetPath);
    } catch {
      return {
        ok: false,
        error: `Directory not found: ${requestedPath}`,
      };
    }

    if (!targetStat.isDirectory()) {
      return {
        ok: false,
        error: `Path is not a directory: ${requestedPath}`,
      };
    }

    const entries: ListedEntry[] = [];
    const truncated = await collectEntries(workspaceRoot, targetPath, 0, maxDepth, entries);
    const displayRoot = normalizeRelativePath(relative(workspaceRoot, targetPath)) || ".";

    return {
      ok: true,
      content: formatEntries(displayRoot, entries, truncated),
      metadata: {
        path: displayRoot,
        count: entries.length,
        maxDepth,
        truncated,
      },
    };
  }
}

async function collectEntries(
  workspaceRoot: string,
  directoryPath: string,
  depth: number,
  maxDepth: number,
  entries: ListedEntry[],
): Promise<boolean> {
  if (entries.length >= MAX_ENTRIES) {
    return true;
  }

  const children = (await readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => !shouldExcludeWorkspaceEntry(workspaceRoot, directoryPath, entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });

  let truncated = false;

  for (const child of children) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }

    entries.push({
      depth,
      name: child.name,
      isDirectory: child.isDirectory(),
    });

    if (child.isDirectory() && depth < maxDepth) {
      const childPath = resolve(directoryPath, child.name);
      truncated = (await collectEntries(workspaceRoot, childPath, depth + 1, maxDepth, entries)) || truncated;
    }
  }

  return truncated;
}

export function shouldExcludeWorkspaceEntry(
  workspaceRoot: string,
  parentPath: string,
  name: string,
): boolean {
  if (EXCLUDED_NAMES.has(name)) {
    return true;
  }

  const relativePath = normalizeRelativePath(relative(workspaceRoot, resolve(parentPath, name)));
  return EXCLUDED_RELATIVE_PATHS.has(relativePath);
}

function formatEntries(root: string, entries: ListedEntry[], truncated: boolean): string {
  const lines = [root];

  for (const entry of entries) {
    const indent = "  ".repeat(entry.depth);
    const suffix = entry.isDirectory ? "/" : "";
    lines.push(`${indent}- ${entry.name}${suffix}`);
  }

  if (entries.length === 0) {
    lines.push("(empty)");
  }

  if (truncated) {
    lines.push("...[truncated]");
  }

  return lines.join("\n");
}

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relativePath = relative(workspaceRoot, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function clampDepth(value: number): number {
  return Math.max(0, Math.min(MAX_DEPTH, Math.floor(value)));
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}
