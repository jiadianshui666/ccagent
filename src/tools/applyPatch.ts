import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractPatchPaths, isSafeWorkspacePath } from "../pathPolicy.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_PATCH_BYTES = 128 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;

export class ApplyPatchTool implements Tool {
  readonly name = "apply_patch";
  readonly description = "Apply a unified diff patch to files in the current workspace after user approval.";
  readonly parameters = {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "Unified diff patch to apply inside the workspace.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  } as const;

  approvalMessage(input: Record<string, unknown>): string | null {
    if (typeof input.patch !== "string") {
      return "Apply an invalid patch request.";
    }

    return formatPatchApprovalMessage(input.patch, "apply");
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return applyPatch(input, context, "apply");
  }
}

export class ReversePatchTool implements Tool {
  readonly name = "reverse_patch";
  readonly description = "Reverse a previously applied unified diff patch in the current workspace after user approval.";
  readonly parameters = {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "Unified diff patch to reverse inside the workspace.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  } as const;

  approvalMessage(input: Record<string, unknown>): string | null {
    if (typeof input.patch !== "string") {
      return "Reverse an invalid patch request.";
    }

    return formatPatchApprovalMessage(input.patch, "reverse");
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return applyPatch(input, context, "reverse");
  }
}

async function applyPatch(
  input: Record<string, unknown>,
  context: ToolContext,
  mode: "apply" | "reverse",
): Promise<ToolResult> {
  if (typeof input.patch !== "string") {
    return {
      ok: false,
      error: "Expected input.patch to be a string.",
    };
  }

  const patch = input.patch;

  if (patch.trim().length === 0) {
    return {
      ok: false,
      error: "Missing patch content.",
    };
  }

  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    return {
      ok: false,
      error: `Patch is too large to apply safely (${Buffer.byteLength(patch, "utf8")} bytes).`,
    };
  }

  const workspaceRoot = resolve(context.workspaceRoot);
  const paths = extractPatchPaths(patch);
  const invalidPath = paths.find((path) => !isSafeWorkspacePath(workspaceRoot, path));

  if (invalidPath) {
    return {
      ok: false,
      error: `Patch contains an unsafe path: ${invalidPath}`,
    };
  }

  const modeArgs = mode === "reverse" ? ["--reverse"] : [];
  const check = await runGitApply(
    ["--check", "--whitespace=nowarn", ...modeArgs, "-"],
    patch,
    workspaceRoot,
  );

  if (check.exitCode !== 0) {
    return {
      ok: false,
      error: formatGitApplyFailure(
        mode === "reverse" ? "Reverse patch check failed" : "Patch check failed",
        check,
        paths,
      ),
    };
  }

  const snapshot = await createPreEditSnapshot(workspaceRoot, patch, paths, mode);
  const applied = await runGitApply(["--whitespace=nowarn", ...modeArgs, "-"], patch, workspaceRoot);

  if (applied.exitCode !== 0) {
    return {
      ok: false,
      error: formatGitApplyFailure(
        mode === "reverse" ? "Reverse patch failed" : "Patch apply failed",
        applied,
        paths,
      ),
    };
  }

  return {
    ok: true,
    content: [
      mode === "reverse" ? "Patch reversed successfully." : "Patch applied successfully.",
      `Pre-edit snapshot: ${snapshot.path}`,
    ].join("\n"),
    metadata: {
      paths,
      snapshotFileCount: snapshot.fileCount,
      snapshotPath: snapshot.path,
    },
  };
}

type PatchSnapshotFile = {
  bytes: number;
  contentBase64?: string;
  exists: boolean;
  path: string;
  truncated?: boolean;
};

async function createPreEditSnapshot(
  workspaceRoot: string,
  patch: string,
  paths: string[],
  mode: "apply" | "reverse",
): Promise<{ fileCount: number; path: string }> {
  const createdAt = new Date().toISOString();
  const fileName = `patch-snapshot-${formatSnapshotTimestamp(createdAt)}-${Math.random()
    .toString(36)
    .slice(2, 8)}.json`;
  const relativePath = `.ccagent/patch-snapshots/${fileName}`;
  const absolutePath = join(workspaceRoot, ".ccagent", "patch-snapshots", fileName);
  const files = await Promise.all(paths.map((path) => snapshotWorkspaceFile(workspaceRoot, path)));
  const payload = {
    version: 1,
    createdAt,
    mode,
    paths,
    patch,
    files,
  };

  await mkdir(join(workspaceRoot, ".ccagent", "patch-snapshots"), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    fileCount: files.length,
    path: relativePath,
  };
}

async function snapshotWorkspaceFile(
  workspaceRoot: string,
  path: string,
): Promise<PatchSnapshotFile> {
  const absolutePath = resolve(workspaceRoot, path);

  try {
    const info = await stat(absolutePath);

    if (!info.isFile()) {
      return {
        bytes: 0,
        exists: false,
        path,
      };
    }

    if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
      return {
        bytes: info.size,
        exists: true,
        path,
        truncated: true,
      };
    }

    const content = await readFile(absolutePath);

    return {
      bytes: content.byteLength,
      contentBase64: content.toString("base64"),
      exists: true,
      path,
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        bytes: 0,
        exists: false,
        path,
      };
    }

    throw error;
  }
}

type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function runGitApply(args: string[], input: string, cwd: string): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn("git", ["apply", ...args], {
      cwd,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = truncate(stdout + chunk.toString("utf8"), MAX_PROCESS_OUTPUT_BYTES);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = truncate(stderr + chunk.toString("utf8"), MAX_PROCESS_OUTPUT_BYTES);
    });

    child.on("error", rejectProcess);

    child.on("close", (exitCode) => {
      resolveProcess({
        exitCode,
        stdout,
        stderr,
      });
    });

    child.stdin.end(input);
  });
}

function formatPatchApprovalMessage(patch: string, mode: "apply" | "reverse"): string {
  return [
    mode === "reverse" ? "Reverse this patch:" : "Apply this patch:",
    formatPatchSummary(patch, mode),
    "",
    formatPatchReview(patch, mode),
    "",
    "Preview:",
    truncate(patch, 6000),
  ].join("\n");
}

function formatPatchSummary(patch: string, mode: "apply" | "reverse"): string {
  const paths = extractPatchPaths(patch);
  const changes = countPatchLineChanges(patch);
  const effectiveChanges =
    mode === "reverse"
      ? {
          additions: changes.deletions,
          deletions: changes.additions,
        }
      : changes;

  return [
    `Files: ${paths.length > 0 ? paths.join(", ") : "(unknown)"}`,
    `Changes: +${effectiveChanges.additions} -${effectiveChanges.deletions}`,
  ].join("\n");
}

function countPatchLineChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return {
    additions,
    deletions,
  };
}

type PatchRisk = "low" | "medium" | "high";

type PatchFileAction = "create" | "delete" | "modify" | "rename";

type PatchFileReview = {
  action: PatchFileAction;
  additions: number;
  binary: boolean;
  deletions: number;
  hunks: number;
  oldPath?: string;
  path: string;
  risk: PatchRisk;
  riskReasons: string[];
};

type MutablePatchFileReview = Omit<PatchFileReview, "action" | "risk" | "riskReasons"> & {
  action?: PatchFileAction;
  isDeletedFile?: boolean;
  isNewFile?: boolean;
  newPath?: string;
  risk?: PatchRisk;
  riskReasons?: string[];
};

function formatPatchReview(patch: string, mode: "apply" | "reverse"): string {
  const files = parsePatchReviewFiles(patch, mode);

  if (files.length === 0) {
    return [
      "Patch review:",
      "Overall risk: medium",
      "Changed files: (could not identify file-level changes)",
    ].join("\n");
  }

  const lines = [
    "Patch review:",
    `Overall risk: ${getHighestPatchRisk(files)}`,
  ];

  for (const risk of ["high", "medium", "low"] as const) {
    const group = files.filter((file) => file.risk === risk);

    if (group.length === 0) {
      continue;
    }

    lines.push(`${capitalizeRisk(risk)} risk files:`);

    for (const file of group) {
      lines.push(formatPatchReviewFile(file));

      if (file.riskReasons.length > 0) {
        lines.push(`  reasons: ${file.riskReasons.join("; ")}`);
      }
    }
  }

  return lines.join("\n");
}

function parsePatchReviewFiles(patch: string, mode: "apply" | "reverse"): PatchFileReview[] {
  const files: MutablePatchFileReview[] = [];
  let current: MutablePatchFileReview | null = null;
  let inHunk = false;

  const ensureCurrent = (): MutablePatchFileReview => {
    if (!current) {
      current = createMutablePatchFileReview("(unknown)");
      files.push(current);
    }

    return current;
  };

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(/\s+/);
      const oldPath = normalizePatchReviewPath(parts[2]);
      const newPath = normalizePatchReviewPath(parts[3]);
      current = createMutablePatchFileReview(newPath ?? oldPath ?? "(unknown)");
      current.oldPath = oldPath;
      current.newPath = newPath;
      files.push(current);
      inHunk = false;
      continue;
    }

    if (line.startsWith("rename from ")) {
      const file = ensureCurrent();
      file.oldPath = normalizePatchReviewPath(line.slice("rename from ".length)) ?? file.oldPath;
      continue;
    }

    if (line.startsWith("rename to ")) {
      const file = ensureCurrent();
      const newPath = normalizePatchReviewPath(line.slice("rename to ".length));
      file.newPath = newPath ?? file.newPath;
      file.path = newPath ?? file.path;
      continue;
    }

    if (line.startsWith("new file mode ")) {
      ensureCurrent().isNewFile = true;
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      ensureCurrent().isDeletedFile = true;
      continue;
    }

    if (line.startsWith("--- ")) {
      const file = ensureCurrent();
      const oldPath = normalizePatchReviewPath(line.slice(4));
      file.oldPath = oldPath;

      if (!file.newPath && oldPath) {
        file.path = oldPath;
      }

      continue;
    }

    if (line.startsWith("+++ ")) {
      const file = ensureCurrent();
      const newPath = normalizePatchReviewPath(line.slice(4));
      file.newPath = newPath;

      if (newPath) {
        file.path = newPath;
      }

      continue;
    }

    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      ensureCurrent().binary = true;
      continue;
    }

    if (line.startsWith("@@")) {
      const file = ensureCurrent();
      file.hunks += 1;
      inHunk = true;
      continue;
    }

    if (!inHunk || !current) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
    }
  }

  return files.map((file) => finalizePatchFileReview(file, mode));
}

function createMutablePatchFileReview(path: string): MutablePatchFileReview {
  return {
    additions: 0,
    binary: false,
    deletions: 0,
    hunks: 0,
    path,
  };
}

function finalizePatchFileReview(
  file: MutablePatchFileReview,
  mode: "apply" | "reverse",
): PatchFileReview {
  const rawAction = classifyPatchFileAction(file);
  const action = mode === "reverse" ? invertPatchFileAction(rawAction) : rawAction;
  const additions = mode === "reverse" ? file.deletions : file.additions;
  const deletions = mode === "reverse" ? file.additions : file.deletions;
  const path = mode === "reverse" && rawAction === "rename" ? file.oldPath ?? file.path : file.path;
  const oldPath = mode === "reverse" && rawAction === "rename" ? file.path : file.oldPath;
  const risk = classifyPatchFileRisk(
    {
      additions,
      binary: file.binary,
      deletions,
      path,
      ...(oldPath ? { oldPath } : {}),
    },
    action,
  );

  return {
    action,
    additions,
    binary: file.binary,
    deletions,
    hunks: file.hunks,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    path,
    risk: risk.level,
    riskReasons: risk.reasons,
  };
}

function classifyPatchFileAction(file: MutablePatchFileReview): PatchFileAction {
  if (file.isNewFile || (!file.oldPath && file.newPath)) {
    return "create";
  }

  if (file.isDeletedFile || (file.oldPath && !file.newPath)) {
    return "delete";
  }

  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return "rename";
  }

  return "modify";
}

function invertPatchFileAction(action: PatchFileAction): PatchFileAction {
  if (action === "create") {
    return "delete";
  }

  if (action === "delete") {
    return "create";
  }

  return action;
}

function classifyPatchFileRisk(
  file: Pick<PatchFileReview, "additions" | "binary" | "deletions" | "path"> & {
    oldPath?: string;
  },
  action: PatchFileAction,
): { level: PatchRisk; reasons: string[] } {
  const reasons: string[] = [];
  let risk: PatchRisk = "low";

  if (file.binary) {
    risk = "high";
    reasons.push("binary patch is hard to inspect");
  }

  if (isSensitivePatchPath(file.path) || (file.oldPath ? isSensitivePatchPath(file.oldPath) : false)) {
    risk = "high";
    reasons.push("touches a sensitive path");
  }

  if (action === "delete") {
    risk = "high";
    reasons.push("deletes a file");
  } else if (action === "create" || action === "rename") {
    risk = maxPatchRisk(risk, "medium");
    reasons.push(action === "create" ? "creates a new file" : "renames a file");
  }

  if (file.deletions > 0) {
    risk = maxPatchRisk(risk, file.deletions >= 50 ? "high" : "medium");
    reasons.push(file.deletions >= 50 ? "removes many lines" : "removes existing lines");
  }

  if (isProjectConfigPath(file.path)) {
    risk = maxPatchRisk(risk, "medium");
    reasons.push("touches project configuration");
  }

  if (reasons.length === 0) {
    reasons.push("text-only addition or small edit");
  }

  return {
    level: risk,
    reasons,
  };
}

function formatPatchReviewFile(file: PatchFileReview): string {
  const oldPath = file.oldPath ? ` from ${file.oldPath}` : "";
  const binary = file.binary ? ", binary" : "";

  return `- ${file.path}${oldPath}: ${file.action}, +${file.additions} -${file.deletions}, hunks=${file.hunks}${binary}`;
}

function getHighestPatchRisk(files: PatchFileReview[]): PatchRisk {
  return files.reduce<PatchRisk>((risk, file) => maxPatchRisk(risk, file.risk), "low");
}

function maxPatchRisk(left: PatchRisk, right: PatchRisk): PatchRisk {
  const order: Record<PatchRisk, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };

  return order[right] > order[left] ? right : left;
}

function capitalizeRisk(risk: PatchRisk): string {
  return `${risk.slice(0, 1).toUpperCase()}${risk.slice(1)}`;
}

function isSensitivePatchPath(path: string): boolean {
  const normalized = path.toLowerCase();

  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.includes("/.env") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized.includes("token") ||
    normalized.includes("api_key") ||
    normalized.includes("apikey")
  );
}

function isProjectConfigPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const fileName = normalized.split("/").at(-1) ?? normalized;

  return (
    fileName === "package.json" ||
    fileName === "package-lock.json" ||
    fileName === "tsconfig.json" ||
    fileName.endsWith(".config.js") ||
    fileName.endsWith(".config.ts") ||
    fileName.endsWith(".config.json")
  );
}

function normalizePatchReviewPath(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }

  let path = rawPath.trim().split(/\s+/)[0] ?? "";

  if (path.startsWith("\"") && path.endsWith("\"")) {
    path = path.slice(1, -1);
  }

  path = path.replaceAll("\\", "/");

  if (path === "/dev/null") {
    return undefined;
  }

  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }

  path = path.replace(/\/+/g, "/");

  while (path.startsWith("./")) {
    path = path.slice(2);
  }

  return path.length > 0 ? path : undefined;
}

function formatGitApplyFailure(
  message: string,
  result: ProcessResult,
  paths: string[],
): string {
  const diagnosis = diagnoseGitApplyFailure(result);
  const rereadPaths = diagnosis.some((item) => item.suggestReread) ? paths : [];

  return [
    message,
    `exitCode: ${result.exitCode ?? "unknown"}`,
    ...(diagnosis.length > 0
      ? [
          "diagnosis:",
          ...diagnosis.map((item) => `- ${item.message}`),
        ]
      : []),
    ...(rereadPaths.length > 0
      ? [
          "suggested next reads:",
          ...rereadPaths.map((path) => `- read_file ${path}`),
        ]
      : []),
    "stdout:",
    result.stdout.trimEnd() || "(empty)",
    "stderr:",
    result.stderr.trimEnd() || "(empty)",
  ].join("\n");
}

type PatchFailureDiagnosis = {
  message: string;
  suggestReread: boolean;
};

function diagnoseGitApplyFailure(result: ProcessResult): PatchFailureDiagnosis[] {
  const text = `${result.stdout}\n${result.stderr}`;
  const diagnosis: PatchFailureDiagnosis[] = [];

  if (/patch failed:|does not apply|while searching for:/i.test(text)) {
    diagnosis.push({
      message: "Patch hunks did not match the current workspace state; reread the file and regenerate the patch from current contents.",
      suggestReread: true,
    });
  }

  if (/corrupt patch|malformed patch|unrecognized input|No valid patches/i.test(text)) {
    diagnosis.push({
      message: "Patch format looks invalid; regenerate a complete unified diff with diff headers, file headers, and hunk headers.",
      suggestReread: false,
    });
  }

  if (/No such file or directory|does not exist in index|unable to find/i.test(text)) {
    diagnosis.push({
      message: "Patch references a path that git could not resolve; verify the current relative path before retrying.",
      suggestReread: true,
    });
  }

  if (/already exists in working directory|already exists/i.test(text)) {
    diagnosis.push({
      message: "Patch tries to create a path that already exists; reread the existing file and use a modify patch instead.",
      suggestReread: true,
    });
  }

  return uniqueDiagnoses(diagnosis);
}

function uniqueDiagnoses(values: PatchFailureDiagnosis[]): PatchFailureDiagnosis[] {
  const seen = new Set<string>();
  const unique: PatchFailureDiagnosis[] = [];

  for (const value of values) {
    if (seen.has(value.message)) {
      continue;
    }

    seen.add(value.message);
    unique.push(value);
  }

  return unique;
}

function formatSnapshotTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
}
