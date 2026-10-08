import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  buildLocalModuleEdges,
  buildTypeScriptSymbolEdges,
  getModuleResolutionConfigFingerprint,
  type LocalModuleEdge,
  type LocalModuleReferenceKind,
  type ModuleGraphSourceFile,
} from "./moduleGraph.js";
import { shouldExcludeWorkspaceEntry } from "./tools/listFiles.js";
import { extractSymbols, type WorkspaceSymbol } from "./tools/symbols.js";

const CONTEXT_INDEX_VERSION = 11;
const CONTEXT_INDEX_DIR = ".ccagent/index";
const CONTEXT_INDEX_FILE = "context-index.json";
const MAX_FILES_SCANNED = 1_500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILE_READ_BYTES = 128 * 1024;
const MAX_TOKEN_ENTRIES_PER_FILE = 500;
const MAX_RESULTS = 25;
const MAX_SNIPPETS_PER_RESULT = 3;
const MAX_GRAPH_SEEDS = 5;
const MAX_GRAPH_EXPANSIONS = 10;
const MAX_GRAPH_DEPTH = 2;
const MAX_GRAPH_RELATIONS = 40;
const MAX_GRAPH_RELATIONS_PER_RESULT = 4;
const MAX_INHERITED_REEXPORT_SYMBOLS = 50;
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
const SUPPORTED_CONTEXT_INDEX_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, CONTEXT_INDEX_VERSION]);
const MODULE_REFERENCE_KINDS = new Set<LocalModuleReferenceKind>([
  "dynamic import",
  "import",
  "project reference",
  "re-export",
  "require",
  "side-effect import",
  "symbol reference",
  "type reference",
]);
const CONTEXT_INDEX_SYMBOL_KINDS = new Set<ContextIndexSymbol["kind"]>([
  "class",
  "const",
  "describe",
  "enum",
  "function",
  "heading",
  "interface",
  "test",
  "type",
]);

export type ContextIndexFile = {
  bytes: number;
  mtimeMs: number;
  path: string;
  preview: string;
  symbols: ContextIndexSymbol[];
  tokenCount: number;
  tokens: Record<string, number>;
};

export type ContextIndexCacheStatus = "miss" | "partial" | "reused";

export type ContextIndexSymbol = Pick<
  WorkspaceSymbol,
  "exported" | "kind" | "line" | "name" | "signature"
>;

export type ContextIndexModuleEdge = LocalModuleEdge;

export type ContextIndex = {
  builtAt: string;
  files: ContextIndexFile[];
  moduleEdges: ContextIndexModuleEdge[];
  moduleResolutionFingerprint: string;
  symbolEdges: ContextIndexModuleEdge[];
  stats: {
    bytesIndexed: number;
    cacheStatus: ContextIndexCacheStatus;
    filesIndexed: number;
    filesRebuilt: number;
    filesScanned: number;
    filesReused: number;
    moduleEdges: number;
    symbolEdges: number;
    symbols: number;
    truncated: boolean;
  };
  version: number;
};

export type ContextIndexSearchResult = {
  bytes: number;
  contentScore: number;
  exactSymbolMatch: boolean;
  graphDepth: number;
  graphRelations: string[];
  graphScore: number;
  path: string;
  pathScore: number;
  score: number;
  snippets: string[];
  stale: boolean;
  symbolMatches: string[];
  symbolScore: number;
};

export type ContextIndexSearch = {
  index: ContextIndex;
  graphExpanded: number;
  graphMaxDepth: number;
  graphRelations: number;
  path: string;
  query: string;
  results: ContextIndexSearchResult[];
};

type ContextIndexBuildFile = {
  file: ContextIndexFile;
  graphFile?: ModuleGraphSourceFile;
  reused: boolean;
};

export type ContextIndexStatus =
  | {
      exists: false;
      path: string;
    }
  | {
      exists: true;
      index: ContextIndex;
      path: string;
    };

export async function buildContextIndex(workspaceRoot: string): Promise<{
  index: ContextIndex;
  path: string;
}> {
  const root = resolve(workspaceRoot);
  const paths = getContextIndexPaths(root);
  const previousIndex = await readContextIndex(paths.absolutePath);
  const previousFiles = new Map(previousIndex?.files.map((file) => [file.path, file]) ?? []);
  const files: string[] = [];
  const truncated = await collectIndexableFiles(root, root, files);
  const indexedFiles: ContextIndexFile[] = [];
  const graphFiles: ModuleGraphSourceFile[] = [];
  const changedPaths = new Set<string>();
  let bytesIndexed = 0;
  let symbolsIndexed = 0;
  let filesReused = 0;
  let filesRebuilt = 0;

  for (const filePath of files) {
    const relativePath = normalizeRelativePath(relative(root, filePath));
    const indexed = await indexFile(root, filePath, previousFiles.get(relativePath));

    if (!indexed) {
      continue;
    }

    indexedFiles.push(indexed.file);
    if (indexed.graphFile) {
      graphFiles.push(indexed.graphFile);
    }
    bytesIndexed += indexed.file.bytes;
    symbolsIndexed += indexed.file.symbols.length;

    if (indexed.reused) {
      filesReused += 1;
    } else {
      changedPaths.add(indexed.file.path);
      filesRebuilt += 1;
    }
  }

  const currentPaths = new Set(indexedFiles.map((file) => file.path));
  const previousPaths = new Set(previousIndex?.files.map((file) => file.path) ?? []);
  const pathSetChanged = currentPaths.size !== previousPaths.size
    || [...currentPaths].some((path) => !previousPaths.has(path));
  const moduleResolutionFingerprint = await getModuleResolutionConfigFingerprint(root);
  const graphEdges = await buildContextGraphEdges(
    root,
    indexedFiles,
    graphFiles,
    previousIndex,
    changedPaths,
    pathSetChanged,
    moduleResolutionFingerprint,
  );
  inheritReExportSymbols(indexedFiles, graphEdges.moduleEdges);
  const index: ContextIndex = {
    builtAt: new Date().toISOString(),
    files: indexedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    moduleEdges: graphEdges.moduleEdges,
    moduleResolutionFingerprint,
    symbolEdges: graphEdges.symbolEdges,
    stats: {
      bytesIndexed,
      cacheStatus: getCacheStatus(filesReused, filesRebuilt),
      filesIndexed: indexedFiles.length,
      filesRebuilt,
      filesScanned: files.length,
      filesReused,
      moduleEdges: graphEdges.moduleEdges.length,
      symbolEdges: graphEdges.symbolEdges.length,
      symbols: symbolsIndexed,
      truncated,
    },
    version: CONTEXT_INDEX_VERSION,
  };

  await mkdir(paths.absoluteDir, { recursive: true });
  await writeFile(paths.absolutePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  return {
    index,
    path: paths.relativePath,
  };
}

// Thin re-export entries such as `module.exports = require('./target')` or
// `export * from './target'` extract no symbols of their own, so lexical and
// graph retrieval can never surface them (e.g. picomatch's `posix.js`). Forward
// the target module's exported symbols onto such entries so queries for the
// re-exported surface still rank them.
function inheritReExportSymbols(
  files: ContextIndexFile[],
  moduleEdges: ContextIndexModuleEdge[],
): void {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const forwardKinds = new Set<LocalModuleReferenceKind>(["re-export", "require"]);

  for (const edge of moduleEdges) {
    if (!forwardKinds.has(edge.kind)) {
      continue;
    }

    const importer = fileByPath.get(edge.fromPath);
    const target = fileByPath.get(edge.toPath);

    if (!importer || !target) {
      continue;
    }

    if (importer.symbols.length > 0) {
      continue;
    }

    const exportedTarget = target.symbols.filter((symbol) => symbol.exported);

    if (exportedTarget.length === 0) {
      continue;
    }

    importer.symbols = exportedTarget.slice(0, MAX_INHERITED_REEXPORT_SYMBOLS);
  }
}

export async function getContextIndexStatus(workspaceRoot: string): Promise<ContextIndexStatus> {
  const paths = getContextIndexPaths(workspaceRoot);
  const index = await readContextIndex(paths.absolutePath);

  if (!index) {
    return {
      exists: false,
      path: paths.relativePath,
    };
  }

  return {
    exists: true,
    index,
    path: paths.relativePath,
  };
}

export async function searchContextIndex(
  workspaceRoot: string,
  query: string,
  limit = 10,
): Promise<ContextIndexSearch | null> {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new Error("Missing index search query.");
  }

  const paths = getContextIndexPaths(workspaceRoot);
  const index = await readContextIndex(paths.absolutePath);

  if (!index) {
    return null;
  }

  const terms = tokenizeSearchQuery(trimmedQuery);
  const docFrequency = buildDocumentFrequency(index.files, terms);
  const fileByPath = new Map(index.files.map((file) => [file.path, file]));
  const lexicalResults = await Promise.all(
    index.files.map(async (file) => {
      const scored = scoreIndexedFile(file, trimmedQuery, terms, docFrequency, index.files.length);

      if (scored.score <= 0) {
        return null;
      }

      const snippets = await extractLiveSnippets(
        workspaceRoot,
        file.path,
        trimmedQuery,
        terms,
        file.mtimeMs,
      );

      return {
        ...scored,
        graphDepth: 0,
        graphRelations: [] as string[],
        graphScore: 0,
        snippets: snippets.snippets.length > 0 ? snippets.snippets : formatPreviewSnippets(file.preview),
        stale: snippets.stale,
        symbolMatches: scored.symbolMatches,
        symbolScore: scored.symbolScore,
      };
    }),
  );
  const expanded = expandSearchWithModuleGraph(
    lexicalResults.filter((result): result is ContextIndexSearchResult => result !== null),
    [...index.moduleEdges, ...index.symbolEdges],
    fileByPath,
    terms,
    trimmedQuery,
  );

  return {
    index,
    graphExpanded: expanded.graphExpanded,
    graphMaxDepth: expanded.graphMaxDepth,
    graphRelations: expanded.graphRelations,
    path: paths.relativePath,
    query: trimmedQuery,
    results: expanded.results
      .sort((left, right) =>
        Number(right.exactSymbolMatch) - Number(left.exactSymbolMatch)
        || right.score - left.score
        || left.path.localeCompare(right.path)
      )
      .slice(0, clampLimit(limit)),
  };
}

export function formatContextIndexBuild(result: { index: ContextIndex; path: string }): string {
  return [
    "Context index built",
    `Path: ${result.path}`,
    `Built at: ${result.index.builtAt}`,
    `Cache: ${result.index.stats.cacheStatus}`,
    `Files indexed: ${result.index.stats.filesIndexed}`,
    `Files reused: ${result.index.stats.filesReused}`,
    `Files rebuilt: ${result.index.stats.filesRebuilt}`,
    `Files scanned: ${result.index.stats.filesScanned}${result.index.stats.truncated ? " (truncated)" : ""}`,
    `Module edges: ${result.index.stats.moduleEdges}`,
    `Symbol edges: ${result.index.stats.symbolEdges}`,
    `Symbols: ${result.index.stats.symbols}`,
    `Bytes indexed: ${result.index.stats.bytesIndexed}`,
  ].join("\n");
}

export function formatContextIndexStatus(status: ContextIndexStatus): string {
  if (!status.exists) {
    return [
      "Context index status",
      "Status: missing",
      `Path: ${status.path}`,
      "Next: /index build",
    ].join("\n");
  }

  return [
    "Context index status",
    "Status: ready",
    `Path: ${status.path}`,
    `Built at: ${status.index.builtAt}`,
    `Version: ${status.index.version}`,
    `Cache: ${status.index.stats.cacheStatus}`,
    `Files indexed: ${status.index.stats.filesIndexed}`,
    `Files reused: ${status.index.stats.filesReused}`,
    `Files rebuilt: ${status.index.stats.filesRebuilt}`,
    `Files scanned: ${status.index.stats.filesScanned}${status.index.stats.truncated ? " (truncated)" : ""}`,
    `Module edges: ${status.index.stats.moduleEdges}`,
    `Symbol edges: ${status.index.stats.symbolEdges}`,
    `Symbols: ${status.index.stats.symbols}`,
    `Bytes indexed: ${status.index.stats.bytesIndexed}`,
  ].join("\n");
}

export function formatContextIndexSearch(search: ContextIndexSearch | null, query: string): string {
  if (!search) {
    return [
      `Context index search: ${query}`,
      "Status: missing index",
      "Next: /index build",
    ].join("\n");
  }

  const lines = [
    `Context index search: ${search.query}`,
    `Index: ${search.path}`,
    `Built at: ${search.index.builtAt}`,
    `Files indexed: ${search.index.stats.filesIndexed}`,
    `Module edges: ${search.index.stats.moduleEdges}`,
    `Symbol edges: ${search.index.stats.symbolEdges}`,
    `Symbols: ${search.index.stats.symbols}`,
  ];

  if (search.graphExpanded > 0) {
    lines.push(
      `Graph-expanded files: ${search.graphExpanded} from ${search.graphRelations} relation(s), max depth ${search.graphMaxDepth}`,
    );
  }

  lines.push("");

  if (search.results.length === 0) {
    lines.push("No matching indexed files found.");
    return lines.join("\n");
  }

  search.results.forEach((result, index) => {
    const stale = result.stale ? " stale" : "";
    lines.push(
      `${index + 1}. ${result.path} (score ${result.score.toFixed(2)}; path ${result.pathScore.toFixed(2)}, content ${result.contentScore.toFixed(2)}${result.symbolScore > 0 ? `, symbols ${result.symbolScore.toFixed(2)}${result.exactSymbolMatch ? " exact" : ""}` : ""}${result.graphScore > 0 ? `, graph ${result.graphScore.toFixed(2)}${result.graphDepth > 0 ? ` depth ${result.graphDepth}` : ""}` : ""}${stale})`,
    );

    for (const relation of result.graphRelations.sort()) {
      lines.push(`   - graph: ${relation}`);
    }

    for (const symbol of result.symbolMatches) {
      lines.push(`   - symbol: ${symbol}`);
    }

    for (const snippet of result.snippets) {
      lines.push(`   - ${snippet}`);
    }
  });

  return lines.join("\n");
}

async function collectIndexableFiles(
  workspaceRoot: string,
  directoryPath: string,
  files: string[],
): Promise<boolean> {
  if (files.length >= MAX_FILES_SCANNED) {
    return true;
  }

  const children = (await readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => entry.name !== ".ccagent")
    .filter((entry) => !shouldExcludeWorkspaceEntry(workspaceRoot, directoryPath, entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  let truncated = false;

  for (const child of children) {
    if (files.length >= MAX_FILES_SCANNED) {
      truncated = true;
      break;
    }

    const childPath = resolve(directoryPath, child.name);

    if (child.isDirectory()) {
      truncated = (await collectIndexableFiles(workspaceRoot, childPath, files)) || truncated;
      continue;
    }

    if (!child.isFile() || !isTextFileName(child.name)) {
      continue;
    }

    const childStat = await stat(childPath);

    if (childStat.size > MAX_FILE_BYTES) {
      continue;
    }

    files.push(childPath);
  }

  return truncated;
}

async function indexFile(
  workspaceRoot: string,
  filePath: string,
  previousFile?: ContextIndexFile,
): Promise<ContextIndexBuildFile | null> {
  if (!isInsideWorkspace(workspaceRoot, filePath)) {
    return null;
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;

  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }

  const relativePath = normalizeRelativePath(relative(workspaceRoot, filePath));
  const mtimeMs = fileStat.mtimeMs;

  if (
    previousFile &&
    previousFile.path === relativePath &&
    previousFile.bytes === fileStat.size &&
    previousFile.mtimeMs === mtimeMs
  ) {
    return {
      file: previousFile,
      reused: true,
    };
  }

  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const content = raw.slice(0, MAX_FILE_READ_BYTES);
  const tokenCounts = countTokens(tokenizeIndexText(`${relativePath}\n${content}`));
  const symbols = extractSymbols(relativePath, content).map(toContextIndexSymbol);

  return {
    file: {
      bytes: fileStat.size,
      mtimeMs,
      path: relativePath,
      preview: buildPreview(content),
      symbols,
      tokenCount: [...tokenCounts.values()].reduce((sum, count) => sum + count, 0),
      tokens: Object.fromEntries(
        [...tokenCounts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, MAX_TOKEN_ENTRIES_PER_FILE),
      ),
    },
    graphFile: {
      absolutePath: filePath,
      content,
      path: relativePath,
    },
    reused: false,
  };
}

async function buildContextGraphEdges(
  workspaceRoot: string,
  indexedFiles: ContextIndexFile[],
  changedGraphFiles: ModuleGraphSourceFile[],
  previousIndex: ContextIndex | null,
  changedPaths: Set<string>,
  pathSetChanged: boolean,
  moduleResolutionFingerprint: string,
): Promise<{
  moduleEdges: ContextIndexModuleEdge[];
  symbolEdges: ContextIndexModuleEdge[];
}> {
  const moduleResolutionChanged = [...changedPaths].some(isModuleResolutionConfigPath)
    || previousIndex?.moduleResolutionFingerprint !== moduleResolutionFingerprint;

  if (
    !previousIndex
    || previousIndex.version < CONTEXT_INDEX_VERSION
    || pathSetChanged
    || moduleResolutionChanged
  ) {
    const graphFiles = await readAllModuleGraphFiles(workspaceRoot, indexedFiles, changedGraphFiles);
    const moduleEdges = await buildLocalModuleEdges(workspaceRoot, graphFiles);
    const symbolEdges = await buildTypeScriptSymbolEdges(workspaceRoot, graphFiles, moduleEdges);
    return { moduleEdges, symbolEdges };
  }

  if (changedPaths.size === 0) {
    return {
      moduleEdges: previousIndex.moduleEdges,
      symbolEdges: previousIndex.symbolEdges,
    };
  }

  const graphFilesByPath = new Map(indexedFiles.map((file) => [file.path, {
    absolutePath: resolve(workspaceRoot, file.path),
    path: file.path,
  }]));

  for (const file of changedGraphFiles) {
    graphFilesByPath.set(file.path, file);
  }

  const graphFiles = [...graphFilesByPath.values()];
  const rebuiltEdges = await buildLocalModuleEdges(workspaceRoot, graphFiles);
  const preservedEdges = previousIndex.moduleEdges.filter((edge) => !changedPaths.has(edge.fromPath));
  const moduleEdges = mergeModuleEdges(
    preservedEdges,
    rebuiltEdges.filter((edge) => changedPaths.has(edge.fromPath)),
  );
  const symbolEdges = [...changedPaths].some(isTypeScriptGraphSourcePath)
    ? await buildTypeScriptSymbolEdges(workspaceRoot, graphFiles, moduleEdges)
    : previousIndex.symbolEdges;

  return { moduleEdges, symbolEdges };
}

function isTypeScriptGraphSourcePath(path: string): boolean {
  return [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]
    .includes(extname(path).toLowerCase());
}

function isModuleResolutionConfigPath(path: string): boolean {
  const fileName = basename(path).toLowerCase();
  return fileName === "package.json"
    || fileName === "pnpm-workspace.yaml"
    || fileName === "pnpm-workspace.yml"
    || fileName === "tsconfig.json"
    || fileName === "jsconfig.json"
    || fileName.startsWith("tsconfig.")
    || fileName.startsWith("jsconfig.");
}

async function readAllModuleGraphFiles(
  workspaceRoot: string,
  indexedFiles: ContextIndexFile[],
  changedGraphFiles: ModuleGraphSourceFile[],
): Promise<ModuleGraphSourceFile[]> {
  const changedByPath = new Map(changedGraphFiles.map((file) => [file.path, file]));
  const graphFiles: ModuleGraphSourceFile[] = [];

  for (const file of indexedFiles) {
    const changed = changedByPath.get(file.path);

    if (changed) {
      graphFiles.push(changed);
      continue;
    }

    const content = await readModuleGraphFile(workspaceRoot, file.path);

    if (content) {
      graphFiles.push(content);
    }
  }

  return graphFiles;
}

async function readModuleGraphFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<ModuleGraphSourceFile | null> {
  const absolutePath = resolve(workspaceRoot, relativePath);

  try {
    const raw = await readFile(absolutePath, "utf8");
    return {
      absolutePath,
      content: raw.slice(0, MAX_FILE_READ_BYTES),
      path: relativePath,
    };
  } catch {
    return null;
  }
}

function mergeModuleEdges(
  preservedEdges: ContextIndexModuleEdge[],
  rebuiltEdges: ContextIndexModuleEdge[],
): ContextIndexModuleEdge[] {
  const edges = new Map<string, ContextIndexModuleEdge>();

  for (const edge of [...preservedEdges, ...rebuiltEdges]) {
    const key = `${edge.fromPath}\0${edge.toPath}\0${edge.kind}`;
    const existing = edges.get(key);

    if (!existing) {
      edges.set(key, edge);
      continue;
    }

    existing.symbols = [...new Set([...existing.symbols, ...edge.symbols])]
      .sort((left, right) => left.localeCompare(right));
  }

  return [...edges.values()].sort((left, right) =>
    left.fromPath.localeCompare(right.fromPath)
      || left.toPath.localeCompare(right.toPath)
      || left.kind.localeCompare(right.kind)
  );
}

function getCacheStatus(filesReused: number, filesRebuilt: number): ContextIndexCacheStatus {
  if (filesReused > 0 && filesRebuilt === 0) {
    return "reused";
  }

  if (filesReused > 0) {
    return "partial";
  }

  return "miss";
}

async function readContextIndex(absolutePath: string): Promise<ContextIndex | null> {
  let raw: string;

  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    return null;
  }

  try {
    return parseContextIndex(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function parseContextIndex(value: unknown): ContextIndex | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const version = readNumber(source.version, 0);

  if (!SUPPORTED_CONTEXT_INDEX_VERSIONS.has(version) || !Array.isArray(source.files)) {
    return null;
  }

  const stats = source.stats;

  if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
    return null;
  }

  const parsedStats = stats as Record<string, unknown>;
  const files = source.files.flatMap(parseContextIndexFile);
  const moduleEdges = Array.isArray(source.moduleEdges)
    ? source.moduleEdges.flatMap(parseContextIndexModuleEdge)
    : [];
  const symbolEdges = Array.isArray(source.symbolEdges)
    ? source.symbolEdges.flatMap(parseContextIndexModuleEdge)
    : [];
  const symbolCount = files.reduce((sum, file) => sum + file.symbols.length, 0);

  return {
    builtAt: typeof source.builtAt === "string" ? source.builtAt : "(unknown)",
    files,
    moduleEdges,
    moduleResolutionFingerprint: typeof source.moduleResolutionFingerprint === "string"
      ? source.moduleResolutionFingerprint
      : "",
    symbolEdges,
    stats: {
      bytesIndexed: readNumber(parsedStats.bytesIndexed, 0),
      cacheStatus: parseContextIndexCacheStatus(parsedStats.cacheStatus),
      filesIndexed: readNumber(parsedStats.filesIndexed, files.length),
      filesRebuilt: readNumber(parsedStats.filesRebuilt, files.length),
      filesScanned: readNumber(parsedStats.filesScanned, files.length),
      filesReused: readNumber(parsedStats.filesReused, 0),
      moduleEdges: readNumber(parsedStats.moduleEdges, moduleEdges.length),
      symbolEdges: readNumber(parsedStats.symbolEdges, symbolEdges.length),
      symbols: readNumber(parsedStats.symbols, symbolCount),
      truncated: parsedStats.truncated === true,
    },
    version,
  };
}

function parseContextIndexFile(value: unknown): ContextIndexFile[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const source = value as Record<string, unknown>;
  const tokens = source.tokens;

  if (typeof source.path !== "string" || !tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return [];
  }

  return [{
    bytes: readNumber(source.bytes, 0),
    mtimeMs: readNumber(source.mtimeMs, 0),
    path: source.path,
    preview: typeof source.preview === "string" ? source.preview : "",
    symbols: Array.isArray(source.symbols)
      ? source.symbols.flatMap(parseContextIndexSymbol)
      : [],
    tokenCount: readNumber(source.tokenCount, 0),
    tokens: Object.fromEntries(
      Object.entries(tokens as Record<string, unknown>).flatMap(([token, count]) => (
        typeof count === "number" && Number.isFinite(count) ? [[token, count]] : []
      )),
    ),
  }];
}

function parseContextIndexCacheStatus(value: unknown): ContextIndexCacheStatus {
  return value === "reused" || value === "partial" ? value : "miss";
}

function toContextIndexSymbol(symbol: WorkspaceSymbol): ContextIndexSymbol {
  return {
    exported: symbol.exported,
    kind: symbol.kind,
    line: symbol.line,
    name: symbol.name,
    signature: symbol.signature,
  };
}

function parseContextIndexSymbol(value: unknown): ContextIndexSymbol[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const source = value as Record<string, unknown>;

  if (
    typeof source.kind !== "string" ||
    typeof source.line !== "number" ||
    typeof source.name !== "string" ||
    typeof source.signature !== "string" ||
    !CONTEXT_INDEX_SYMBOL_KINDS.has(source.kind as ContextIndexSymbol["kind"])
  ) {
    return [];
  }

  return [{
    exported: source.exported === true,
    kind: source.kind as ContextIndexSymbol["kind"],
    line: Math.max(1, Math.floor(source.line)),
    name: source.name,
    signature: source.signature,
  }];
}

function parseContextIndexModuleEdge(value: unknown): ContextIndexModuleEdge[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const source = value as Record<string, unknown>;

  if (
    typeof source.fromPath !== "string" ||
    typeof source.toPath !== "string" ||
    typeof source.specifier !== "string" ||
    typeof source.kind !== "string" ||
    !MODULE_REFERENCE_KINDS.has(source.kind as LocalModuleReferenceKind)
  ) {
    return [];
  }

  return [{
    fromPath: source.fromPath,
    kind: source.kind as LocalModuleReferenceKind,
    specifier: source.specifier,
    symbols: Array.isArray(source.symbols)
      ? source.symbols.filter((symbol): symbol is string => typeof symbol === "string")
      : [],
    toPath: source.toPath,
  }];
}

function scoreIndexedFile(
  file: ContextIndexFile,
  query: string,
  terms: string[],
  docFrequency: Map<string, number>,
  documentCount: number,
): Omit<ContextIndexSearchResult, "graphDepth" | "graphRelations" | "graphScore" | "snippets" | "stale"> {
  const lowerQuery = query.toLowerCase();
  const lowerPath = file.path.toLowerCase();
  const lowerName = basename(file.path).toLowerCase();
  let pathScore = lowerPath.includes(lowerQuery) ? 35 : 0;
  let contentScore = 0;
  const symbolResult = scoreIndexedSymbols(file.symbols, query, terms);

  for (const term of terms) {
    if (lowerName.includes(term)) {
      pathScore += 12;
    } else if (lowerPath.includes(term)) {
      pathScore += 6;
    }

    const count = file.tokens[term] ?? 0;
    const frequency = docFrequency.get(term) ?? 0;
    const idf = Math.log(1 + documentCount / (1 + frequency));
    contentScore += Math.min(count, 10) * (2 + idf);
  }

  if (terms.length > 1 && terms.every((term) => (file.tokens[term] ?? 0) > 0 || lowerPath.includes(term))) {
    contentScore += 10;
  }

  if (file.preview.toLowerCase().includes(lowerQuery)) {
    contentScore += 12;
  }

  return {
    bytes: file.bytes,
    contentScore,
    exactSymbolMatch: symbolResult.exactMatch,
    path: file.path,
    pathScore,
    score: pathScore + contentScore + symbolResult.score,
    symbolMatches: symbolResult.matches,
    symbolScore: symbolResult.score,
  };
}

function scoreIndexedSymbols(
  symbols: ContextIndexSymbol[],
  query: string,
  terms: string[],
): { exactMatch: boolean; matches: string[]; score: number } {
  if (symbols.length === 0) {
    return {
      exactMatch: false,
      matches: [],
      score: 0,
    };
  }

  const lowerQuery = query.toLowerCase();
  const matches: Array<{ score: number; summary: string }> = [];
  let exactMatch = false;

  for (const symbol of symbols) {
    const lowerName = symbol.name.toLowerCase();
    const lowerKind = symbol.kind.toLowerCase();
    const lowerSignature = symbol.signature.toLowerCase();
    let score = 0;

    if (lowerName === lowerQuery) {
      exactMatch = true;
      score += 80;
    } else if (lowerName.includes(lowerQuery)) {
      score += 48;
    }

    if (lowerKind === lowerQuery) {
      score += 18;
    }

    if (lowerSignature.includes(lowerQuery)) {
      score += 12;
    }

    for (const term of terms) {
      if (lowerName.includes(term)) {
        score += 14;
      }
      if (lowerSignature.includes(term)) {
        score += 5;
      }
    }

    if (symbol.exported && score > 0) {
      score += 5;
    }

    if (score > 0) {
      matches.push({
        score,
        summary: formatIndexedSymbol(symbol),
      });
    }
  }

  matches.sort((left, right) => right.score - left.score || left.summary.localeCompare(right.summary));

  return {
    exactMatch,
    matches: matches.slice(0, 5).map((match) => match.summary),
    score: matches.slice(0, 5).reduce((sum, match) => sum + match.score, 0),
  };
}

function formatIndexedSymbol(symbol: ContextIndexSymbol): string {
  const exported = symbol.exported ? " exported" : "";
  return `${symbol.kind}${exported} ${symbol.name} line ${symbol.line} - ${symbol.signature}`;
}

function expandSearchWithModuleGraph(
  lexicalResults: ContextIndexSearchResult[],
  edges: ContextIndexModuleEdge[],
  fileByPath: Map<string, ContextIndexFile>,
  terms: string[],
  query: string,
): {
  graphExpanded: number;
  graphMaxDepth: number;
  graphRelations: number;
  results: ContextIndexSearchResult[];
} {
  if (lexicalResults.length === 0 || edges.length === 0) {
    return {
      graphExpanded: 0,
      graphMaxDepth: 0,
      graphRelations: 0,
      results: lexicalResults,
    };
  }

  const resultsByPath = new Map(lexicalResults.map((result) => [result.path, result]));
  const seeds = [...lexicalResults]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_GRAPH_SEEDS);
  const neighborsByPath = buildGraphNeighbors(edges);
  const visitedDepth = new Map(seeds.map((seed) => [seed.path, 0]));
  const exactDefinitionScore = getExactDefinitionScore(lexicalResults, fileByPath, query);
  let frontier: GraphTraversalNode[] = seeds.map((seed) => ({
    depth: 0,
    path: seed.path,
    seedScore: Math.max(1, seed.pathScore + seed.contentScore),
  }));
  let graphExpanded = 0;
  let graphMaxDepth = 0;
  let graphRelations = 0;

  for (let depth = 1; depth <= MAX_GRAPH_DEPTH && frontier.length > 0; depth += 1) {
    const candidates = frontier
      .flatMap((node) => (neighborsByPath.get(node.path) ?? [])
        .filter((item) => item.path !== node.parentPath)
        .map((item): GraphTraversalCandidate => ({
          ...item,
          depth,
          parentPath: node.path,
          score: scoreGraphRelation(node.seedScore, depth, item.edge, item.path, terms),
          seedScore: node.seedScore,
          symbolMatches: countGraphSymbolMatches(item.edge, terms),
        })))
      .sort(compareGraphTraversalCandidates);
    const nextFrontier = new Map<string, GraphTraversalNode>();

    for (const item of candidates) {
      if (graphRelations >= MAX_GRAPH_RELATIONS) {
        break;
      }

      let result = resultsByPath.get(item.path);

      if (!result) {
        if (graphExpanded >= MAX_GRAPH_EXPANSIONS) {
          continue;
        }

        const file = fileByPath.get(item.path);

        if (!file) {
          continue;
        }

        result = {
          bytes: file.bytes,
          contentScore: 0,
          exactSymbolMatch: false,
          graphDepth: depth,
          graphRelations: [],
          graphScore: 0,
          path: file.path,
          pathScore: 0,
          score: 0,
          snippets: formatPreviewSnippets(file.preview),
          stale: false,
          symbolMatches: file.symbols.slice(0, 5).map(formatIndexedSymbol),
          symbolScore: 0,
        };
        resultsByPath.set(item.path, result);
        graphExpanded += 1;
        graphMaxDepth = Math.max(graphMaxDepth, depth);
      }

      const graphScore = result.graphDepth > 0 && exactDefinitionScore !== null
        ? Math.min(item.score, Math.max(1, exactDefinitionScore - 0.01))
        : item.score;
      result.graphScore = Math.max(result.graphScore, graphScore);
      result.score = Math.max(
        result.pathScore + result.contentScore + result.symbolScore,
        result.graphScore,
      );

      if (
        result.graphRelations.length < MAX_GRAPH_RELATIONS_PER_RESULT
        && !result.graphRelations.includes(item.relation)
      ) {
        result.graphRelations.push(item.relation);
        graphRelations += 1;
      }

      const previousDepth = visitedDepth.get(item.path);

      if (previousDepth === undefined) {
        visitedDepth.set(item.path, depth);
        nextFrontier.set(item.path, {
          depth,
          parentPath: item.parentPath,
          path: item.path,
          seedScore: item.seedScore,
        });
      } else if (previousDepth === depth) {
        const queued = nextFrontier.get(item.path);

        if (queued && item.seedScore > queued.seedScore) {
          queued.parentPath = item.parentPath;
          queued.seedScore = item.seedScore;
        }
      }
    }

    frontier = [...nextFrontier.values()];
  }

  return {
    graphExpanded,
    graphMaxDepth,
    graphRelations,
    results: [...resultsByPath.values()],
  };
}

type GraphNeighbor = {
  edge: ContextIndexModuleEdge;
  path: string;
  relation: string;
};

type GraphTraversalNode = {
  depth: number;
  parentPath?: string;
  path: string;
  seedScore: number;
};

type GraphTraversalCandidate = GraphNeighbor & {
  depth: number;
  parentPath: string;
  score: number;
  seedScore: number;
  symbolMatches: number;
};

function buildGraphNeighbors(edges: ContextIndexModuleEdge[]): Map<string, GraphNeighbor[]> {
  const neighbors = new Map<string, GraphNeighbor[]>();

  for (const edge of edges) {
    appendGraphNeighbor(neighbors, edge.fromPath, {
      edge,
      path: edge.toPath,
      relation: formatGraphRelation(edge, "dependency"),
    });
    appendGraphNeighbor(neighbors, edge.toPath, {
      edge,
      path: edge.fromPath,
      relation: formatGraphRelation(edge, "caller"),
    });
  }

  return neighbors;
}

function appendGraphNeighbor(
  neighbors: Map<string, GraphNeighbor[]>,
  path: string,
  neighbor: GraphNeighbor,
): void {
  const existing = neighbors.get(path);

  if (existing) {
    existing.push(neighbor);
  } else {
    neighbors.set(path, [neighbor]);
  }
}

function compareGraphTraversalCandidates(
  left: GraphTraversalCandidate,
  right: GraphTraversalCandidate,
): number {
  return right.symbolMatches - left.symbolMatches
    || right.score - left.score
    || Number(isTestFile(right.path)) - Number(isTestFile(left.path))
    || left.path.localeCompare(right.path)
    || left.relation.localeCompare(right.relation);
}

function scoreGraphRelation(
  seedScore: number,
  depth: number,
  edge: ContextIndexModuleEdge,
  path: string,
  terms: string[],
): number {
  const depthFactor = depth === 1 ? 0.68 : 0.42;
  const symbolBoost = Math.min(6, countGraphSymbolMatches(edge, terms) * 2);
  const testBoost = isTestFile(path) ? 1.5 : 0;
  return Math.max(1, seedScore * depthFactor + symbolBoost + testBoost);
}

function countGraphSymbolMatches(edge: ContextIndexModuleEdge, terms: string[]): number {
  const symbolTerms = new Set(edge.symbols.flatMap(tokenizeIndexText));
  return terms.filter((term) => symbolTerms.has(term)).length;
}

function getExactDefinitionScore(
  lexicalResults: ContextIndexSearchResult[],
  fileByPath: Map<string, ContextIndexFile>,
  query: string,
): number | null {
  const lowerQuery = query.toLowerCase();
  const scores = lexicalResults
    .filter((result) => fileByPath.get(result.path)?.symbols.some(
      (symbol) => symbol.name.toLowerCase() === lowerQuery,
    ))
    .map((result) => result.score);

  return scores.length > 0 ? Math.min(...scores) : null;
}

function isTestFile(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return /(^|\/)(?:__tests__|test|tests)(\/|$)/.test(lowerPath)
    || /\.(?:spec|test)\.[^/]+$/.test(lowerPath);
}

function formatGraphRelation(edge: ContextIndexModuleEdge, direction: "caller" | "dependency"): string {
  const symbolSuffix = edge.symbols.length > 0
    ? ` (${edge.symbols.slice(0, 6).join(", ")}${edge.symbols.length > 6 ? ", ..." : ""})`
    : "";

  if (direction === "dependency") {
    return `imported by ${edge.fromPath} via ${edge.kind}${symbolSuffix}`;
  }

  return `imports ${edge.toPath} via ${edge.kind}${symbolSuffix}`;
}

async function extractLiveSnippets(
  workspaceRoot: string,
  relativePath: string,
  query: string,
  terms: string[],
  indexedMtimeMs: number,
): Promise<{ snippets: string[]; stale: boolean }> {
  const root = resolve(workspaceRoot);
  const targetPath = resolve(root, relativePath);

  if (!isInsideWorkspace(root, targetPath)) {
    return { snippets: [], stale: true };
  }

  let raw: string;
  let targetStat: Awaited<ReturnType<typeof stat>>;

  try {
    targetStat = await stat(targetPath);
    raw = await readFile(targetPath, "utf8");
  } catch {
    return { snippets: [], stale: true };
  }

  const snippets: string[] = [];
  const lowerQuery = query.toLowerCase();
  const lines = raw.slice(0, MAX_FILE_READ_BYTES).split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const normalized = line.toLowerCase();

    if (!normalized.includes(lowerQuery) && !terms.some((term) => normalized.includes(term))) {
      continue;
    }

    snippets.push(`line ${index + 1}: ${truncateOneLine(line.trim(), 180)}`);

    if (snippets.length >= MAX_SNIPPETS_PER_RESULT) {
      break;
    }
  }

  return {
    snippets,
    stale: targetStat.mtimeMs !== indexedMtimeMs,
  };
}

function buildDocumentFrequency(files: ContextIndexFile[], terms: string[]): Map<string, number> {
  const frequency = new Map<string, number>();

  for (const term of terms) {
    frequency.set(term, files.filter((file) => (file.tokens[term] ?? 0) > 0).length);
  }

  return frequency;
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function tokenizeSearchQuery(query: string): string[] {
  const tokens = tokenizeIndexText(query);

  if (tokens.length > 0) {
    return [...new Set(tokens)];
  }

  return [query.toLowerCase()];
}

function tokenizeIndexText(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_$.-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
}

const STOP_WORDS = new Set([
  "and",
  "are",
  "const",
  "for",
  "from",
  "function",
  "import",
  "return",
  "the",
  "this",
  "type",
  "with",
]);

function buildPreview(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => truncateOneLine(line, 180))
    .join("\n");
}

function formatPreviewSnippets(preview: string): string[] {
  if (!preview.trim()) {
    return [];
  }

  return preview.split(/\r?\n/).slice(0, MAX_SNIPPETS_PER_RESULT).map((line) => `preview: ${line}`);
}

function getContextIndexPaths(workspaceRoot: string): {
  absoluteDir: string;
  absolutePath: string;
  relativePath: string;
} {
  const root = resolve(workspaceRoot);
  const relativePath = normalizeRelativePath(join(CONTEXT_INDEX_DIR, CONTEXT_INDEX_FILE));

  return {
    absoluteDir: resolve(root, CONTEXT_INDEX_DIR),
    absolutePath: resolve(root, relativePath),
    relativePath,
  };
}

function isTextFileName(name: string): boolean {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relativePath = relative(workspaceRoot, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value)));
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...[truncated]`;
}
