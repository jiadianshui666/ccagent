import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSafeWorkspacePath } from "../pathPolicy.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const SNAPSHOT_DIR = ".ccagent/patch-snapshots";
const MAX_LIST_LIMIT = 50;

type PatchSnapshotFile = {
  bytes: number;
  contentBase64?: string;
  exists: boolean;
  path: string;
  truncated?: boolean;
};

type PatchSnapshot = {
  createdAt: string;
  files: PatchSnapshotFile[];
  mode: "apply" | "reverse";
  patch: string;
  paths: string[];
  version: 1;
};

type LoadedPatchSnapshot = {
  absolutePath: string;
  displayPath: string;
  snapshot: PatchSnapshot;
};

export class ListPatchSnapshotsTool implements Tool {
  readonly name = "list_patch_snapshots";
  readonly description = "List saved pre-edit patch snapshots.";
  readonly parameters = {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of snapshots to list, from 1 to 50.",
      },
    },
    required: ["limit"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) {
      return {
        ok: false,
        error: "Expected input.limit to be a number.",
      };
    }

    const workspaceRoot = resolve(context.workspaceRoot);
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(input.limit)));
    const { snapshots, warnings } = await loadPatchSnapshots(workspaceRoot);

    snapshots.sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt));
    const listed = snapshots.slice(0, limit);

    return {
      ok: true,
      content: formatPatchSnapshotList(listed, {
        dir: SNAPSHOT_DIR,
        total: snapshots.length,
        warnings,
      }),
      metadata: {
        count: listed.length,
        dir: SNAPSHOT_DIR,
        total: snapshots.length,
        warnings: warnings.length,
      },
    };
  }
}

export class PatchSnapshotHistoryTool implements Tool {
  readonly name = "patch_snapshot_history";
  readonly description = "Show saved patch snapshots as a rollback history with restore commands.";
  readonly parameters = {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of history entries to show, from 1 to 50.",
      },
    },
    required: ["limit"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) {
      return {
        ok: false,
        error: "Expected input.limit to be a number.",
      };
    }

    const workspaceRoot = resolve(context.workspaceRoot);
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(input.limit)));
    const { snapshots, warnings } = await loadPatchSnapshots(workspaceRoot);

    snapshots.sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt));
    const listed = snapshots.slice(0, limit);

    return {
      ok: true,
      content: formatPatchSnapshotHistory(listed, {
        dir: SNAPSHOT_DIR,
        total: snapshots.length,
        warnings,
      }),
      metadata: {
        count: listed.length,
        dir: SNAPSHOT_DIR,
        total: snapshots.length,
        warnings: warnings.length,
      },
    };
  }
}

export class ShowPatchSnapshotTool implements Tool {
  readonly name = "show_patch_snapshot";
  readonly description = "Show metadata and captured files for one pre-edit patch snapshot.";
  readonly parameters = {
    type: "object",
    properties: {
      snapshotPath: {
        type: "string",
        description: "Snapshot file name or .ccagent/patch-snapshots/*.json path.",
      },
    },
    required: ["snapshotPath"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.snapshotPath !== "string") {
      return {
        ok: false,
        error: "Expected input.snapshotPath to be a string.",
      };
    }

    const loaded = await loadPatchSnapshot(resolve(context.workspaceRoot), input.snapshotPath);

    if (!loaded.ok) {
      return {
        ok: false,
        error: loaded.error,
      };
    }

    return {
      ok: true,
      content: formatPatchSnapshotDetails(loaded.snapshot),
      metadata: {
        path: loaded.snapshot.displayPath,
        files: loaded.snapshot.snapshot.files.length,
        paths: loaded.snapshot.snapshot.paths,
      },
    };
  }
}

export class RestorePatchSnapshotTool implements Tool {
  readonly name = "restore_patch_snapshot";
  readonly description = "Restore one workspace file from a saved pre-edit patch snapshot after approval.";
  readonly parameters = {
    type: "object",
    properties: {
      snapshotPath: {
        type: "string",
        description: "Snapshot file name or .ccagent/patch-snapshots/*.json path.",
      },
      path: {
        type: "string",
        description: "Workspace file path captured in the snapshot to restore.",
      },
    },
    required: ["snapshotPath", "path"],
    additionalProperties: false,
  } as const;

  approvalMessage(input: Record<string, unknown>): string | null {
    const snapshotPath = typeof input.snapshotPath === "string" ? input.snapshotPath : "(invalid)";
    const path = typeof input.path === "string" ? input.path : "(invalid)";

    return [
      "Restore file from patch snapshot?",
      `Snapshot: ${snapshotPath}`,
      `File: ${path}`,
      "",
      "This can overwrite or delete the current workspace file.",
    ].join("\n");
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.snapshotPath !== "string") {
      return {
        ok: false,
        error: "Expected input.snapshotPath to be a string.",
      };
    }

    if (typeof input.path !== "string") {
      return {
        ok: false,
        error: "Expected input.path to be a string.",
      };
    }

    const requestedPath = normalizeWorkspacePath(input.path);
    const workspaceRoot = resolve(context.workspaceRoot);

    if (!isSafeWorkspacePath(workspaceRoot, requestedPath)) {
      return {
        ok: false,
        error: `Refusing to restore an unsafe path: ${input.path}`,
      };
    }

    const loaded = await loadPatchSnapshot(workspaceRoot, input.snapshotPath);

    if (!loaded.ok) {
      return {
        ok: false,
        error: loaded.error,
      };
    }

    const snapshotFile = loaded.snapshot.snapshot.files.find(
      (file) => normalizeWorkspacePath(file.path) === requestedPath,
    );

    if (!snapshotFile) {
      return {
        ok: false,
        error: `Snapshot does not contain path: ${requestedPath}`,
      };
    }

    if (snapshotFile.truncated) {
      return {
        ok: false,
        error: `Snapshot content is truncated and cannot be restored safely: ${requestedPath}`,
      };
    }

    const targetPath = resolve(workspaceRoot, requestedPath);

    if (!isInsideWorkspace(workspaceRoot, targetPath)) {
      return {
        ok: false,
        error: `Refusing to restore outside the workspace: ${requestedPath}`,
      };
    }

    if (!snapshotFile.exists) {
      await removeFileIfPresent(targetPath, requestedPath);

      return {
        ok: true,
        content: [
          `Restored snapshot absence: ${requestedPath}`,
          `Snapshot: ${loaded.snapshot.displayPath}`,
        ].join("\n"),
        metadata: {
          action: "delete",
          paths: [requestedPath],
          snapshotPath: loaded.snapshot.displayPath,
        },
      };
    }

    if (typeof snapshotFile.contentBase64 !== "string") {
      return {
        ok: false,
        error: `Snapshot does not include restorable content for: ${requestedPath}`,
      };
    }

    const content = Buffer.from(snapshotFile.contentBase64, "base64");

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);

    return {
      ok: true,
      content: [
        `Restored snapshot file: ${requestedPath}`,
        `Snapshot: ${loaded.snapshot.displayPath}`,
        `Bytes: ${content.byteLength}`,
      ].join("\n"),
      metadata: {
        action: "write",
        bytes: content.byteLength,
        paths: [requestedPath],
        snapshotPath: loaded.snapshot.displayPath,
      },
    };
  }
}

async function loadPatchSnapshots(
  workspaceRoot: string,
): Promise<{ snapshots: LoadedPatchSnapshot[]; warnings: string[] }> {
  const snapshotDir = join(workspaceRoot, SNAPSHOT_DIR);
  const snapshots: LoadedPatchSnapshot[] = [];
  const warnings: string[] = [];

  try {
    const entries = await readdir(snapshotDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const displayPath = `${SNAPSHOT_DIR}/${entry.name}`;
      const loaded = await loadPatchSnapshot(workspaceRoot, displayPath);

      if (loaded.ok) {
        snapshots.push(loaded.snapshot);
      } else {
        warnings.push(`${displayPath}: ${loaded.error}`);
      }
    }
  } catch (error) {
    if (isFileNotFound(error)) {
      return { snapshots, warnings };
    }

    throw error;
  }

  return { snapshots, warnings };
}

function formatPatchSnapshotList(
  snapshots: LoadedPatchSnapshot[],
  options: { dir: string; total: number; warnings: string[] },
): string {
  const lines = [`Patch snapshots: ${options.dir}`];

  if (snapshots.length === 0) {
    lines.push("No patch snapshots found.");
  } else {
    for (const snapshot of snapshots) {
      lines.push(
        [
          `- ${snapshot.displayPath}`,
          `created=${snapshot.snapshot.createdAt}`,
          `mode=${snapshot.snapshot.mode}`,
          `files=${snapshot.snapshot.files.length}`,
          `paths=${snapshot.snapshot.paths.join(", ") || "(none)"}`,
        ].join(" "),
      );
    }

    if (options.total > snapshots.length) {
      lines.push(`...${options.total - snapshots.length} more snapshot(s) not shown`);
    }
  }

  if (options.warnings.length > 0) {
    lines.push("", "Warnings:", ...options.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatPatchSnapshotHistory(
  snapshots: LoadedPatchSnapshot[],
  options: { dir: string; total: number; warnings: string[] },
): string {
  const lines = [`Patch rollback history: ${options.dir}`];

  if (snapshots.length === 0) {
    lines.push("No patch snapshots found.");
  } else {
    snapshots.forEach((snapshot, index) => {
      const patchStats = summarizePatch(snapshot.snapshot.patch);
      const restorableFiles = snapshot.snapshot.files.filter(isRestorablePatchSnapshotFile);
      const restorePath = restorableFiles[0]?.path ?? "<path>";

      lines.push(
        `${index + 1}. ${snapshot.displayPath}`,
        `   created=${snapshot.snapshot.createdAt} mode=${snapshot.snapshot.mode} changes=+${patchStats.additions} -${patchStats.deletions}`,
        `   changed paths: ${snapshot.snapshot.paths.join(", ") || "(none)"}`,
        `   restorable files: ${restorableFiles.map((file) => file.path).join(", ") || "(none)"}`,
        `   show: /snapshots show ${snapshot.displayPath}`,
        `   restore: /snapshots restore ${snapshot.displayPath} ${restorePath}`,
      );
    });

    if (options.total > snapshots.length) {
      lines.push(`...${options.total - snapshots.length} more snapshot(s) not shown`);
    }
  }

  if (options.warnings.length > 0) {
    lines.push("", "Warnings:", ...options.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatPatchSnapshotDetails(snapshot: LoadedPatchSnapshot): string {
  return [
    `Patch snapshot: ${snapshot.displayPath}`,
    `Created: ${snapshot.snapshot.createdAt}`,
    `Mode: ${snapshot.snapshot.mode}`,
    `Paths: ${snapshot.snapshot.paths.join(", ") || "(none)"}`,
    `Patch bytes: ${Buffer.byteLength(snapshot.snapshot.patch, "utf8")}`,
    "Files:",
    ...snapshot.snapshot.files.map(formatPatchSnapshotFile),
  ].join("\n");
}

function formatPatchSnapshotFile(file: PatchSnapshotFile): string {
  const state = file.exists ? "exists" : "missing";
  const restorable = file.exists
    ? file.truncated
      ? "not restorable (truncated)"
      : typeof file.contentBase64 === "string"
        ? "restorable"
        : "not restorable (missing content)"
    : "restorable as deletion";

  return `- ${file.path}: ${state}, bytes=${file.bytes}, ${restorable}`;
}

function isRestorablePatchSnapshotFile(file: PatchSnapshotFile): boolean {
  if (!file.exists) {
    return true;
  }

  return !file.truncated && typeof file.contentBase64 === "string";
}

function summarizePatch(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

async function loadPatchSnapshot(
  workspaceRoot: string,
  snapshotPath: string,
): Promise<
  | {
      ok: true;
      snapshot: LoadedPatchSnapshot;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const resolved = resolveSnapshotPath(workspaceRoot, snapshotPath);

  if (!resolved.ok) {
    return resolved;
  }

  try {
    const raw = await readFile(resolved.absolutePath, "utf8");
    const parsed = parsePatchSnapshot(JSON.parse(raw));

    if (!parsed.ok) {
      return parsed;
    }

    return {
      ok: true,
      snapshot: {
        absolutePath: resolved.absolutePath,
        displayPath: resolved.displayPath,
        snapshot: parsed.snapshot,
      },
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        ok: false,
        error: `Patch snapshot not found: ${snapshotPath}`,
      };
    }

    const reason = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      error: `Failed to load patch snapshot: ${reason}`,
    };
  }
}

function resolveSnapshotPath(
  workspaceRoot: string,
  snapshotPath: string,
): { ok: true; absolutePath: string; displayPath: string } | { ok: false; error: string } {
  const requested = snapshotPath.trim().replaceAll("\\", "/");

  if (requested.length === 0) {
    return {
      ok: false,
      error: "Missing patch snapshot path.",
    };
  }

  if (requested.includes("\0") || isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) {
    return {
      ok: false,
      error: "Patch snapshot path must be relative.",
    };
  }

  const displayPath = requested.includes("/")
    ? normalizeSnapshotDisplayPath(requested)
    : `${SNAPSHOT_DIR}/${requested}`;

  if (!displayPath.startsWith(`${SNAPSHOT_DIR}/`) || !displayPath.endsWith(".json")) {
    return {
      ok: false,
      error: `Patch snapshot path must be under ${SNAPSHOT_DIR}/ and end with .json.`,
    };
  }

  const absolutePath = resolve(workspaceRoot, displayPath);
  const snapshotDir = resolve(workspaceRoot, SNAPSHOT_DIR);

  if (!isInsideWorkspace(snapshotDir, absolutePath)) {
    return {
      ok: false,
      error: "Patch snapshot path escapes the snapshot directory.",
    };
  }

  return {
    ok: true,
    absolutePath,
    displayPath,
  };
}

function parsePatchSnapshot(value: unknown): { ok: true; snapshot: PatchSnapshot } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "Patch snapshot root must be an object.",
    };
  }

  const source = value as Record<string, unknown>;
  const files = source.files;
  const mode = source.mode;
  const paths = source.paths;

  if (source.version !== 1) {
    return {
      ok: false,
      error: "Unsupported patch snapshot version.",
    };
  }

  if (mode !== "apply" && mode !== "reverse") {
    return {
      ok: false,
      error: "Patch snapshot mode is invalid.",
    };
  }

  if (!Array.isArray(files)) {
    return {
      ok: false,
      error: "Patch snapshot files must be an array.",
    };
  }

  return {
    ok: true,
    snapshot: {
      version: 1,
      createdAt: typeof source.createdAt === "string" ? source.createdAt : "(unknown)",
      mode,
      patch: typeof source.patch === "string" ? source.patch : "",
      paths: Array.isArray(paths)
        ? paths.filter((path): path is string => typeof path === "string").map(normalizeWorkspacePath)
        : [],
      files: files.flatMap(parsePatchSnapshotFile),
    },
  };
}

function parsePatchSnapshotFile(value: unknown): PatchSnapshotFile[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const source = value as Record<string, unknown>;

  if (typeof source.path !== "string" || typeof source.exists !== "boolean") {
    return [];
  }

  return [
    {
      bytes: typeof source.bytes === "number" && Number.isFinite(source.bytes) ? source.bytes : 0,
      exists: source.exists,
      path: normalizeWorkspacePath(source.path),
      ...(typeof source.contentBase64 === "string" ? { contentBase64: source.contentBase64 } : {}),
      ...(source.truncated === true ? { truncated: true } : {}),
    },
  ];
}

async function removeFileIfPresent(targetPath: string, displayPath: string): Promise<void> {
  try {
    const info = await stat(targetPath);

    if (!info.isFile()) {
      throw new Error(`Refusing to delete non-file path while restoring snapshot: ${displayPath}`);
    }

    await rm(targetPath);
  } catch (error) {
    if (isFileNotFound(error)) {
      return;
    }

    throw error;
  }
}

function normalizeSnapshotDisplayPath(path: string): string {
  let normalized = path.replace(/\/+/g, "/");

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

function normalizeWorkspacePath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relativePath = relative(workspaceRoot, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
