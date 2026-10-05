import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isSafeWorkspacePath } from "../pathPolicy.js";
import { applyPatch } from "./applyPatch.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_EDIT_FILE_BYTES = 512 * 1024;

export class EditTool implements Tool {
  readonly name = "edit";
  readonly description =
    "Replace an exact string in a workspace file after user approval. Prefer this over apply_patch for small, precise edits: provide the exact old text and its replacement and CCAgent produces a valid patch for you.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace file path to edit, relative to the workspace root.",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to replace. Must match exactly once in the file unless replace_all is true; use more surrounding context when the match is ambiguous.",
      },
      new_string: {
        type: "string",
        description: "Replacement text. Use an empty string to delete old_string.",
      },
      replace_all: {
        type: "boolean",
        description: "When true, replace every occurrence of old_string instead of requiring exactly one match.",
      },
    },
    required: ["path", "old_string", "new_string", "replace_all"],
    additionalProperties: false,
  } as const;

  approvalMessage(input: Record<string, unknown>): string | null {
    const path = typeof input.path === "string" ? input.path : "(invalid)";
    const oldString = typeof input.old_string === "string" ? input.old_string : "";
    const newString = typeof input.new_string === "string" ? input.new_string : "";

    return [
      "Edit this file?",
      `Path: ${path}`,
      `Replace: ${truncate(oldString, 200)}`,
      `With: ${truncate(newString, 200)}`,
    ].join("\n");
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return { ok: false, error: "Expected input.path to be a non-empty string." };
    }

    if (typeof input.old_string !== "string" || input.old_string.length === 0) {
      return { ok: false, error: "Expected input.old_string to be a non-empty string." };
    }

    if (typeof input.new_string !== "string") {
      return { ok: false, error: "Expected input.new_string to be a string." };
    }

    const replaceAll = input.replace_all === true;
    const requestedPath = normalizeWorkspacePath(input.path);
    const workspaceRoot = resolve(context.workspaceRoot);

    if (!isSafeWorkspacePath(workspaceRoot, requestedPath)) {
      return { ok: false, error: `Refusing to edit an unsafe path: ${input.path}` };
    }

    const absolutePath = resolve(workspaceRoot, requestedPath);
    let currentContent: string;

    try {
      const buffer = await readFile(absolutePath);

      if (buffer.byteLength > MAX_EDIT_FILE_BYTES) {
        return { ok: false, error: `File is too large to edit safely (${buffer.byteLength} bytes).` };
      }

      currentContent = buffer.toString("utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return { ok: false, error: `File not found: ${requestedPath}` };
      }

      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Failed to read ${requestedPath}: ${reason}` };
    }

    const occurrences = countOccurrences(currentContent, input.old_string);

    if (occurrences === 0) {
      return { ok: false, error: `old_string was not found in ${requestedPath}; reread the file and copy the exact current text.` };
    }

    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        error: `old_string matches ${occurrences} locations in ${requestedPath}; include more surrounding context or set replace_all to true.`,
      };
    }

    const nextContent = replaceAll
      ? currentContent.split(input.old_string).join(input.new_string)
      : currentContent.replace(input.old_string, input.new_string);

    if (nextContent === currentContent) {
      return { ok: false, error: `Edit produced no change to ${requestedPath}.` };
    }

    const patch = buildLocalizedUnifiedDiff(requestedPath, currentContent, nextContent);
    const applied = await applyPatch({ patch }, context, "apply");

    if (!applied.ok) {
      return applied;
    }

    const snapshotPath = typeof applied.metadata?.snapshotPath === "string" ? applied.metadata.snapshotPath : undefined;

    return {
      ok: true,
      content: [
        `Edited ${requestedPath} successfully.`,
        ...(snapshotPath ? [`Pre-edit snapshot: ${snapshotPath}`] : []),
      ].join("\n"),
      metadata: {
        paths: [requestedPath],
        snapshotPath,
        patch,
      },
    };
  }
}

function normalizeWorkspacePath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }

  return count;
}

function buildLocalizedUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  let start = 0;

  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }

  let end = 0;

  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
  ) {
    end += 1;
  }

  const oldChanged = oldLines.slice(start, oldLines.length - end);
  const newChanged = newLines.slice(start, newLines.length - end);
  const contextBefore = Math.min(start, 3);
  const contextAfter = Math.min(end, 3);
  const hunkStart = start - contextBefore + 1;
  const oldCount = contextBefore + oldChanged.length + contextAfter;
  const newCount = contextBefore + newChanged.length + contextAfter;

  const lines = [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    `@@ -${hunkStart},${oldCount} +${hunkStart},${newCount} @@`,
  ];

  for (let i = contextBefore; i > 0; i -= 1) {
    lines.push(` ${oldLines[start - i]}`);
  }

  for (const line of oldChanged) {
    lines.push(`-${line}`);
  }

  for (const line of newChanged) {
    lines.push(`+${line}`);
  }

  for (let i = 0; i < contextAfter; i += 1) {
    lines.push(` ${oldLines[oldLines.length - end + i]}`);
  }

  lines.push("");
  return lines.join("\n");
}

function splitLines(content: string): string[] {
  const normalized = content.replaceAll("\r\n", "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split("\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}