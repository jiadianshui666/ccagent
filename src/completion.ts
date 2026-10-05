import { readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ARCHITECTURE_TOPIC_NAMES } from "./architecture.js";
import { getHelpTopicNames } from "./help.js";
import { shouldExcludeWorkspaceEntry } from "./tools/listFiles.js";

export type InteractiveCompletionProjectCommand = {
  aliases?: string[];
  name: string;
  tags?: string[];
};

export type InteractiveCompletionContext = {
  checkpointNames?: string[];
  projectCommands?: InteractiveCompletionProjectCommand[];
  skillNames?: string[];
  toolNames?: string[];
  workspaceRoot?: string;
};

export type InteractiveCompletionResult = [matches: string[], completed: string];

type CompletionCandidate = {
  appendSpace?: boolean;
  text: string;
};

const SLASH_COMMAND_CANDIDATES: CompletionCandidate[] = [
  { text: "/help" },
  { text: "/hello" },
  { text: "/completion" },
  { text: "/keys" },
  { text: "/architecture" },
  { text: "/arch" },
  { text: "/flow" },
  { text: "/config" },
  { text: "/skills" },
  { text: "/skill", appendSpace: true },
  { text: "/mcp" },
  { text: "/mcp --json", appendSpace: true },
  { text: "/mcp prompt", appendSpace: true },
  { text: "/mcp prompts" },
  { text: "/mcp prompts --json", appendSpace: true },
  { text: "/mcp read", appendSpace: true },
  { text: "/mcp reload" },
  { text: "/mcp reload --json", appendSpace: true },
  { text: "/mcp resources" },
  { text: "/mcp resources --json", appendSpace: true },
  { text: "/mcp status" },
  { text: "/mcp status --json", appendSpace: true },
  { text: "/mcp templates" },
  { text: "/mcp templates --json", appendSpace: true },
  { text: "/mcp tools" },
  { text: "/mcp tools --json", appendSpace: true },
  { text: "/context" },
  { text: "/code-map" },
  { text: "/code-map export" },
  { text: "/codemap" },
  { text: "/codemap export" },
  { text: "/doctor" },
  { text: "/diagnostics" },
  { text: "/diagnostics export" },
  { text: "/evals" },
  { text: "/evals --json", appendSpace: true },
  { text: "/evals benchmark", appendSpace: true },
  { text: "/evals benchmark --iterations 1", appendSpace: true },
  { text: "/evals benchmark --json", appendSpace: true },
  { text: "/evals benchmark --tag repair", appendSpace: true },
  { text: "/evals benchmark --tag retrieval", appendSpace: true },
  { text: "/evals case", appendSpace: true },
  { text: "/evals case context_graph_retrieval", appendSpace: true },
  { text: "/evals case list_files", appendSpace: true },
  { text: "/evals case missing_text_recovery", appendSpace: true },
  { text: "/evals case plan_update", appendSpace: true },
  { text: "/evals case read_file", appendSpace: true },
  { text: "/evals case replace_file", appendSpace: true },
  { text: "/evals case repair_loop", appendSpace: true },
  { text: "/evals case repair_loop_multifile", appendSpace: true },
  { text: "/evals case task_replace_file", appendSpace: true },
  { text: "/evals case verification_failure_strategies", appendSpace: true },
  { text: "/evals case workspace_info", appendSpace: true },
  { text: "/evals cases", appendSpace: true },
  { text: "/evals cases --json", appendSpace: true },
  { text: "/evals cases --tag repair", appendSpace: true },
  { text: "/evals cases --tag retrieval", appendSpace: true },
  { text: "/evals cases --tag verification", appendSpace: true },
  { text: "/evals cases benchmark", appendSpace: true },
  { text: "/evals cases benchmark --json", appendSpace: true },
  { text: "/evals cases regression", appendSpace: true },
  { text: "/evals cases regression --json", appendSpace: true },
  { text: "/evals cases regression --tag repair", appendSpace: true },
  { text: "/evals cases regression --tag retrieval", appendSpace: true },
  { text: "/evals cases regression --tag verification", appendSpace: true },
  { text: "/evals cases smoke", appendSpace: true },
  { text: "/evals cases smoke --json", appendSpace: true },
  { text: "/evals gate", appendSpace: true },
  { text: "/evals gate --json", appendSpace: true },
  { text: "/evals gate --max-duration-delta 100", appendSpace: true },
  { text: "/evals report", appendSpace: true },
  { text: "/evals report --json", appendSpace: true },
  { text: "/evals report benchmark", appendSpace: true },
  { text: "/evals report benchmark --iterations 1", appendSpace: true },
  { text: "/evals report benchmark --json", appendSpace: true },
  { text: "/evals report regression", appendSpace: true },
  { text: "/evals report regression --json", appendSpace: true },
  { text: "/evals report smoke", appendSpace: true },
  { text: "/evals report smoke --json", appendSpace: true },
  { text: "/evals reports", appendSpace: true },
  { text: "/evals reports --json", appendSpace: true },
  { text: "/evals reports 10", appendSpace: true },
  { text: "/evals compare", appendSpace: true },
  { text: "/evals compare --json", appendSpace: true },
  { text: "/evals compare --max-duration-delta 100", appendSpace: true },
  { text: "/evals regression", appendSpace: true },
  { text: "/evals regression --json", appendSpace: true },
  { text: "/evals regression --tag repair", appendSpace: true },
  { text: "/evals regression --tag retrieval", appendSpace: true },
  { text: "/evals regression --tag verification", appendSpace: true },
  { text: "/evals run", appendSpace: true },
  { text: "/evals run --json", appendSpace: true },
  { text: "/evals run --tag retrieval", appendSpace: true },
  { text: "/evals run --tag tool", appendSpace: true },
  { text: "/evals smoke", appendSpace: true },
  { text: "/evals smoke --json", appendSpace: true },
  { text: "/evals smoke --tag tool", appendSpace: true },
  { text: "/evals tags", appendSpace: true },
  { text: "/evals tags --json", appendSpace: true },
  { text: "/evals tags benchmark", appendSpace: true },
  { text: "/evals tags benchmark --json", appendSpace: true },
  { text: "/evals tags regression", appendSpace: true },
  { text: "/evals tags regression --json", appendSpace: true },
  { text: "/evals tags smoke", appendSpace: true },
  { text: "/evals tags smoke --json", appendSpace: true },
  { text: "/audit", appendSpace: true },
  { text: "/audit --all", appendSpace: true },
  { text: "/audit --jsonl", appendSpace: true },
  { text: "/audit-replay", appendSpace: true },
  { text: "/audit-timeline", appendSpace: true },
  { text: "/model" },
  { text: "/model-smoke", appendSpace: true },
  { text: "/model-smoke --stream", appendSpace: true },
  { text: "/model-smoke --tool", appendSpace: true },
  { text: "/models" },
  { text: "/provider-compare", appendSpace: true },
  { text: "/provider-compare --json", appendSpace: true },
  { text: "/provider-gate", appendSpace: true },
  { text: "/provider-gate --json", appendSpace: true },
  { text: "/provider-matrix" },
  { text: "/provider-reports", appendSpace: true },
  { text: "/provider-reports --json", appendSpace: true },
  { text: "/provider-reports 10", appendSpace: true },
  { text: "/provider-smoke", appendSpace: true },
  { text: "/provider-smoke --full", appendSpace: true },
  { text: "/provider-smoke --full --save", appendSpace: true },
  { text: "/provider-smoke --json", appendSpace: true },
  { text: "/provider-smoke --json --save", appendSpace: true },
  { text: "/provider-smoke --profile full", appendSpace: true },
  { text: "/provider-smoke --profile full --save", appendSpace: true },
  { text: "/provider-smoke --profile quick", appendSpace: true },
  { text: "/provider-smoke --save", appendSpace: true },
  { text: "/providers" },
  { text: "/model-trace", appendSpace: true },
  { text: "/usage-summary" },
  { text: "/usage-summary --all" },
  { text: "/usage-models" },
  { text: "/usage-models --all" },
  { text: "/audit-call", appendSpace: true },
  { text: "/audit-summary" },
  { text: "/audit-summary --all" },
  { text: "/audit-export summary" },
  { text: "/audit-export summary --all" },
  { text: "/audit-export call", appendSpace: true },
  { text: "/audit-export call --all", appendSpace: true },
  { text: "/audit-report" },
  { text: "/audit-report --all" },
  { text: "/command-history", appendSpace: true },
  { text: "/command-history --all", appendSpace: true },
  { text: "/command-stats" },
  { text: "/command-stats --all" },
  { text: "/permissions" },
  { text: "/instructions" },
  { text: "/roadmap" },
  { text: "/prompt" },
  { text: "/session" },
  { text: "/session show" },
  { text: "/session show --limit", appendSpace: true },
  { text: "/session stats" },
  { text: "/session search", appendSpace: true },
  { text: "/checkpoint" },
  { text: "/checkpoint list" },
  { text: "/checkpoint backups" },
  { text: "/checkpoint save", appendSpace: true },
  { text: "/checkpoint show", appendSpace: true },
  { text: "/checkpoint stats", appendSpace: true },
  { text: "/checkpoint search", appendSpace: true },
  { text: "/checkpoint diff", appendSpace: true },
  { text: "/checkpoint diff-current", appendSpace: true },
  { text: "/checkpoint load", appendSpace: true },
  { text: "/checkpoint delete", appendSpace: true },
  { text: "/plan" },
  { text: "/plan add", appendSpace: true },
  { text: "/plan start", appendSpace: true },
  { text: "/plan done", appendSpace: true },
  { text: "/plan pending", appendSpace: true },
  { text: "/plan drop", appendSpace: true },
  { text: "/plan clear" },
  { text: "/task-state" },
  { text: "/task-state resume" },
  { text: "/task-state prompt" },
  { text: "/task-state set", appendSpace: true },
  { text: "/task-state status", appendSpace: true },
  { text: "/task-state step", appendSpace: true },
  { text: "/task-state note", appendSpace: true },
  { text: "/task-state files", appendSpace: true },
  { text: "/task-state files --mode=merge", appendSpace: true },
  { text: "/task-state files --mode=clear" },
  { text: "/task-state clear" },
  { text: "/history", appendSpace: true },
  { text: "/history --all" },
  { text: "/index" },
  { text: "/index build" },
  { text: "/index eval" },
  { text: "/index eval init" },
  { text: "/index eval run" },
  { text: "/index eval run --json" },
  { text: "/index eval status" },
  { text: "/index search", appendSpace: true },
  { text: "/index semantic" },
  { text: "/index semantic build" },
  { text: "/index semantic search", appendSpace: true },
  { text: "/index semantic status" },
  { text: "/index status" },
  { text: "/input-history" },
  { text: "/input-history clear" },
  { text: "/compact" },
  { text: "/compact-status" },
  { text: "/clear" },
  { text: "/tools" },
  { text: "/tools --verbose" },
  { text: "/tool", appendSpace: true },
  { text: "/commands", appendSpace: true },
  { text: "/commands --check" },
  { text: "/command", appendSpace: true },
  { text: "/cmd-preview", appendSpace: true },
  { text: "/cmd", appendSpace: true },
  { text: "/undo" },
  { text: "/snapshots" },
  { text: "/snapshots history", appendSpace: true },
  { text: "/snapshots list", appendSpace: true },
  { text: "/snapshots show", appendSpace: true },
  { text: "/snapshots restore", appendSpace: true },
  { text: "/ls", appendSpace: true },
  { text: "/tree", appendSpace: true },
  { text: "/read", appendSpace: true },
  { text: "/search", appendSpace: true },
  { text: "/suggest-context", appendSpace: true },
  { text: "/symbols" },
  { text: "/symbols list", appendSpace: true },
  { text: "/symbols search", appendSpace: true },
  { text: "/repair-last" },
  { text: "/repair-loop", appendSpace: true },
  { text: "/repair-preview" },
  { text: "/repair-run" },
  { text: "/verify-clear" },
  { text: "/verify-failure" },
  { text: "/verify-last" },
  { text: "/verify-rerun" },
  { text: "/verify-run", appendSpace: true },
  { text: "/verify-stability", appendSpace: true },
  { text: "/verify-suggest", appendSpace: true },
  { text: "/status" },
  { text: "/diff" },
  { text: "/run", appendSpace: true },
  { text: "/apply_patch_file", appendSpace: true },
];

const SLASH_HINT_CANDIDATES: string[] = (() => {
  const values = new Set<string>();

  for (const candidate of SLASH_COMMAND_CANDIDATES) {
    values.add(candidate.text);
    values.add(candidate.text.split(" ", 1)[0] ?? "");
  }

  values.delete("");

  return [...values].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
})();

export function completeSlashCommandHints(line: string, limit = 12): string[] {
  const prefix = line.trimStart();

  if (!prefix.startsWith("/")) {
    return [];
  }

  return SLASH_HINT_CANDIDATES
    .filter((candidate) => candidate.startsWith(prefix) && candidate !== prefix)
    .slice(0, limit);
}

const TOOL_NAME_CANDIDATES = [
  "apply_patch",
  "build_context_index",
  "context_index_status",
  "git_diff",
  "git_status",
  "list_files",
  "list_patch_snapshots",
  "list_skills",
  "list_symbols",
  "patch_snapshot_history",
  "read_file",
  "read_skill",
  "restore_patch_snapshot",
  "reverse_patch",
  "run_shell",
  "search_files",
  "search_context_index",
  "search_semantic_index",
  "search_symbols",
  "semantic_index_status",
  "show_patch_snapshot",
  "suggest_context",
  "suggest_verification",
  "update_plan",
  "update_task_state",
  "workspace_info",
  "build_semantic_index",
];

const PATH_COMPLETION_COMMANDS = [
  { directoriesOnly: false, prefix: "/read " },
  { directoriesOnly: false, prefix: "/apply_patch_file " },
  { directoriesOnly: true, prefix: "/ls " },
  { directoriesOnly: true, prefix: "/tree " },
] as const;

export async function completeInteractiveInputWithWorkspace(
  line: string,
  context: InteractiveCompletionContext = {},
): Promise<InteractiveCompletionResult> {
  const pathCompletion = await completeWorkspacePathCommand(line, context);

  if (pathCompletion) {
    return pathCompletion;
  }

  return completeInteractiveInput(line, context);
}

export function completeInteractiveInput(
  line: string,
  context: InteractiveCompletionContext = {},
): InteractiveCompletionResult {
  if (!line.startsWith("/")) {
    return [[], line];
  }

  const helpTopicMatches = completeHelpTopic(line);

  if (helpTopicMatches) {
    return helpTopicMatches;
  }

  const architectureTopicMatches = completeArchitectureTopic(line);

  if (architectureTopicMatches) {
    return architectureTopicMatches;
  }

  const checkpointShowLimitMatches = completeCheckpointShowLimit(line);

  if (checkpointShowLimitMatches) {
    return checkpointShowLimitMatches;
  }

  const checkpointNameMatches = completeCheckpointName(line, context.checkpointNames ?? []);

  if (checkpointNameMatches) {
    return checkpointNameMatches;
  }

  const matches = uniqueSortedCandidates(buildCandidates(context))
    .map(formatCandidate)
    .filter((candidate) => candidate.startsWith(line) && candidate !== line);

  return [matches, line];
}

function completeCheckpointName(
  line: string,
  checkpointNames: string[],
): InteractiveCompletionResult | null {
  if (checkpointNames.length === 0 || !line.startsWith("/checkpoint ")) {
    return null;
  }

  const parts = line.split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(line);
  const sortedNames = uniqueStrings(checkpointNames).sort((left, right) => left.localeCompare(right));
  const action = parts[1] ?? "";

  if (["show", "stats", "search", "load", "delete", "diff-current"].includes(action)) {
    if (!((endsWithSpace && parts.length === 2) || (!endsWithSpace && parts.length === 3))) {
      return null;
    }

    const prefix = `/checkpoint ${action} `;

    return [
      sortedNames
        .map((name) => `${prefix}${name}${action === "search" ? " " : ""}`)
        .filter((candidate) => candidate.startsWith(line) && candidate !== line),
      line,
    ];
  }

  if (action === "diff") {
    if ((endsWithSpace && parts.length === 2) || (!endsWithSpace && parts.length === 3)) {
      const prefix = "/checkpoint diff ";

      return [
        sortedNames
          .map((name) => `${prefix}${name} `)
          .filter((candidate) => candidate.startsWith(line) && candidate !== line),
        line,
      ];
    }

    if ((endsWithSpace && parts.length === 3) || (!endsWithSpace && parts.length === 4)) {
      const leftName = parts[2] ?? "";
      const prefix = `/checkpoint diff ${leftName} `;

      return [
        sortedNames
          .map((name) => `${prefix}${name}`)
          .filter((candidate) => candidate.startsWith(line) && candidate !== line),
        line,
      ];
    }
  }

  return null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function completeCheckpointShowLimit(line: string): InteractiveCompletionResult | null {
  const parts = line.split(/\s+/).filter(Boolean);

  if (parts.length !== 4 || parts[0] !== "/checkpoint" || parts[1] !== "show") {
    return null;
  }

  const [,, name = "", option = ""] = parts;

  if (!option.startsWith("--l")) {
    return null;
  }

  const candidate = `/checkpoint show ${name} --limit `;

  return [candidate.startsWith(line) && candidate !== line ? [candidate] : [], line];
}

function completeHelpTopic(line: string): InteractiveCompletionResult | null {
  if (!line.startsWith("/help ")) {
    return null;
  }

  const matches = getHelpTopicNames()
    .map((topic) => `/help ${topic}`)
    .filter((candidate) => candidate.startsWith(line) && candidate !== line);

  return [matches, line];
}

function completeArchitectureTopic(line: string): InteractiveCompletionResult | null {
  const commands = ["/architecture", "/arch", "/flow"];
  const baseMatches = commands
    .filter((command) => command.startsWith(line) && command !== line)
    .sort((left, right) => left.localeCompare(right));

  if (baseMatches.length > 0 && !line.includes(" ")) {
    return [baseMatches, line];
  }

  for (const command of commands) {
    const prefix = `${command} `;

    if (!line.startsWith(prefix)) {
      continue;
    }

    const partialTopic = line.slice(prefix.length);

    if (partialTopic.includes(" ")) {
      return [[], line];
    }

    const matches = [...ARCHITECTURE_TOPIC_NAMES]
      .sort((left, right) => left.localeCompare(right))
      .map((topic) => `${prefix}${topic} `)
      .filter((candidate) => candidate.startsWith(line) && candidate !== line);

    return [matches, line];
  }

  return null;
}

async function completeWorkspacePathCommand(
  line: string,
  context: InteractiveCompletionContext,
): Promise<InteractiveCompletionResult | null> {
  if (!context.workspaceRoot) {
    return null;
  }

  const command = PATH_COMPLETION_COMMANDS.find((item) => line.startsWith(item.prefix));

  if (!command) {
    return null;
  }

  const partialPath = line.slice(command.prefix.length);

  if (partialPath.trim() !== partialPath || /\s/.test(partialPath)) {
    return null;
  }

  const matches = await completeWorkspacePath(context.workspaceRoot, partialPath, {
    directoriesOnly: command.directoriesOnly,
  });

  return [matches.map((match) => `${command.prefix}${match}`), line];
}

async function completeWorkspacePath(
  workspaceRoot: string,
  partialPath: string,
  options: { directoriesOnly: boolean },
): Promise<string[]> {
  const normalizedPartialPath = partialPath.replaceAll("\\", "/");

  if (isAbsolute(normalizedPartialPath) || normalizedPartialPath === ".." || normalizedPartialPath.startsWith("../")) {
    return [];
  }

  const slashIndex = normalizedPartialPath.lastIndexOf("/");
  const directoryPrefix = slashIndex >= 0 ? normalizedPartialPath.slice(0, slashIndex + 1) : "";
  const entryPrefix = slashIndex >= 0 ? normalizedPartialPath.slice(slashIndex + 1) : normalizedPartialPath;
  const lookupDirectory = directoryPrefix || ".";
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const resolvedDirectory = resolve(resolvedWorkspaceRoot, lookupDirectory);

  if (!isInsideWorkspace(resolvedWorkspaceRoot, resolvedDirectory)) {
    return [];
  }

  try {
    const directoryStat = await stat(resolvedDirectory);

    if (!directoryStat.isDirectory()) {
      return [];
    }

    const entries = await readdir(resolvedDirectory, { withFileTypes: true });
    const normalizedEntryPrefix = entryPrefix.toLowerCase();

    return entries
      .filter((entry) => !shouldExcludeWorkspaceEntry(resolvedWorkspaceRoot, resolvedDirectory, entry.name))
      .filter((entry) => !options.directoriesOnly || entry.isDirectory())
      .filter((entry) => entry.name.toLowerCase().startsWith(normalizedEntryPrefix))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      })
      .map((entry) => `${directoryPrefix}${entry.name}${entry.isDirectory() ? "/" : " "}`);
  } catch {
    return [];
  }
}

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relativePath = relative(workspaceRoot, targetPath);

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function buildCandidates(context: InteractiveCompletionContext): CompletionCandidate[] {
  return [
    ...SLASH_COMMAND_CANDIDATES,
    ...buildToolCandidates(context.toolNames ?? []),
    ...buildSkillCandidates(context.skillNames ?? []),
    ...buildProjectCommandCandidates(context.projectCommands ?? []),
  ];
}

function buildToolCandidates(additionalToolNames: string[]): CompletionCandidate[] {
  return uniqueStrings([...TOOL_NAME_CANDIDATES, ...additionalToolNames]).map((name) => ({
    text: `/tool ${name}`,
  }));
}

function buildSkillCandidates(skillNames: string[]): CompletionCandidate[] {
  return uniqueStrings(skillNames).map((name) => ({
    text: `/skill ${name}`,
  }));
}

function buildProjectCommandCandidates(
  commands: InteractiveCompletionProjectCommand[],
): CompletionCandidate[] {
  const candidates: CompletionCandidate[] = [];

  for (const command of commands) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      candidates.push(
        { text: `/command ${name}` },
        { text: `/cmd-preview ${name}`, appendSpace: true },
        { text: `/cmd ${name}`, appendSpace: true },
      );
    }

    candidates.push({ text: `/command-history ${command.name}`, appendSpace: true });

    for (const tag of command.tags ?? []) {
      candidates.push({ text: `/commands ${tag}` });
    }
  }

  return candidates;
}

function uniqueSortedCandidates(candidates: CompletionCandidate[]): CompletionCandidate[] {
  const seen = new Set<string>();
  const unique: CompletionCandidate[] = [];

  for (const candidate of candidates) {
    const formatted = formatCandidate(candidate);

    if (seen.has(formatted)) {
      continue;
    }

    seen.add(formatted);
    unique.push(candidate);
  }

  return unique.sort((left, right) => formatCandidate(left).localeCompare(formatCandidate(right)));
}

function formatCandidate(candidate: CompletionCandidate): string {
  if (!candidate.appendSpace || candidate.text.endsWith(" ")) {
    return candidate.text;
  }

  return `${candidate.text} `;
}
