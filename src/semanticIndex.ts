import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { EmbeddingProvider } from "./embeddingProvider.js";
import { shouldExcludeWorkspaceEntry } from "./tools/listFiles.js";

const SEMANTIC_INDEX_VERSION = 2;
const SEMANTIC_INDEX_MODEL = "local-hash-v1";
const SEMANTIC_INDEX_DIMENSIONS = 128;
const SEMANTIC_INDEX_DIR = ".ccagent/index";
const SEMANTIC_INDEX_FILE = "semantic-index.json";
const MAX_FILES_SCANNED = 1_500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILE_READ_BYTES = 128 * 1024;
const MAX_PROVIDER_INPUT_CHARS = 24_000;
const PROVIDER_BATCH_SIZE = 32;
const CHUNK_LINE_COUNT = 80;
const CHUNK_OVERLAP_LINES = 10;
const MAX_CHUNKS_PER_FILE = 256;
const MAX_RESULTS = 25;
const MAX_SNIPPETS_PER_RESULT = 3;
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

export type SemanticIndexFile = {
  bytes: number;
  contentHash: string;
  mtimeMs: number;
  path: string;
  chunks: SemanticIndexChunk[];
};

export type SemanticIndexChunk = {
  endLine: number;
  featureCount: number;
  preview: string;
  startLine: number;
  vector: number[];
};

export type SemanticIndexProvider = "local" | "openai";
export type SemanticIndexCacheStatus = "miss" | "partial" | "reused";

export type SemanticIndex = {
  builtAt: string;
  dimensions: number;
  files: SemanticIndexFile[];
  model: string;
  provider: SemanticIndexProvider;
  providerBaseURL?: string;
  stats: {
    bytesIndexed: number;
    cacheStatus: SemanticIndexCacheStatus;
    chunksIndexed: number;
    chunksRebuilt: number;
    chunksReused: number;
    filesIndexed: number;
    filesRebuilt: number;
    filesScanned: number;
    filesReused: number;
    truncated: boolean;
  };
  version: number;
};

export type SemanticIndexSearchResult = {
  bytes: number;
  chunkIndex: number;
  endLine: number;
  path: string;
  pathScore: number;
  score: number;
  similarity: number;
  snippets: string[];
  startLine: number;
  stale: boolean;
};

export type SemanticIndexSearch = {
  index: SemanticIndex;
  path: string;
  query: string;
  results: SemanticIndexSearchResult[];
};

export type SemanticIndexStatus =
  | {
      exists: false;
      path: string;
    }
  | {
      exists: true;
      index: SemanticIndex;
      path: string;
    };

export type SemanticIndexOptions = {
  provider?: EmbeddingProvider;
};

type SemanticSourceFile = {
  bytes: number;
  contentHash: string;
  chunks: SemanticSourceChunk[];
  mtimeMs: number;
  path: string;
};

type SemanticSourceChunk = {
  content: string;
  endLine: number;
  preview: string;
  startLine: number;
};

export async function buildSemanticIndex(workspaceRoot: string): Promise<{
  index: SemanticIndex;
  path: string;
}>;
export async function buildSemanticIndex(
  workspaceRoot: string,
  options: SemanticIndexOptions,
): Promise<{
  index: SemanticIndex;
  path: string;
}>;
export async function buildSemanticIndex(
  workspaceRoot: string,
  options: SemanticIndexOptions = {},
): Promise<{
  index: SemanticIndex;
  path: string;
}> {
  const root = resolve(workspaceRoot);
  const paths = getSemanticIndexPaths(root);
  const previousIndex = await readSemanticIndex(paths.absolutePath);
  const files: string[] = [];
  const truncated = await collectIndexableFiles(root, root, files);
  const sourceFiles: SemanticSourceFile[] = [];
  let bytesIndexed = 0;

  for (const filePath of files) {
    const source = await readSourceFile(root, filePath);

    if (!source) {
      continue;
    }

    sourceFiles.push(source);
    bytesIndexed += source.bytes;
  }

  const provider = options.provider?.source ?? "local";
  const model = options.provider?.model ?? SEMANTIC_INDEX_MODEL;
  const providerBaseURL = normalizeProviderBaseURL(options.provider?.baseURL);
  const reusableFiles = findReusableFiles(sourceFiles, previousIndex, provider, model, providerBaseURL);
  const filesToRebuild = sourceFiles.filter((file) => !reusableFiles.has(file.path));
  const rebuiltFiles = options.provider
    ? await indexFilesWithProvider(filesToRebuild, options.provider)
    : indexFilesLocally(filesToRebuild);
  const reusedFiles = sourceFiles
    .filter((file) => reusableFiles.has(file.path))
    .map((file) => reuseIndexedFile(file, reusableFiles.get(file.path)!));
  const indexedFiles = [...reusedFiles, ...rebuiltFiles];
  const dimensions = indexedFiles[0]?.chunks[0]?.vector.length ?? (
    options.provider ? 0 : SEMANTIC_INDEX_DIMENSIONS
  );
  validateIndexDimensions(indexedFiles, dimensions);
  const filesReused = reusedFiles.length;
  const chunksReused = reusedFiles.reduce((sum, file) => sum + file.chunks.length, 0);
  const filesRebuilt = rebuiltFiles.length;
  const chunksRebuilt = rebuiltFiles.reduce((sum, file) => sum + file.chunks.length, 0);
  const index: SemanticIndex = {
    builtAt: new Date().toISOString(),
    dimensions,
    files: indexedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    model,
    provider,
    ...(providerBaseURL ? { providerBaseURL } : {}),
    stats: {
      bytesIndexed,
      cacheStatus: getCacheStatus(filesReused, filesRebuilt),
      chunksIndexed: indexedFiles.reduce((sum, file) => sum + file.chunks.length, 0),
      chunksRebuilt,
      chunksReused,
      filesIndexed: indexedFiles.length,
      filesRebuilt,
      filesScanned: files.length,
      filesReused,
      truncated,
    },
    version: SEMANTIC_INDEX_VERSION,
  };

  await mkdir(paths.absoluteDir, { recursive: true });
  await writeFile(paths.absolutePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  return {
    index,
    path: paths.relativePath,
  };
}

export async function getSemanticIndexStatus(workspaceRoot: string): Promise<SemanticIndexStatus> {
  const paths = getSemanticIndexPaths(workspaceRoot);
  const index = await readSemanticIndex(paths.absolutePath);

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

export async function searchSemanticIndex(
  workspaceRoot: string,
  query: string,
  limit = 10,
  options: SemanticIndexOptions = {},
): Promise<SemanticIndexSearch | null> {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new Error("Missing semantic index search query.");
  }

  const paths = getSemanticIndexPaths(workspaceRoot);
  const index = await readSemanticIndex(paths.absolutePath);

  if (!index) {
    return null;
  }

  const queryVector = await buildQueryVector(index, trimmedQuery, options.provider);
  const queryTerms = tokenizeText(trimmedQuery);
  const candidates = index.files.flatMap((file) => (
    file.chunks.map((chunk, chunkIndex) => ({ chunk, chunkIndex, file }))
  ));
  const results = await Promise.all(
    candidates.map(async ({ chunk, chunkIndex, file }) => {
      const similarity = cosineSimilarity(queryVector, chunk.vector);
      const pathScore = scorePath(file.path, trimmedQuery, queryTerms);
      const score = similarity * 100 + pathScore;

      if (score <= 0.01) {
        return null;
      }

      const snippets = await extractLiveSnippets(
        workspaceRoot,
        file.path,
        trimmedQuery,
        queryTerms,
        chunk.startLine,
        chunk.endLine,
        file.mtimeMs,
      );

      return {
        bytes: file.bytes,
        chunkIndex,
        endLine: chunk.endLine,
        path: file.path,
        pathScore,
        score,
        similarity,
        snippets: snippets.snippets.length > 0
          ? snippets.snippets
          : formatPreviewSnippets(chunk.preview),
        startLine: chunk.startLine,
        stale: snippets.stale,
      };
    }),
  );

  return {
    index,
    path: paths.relativePath,
    query: trimmedQuery,
    results: results
      .filter((result): result is SemanticIndexSearchResult => result !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.path.localeCompare(right.path) ||
          left.startLine - right.startLine,
      )
      .slice(0, clampLimit(limit)),
  };
}

export function formatSemanticIndexBuild(result: { index: SemanticIndex; path: string }): string {
  return [
    "Semantic vector index built",
    `Path: ${result.path}`,
    `Built at: ${result.index.builtAt}`,
    `Model: ${result.index.model}`,
    `Provider: ${result.index.provider}`,
    `Dimensions: ${result.index.dimensions}`,
    `Files indexed: ${result.index.stats.filesIndexed}`,
    `Chunks indexed: ${result.index.stats.chunksIndexed}`,
    `Cache: ${result.index.stats.cacheStatus}`,
    `Files reused: ${result.index.stats.filesReused}`,
    `Chunks reused: ${result.index.stats.chunksReused}`,
    `Files rebuilt: ${result.index.stats.filesRebuilt}`,
    `Chunks rebuilt: ${result.index.stats.chunksRebuilt}`,
    `Files scanned: ${result.index.stats.filesScanned}${result.index.stats.truncated ? " (truncated)" : ""}`,
    `Bytes indexed: ${result.index.stats.bytesIndexed}`,
  ].join("\n");
}

export function formatSemanticIndexStatus(status: SemanticIndexStatus): string {
  if (!status.exists) {
    return [
      "Semantic vector index status",
      "Status: missing",
      `Path: ${status.path}`,
      "Next: /index semantic build",
    ].join("\n");
  }

  return [
    "Semantic vector index status",
    "Status: ready",
    `Path: ${status.path}`,
    `Built at: ${status.index.builtAt}`,
    `Version: ${status.index.version}`,
    `Model: ${status.index.model}`,
    `Provider: ${status.index.provider}`,
    `Dimensions: ${status.index.dimensions}`,
    `Files indexed: ${status.index.stats.filesIndexed}`,
    `Chunks indexed: ${status.index.stats.chunksIndexed}`,
    `Cache: ${status.index.stats.cacheStatus}`,
    `Files reused: ${status.index.stats.filesReused}`,
    `Chunks reused: ${status.index.stats.chunksReused}`,
    `Files rebuilt: ${status.index.stats.filesRebuilt}`,
    `Chunks rebuilt: ${status.index.stats.chunksRebuilt}`,
    `Files scanned: ${status.index.stats.filesScanned}${status.index.stats.truncated ? " (truncated)" : ""}`,
    `Bytes indexed: ${status.index.stats.bytesIndexed}`,
  ].join("\n");
}

export function formatSemanticIndexSearch(search: SemanticIndexSearch | null, query: string): string {
  if (!search) {
    return [
      `Semantic vector search: ${query}`,
      "Status: missing index",
      "Next: /index semantic build",
    ].join("\n");
  }

  const lines = [
    `Semantic vector search: ${search.query}`,
    `Index: ${search.path}`,
    `Built at: ${search.index.builtAt}`,
    `Model: ${search.index.model}`,
    `Provider: ${search.index.provider}`,
    `Dimensions: ${search.index.dimensions}`,
    `Files indexed: ${search.index.stats.filesIndexed}`,
    `Chunks indexed: ${search.index.stats.chunksIndexed}`,
    "",
  ];

  if (search.results.length === 0) {
    lines.push("No matching semantic files found.");
    return lines.join("\n");
  }

  search.results.forEach((result, index) => {
    const stale = result.stale ? " stale" : "";
    lines.push(
      `${index + 1}. ${result.path}:${result.startLine}-${result.endLine} (score ${result.score.toFixed(2)}; similarity ${result.similarity.toFixed(3)}, path ${result.pathScore.toFixed(2)}${stale})`,
    );

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

async function readSourceFile(workspaceRoot: string, filePath: string): Promise<SemanticSourceFile | null> {
  if (!isInsideWorkspace(workspaceRoot, filePath)) {
    return null;
  }

  const fileStat = await stat(filePath);
  const relativePath = normalizeRelativePath(relative(workspaceRoot, filePath));
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const content = raw.slice(0, MAX_FILE_READ_BYTES);
  return {
    bytes: fileStat.size,
    contentHash: hashContent(raw),
    chunks: buildSourceChunks(content),
    mtimeMs: Math.floor(fileStat.mtimeMs),
    path: relativePath,
  };
}

function findReusableFiles(
  sourceFiles: SemanticSourceFile[],
  previousIndex: SemanticIndex | null,
  provider: SemanticIndexProvider,
  model: string,
  providerBaseURL: string | undefined,
): Map<string, SemanticIndexFile> {
  const reusable = new Map<string, SemanticIndexFile>();

  if (!previousIndex || previousIndex.provider !== provider || previousIndex.model !== model) {
    return reusable;
  }

  if (normalizeProviderBaseURL(previousIndex.providerBaseURL) !== providerBaseURL) {
    return reusable;
  }

  if (provider === "local" && previousIndex.dimensions !== SEMANTIC_INDEX_DIMENSIONS) {
    return reusable;
  }

  const previousByPath = new Map(previousIndex.files.map((file) => [file.path, file]));

  for (const source of sourceFiles) {
    const previousFile = previousByPath.get(source.path);

    if (!previousFile || !canReuseIndexedFile(source, previousFile, previousIndex.dimensions)) {
      continue;
    }

    reusable.set(source.path, previousFile);
  }

  return reusable;
}

function canReuseIndexedFile(
  source: SemanticSourceFile,
  previousFile: SemanticIndexFile,
  dimensions: number,
): boolean {
  if (!previousFile.contentHash || previousFile.contentHash !== source.contentHash) {
    return false;
  }

  if (previousFile.bytes !== source.bytes || previousFile.chunks.length !== source.chunks.length) {
    return false;
  }

  return previousFile.chunks.every((chunk, index) => {
    const sourceChunk = source.chunks[index];

    return Boolean(sourceChunk) &&
      chunk.startLine === sourceChunk.startLine &&
      chunk.endLine === sourceChunk.endLine &&
      chunk.preview === sourceChunk.preview &&
      chunk.vector.length === dimensions;
  });
}

function reuseIndexedFile(source: SemanticSourceFile, previousFile: SemanticIndexFile): SemanticIndexFile {
  return {
    bytes: source.bytes,
    contentHash: source.contentHash,
    chunks: previousFile.chunks,
    mtimeMs: source.mtimeMs,
    path: source.path,
  };
}

function validateIndexDimensions(files: SemanticIndexFile[], dimensions: number): void {
  for (const file of files) {
    for (const chunk of file.chunks) {
      if (chunk.vector.length !== dimensions) {
        throw new Error(
          `Semantic index dimension mismatch for ${file.path}: expected ${dimensions}, got ${chunk.vector.length}.`,
        );
      }
    }
  }
}

function getCacheStatus(filesReused: number, filesRebuilt: number): SemanticIndexCacheStatus {
  if (filesReused > 0 && filesRebuilt === 0) {
    return "reused";
  }

  if (filesReused > 0) {
    return "partial";
  }

  return "miss";
}

function indexFilesLocally(files: SemanticSourceFile[]): SemanticIndexFile[] {
  return files.map((file) => {
    return {
      bytes: file.bytes,
      contentHash: file.contentHash,
      mtimeMs: file.mtimeMs,
      path: file.path,
      chunks: file.chunks.map((chunk) => {
        const features = buildFeatureVector({
          content: chunk.content,
          path: file.path,
        });

        return {
          endLine: chunk.endLine,
          featureCount: features.featureCount,
          preview: chunk.preview,
          startLine: chunk.startLine,
          vector: features.vector,
        };
      }),
    };
  });
}

async function indexFilesWithProvider(
  files: SemanticSourceFile[],
  provider: EmbeddingProvider,
): Promise<SemanticIndexFile[]> {
  const indexed: SemanticIndexFile[] = [];
  const inputs = files.flatMap((file) => (
    file.chunks.map((chunk) => ({ chunk, file }))
  ));
  const chunksByFile = new Map<string, SemanticIndexChunk[]>();
  let dimensions: number | undefined;

  for (let start = 0; start < inputs.length; start += PROVIDER_BATCH_SIZE) {
    const batch = inputs.slice(start, start + PROVIDER_BATCH_SIZE);
    const vectors = await provider.embedTexts(batch.map(({ chunk, file }) => (
      formatProviderEmbeddingInput(file.path, chunk)
    )));

    if (vectors.length !== batch.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vector(s) for ${batch.length} input(s).`);
    }

    for (const [index, { chunk, file }] of batch.entries()) {
      const vector = vectors[index] ?? [];

      if (vector.length === 0) {
        throw new Error(`Embedding provider returned an empty vector for ${file.path}.`);
      }

      if (dimensions === undefined) {
        dimensions = vector.length;
      } else if (vector.length !== dimensions) {
        throw new Error(
          `Embedding provider returned inconsistent dimensions: expected ${dimensions}, got ${vector.length}.`,
        );
      }

      const fileChunks = chunksByFile.get(file.path) ?? [];
      fileChunks.push({
        endLine: chunk.endLine,
        featureCount: approximateFeatureCount(chunk.content),
        preview: chunk.preview,
        startLine: chunk.startLine,
        vector,
      });
      chunksByFile.set(file.path, fileChunks);
    }
  }

  for (const file of files) {
    indexed.push({
      bytes: file.bytes,
      contentHash: file.contentHash,
      chunks: chunksByFile.get(file.path) ?? [],
      mtimeMs: file.mtimeMs,
      path: file.path,
    });
  }

  return indexed.filter((file) => file.chunks.length > 0);
}

function buildSourceChunks(content: string): SemanticSourceChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: SemanticSourceChunk[] = [];
  const step = CHUNK_LINE_COUNT - CHUNK_OVERLAP_LINES;

  for (let start = 0; start < lines.length && chunks.length < MAX_CHUNKS_PER_FILE; start += step) {
    const end = Math.min(lines.length, start + CHUNK_LINE_COUNT);
    const chunkLines = lines.slice(start, end);

    chunks.push({
      content: chunkLines.join("\n"),
      endLine: end,
      preview: buildPreview(chunkLines.join("\n")),
      startLine: start + 1,
    });

    if (end >= lines.length) {
      break;
    }
  }

  return chunks;
}

async function readSemanticIndex(absolutePath: string): Promise<SemanticIndex | null> {
  let raw: string;

  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    return null;
  }

  try {
    return parseSemanticIndex(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function parseSemanticIndex(value: unknown): SemanticIndex | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;

  if (source.version !== SEMANTIC_INDEX_VERSION || !Array.isArray(source.files)) {
    return null;
  }

  const stats = source.stats;

  if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
    return null;
  }

  const parsedStats = stats as Record<string, unknown>;
  const dimensions = readNumber(source.dimensions, SEMANTIC_INDEX_DIMENSIONS);
  const model = typeof source.model === "string" && source.model.trim()
    ? source.model.trim()
    : SEMANTIC_INDEX_MODEL;
  const provider = parseSemanticIndexProvider(source.provider, model);
  const files = source.files.flatMap((file) => parseSemanticIndexFile(file, dimensions));

  return {
    builtAt: typeof source.builtAt === "string" ? source.builtAt : "(unknown)",
    dimensions,
    files,
    model,
    provider,
    ...(typeof source.providerBaseURL === "string" && source.providerBaseURL.trim()
      ? { providerBaseURL: normalizeProviderBaseURL(source.providerBaseURL) }
      : {}),
    stats: {
      bytesIndexed: readNumber(parsedStats.bytesIndexed, 0),
      cacheStatus: parseSemanticIndexCacheStatus(parsedStats.cacheStatus),
      chunksIndexed: readNumber(
        parsedStats.chunksIndexed,
        files.reduce((sum, file) => sum + file.chunks.length, 0),
      ),
      chunksRebuilt: readNumber(parsedStats.chunksRebuilt, 0),
      chunksReused: readNumber(parsedStats.chunksReused, 0),
      filesIndexed: readNumber(parsedStats.filesIndexed, files.length),
      filesRebuilt: readNumber(parsedStats.filesRebuilt, files.length),
      filesScanned: readNumber(parsedStats.filesScanned, files.length),
      filesReused: readNumber(parsedStats.filesReused, 0),
      truncated: parsedStats.truncated === true,
    },
    version: SEMANTIC_INDEX_VERSION,
  };
}

function parseSemanticIndexFile(value: unknown, dimensions: number): SemanticIndexFile[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const source = value as Record<string, unknown>;

  if (typeof source.path !== "string") {
    return [];
  }

  if (Array.isArray(source.chunks)) {
    const chunks = source.chunks.flatMap((chunk) => parseSemanticIndexChunk(chunk, dimensions));

    if (chunks.length === 0) {
      return [];
    }

    return [{
      bytes: readNumber(source.bytes, 0),
      contentHash: typeof source.contentHash === "string" ? source.contentHash : "",
      chunks,
      mtimeMs: readNumber(source.mtimeMs, 0),
      path: source.path,
    }];
  }

  if (!Array.isArray(source.vector)) {
    return [];
  }

  const legacyChunk = parseSemanticIndexChunk({
    endLine: 1,
    featureCount: source.featureCount,
    preview: source.preview,
    startLine: 1,
    vector: source.vector,
  }, dimensions);

  if (legacyChunk.length === 0) {
    return [];
  }

  return [{
    bytes: readNumber(source.bytes, 0),
    contentHash: "",
    chunks: legacyChunk,
    mtimeMs: readNumber(source.mtimeMs, 0),
    path: source.path,
  }];
}

function parseSemanticIndexChunk(value: unknown, dimensions: number): SemanticIndexChunk[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const source = value as Record<string, unknown>;

  if (!Array.isArray(source.vector)) {
    return [];
  }

  const vector = source.vector.map((item) => readNumber(item, 0));

  if (vector.length !== dimensions) {
    return [];
  }

  return [{
    endLine: Math.max(1, Math.floor(readNumber(source.endLine, 1))),
    featureCount: readNumber(source.featureCount, 0),
    preview: typeof source.preview === "string" ? source.preview : "",
    startLine: Math.max(1, Math.floor(readNumber(source.startLine, 1))),
    vector,
  }];
}

async function buildQueryVector(
  index: SemanticIndex,
  query: string,
  provider: EmbeddingProvider | undefined,
): Promise<number[]> {
  if (index.provider === "openai") {
    if (!provider) {
      throw new Error(
        `Semantic index was built with provider model ${index.model}; set OPENAI_API_KEY and openai.embeddingModel to search it.`,
      );
    }

    if (provider.model !== index.model) {
      throw new Error(
        `Semantic index model mismatch: index=${index.model}, configured=${provider.model}.`,
      );
    }

    const indexBaseURL = normalizeProviderBaseURL(index.providerBaseURL);
    const providerBaseURL = normalizeProviderBaseURL(provider.baseURL);

    if (indexBaseURL && indexBaseURL !== providerBaseURL) {
      throw new Error(
        `Semantic index provider base URL mismatch: index=${indexBaseURL}, configured=${providerBaseURL || "(default)"}.`,
      );
    }

    const [vector] = await provider.embedTexts([query]);

    if (!vector || vector.length !== index.dimensions) {
      throw new Error(
        `Embedding provider returned a query vector with ${vector?.length ?? 0} dimensions; expected ${index.dimensions}.`,
      );
    }

    return vector;
  }

  return buildFeatureVector({
    content: query,
    path: query,
  }).vector;
}

function buildFeatureVector(input: { content: string; path: string }): {
  featureCount: number;
  vector: number[];
} {
  const features = new Map<string, number>();

  addTextFeatures(features, input.path, 3.5);
  addTextFeatures(features, basename(input.path), 4.5);
  addTextFeatures(features, input.content, 1);

  const vector = new Array<number>(SEMANTIC_INDEX_DIMENSIONS).fill(0);
  let featureCount = 0;

  for (const [feature, weight] of features.entries()) {
    const hash = hashString(feature);
    const index = hash % SEMANTIC_INDEX_DIMENSIONS;

    vector[index] += Math.log1p(weight);
    featureCount += weight;
  }

  normalizeVector(vector);

  return {
    featureCount: Math.round(featureCount),
    vector,
  };
}

function formatProviderEmbeddingInput(path: string, chunk: SemanticSourceChunk): string {
  return [
    `Path: ${path}`,
    `Lines: ${chunk.startLine}-${chunk.endLine}`,
    "",
    chunk.content.slice(0, MAX_PROVIDER_INPUT_CHARS),
  ].join("\n");
}

function approximateFeatureCount(content: string): number {
  return Math.max(1, tokenizeText(content).length);
}

function addTextFeatures(features: Map<string, number>, text: string, baseWeight: number): void {
  const tokens = tokenizeText(text);

  for (const token of tokens) {
    addFeature(features, `tok:${token}`, baseWeight * 2.5);

    for (const concept of semanticConceptsForToken(token)) {
      addFeature(features, `sem:${concept}`, baseWeight * 2);
    }

    for (const gram of tokenCharacterGrams(token)) {
      addFeature(features, `gram:${gram}`, baseWeight * 0.35);
    }
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    addFeature(features, `pair:${tokens[index]}:${tokens[index + 1]}`, baseWeight * 1.2);
  }
}

function addFeature(features: Map<string, number>, feature: string, weight: number): void {
  features.set(feature, (features.get(feature) ?? 0) + weight);
}

function tokenizeText(value: string): string[] {
  const tokens = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_$.-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));

  return [...new Set(tokens)];
}

function semanticConceptsForToken(token: string): string[] {
  return SEMANTIC_CONCEPTS.get(token) ?? [];
}

function tokenCharacterGrams(token: string): string[] {
  if (token.length <= 3) {
    return [token];
  }

  const grams: string[] = [];

  for (let index = 0; index <= token.length - 3; index += 1) {
    grams.push(token.slice(index, index + 3));
  }

  return grams;
}

function normalizeVector(vector: number[]): void {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (norm === 0) {
    return;
  }

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = Number((vector[index] / norm).toFixed(6));
  }
}

function parseSemanticIndexProvider(value: unknown, model: string): SemanticIndexProvider {
  if (value === "openai" || value === "local") {
    return value;
  }

  return model === SEMANTIC_INDEX_MODEL ? "local" : "openai";
}

function parseSemanticIndexCacheStatus(value: unknown): SemanticIndexCacheStatus {
  if (value === "reused" || value === "partial") {
    return value;
  }

  return "miss";
}

function cosineSimilarity(left: number[], right: number[]): number {
  let sum = 0;

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    sum += left[index] * right[index];
  }

  return Math.max(0, sum);
}

function scorePath(path: string, query: string, terms: string[]): number {
  const lowerPath = path.toLowerCase();
  const lowerName = basename(path).toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = lowerPath.includes(lowerQuery) ? 20 : 0;

  for (const term of terms) {
    if (lowerName.includes(term)) {
      score += 8;
    } else if (lowerPath.includes(term)) {
      score += 4;
    }
  }

  return score;
}

async function extractLiveSnippets(
  workspaceRoot: string,
  relativePath: string,
  query: string,
  terms: string[],
  startLine: number,
  endLine: number,
  indexedMtimeMs: number,
): Promise<{ snippets: string[]; stale: boolean }> {
  const root = resolve(workspaceRoot);
  const targetPath = resolve(root, relativePath);

  if (!isInsideWorkspace(root, targetPath)) {
    return { snippets: [], stale: true };
  }

  let raw: string;
  let stale = false;

  try {
    const targetStat = await stat(targetPath);
    stale = Math.floor(targetStat.mtimeMs) !== indexedMtimeMs;
    raw = await readFile(targetPath, "utf8");
  } catch {
    return { snippets: [], stale: true };
  }

  const snippets: string[] = [];
  const lowerQuery = query.toLowerCase();
  const semanticTerms = new Set([
    ...terms,
    ...terms.flatMap((term) => semanticConceptsForToken(term)),
  ]);
  const lines = raw.slice(0, MAX_FILE_READ_BYTES).split(/\r?\n/).slice(startLine - 1, endLine);

  for (const [index, line] of lines.entries()) {
    const normalized = line.toLowerCase();

    if (
      !normalized.includes(lowerQuery) &&
      ![...semanticTerms].some((term) => normalized.includes(term))
    ) {
      continue;
    }

    snippets.push(`line ${startLine + index}: ${truncateOneLine(line.trim(), 180)}`);

    if (snippets.length >= MAX_SNIPPETS_PER_RESULT) {
      break;
    }
  }

  return { snippets, stale };
}

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

function getSemanticIndexPaths(workspaceRoot: string): {
  absoluteDir: string;
  absolutePath: string;
  relativePath: string;
} {
  const root = resolve(workspaceRoot);
  const relativePath = normalizeRelativePath(join(SEMANTIC_INDEX_DIR, SEMANTIC_INDEX_FILE));

  return {
    absoluteDir: resolve(root, SEMANTIC_INDEX_DIR),
    absolutePath: resolve(root, relativePath),
    relativePath,
  };
}

function normalizeProviderBaseURL(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, "");
}

function hashString(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function hashContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

const SEMANTIC_CONCEPTS = buildSemanticConcepts({
  approval: ["approval", "approve", "permission", "permissions", "policy", "safety"],
  command: ["cmd", "command", "commands", "prompt", "template", "templates"],
  context: ["context", "retrieval", "retrieve", "index", "search", "semantic", "symbol", "symbols"],
  editing: ["apply", "change", "diff", "edit", "patch", "replace", "undo"],
  evaluation: ["benchmark", "check", "ci", "eval", "evals", "gate", "regression", "test", "tests"],
  provider: ["api", "chat", "model", "openai", "provider", "relay", "responses"],
  repair: ["failure", "fix", "repair", "rerun", "verify", "verification"],
  session: ["checkpoint", "compact", "compaction", "history", "session", "state"],
  streaming: ["delta", "stream", "streamed", "streaming"],
  tool: ["function", "registry", "schema", "tool", "tools"],
});

function buildSemanticConcepts(groups: Record<string, string[]>): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const [concept, terms] of Object.entries(groups)) {
    for (const term of terms) {
      result.set(term, [...(result.get(term) ?? []), concept]);
    }
  }

  return result;
}
