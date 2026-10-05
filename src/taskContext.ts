import {
  buildContextIndex,
  getContextIndexStatus,
  searchContextIndex,
  type ContextIndexCacheStatus,
  type ContextIndexSearch,
  type ContextIndexSearchResult,
} from "./contextIndex.js";
import {
  buildSemanticIndex,
  getSemanticIndexStatus,
  searchSemanticIndex,
  type SemanticIndexSearch,
  type SemanticIndexSearchResult,
} from "./semanticIndex.js";

const DEFAULT_MAX_CONTEXT_CHARS = 6_000;
const DEFAULT_MAX_CONTEXT_FILES = 5;
const MIN_CONTEXT_CHARS = 1_000;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_CONTEXT_FILES = 10;
const MAX_CANDIDATE_FILES = 25;

export type AutomaticTaskContextOptions = {
  maxChars?: number;
  maxFiles?: number;
  refresh?: boolean;
};

export type AutomaticTaskContext = {
  cacheStatus: ContextIndexCacheStatus;
  content: string;
  files: string[];
  retrievalMode: "hybrid" | "lexical";
  refreshed: boolean;
  staleFiles: number;
  semanticFiles: number;
};

type AutomaticContextCandidate = {
  lexical?: ContextIndexSearchResult;
  path: string;
  score: number;
  semantic?: SemanticIndexSearchResult;
  stale: boolean;
};

export async function prepareAutomaticTaskContext(
  workspaceRoot: string,
  query: string,
  options: AutomaticTaskContextOptions = {},
): Promise<AutomaticTaskContext | null> {
  const status = await getContextIndexStatus(workspaceRoot);

  if (!status.exists) {
    return null;
  }

  const maxFiles = clampMaxFiles(options.maxFiles);
  const candidateLimit = clampCandidateFiles(maxFiles * 3);
  let refreshed = false;

  if (options.refresh) {
    await buildContextIndex(workspaceRoot);
    refreshed = true;
  }

  let search = await searchContextIndex(workspaceRoot, query, candidateLimit);

  if (!search) {
    return null;
  }

  if (!refreshed && search.results.some((result) => result.stale)) {
    await buildContextIndex(workspaceRoot);
    refreshed = true;
    search = await searchContextIndex(workspaceRoot, query, candidateLimit);

    if (!search) {
      return null;
    }
  }

  const semanticSearch = await searchLocalSemanticContext(workspaceRoot, query, candidateLimit);
  const candidates = mergeAutomaticContextResults(search, semanticSearch, maxFiles);

  if (candidates.length === 0) {
    return null;
  }

  return {
    cacheStatus: search.index.stats.cacheStatus,
    content: formatAutomaticTaskContextResults(
      search.query,
      search.index.builtAt,
      candidates,
      clampMaxChars(options.maxChars),
      Boolean(semanticSearch),
    ),
    files: candidates.map((result) => result.path),
    retrievalMode: semanticSearch ? "hybrid" : "lexical",
    refreshed,
    staleFiles: candidates.filter((result) => result.stale).length,
    semanticFiles: candidates.filter((result) => result.semantic).length,
  };
}

export function formatAutomaticTaskContext(
  search: ContextIndexSearch,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
  semanticSearch: SemanticIndexSearch | null = null,
): string {
  const candidates = mergeAutomaticContextResults(
    search,
    semanticSearch,
    DEFAULT_MAX_CONTEXT_FILES,
  );

  return formatAutomaticTaskContextResults(
    search.query,
    search.index.builtAt,
    candidates,
    clampMaxChars(maxChars),
    Boolean(semanticSearch),
  );
}

async function searchLocalSemanticContext(
  workspaceRoot: string,
  query: string,
  limit: number,
): Promise<SemanticIndexSearch | null> {
  try {
    const status = await getSemanticIndexStatus(workspaceRoot);

    if (!status.exists || status.index.provider !== "local") {
      return null;
    }

    let search = await searchSemanticIndex(workspaceRoot, query, limit);

    if (search?.results.some((result) => result.stale)) {
      await buildSemanticIndex(workspaceRoot);
      search = await searchSemanticIndex(workspaceRoot, query, limit);
    }

    return search && search.results.length > 0 ? search : null;
  } catch {
    return null;
  }
}

function mergeAutomaticContextResults(
  lexicalSearch: ContextIndexSearch,
  semanticSearch: SemanticIndexSearch | null,
  maxFiles: number,
): AutomaticContextCandidate[] {
  const lexicalByPath = new Map(lexicalSearch.results.map((result) => [result.path, result]));
  const semanticByPath = new Map<string, SemanticIndexSearchResult>();

  for (const result of semanticSearch?.results ?? []) {
    const existing = semanticByPath.get(result.path);

    if (!existing || result.score > existing.score) {
      semanticByPath.set(result.path, result);
    }
  }

  const maxLexicalScore = Math.max(
    1,
    ...[...lexicalByPath.values()].map((result) => result.score),
  );
  const maxSemanticScore = Math.max(1, ...[...semanticByPath.values()].map((result) => result.score));
  const paths = new Set([...lexicalByPath.keys(), ...semanticByPath.keys()]);
  const merged = [...paths].map((path): AutomaticContextCandidate => {
    const lexical = lexicalByPath.get(path);
    const semantic = semanticByPath.get(path);
    const lexicalNormalized = lexical ? lexical.score / maxLexicalScore : 0;
    const semanticNormalized = semantic ? semantic.score / maxSemanticScore : 0;
    const agreementBoost = lexical && semantic ? 0.1 : 0;

    return {
      lexical,
      path,
      score: 0.65 * lexicalNormalized + 0.35 * semanticNormalized + agreementBoost,
      semantic,
      stale: Boolean(lexical?.stale || semantic?.stale),
    };
  });

  return merged
    .sort((left, right) =>
      Number(Boolean(right.lexical?.exactSymbolMatch)) - Number(Boolean(left.lexical?.exactSymbolMatch))
      || right.score - left.score
      || Number(Boolean(right.lexical && right.semantic)) - Number(Boolean(left.lexical && left.semantic))
      || (right.lexical?.score ?? 0) - (left.lexical?.score ?? 0)
      || left.path.localeCompare(right.path)
    )
    .slice(0, maxFiles);
}

function formatAutomaticTaskContextResults(
  query: string,
  builtAt: string,
  results: AutomaticContextCandidate[],
  maxChars: number,
  hybrid: boolean,
): string {
  const limit = clampMaxChars(maxChars);
  const lines = [
    hybrid
      ? "Source: hybrid local context index (lexical + semantic)"
      : "Source: persistent local context index",
    `Query: ${truncateOneLine(query, 300)}`,
    `Index built at: ${builtAt}`,
    "Relevant files:",
  ];
  let omitted = 0;

  for (const [index, result] of results.entries()) {
    const block = formatContextResult(index + 1, result);
    const candidate = [...lines, ...block].join("\n");

    if (candidate.length > limit) {
      omitted = results.length - index;
      break;
    }

    lines.push(...block);
  }

  if (omitted > 0) {
    lines.push(`... ${omitted} additional indexed file(s) omitted by context budget.`);
  }

  return truncateText(lines.join("\n"), limit);
}

function formatContextResult(index: number, result: AutomaticContextCandidate): string[] {
  const stale = result.stale ? " [stale]" : "";
  const lines = [`${index}. ${result.path}${stale}`];

  for (const symbol of result.lexical?.symbolMatches.slice(0, 2) ?? []) {
    lines.push(`   symbol: ${symbol}`);
  }

  for (const relation of result.lexical?.graphRelations.slice(0, 2) ?? []) {
    lines.push(`   relation: ${relation}`);
  }

  if (result.semantic) {
    lines.push(
      `   semantic: similarity ${result.semantic.similarity.toFixed(3)}, lines ${result.semantic.startLine}-${result.semantic.endLine}`,
    );
  }

  const snippets = [
    ...(result.lexical?.snippets ?? []),
    ...(result.semantic?.snippets ?? []),
  ];

  for (const snippet of [...new Set(snippets)].slice(0, 2)) {
    lines.push(`   evidence: ${snippet}`);
  }

  return lines;
}

function clampMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_CONTEXT_CHARS;
  }

  return Math.max(MIN_CONTEXT_CHARS, Math.min(MAX_CONTEXT_CHARS, Math.floor(value)));
}

function clampMaxFiles(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_CONTEXT_FILES;
  }

  return Math.max(1, Math.min(MAX_CONTEXT_FILES, Math.floor(value)));
}

function clampCandidateFiles(value: number): number {
  return Math.max(1, Math.min(MAX_CANDIDATE_FILES, Math.floor(value)));
}

function truncateOneLine(value: string, maxLength: number): string {
  return truncateText(value.replace(/\s+/g, " ").trim(), maxLength);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 15))}...[truncated]`;
}
