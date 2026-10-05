import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INSTRUCTIONS_FILE = "CCAGENT.md";
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
const DEFAULT_PROJECT_INSTRUCTIONS = [
  "# CCAgent Instructions",
  "",
  "- Prefer Chinese responses for this project.",
  "- Inspect relevant files before editing.",
  "- Use apply_patch for file edits; do not edit files with shell commands.",
  "- Run npm test before summarizing code changes when practical.",
  "- Never store OPENAI_API_KEY or other secrets in project files.",
  "",
].join("\n");

export type LoadedProjectInstructions = {
  path: string;
  exists: boolean;
  content: string;
  warnings: string[];
  bytes?: number;
};

export type InitProjectInstructionsResult =
  | {
      created: true;
      path: string;
    }
  | {
      created: false;
      path: string;
      reason: string;
    };

export async function initProjectInstructions(
  workspaceRoot: string,
): Promise<InitProjectInstructionsResult> {
  const path = join(workspaceRoot, INSTRUCTIONS_FILE);

  try {
    await stat(path);

    return {
      created: false,
      path,
      reason: `${INSTRUCTIONS_FILE} already exists.`,
    };
  } catch (error) {
    if (!isFileNotFound(error)) {
      const reason = error instanceof Error ? error.message : String(error);

      return {
        created: false,
        path,
        reason: `Could not check ${INSTRUCTIONS_FILE}: ${reason}`,
      };
    }
  }

  await writeFile(path, DEFAULT_PROJECT_INSTRUCTIONS, "utf8");

  return {
    created: true,
    path,
  };
}

export async function loadProjectInstructions(
  workspaceRoot: string,
): Promise<LoadedProjectInstructions> {
  const path = join(workspaceRoot, INSTRUCTIONS_FILE);

  try {
    const fileStat = await stat(path);

    if (!fileStat.isFile()) {
      return {
        path,
        exists: false,
        content: "",
        warnings: [`${INSTRUCTIONS_FILE} exists but is not a file.`],
      };
    }

    if (fileStat.size > MAX_INSTRUCTIONS_BYTES) {
      return {
        path,
        exists: true,
        content: "",
        bytes: fileStat.size,
        warnings: [
          `${INSTRUCTIONS_FILE} is too large (${fileStat.size} bytes, max ${MAX_INSTRUCTIONS_BYTES}).`,
        ],
      };
    }

    const content = (await readFile(path, "utf8")).trimEnd();

    return {
      path,
      exists: true,
      content,
      bytes: fileStat.size,
      warnings: content.trim().length === 0 ? [`${INSTRUCTIONS_FILE} is empty.`] : [],
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        path,
        exists: false,
        content: "",
        warnings: [],
      };
    }

    const reason = error instanceof Error ? error.message : String(error);

    return {
      path,
      exists: false,
      content: "",
      warnings: [`Failed to load ${INSTRUCTIONS_FILE}: ${reason}`],
    };
  }
}

export function formatProjectInstructions(loaded: LoadedProjectInstructions): string {
  const lines = [
    "Project instructions",
    `Path: ${loaded.path}`,
    `Loaded: ${loaded.exists ? "yes" : "no"}`,
  ];

  if (loaded.bytes !== undefined) {
    lines.push(`Bytes: ${loaded.bytes}`);
  }

  if (loaded.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    lines.push(...loaded.warnings.map((warning) => `- ${warning}`));
  }

  if (!loaded.exists) {
    lines.push("");
    lines.push(`No ${INSTRUCTIONS_FILE} found. Create it in the workspace root to add project-specific guidance.`);
    return lines.join("\n");
  }

  if (loaded.content.trim().length === 0) {
    lines.push("");
    lines.push("(No instruction content loaded.)");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Content:");
  lines.push("");
  lines.push(loaded.content);

  return lines.join("\n");
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
