import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_STATUS_BYTES = 128 * 1024;

type PackageScripts = Record<string, string>;

type VerificationSuggestion = {
  command: string;
  reason: string;
};

type ChangedPathSource = "git" | "input" | "none";

export class SuggestVerificationTool implements Tool {
  readonly name = "suggest_verification";
  readonly description = "Suggest verification commands based on changed files and package scripts.";
  readonly parameters = {
    type: "object",
    properties: {
      paths: {
        type: "array",
        description: "Changed workspace paths. Use an empty array to infer paths from git status.",
        items: {
          type: "string",
        },
      },
    },
    required: ["paths"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!Array.isArray(input.paths) || !input.paths.every((path) => typeof path === "string")) {
      return {
        ok: false,
        error: "Expected input.paths to be an array of strings.",
      };
    }

    const workspaceRoot = resolve(context.workspaceRoot);
    const explicitPaths = normalizeWorkspacePaths(input.paths);
    const packageScripts = await readPackageScripts(workspaceRoot);
    const changed = explicitPaths.length > 0
      ? { paths: explicitPaths, source: "input" as const }
      : await inferChangedPaths(workspaceRoot);
    const suggestions = await buildVerificationSuggestions(workspaceRoot, changed.paths, packageScripts);

    return {
      ok: true,
      content: formatVerificationSuggestions(suggestions, {
        changedPaths: changed.paths,
        packageScripts,
        source: changed.source,
      }),
      metadata: {
        changedPathCount: changed.paths.length,
        commandCount: suggestions.length,
        commands: suggestions.map((suggestion) => suggestion.command),
        suggestions: suggestions.map((suggestion) => ({
          command: suggestion.command,
          reason: suggestion.reason,
        })),
        source: changed.source,
      },
    };
  }
}

async function buildVerificationSuggestions(
  workspaceRoot: string,
  changedPaths: string[],
  scripts: PackageScripts,
): Promise<VerificationSuggestion[]> {
  const suggestions: VerificationSuggestion[] = [];
  const sourceLike = changedPaths.some(isSourceLikePath);
  const testLike = changedPaths.some(isTestLikePath);
  const packageLike = changedPaths.some(isPackageLikePath);
  const broad = changedPaths.length === 0 || changedPaths.some(isBroadImpactPath);

  if (scriptExists(scripts, "build") && (changedPaths.length === 0 || sourceLike || packageLike)) {
    suggestions.push({
      command: "npm run build",
      reason: changedPaths.length === 0
        ? "baseline build check is available"
        : "source, TypeScript config, or package metadata changed",
    });
  }

  if (scriptExists(scripts, "typecheck") && (changedPaths.length === 0 || changedPaths.some(isTypeScriptPath))) {
    suggestions.push({
      command: "npm run typecheck",
      reason: changedPaths.length === 0
        ? "baseline typecheck is available"
        : "TypeScript files changed",
    });
  }

  for (const command of await findFocusedTestCommands(workspaceRoot, changedPaths)) {
    suggestions.push(command);
  }

  if (scriptExists(scripts, "test") && (changedPaths.length === 0 || testLike || broad)) {
    suggestions.push({
      command: "npm test",
      reason: changedPaths.length === 0
        ? "baseline full test suite is available"
        : broad
          ? "core agent, CLI, model, config, or package behavior changed"
          : "test files changed",
    });
  }

  if (scriptExists(scripts, "evals:smoke") && changedPaths.some(affectsAgentLoop)) {
    suggestions.push({
      command: "npm run evals:smoke",
      reason: "agent loop, model, tool, or eval behavior changed",
    });
  }

  if (scriptExists(scripts, "release:check") && (packageLike || changedPaths.some(isReleasePath))) {
    suggestions.push({
      command: "npm run release:check",
      reason: "packaging, README, release script, or CLI entrypoint changed",
    });
  }

  return uniqueSuggestions(suggestions);
}

async function findFocusedTestCommands(
  workspaceRoot: string,
  changedPaths: string[],
): Promise<VerificationSuggestion[]> {
  const suggestions: VerificationSuggestion[] = [];
  const candidates = new Set<string>();

  for (const path of changedPaths) {
    if (isTestLikePath(path)) {
      candidates.add(path);
      continue;
    }

    for (const candidate of mapSourcePathToTests(path)) {
      candidates.add(candidate);
    }
  }

  for (const candidate of [...candidates].sort((left, right) => left.localeCompare(right))) {
    if (!(await pathExists(resolve(workspaceRoot, candidate)))) {
      continue;
    }

    suggestions.push({
      command: `node --import tsx --test ${candidate}`,
      reason: `focused test for ${candidate}`,
    });
  }

  return suggestions.slice(0, 5);
}

function mapSourcePathToTests(path: string): string[] {
  const normalized = normalizeWorkspacePath(path);
  const exact = new Map<string, string[]>([
    ["src/agent.ts", ["tests/editing.test.ts", "tests/streaming.test.ts"]],
    ["src/args.ts", ["tests/args.test.ts"]],
    ["src/cli.ts", ["tests/cli.test.ts"]],
    ["src/codeMap.ts", ["tests/codeMap.test.ts"]],
    ["src/commands.ts", ["tests/commands.test.ts"]],
    ["src/completion.ts", ["tests/completion.test.ts"]],
    ["src/config.ts", ["tests/config.test.ts"]],
    ["src/conversation.ts", ["tests/conversation.test.ts"]],
    ["src/diagnostics.ts", ["tests/diagnostics.test.ts"]],
    ["src/doctor.ts", ["tests/doctor.test.ts"]],
    ["src/evals.ts", ["tests/evals.test.ts"]],
    ["src/help.ts", ["tests/help.test.ts"]],
    ["src/instructions.ts", ["tests/instructions.test.ts"]],
    ["src/model.ts", ["tests/model.test.ts"]],
    ["src/pathPolicy.ts", ["tests/pathPolicy.test.ts"]],
    ["src/plan.ts", ["tests/plan.test.ts"]],
    ["src/preflight.ts", ["tests/preflight.test.ts"]],
    ["src/prompt.ts", ["tests/prompt.test.ts"]],
    ["src/renderer.ts", ["tests/renderer.test.ts"]],
    ["src/session.ts", ["tests/session.test.ts"]],
    ["src/terminalHistory.ts", ["tests/terminalHistory.test.ts"]],
  ]);

  if (exact.has(normalized)) {
    return exact.get(normalized) ?? [];
  }

  if (normalized.startsWith("src/tools/")) {
    return ["tests/tools.test.ts"];
  }

  return [];
}

async function inferChangedPaths(workspaceRoot: string): Promise<{ paths: string[]; source: ChangedPathSource }> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: workspaceRoot,
      maxBuffer: MAX_GIT_STATUS_BYTES,
      windowsHide: true,
    });
    const paths = parseGitStatusPaths(stdout);

    if (paths.length === 0) {
      return { paths, source: "none" };
    }

    return { paths, source: "git" };
  } catch {
    return { paths: [], source: "none" };
  }
}

function parseGitStatusPaths(output: string): string[] {
  const paths: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) {
      continue;
    }

    const rawPath = line.slice(3).trim();
    const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
    const normalized = normalizeWorkspacePath(renamedPath);

    if (normalized.length > 0) {
      paths.push(normalized);
    }
  }

  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function readPackageScripts(workspaceRoot: string): Promise<PackageScripts> {
  try {
    const raw = await readFile(join(workspaceRoot, "package.json"), "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const scripts = (parsed as Record<string, unknown>).scripts;

    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function stripUtf8Bom(value: string): string {
  return value.startsWith("\uFEFF") ? value.slice(1) : value;
}

function formatVerificationSuggestions(
  suggestions: VerificationSuggestion[],
  input: {
    changedPaths: string[];
    packageScripts: PackageScripts;
    source: ChangedPathSource;
  },
): string {
  const lines = [
    "Verification suggestions",
    `Changed paths: ${input.changedPaths.length} (${formatChangedPathSource(input.source)})`,
    `Package scripts: ${Object.keys(input.packageScripts).sort((left, right) => left.localeCompare(right)).join(", ") || "(none)"}`,
    "",
  ];

  if (input.changedPaths.length > 0) {
    lines.push("Changed path summary:");
    lines.push(...input.changedPaths.slice(0, 20).map((path) => `- ${path}`));

    if (input.changedPaths.length > 20) {
      lines.push(`...${input.changedPaths.length - 20} more path(s) not shown`);
    }

    lines.push("");
  }

  if (suggestions.length === 0) {
    lines.push("Recommended commands: (none found)");
    lines.push("Reason: no matching package scripts or focused tests were found.");
    return lines.join("\n");
  }

  lines.push("Recommended commands:");
  suggestions.forEach((suggestion, index) => {
    lines.push(`${index + 1}. ${suggestion.command}`);
    lines.push(`   reason: ${suggestion.reason}`);
  });

  return lines.join("\n");
}

function formatChangedPathSource(source: ChangedPathSource): string {
  if (source === "git") {
    return "from git status";
  }

  if (source === "input") {
    return "from input";
  }

  return "none detected";
}

function uniqueSuggestions(suggestions: VerificationSuggestion[]): VerificationSuggestion[] {
  const seen = new Set<string>();
  const unique: VerificationSuggestion[] = [];

  for (const suggestion of suggestions) {
    if (seen.has(suggestion.command)) {
      continue;
    }

    seen.add(suggestion.command);
    unique.push(suggestion);
  }

  return unique;
}

function normalizeWorkspacePaths(paths: string[]): string[] {
  return [
    ...new Set(
      paths
        .map(normalizeWorkspacePath)
        .filter((path) => path.length > 0)
        .filter((path) => !path.includes("\0") && !isAbsolute(path) && !path.startsWith("../") && path !== ".."),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeWorkspacePath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

function scriptExists(scripts: PackageScripts, name: string): boolean {
  return typeof scripts[name] === "string" && scripts[name].trim().length > 0;
}

function isSourceLikePath(path: string): boolean {
  return path.startsWith("src/") || /\.(cjs|js|jsx|mjs|mts|ts|tsx)$/.test(path);
}

function isTypeScriptPath(path: string): boolean {
  return /\.(mts|ts|tsx)$/.test(path);
}

function isTestLikePath(path: string): boolean {
  return /^tests\/.+\.test\.(js|mjs|ts|tsx)$/.test(path) || /\.test\.(js|mjs|ts|tsx)$/.test(path);
}

function isPackageLikePath(path: string): boolean {
  return ["package.json", "package-lock.json", "tsconfig.json"].includes(path);
}

function isReleasePath(path: string): boolean {
  return path === "README.md" || path === "src/index.ts" || path === "src/cli.ts" || path.startsWith("scripts/");
}

function isBroadImpactPath(path: string): boolean {
  return (
    isPackageLikePath(path) ||
    [
      "src/agent.ts",
      "src/cli.ts",
      "src/model.ts",
      "src/tools/registry.ts",
      "src/session.ts",
      "src/config.ts",
    ].includes(path)
  );
}

function affectsAgentLoop(path: string): boolean {
  return (
    path === "src/agent.ts" ||
    path === "src/model.ts" ||
    path === "src/evals.ts" ||
    path.startsWith("src/tools/") ||
    path.startsWith("tests/editing.test.ts") ||
    path.startsWith("tests/model.test.ts")
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
