import { ApplyPatchTool, ReversePatchTool } from "./applyPatch.js";
import {
  BuildContextIndexTool,
  ContextIndexStatusTool,
  SearchContextIndexTool,
} from "./contextIndex.js";
import { EditTool } from "./edit.js";
import { RunSubagentTool } from "./runSubagent.js";
import { RunSubagentsTool } from "./runSubagents.js";
import { GitDiffTool } from "./gitDiff.js";
import { GitStatusTool } from "./gitStatus.js";
import { ListFilesTool } from "./listFiles.js";
import {
  ListPatchSnapshotsTool,
  PatchSnapshotHistoryTool,
  RestorePatchSnapshotTool,
  ShowPatchSnapshotTool,
} from "./patchSnapshots.js";
import { WorkspaceInfoTool } from "./workspaceInfo.js";
import { ReadFileTool } from "./readFile.js";
import { RunShellTool } from "./runShell.js";
import { SearchFilesTool } from "./searchFiles.js";
import { ListSkillsTool, ReadSkillTool } from "./skills.js";
import {
  BuildSemanticIndexTool,
  SearchSemanticIndexTool,
  SemanticIndexStatusTool,
} from "./semanticIndex.js";
import { SuggestContextTool } from "./suggestContext.js";
import { ListSymbolsTool, SearchSymbolsTool } from "./symbols.js";
import { UpdateTaskStateTool } from "./taskState.js";
import { UpdatePlanTool } from "./updatePlan.js";
import { SuggestVerificationTool } from "./verifySuggest.js";
import type { ShellSandboxSettings } from "../sandbox.js";
import type { ExecutionGuardLevel } from "../injectionGuard.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    this.replace(tools);
  }

  replace(tools: Tool[]): void {
    this.tools.clear();

    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool: ${name}`,
      };
    }

    try {
      return await tool.execute(input, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        error: `Tool crashed: ${reason}`,
      };
    }
  }
}

export type DefaultToolRegistryOptions = {
  executionGuard?: ExecutionGuardLevel;
  shellSandbox?: ShellSandboxSettings;
  shellCommandTimeoutMs?: number;
};

export function createDefaultToolRegistry(
  options: DefaultToolRegistryOptions = {},
  additionalTools: Tool[] = [],
): ToolRegistry {
  return new ToolRegistry([
    new ListFilesTool(),
    new WorkspaceInfoTool(),
    new ListPatchSnapshotsTool(),
    new PatchSnapshotHistoryTool(),
    new ShowPatchSnapshotTool(),
    new ReadFileTool(),
    new SearchFilesTool(),
    new SuggestContextTool(),
    new ListSkillsTool(),
    new ReadSkillTool(),
    new BuildContextIndexTool(),
    new ContextIndexStatusTool(),
    new SearchContextIndexTool(),
    new BuildSemanticIndexTool(),
    new SemanticIndexStatusTool(),
    new SearchSemanticIndexTool(),
    new ListSymbolsTool(),
    new SearchSymbolsTool(),
    new SuggestVerificationTool(),
    new RunShellTool({
      executionGuard: options.executionGuard,
      sandbox: options.shellSandbox,
      timeoutMs: options.shellCommandTimeoutMs,
    }),
    new ApplyPatchTool(),
    new ReversePatchTool(),
    new EditTool(),
    new RunSubagentTool(),
    new RunSubagentsTool(),
    new RestorePatchSnapshotTool(),
    new GitStatusTool(),
    new GitDiffTool(),
    new UpdatePlanTool(),
    new UpdateTaskStateTool(),
    ...additionalTools,
  ]);
}
