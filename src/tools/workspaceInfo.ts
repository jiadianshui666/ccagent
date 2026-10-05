import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { shouldExcludeWorkspaceEntry } from "./listFiles.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_DISPLAY_ENTRIES = 30;

export class WorkspaceInfoTool implements Tool {
  readonly name = "workspace_info";
  readonly description = "Summarize the current workspace without reading file contents.";
  readonly parameters = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (Object.keys(input).length > 0) {
      return {
        ok: false,
        error: "workspace_info does not accept input parameters.",
      };
    }

    const workspaceRoot = resolve(context.workspaceRoot);
    const displayRoot = ".";

    try {
      const workspaceStat = await stat(workspaceRoot);

      if (!workspaceStat.isDirectory()) {
        return {
          ok: false,
          error: "Workspace root is not a directory.",
        };
      }
    } catch {
      return {
        ok: false,
        error: "Workspace root was not found.",
      };
    }

    const entries = (await readdir(workspaceRoot, { withFileTypes: true }))
      .filter((entry) => !shouldExcludeWorkspaceEntry(workspaceRoot, workspaceRoot, entry.name))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });
    const directoryCount = entries.filter((entry) => entry.isDirectory()).length;
    const fileCount = entries.filter((entry) => entry.isFile()).length;
    const otherCount = entries.length - directoryCount - fileCount;
    const markers = {
      git: await pathExists(join(workspaceRoot, ".git")),
      ccagentConfig: await pathExists(join(workspaceRoot, ".ccagent", "config.json")),
      packageJson: await pathExists(join(workspaceRoot, "package.json")),
      projectInstructions: await pathExists(join(workspaceRoot, "CCAGENT.md")),
    };
    const displayEntries = entries.slice(0, MAX_DISPLAY_ENTRIES);
    const truncated = entries.length > displayEntries.length;

    return {
      ok: true,
      content: formatWorkspaceInfo({
        directoryCount,
        displayEntries: displayEntries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`),
        fileCount,
        markers,
        otherCount,
        root: displayRoot,
        topLevelCount: entries.length,
        truncated,
      }),
      metadata: {
        directoryCount,
        fileCount,
        git: markers.git,
        ccagentConfig: markers.ccagentConfig,
        packageJson: markers.packageJson,
        projectInstructions: markers.projectInstructions,
        root: displayRoot,
        topLevelCount: entries.length,
        truncated,
      },
    };
  }
}

type WorkspaceInfoFormatInput = {
  directoryCount: number;
  displayEntries: string[];
  fileCount: number;
  markers: {
    git: boolean;
    ccagentConfig: boolean;
    packageJson: boolean;
    projectInstructions: boolean;
  };
  otherCount: number;
  root: string;
  topLevelCount: number;
  truncated: boolean;
};

function formatWorkspaceInfo(input: WorkspaceInfoFormatInput): string {
  const lines = [
    "Workspace info",
    `Root: ${input.root}`,
    `Top-level entries: ${input.topLevelCount}`,
    `Directories: ${input.directoryCount}`,
    `Files: ${input.fileCount}`,
    `Other entries: ${input.otherCount}`,
    "",
    "Project markers:",
    `- package.json: ${formatYesNo(input.markers.packageJson)}`,
    `- .git/: ${formatYesNo(input.markers.git)}`,
    `- CCAGENT.md: ${formatYesNo(input.markers.projectInstructions)}`,
    `- .ccagent/config.json: ${formatYesNo(input.markers.ccagentConfig)}`,
    "",
    "Top-level visible entries:",
  ];

  if (input.displayEntries.length === 0) {
    lines.push("- (none)");
  } else {
    lines.push(...input.displayEntries.map((entry) => `- ${entry}`));
  }

  if (input.truncated) {
    lines.push("...[truncated]");
  }

  return lines.join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatYesNo(value: boolean): string {
  return value ? "yes" : "no";
}
