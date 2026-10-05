import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { buildLocalModuleEdges, type LocalModuleEdge, type ModuleGraphSourceFile } from "../moduleGraph.js";
import { shouldExcludeWorkspaceEntry } from "./listFiles.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_FILES_SCANNED = 500;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_FILE_READ_BYTES = 64 * 1024;
const MAX_RESULTS = 10;
const MAX_SNIPPETS_PER_FILE = 2;
const MAX_DIRECTORIES_SCANNED = 5_000;
const FILES_PER_DIRECTORY_PASS = 20;
const MAX_GRAPH_SEEDS = 5;
const MAX_GRAPH_EXPANSIONS = 10;
const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

type ContextCandidate = {
  contentScore: number;
  graphRelations: string[];
  graphScore: number;
  path: string;
  pathScore: number;
  score: number;
  snippets: string[];
};

export class SuggestContextTool implements Tool {
  readonly name = "suggest_context";
  readonly description = "Suggest the most relevant workspace files for a query before reading them.";
  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Task, feature, symbol, or error text to find relevant files for.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.query !== "string") {
      return {
        ok: false,
        error: "Expected input.query to be a string.",
      };
    }

    const query = input.query.trim();

    if (query.length === 0) {
      return {
        ok: false,
        error: "Missing context query.",
      };
    }

    const terms = tokenizeQuery(query);
    const workspaceRoot = resolve(context.workspaceRoot);
    const collected: string[] = [];
    const truncated = await collectTextFiles(workspaceRoot, workspaceRoot, collected);
    const candidates: ContextCandidate[] = [];
    const graphFiles: ModuleGraphSourceFile[] = [];

    for (const filePath of collected) {
      const analyzed = await analyzeFile(workspaceRoot, filePath, query, terms);

      graphFiles.push({
        absolutePath: filePath,
        content: analyzed.content,
        path: analyzed.path,
      });

      if (analyzed.candidate && analyzed.candidate.score > 0) {
        candidates.push(analyzed.candidate);
      }
    }

    const graphEdges = candidates.length > 0
      ? await buildLocalModuleEdges(workspaceRoot, graphFiles)
      : [];
    const expanded = expandCandidatesWithModuleGraph(candidates, graphEdges);
    const results = expanded.candidates
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, MAX_RESULTS);

    return {
      ok: true,
      content: formatContextSuggestions(query, results, {
        scanned: collected.length,
        truncated,
        graphExpanded: expanded.graphExpanded,
        graphRelations: expanded.graphRelations,
      }),
      metadata: {
        query,
        count: results.length,
        scanned: collected.length,
        truncated,
        graphExpanded: expanded.graphExpanded,
        graphRelations: expanded.graphRelations,
      },
    };
  }
}

async function collectTextFiles(
  workspaceRoot: string,
  directoryPath: string,
  files: string[],
): Promise<boolean> {
  const pending: Array<{
    directoryPath: string;
    fileNames?: string[];
    nextFileIndex: number;
  }> = [{ directoryPath, nextFileIndex: 0 }];
  let nextDirectoryIndex = 0;
  let directoriesScanned = 0;
  let truncated = false;

  // Rotate unfinished directories to the back so one large module cannot consume the whole file budget.
  while (nextDirectoryIndex < pending.length && files.length < MAX_FILES_SCANNED) {
    const current = pending[nextDirectoryIndex];
    nextDirectoryIndex += 1;

    if (!current) {
      continue;
    }

    if (!current.fileNames) {
      if (directoriesScanned >= MAX_DIRECTORIES_SCANNED) {
        truncated = true;
        break;
      }

      directoriesScanned += 1;
      let children;

      try {
        children = (await readdir(current.directoryPath, { withFileTypes: true }))
          .filter((entry) => !shouldExcludeWorkspaceEntry(workspaceRoot, current.directoryPath, entry.name))
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        continue;
      }

      current.fileNames = [];

      for (const child of children) {
        const childPath = resolve(current.directoryPath, child.name);

        if (child.isDirectory()) {
          pending.push({ directoryPath: childPath, nextFileIndex: 0 });
        } else if (child.isFile() && isTextFileName(child.name)) {
          current.fileNames.push(child.name);
        }
      }
    }

    const end = Math.min(
      current.fileNames.length,
      current.nextFileIndex + FILES_PER_DIRECTORY_PASS,
    );

    for (; current.nextFileIndex < end; current.nextFileIndex += 1) {
      if (files.length >= MAX_FILES_SCANNED) {
        truncated = true;
        break;
      }

      const fileName = current.fileNames[current.nextFileIndex];

      if (!fileName) {
        continue;
      }

      const childPath = resolve(current.directoryPath, fileName);
      let childStat;

      try {
        childStat = await stat(childPath);
      } catch {
        continue;
      }

      if (childStat.size <= MAX_FILE_BYTES) {
        files.push(childPath);
      }
    }

    if (current.nextFileIndex < current.fileNames.length) {
      pending.push(current);
    }
  }

  if (nextDirectoryIndex < pending.length) {
    truncated = true;
  }

  if (files.length >= MAX_FILES_SCANNED) {
    const hasUnvisitedFiles = pending.slice(nextDirectoryIndex).some((entry) =>
      entry.fileNames === undefined || entry.nextFileIndex < entry.fileNames.length
    );

    if (hasUnvisitedFiles) {
      truncated = true;
    }
  }

  return truncated;
}

async function analyzeFile(
  workspaceRoot: string,
  filePath: string,
  query: string,
  terms: string[],
): Promise<{ candidate: ContextCandidate | null; content?: string; path: string }> {
  const relativePath = normalizeRelativePath(relative(workspaceRoot, filePath));

  if (!isInsideWorkspace(workspaceRoot, filePath)) {
    return { candidate: null, path: relativePath };
  }

  const lowerPath = relativePath.toLowerCase();
  const lowerName = basename(relativePath).toLowerCase();
  const lowerQuery = query.toLowerCase();
  let pathScore = lowerPath.includes(lowerQuery) ? 30 : 0;

  for (const term of terms) {
    if (lowerName.includes(term)) {
      pathScore += 12;
    } else if (lowerPath.includes(term)) {
      pathScore += 6;
    }
  }

  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return {
      candidate: pathScore > 0
        ? {
          contentScore: 0,
          graphRelations: [],
          graphScore: 0,
          path: relativePath,
          pathScore,
          score: pathScore,
          snippets: [],
        }
        : null,
      path: relativePath,
    };
  }

  const content = raw.slice(0, MAX_FILE_READ_BYTES);
  const lowerContent = content.toLowerCase();
  let contentScore = 0;

  if (lowerContent.includes(lowerQuery)) {
    contentScore += 24;
  }

  for (const term of terms) {
    contentScore += Math.min(occurrenceCount(lowerContent, term), 8) * 3;
  }

  const snippets = extractSnippets(content, terms);
  contentScore += snippets.length * 2;
  const score = pathScore + contentScore;

  if (score === 0) {
    return { candidate: null, content, path: relativePath };
  }

  return {
    candidate: {
      contentScore,
      graphRelations: [],
      graphScore: 0,
      path: relativePath,
      pathScore,
      score,
      snippets,
    },
    content,
    path: relativePath,
  };
}

function expandCandidatesWithModuleGraph(
  lexicalCandidates: ContextCandidate[],
  edges: LocalModuleEdge[],
): { candidates: ContextCandidate[]; graphExpanded: number; graphRelations: number } {
  const candidatesByPath = new Map(lexicalCandidates.map((candidate) => [candidate.path, candidate]));
  const seeds = [...lexicalCandidates]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_GRAPH_SEEDS);
  let graphExpanded = 0;
  let graphRelations = 0;

  for (const seed of seeds) {
    const related = [
      ...edges
        .filter((edge) => edge.fromPath === seed.path)
        .map((edge) => ({ edge, path: edge.toPath, relation: formatGraphRelation(edge, "dependency") })),
      ...edges
        .filter((edge) => edge.toPath === seed.path)
        .map((edge) => ({ edge, path: edge.fromPath, relation: formatGraphRelation(edge, "caller") })),
    ];

    for (const item of related) {
      let candidate = candidatesByPath.get(item.path);

      if (!candidate) {
        if (graphExpanded >= MAX_GRAPH_EXPANSIONS) {
          continue;
        }

        candidate = {
          contentScore: 0,
          graphRelations: [],
          graphScore: 0,
          path: item.path,
          pathScore: 0,
          score: 0,
          snippets: [],
        };
        candidatesByPath.set(item.path, candidate);
        graphExpanded += 1;
      }

      if (candidate.graphRelations.includes(item.relation)) {
        continue;
      }

      const lexicalSeedScore = seed.pathScore + seed.contentScore;
      candidate.graphRelations.push(item.relation);
      candidate.graphScore = Math.max(candidate.graphScore, Math.max(1, lexicalSeedScore - 1));
      candidate.score = Math.max(candidate.pathScore + candidate.contentScore, candidate.graphScore);
      graphRelations += 1;
    }
  }

  return {
    candidates: [...candidatesByPath.values()],
    graphExpanded,
    graphRelations,
  };
}

function formatGraphRelation(edge: LocalModuleEdge, direction: "caller" | "dependency"): string {
  const symbolSuffix = edge.symbols.length > 0
    ? ` (${edge.symbols.slice(0, 6).join(", ")}${edge.symbols.length > 6 ? ", ..." : ""})`
    : "";

  if (direction === "dependency") {
    return `imported by ${edge.fromPath} via ${edge.kind}${symbolSuffix}`;
  }

  return `imports ${edge.toPath} via ${edge.kind}${symbolSuffix}`;
}

function formatContextSuggestions(
  query: string,
  results: ContextCandidate[],
  stats: { graphExpanded: number; graphRelations: number; scanned: number; truncated: boolean },
): string {
  const lines = [
    `Context suggestions for: ${query}`,
    `Scanned files: ${stats.scanned}${stats.truncated ? " (truncated)" : ""}`,
  ];

  if (stats.graphExpanded > 0) {
    lines.push(`Graph-expanded files: ${stats.graphExpanded} from ${stats.graphRelations} direct relation(s)`);
  }

  lines.push("");

  if (results.length === 0) {
    lines.push("No relevant files found.");
    return lines.join("\n");
  }

  for (const [index, result] of results.entries()) {
    lines.push(
      `${index + 1}. ${result.path} (score ${result.score}; path ${result.pathScore}, content ${result.contentScore}${result.graphScore > 0 ? `, graph ${result.graphScore}` : ""})`,
    );

    for (const relation of result.graphRelations.sort()) {
      lines.push(`   - graph: ${relation}`);
    }

    for (const snippet of result.snippets) {
      lines.push(`   - ${snippet}`);
    }
  }

  return lines.join("\n");
}

function extractSnippets(content: string, terms: string[]): string[] {
  const snippets: string[] = [];
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const normalized = line.toLowerCase();

    if (!terms.some((term) => normalized.includes(term))) {
      continue;
    }

    snippets.push(`line ${index + 1}: ${truncateOneLine(line.trim(), 140)}`);

    if (snippets.length >= MAX_SNIPPETS_PER_FILE) {
      break;
    }
  }

  return snippets;
}

function occurrenceCount(value: string, term: string): number {
  if (term.length === 0) {
    return 0;
  }

  let count = 0;
  let start = 0;

  while (start < value.length) {
    const index = value.indexOf(term, start);

    if (index === -1) {
      break;
    }

    count += 1;
    start = index + term.length;
  }

  return count;
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase();
  const terms = normalized
    .split(/[^a-z0-9_\-.]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  if (terms.length === 0 && normalized.length > 0) {
    return [normalized];
  }

  return [...new Set(terms)];
}

function isTextFileName(name: string): boolean {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relativePath = relative(workspaceRoot, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...[truncated]`;
}
