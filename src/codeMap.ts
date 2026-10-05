import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

type CodeMapEntry = {
  description: string;
  key: string;
  path: string;
};

const CODE_MAP_ENTRIES: CodeMapEntry[] = [
  {
    key: "cli",
    path: "src/cli.ts",
    description: "CLI routing, interactive loop, local slash commands, runtime wiring.",
  },
  {
    key: "agent",
    path: "src/agent.ts",
    description: "Model loop, tool execution, approvals, sessions, plan updates, audit hooks.",
  },
  {
    key: "model",
    path: "src/model.ts",
    description: "Mock client, OpenAI Responses client, Chat Completions relay client.",
  },
  {
    key: "tools",
    path: "src/tools/registry.ts",
    description: "Registered tool catalog, context suggestions, and model-facing tool schemas.",
  },
  {
    key: "evals",
    path: "src/evals.ts",
    description: "Offline mock-agent smoke, regression, and benchmark checks.",
  },
  {
    key: "retrieval-eval",
    path: "src/retrievalEval.ts",
    description: "Manifest-backed lexical and automatic retrieval quality metrics.",
  },
  {
    key: "audit",
    path: "src/audit.ts",
    description: "Tool/model/project-command audit logs, replay, reports, and usage summaries.",
  },
  {
    key: "session",
    path: "src/session.ts",
    description: "Persisted session state, checkpoints, diffs, stats, and search.",
  },
  {
    key: "commands",
    path: "src/commands.ts",
    description: "Reusable project command templates and argument expansion.",
  },
  {
    key: "help",
    path: "src/help.ts",
    description: "Help text, topic routing, and learning-oriented command docs.",
  },
  {
    key: "architecture",
    path: "src/architecture.ts",
    description: "Learning map for the codebase structure and agent loop.",
  },
  {
    key: "roadmap",
    path: "src/roadmap.ts",
    description: "Current completion estimate and next work items.",
  },
  {
    key: "tests",
    path: "tests",
    description: "Behavioral coverage for CLI, agent, tools, evals, and docs.",
  },
];

export type CodeMapResult = {
  entries: CodeMapEntry[];
  generatedAt: string;
  root: string;
  rootFiles: string[];
  srcFiles: string[];
};

export async function buildCodeMap(workspaceRoot: string): Promise<CodeMapResult> {
  return {
    entries: CODE_MAP_ENTRIES,
    generatedAt: new Date().toISOString(),
    root: workspaceRoot,
    rootFiles: await listTopLevelFiles(workspaceRoot),
    srcFiles: await listKeySourceFiles(workspaceRoot, join(workspaceRoot, "src")),
  };
}

export function formatCodeMap(result: CodeMapResult): string {
  return [
    "CCAgent code map",
    `Generated: ${result.generatedAt}`,
    `Workspace: ${result.root}`,
    "",
    "Key files:",
    ...result.entries.map((entry) => `- ${entry.path}: ${entry.description}`),
    "",
    "Top-level files:",
    ...result.rootFiles.map((file) => `- ${file}`),
    "",
    "Key source files:",
    ...result.srcFiles.map((file) => `- ${file}`),
    "",
    "Learning order:",
    "1. src/cli.ts",
    "2. src/agent.ts",
    "3. src/model.ts",
    "4. src/tools/registry.ts",
    "5. tests/cli.test.ts",
    "6. tests/evals.test.ts",
  ].join("\n");
}

export async function exportCodeMapReport(
  workspaceRoot: string,
): Promise<{ absolutePath: string; content: string; path: string }> {
  const result = await buildCodeMap(workspaceRoot);
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const exportedAt = result.generatedAt;
  const fileName = `code-map-${formatExportTimestamp(exportedAt)}.md`;
  const path = join(reportsDir, fileName);
  const relativePath = join(".ccagent", "reports", fileName).replaceAll("\\", "/");
  const content = [
    "# CCAgent Code Map",
    "",
    `Generated at: ${exportedAt}`,
    `Workspace: ${workspaceRoot}`,
    "",
    "## Key Files",
    "",
    ...result.entries.map((entry) => `- \`${entry.path}\`: ${entry.description}`),
    "",
    "## Top-Level Files",
    "",
    ...result.rootFiles.map((file) => `- ${file}`),
    "",
    "## Key Source Files",
    "",
    ...result.srcFiles.map((file) => `- ${file}`),
    "",
    "## Learning Order",
    "",
    "1. `src/cli.ts`",
    "2. `src/agent.ts`",
    "3. `src/model.ts`",
    "4. `src/tools/registry.ts`",
    "5. `tests/cli.test.ts`",
    "6. `tests/evals.test.ts`",
    "",
  ].join("\n");

  await mkdir(reportsDir, { recursive: true });
  await writeFile(path, content, "utf8");

  return { absolutePath: path, content, path: relativePath };
}

async function listTopLevelFiles(workspaceRoot: string): Promise<string[]> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort((left, right) => left.localeCompare(right));
}

async function listKeySourceFiles(workspaceRoot: string, srcRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(srcRoot, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(srcRoot, entry.name);

      if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(relative(workspaceRoot, fullPath).replaceAll("\\", "/"));
      }
    }

    return files.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function formatExportTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}
