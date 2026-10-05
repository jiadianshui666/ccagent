import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  getContextIndexStatus,
  searchContextIndex,
} from "./contextIndex.js";
import { prepareAutomaticTaskContext } from "./taskContext.js";

const RETRIEVAL_EVAL_VERSION = 1;
const RETRIEVAL_EVAL_PATH = ".ccagent/retrieval-eval.json";
const DEFAULT_K = 5;
const MAX_K = 10;
const MAX_CASES = 100;
const DEFAULT_THRESHOLDS: RetrievalEvalThresholds = {
  automaticMrr: 0.5,
  automaticRecallAtK: 0.8,
  lexicalMrr: 0.5,
  lexicalRecallAtK: 0.8,
};

export type RetrievalEvalCase = {
  expected: string[];
  name: string;
  query: string;
};

export type RetrievalEvalThresholds = {
  automaticMrr: number;
  automaticRecallAtK: number;
  lexicalMrr: number;
  lexicalRecallAtK: number;
};

export type RetrievalEvalManifest = {
  cases: RetrievalEvalCase[];
  k: number;
  thresholds: RetrievalEvalThresholds;
  version: number;
};

export type RetrievalEvalManifestStatus = {
  exists: false;
  path: string;
} | {
  exists: true;
  manifest: RetrievalEvalManifest;
  path: string;
};

export type RetrievalEvalMetric = {
  hits: number;
  mrr: number;
  recallAtK: number;
  resultCount: number;
};

export type RetrievalEvalCaseResult = {
  automatic: RetrievalEvalMetric;
  automaticPaths: string[];
  expected: string[];
  lexical: RetrievalEvalMetric;
  lexicalPaths: string[];
  missingExpected: string[];
  name: string;
  query: string;
};

export type RetrievalEvalResult = {
  automatic: RetrievalEvalMetric;
  automaticPaths: string[];
  builtAt: string;
  cases: RetrievalEvalCaseResult[];
  indexPath: string;
  k: number;
  lexical: RetrievalEvalMetric;
  manifestPath: string;
  refreshed: boolean;
  retrievalMode: "hybrid" | "lexical";
  status: "fail" | "pass";
  thresholds: RetrievalEvalThresholds;
};

export async function initRetrievalEvalManifest(workspaceRoot: string): Promise<{
  created: boolean;
  manifest: RetrievalEvalManifest;
  path: string;
}> {
  const path = getRetrievalEvalManifestPath(workspaceRoot);
  const manifest = createDefaultRetrievalEvalManifest();

  try {
    const raw = await readFile(path, "utf8");
    return {
      created: false,
      manifest: parseRetrievalEvalManifest(JSON.parse(raw) as unknown),
      path: RETRIEVAL_EVAL_PATH,
    };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  return {
    created: true,
    manifest,
    path: RETRIEVAL_EVAL_PATH,
  };
}

export async function getRetrievalEvalManifestStatus(
  workspaceRoot: string,
): Promise<RetrievalEvalManifestStatus> {
  const path = getRetrievalEvalManifestPath(workspaceRoot);

  try {
    const raw = await readFile(path, "utf8");
    return {
      exists: true,
      manifest: parseRetrievalEvalManifest(JSON.parse(raw) as unknown),
      path: RETRIEVAL_EVAL_PATH,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        exists: false,
        path: RETRIEVAL_EVAL_PATH,
      };
    }

    throw error;
  }
}

export async function runRetrievalEval(workspaceRoot: string): Promise<RetrievalEvalResult> {
  const manifestStatus = await getRetrievalEvalManifestStatus(workspaceRoot);

  if (!manifestStatus.exists) {
    throw new Error(`Missing ${RETRIEVAL_EVAL_PATH}. Run /index eval init first.`);
  }

  const contextIndexStatus = await getContextIndexStatus(workspaceRoot);

  if (!contextIndexStatus.exists) {
    throw new Error("Missing context index. Run /index build before /index eval run.");
  }

  if (manifestStatus.manifest.cases.length === 0) {
    throw new Error(`${RETRIEVAL_EVAL_PATH} has no cases. Add at least one query and expected path.`);
  }

  const manifest = manifestStatus.manifest;
  const caseResults: RetrievalEvalCaseResult[] = [];
  let refreshed = false;
  let retrievalMode: "hybrid" | "lexical" = "lexical";
  let builtAt = contextIndexStatus.index.builtAt;
  let indexPath = RETRIEVAL_EVAL_PATH;

  for (const testCase of manifest.cases) {
    const automaticContext = await prepareAutomaticTaskContext(
      workspaceRoot,
      testCase.query,
      {
        maxChars: 12_000,
        maxFiles: manifest.k,
        refresh: false,
      },
    );
    const lexicalSearch = await searchContextIndex(workspaceRoot, testCase.query, manifest.k);

    if (!lexicalSearch) {
      throw new Error(`Context index disappeared while evaluating case ${testCase.name}.`);
    }

    const automaticPaths = automaticContext?.files ?? [];
    const lexicalPaths = lexicalSearch.results.map((result) => result.path);
    const missingExpected = testCase.expected.filter(
      (path) => !lexicalSearch.index.files.some((file) => file.path === path),
    );

    caseResults.push({
      automatic: calculateRetrievalMetric(automaticPaths, testCase.expected),
      automaticPaths,
      expected: testCase.expected,
      lexical: calculateRetrievalMetric(lexicalPaths, testCase.expected),
      lexicalPaths,
      missingExpected,
      name: testCase.name,
      query: testCase.query,
    });

    refreshed = refreshed || Boolean(automaticContext?.refreshed);
    retrievalMode = automaticContext?.retrievalMode ?? retrievalMode;
    builtAt = lexicalSearch.index.builtAt;
    indexPath = lexicalSearch.path;
  }

  const lexical = averageRetrievalMetric(caseResults.map((result) => result.lexical));
  const automatic = averageRetrievalMetric(caseResults.map((result) => result.automatic));
  const missingExpected = caseResults.some((result) => result.missingExpected.length > 0);
  const status = !missingExpected
    && lexical.recallAtK >= manifest.thresholds.lexicalRecallAtK
    && lexical.mrr >= manifest.thresholds.lexicalMrr
    && automatic.recallAtK >= manifest.thresholds.automaticRecallAtK
    && automatic.mrr >= manifest.thresholds.automaticMrr
    ? "pass"
    : "fail";

  return {
    automatic,
    automaticPaths: [...new Set(caseResults.flatMap((result) => result.automaticPaths))],
    builtAt,
    cases: caseResults,
    indexPath,
    k: manifest.k,
    lexical,
    manifestPath: manifestStatus.path,
    refreshed,
    retrievalMode,
    status,
    thresholds: manifest.thresholds,
  };
}

export function formatRetrievalEvalInit(result: {
  created: boolean;
  manifest: RetrievalEvalManifest;
  path: string;
}): string {
  return [
    result.created ? "Retrieval eval manifest initialized" : "Retrieval eval manifest already exists",
    `Path: ${result.path}`,
    `Cases: ${result.manifest.cases.length}`,
    `K: ${result.manifest.k}`,
    "Next: edit the manifest cases, build indexes, then run /index eval run",
  ].join("\n");
}

export function formatRetrievalEvalManifestStatus(status: RetrievalEvalManifestStatus): string {
  if (!status.exists) {
    return [
      "Retrieval eval manifest",
      "Status: missing",
      `Path: ${status.path}`,
      "Next: /index eval init",
    ].join("\n");
  }

  return [
    "Retrieval eval manifest",
    "Status: ready",
    `Path: ${status.path}`,
    `Version: ${status.manifest.version}`,
    `Cases: ${status.manifest.cases.length}`,
    `K: ${status.manifest.k}`,
    `Thresholds: lexical recall ${formatMetricValue(status.manifest.thresholds.lexicalRecallAtK)}, lexical MRR ${formatMetricValue(status.manifest.thresholds.lexicalMrr)}, automatic recall ${formatMetricValue(status.manifest.thresholds.automaticRecallAtK)}, automatic MRR ${formatMetricValue(status.manifest.thresholds.automaticMrr)}`,
  ].join("\n");
}

export function formatRetrievalEval(result: RetrievalEvalResult): string {
  const lines = [
    "Retrieval eval",
    `Status: ${result.status.toUpperCase()}`,
    `Manifest: ${result.manifestPath}`,
    `Index: ${result.indexPath}`,
    `Index built at: ${result.builtAt}`,
    `Retrieval mode: ${result.retrievalMode}`,
    `K: ${result.k}`,
    `Refreshed stale indexes: ${result.refreshed ? "yes" : "no"}`,
    "",
    `Lexical: recall@${result.k} ${formatMetricValue(result.lexical.recallAtK)}, MRR ${formatMetricValue(result.lexical.mrr)} (thresholds ${formatMetricValue(result.thresholds.lexicalRecallAtK)} / ${formatMetricValue(result.thresholds.lexicalMrr)})`,
    `Automatic: recall@${result.k} ${formatMetricValue(result.automatic.recallAtK)}, MRR ${formatMetricValue(result.automatic.mrr)} (thresholds ${formatMetricValue(result.thresholds.automaticRecallAtK)} / ${formatMetricValue(result.thresholds.automaticMrr)})`,
    "",
    "Cases:",
  ];

  for (const [index, testCase] of result.cases.entries()) {
    const missing = testCase.missingExpected.length > 0
      ? `; missing expected ${testCase.missingExpected.join(", ")}`
      : "";
    lines.push(
      `${index + 1}. ${testCase.name}: lexical ${formatMetricValue(testCase.lexical.recallAtK)}/${formatMetricValue(testCase.lexical.mrr)}, automatic ${formatMetricValue(testCase.automatic.recallAtK)}/${formatMetricValue(testCase.automatic.mrr)}${missing}`,
    );
    lines.push(`   query: ${testCase.query}`);
    lines.push(`   expected: ${testCase.expected.join(", ")}`);
    lines.push(`   lexical top: ${testCase.lexicalPaths.slice(0, result.k).join(", ") || "(none)"}`);
    lines.push(`   automatic top: ${testCase.automaticPaths.slice(0, result.k).join(", ") || "(none)"}`);
  }

  return lines.join("\n");
}

export function formatRetrievalEvalJson(result: RetrievalEvalResult): string {
  return JSON.stringify(result, null, 2);
}

export function createDefaultRetrievalEvalManifest(): RetrievalEvalManifest {
  return {
    cases: [],
    k: DEFAULT_K,
    thresholds: { ...DEFAULT_THRESHOLDS },
    version: RETRIEVAL_EVAL_VERSION,
  };
}

function getRetrievalEvalManifestPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, RETRIEVAL_EVAL_PATH);
}

function parseRetrievalEvalManifest(value: unknown): RetrievalEvalManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${RETRIEVAL_EVAL_PATH} must contain a JSON object.`);
  }

  const source = value as Record<string, unknown>;
  const version = readOptionalInteger(
    source.version,
    RETRIEVAL_EVAL_VERSION,
    `${RETRIEVAL_EVAL_PATH}.version`,
  );

  if (version !== RETRIEVAL_EVAL_VERSION) {
    throw new Error(`${RETRIEVAL_EVAL_PATH} has unsupported version ${version}.`);
  }

  const k = readOptionalInteger(source.k, DEFAULT_K, `${RETRIEVAL_EVAL_PATH}.k`);

  if (k < 1 || k > MAX_K) {
    throw new Error(`${RETRIEVAL_EVAL_PATH}.k must be an integer from 1 to ${MAX_K}.`);
  }

  if (!Array.isArray(source.cases)) {
    throw new Error(`${RETRIEVAL_EVAL_PATH}.cases must be an array.`);
  }

  if (source.cases.length === 0) {
    return {
      cases: [],
      k,
      thresholds: parseThresholds(source.thresholds),
      version,
    };
  }

  if (source.cases.length > MAX_CASES) {
    throw new Error(`${RETRIEVAL_EVAL_PATH}.cases cannot contain more than ${MAX_CASES} cases.`);
  }

  const names = new Set<string>();
  const cases = source.cases.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${RETRIEVAL_EVAL_PATH}.cases[${index}] must be an object.`);
    }

    const item = value as Record<string, unknown>;
    const name = readNonEmptyString(item.name, `${RETRIEVAL_EVAL_PATH}.cases[${index}].name`);
    const query = readNonEmptyString(item.query, `${RETRIEVAL_EVAL_PATH}.cases[${index}].query`);

    if (names.has(name)) {
      throw new Error(`${RETRIEVAL_EVAL_PATH} contains duplicate case name: ${name}.`);
    }

    names.add(name);

    if (!Array.isArray(item.expected) || item.expected.length === 0) {
      throw new Error(`${RETRIEVAL_EVAL_PATH}.cases[${index}].expected must contain at least one path.`);
    }

    const expected = item.expected.map((path, pathIndex) => {
      if (typeof path !== "string" || !path.trim()) {
        throw new Error(`${RETRIEVAL_EVAL_PATH}.cases[${index}].expected[${pathIndex}] must be a path.`);
      }

      const normalized = normalizeExpectedPath(path);

      if (!normalized) {
        throw new Error(`${RETRIEVAL_EVAL_PATH}.cases[${index}].expected[${pathIndex}] must stay inside the workspace.`);
      }

      return normalized;
    });

    return {
      expected: [...new Set(expected)],
      name,
      query,
    };
  });

  return {
    cases,
    k,
    thresholds: parseThresholds(source.thresholds),
    version,
  };
}

function parseThresholds(value: unknown): RetrievalEvalThresholds {
  if (value === undefined) {
    return { ...DEFAULT_THRESHOLDS };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${RETRIEVAL_EVAL_PATH}.thresholds must be an object.`);
  }

  const source = value as Record<string, unknown>;

  return {
    automaticMrr: readThreshold(source.automaticMrr, DEFAULT_THRESHOLDS.automaticMrr, "automaticMrr"),
    automaticRecallAtK: readThreshold(source.automaticRecallAtK, DEFAULT_THRESHOLDS.automaticRecallAtK, "automaticRecallAtK"),
    lexicalMrr: readThreshold(source.lexicalMrr, DEFAULT_THRESHOLDS.lexicalMrr, "lexicalMrr"),
    lexicalRecallAtK: readThreshold(source.lexicalRecallAtK, DEFAULT_THRESHOLDS.lexicalRecallAtK, "lexicalRecallAtK"),
  };
}

function calculateRetrievalMetric(paths: string[], expected: string[]): RetrievalEvalMetric {
  const expectedSet = new Set(expected);
  const topPaths = paths.slice(0, MAX_K);
  const hits = topPaths.filter((path) => expectedSet.has(path)).length;
  const firstRank = topPaths.findIndex((path) => expectedSet.has(path));

  return {
    hits,
    mrr: firstRank < 0 ? 0 : 1 / (firstRank + 1),
    recallAtK: hits / expected.length,
    resultCount: topPaths.length,
  };
}

function averageRetrievalMetric(metrics: RetrievalEvalMetric[]): RetrievalEvalMetric {
  if (metrics.length === 0) {
    return {
      hits: 0,
      mrr: 0,
      recallAtK: 0,
      resultCount: 0,
    };
  }

  return {
    hits: metrics.reduce((sum, metric) => sum + metric.hits, 0),
    mrr: metrics.reduce((sum, metric) => sum + metric.mrr, 0) / metrics.length,
    recallAtK: metrics.reduce((sum, metric) => sum + metric.recallAtK, 0) / metrics.length,
    resultCount: metrics.reduce((sum, metric) => sum + metric.resultCount, 0),
  };
}

function normalizeExpectedPath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");

  if (
    !normalized
    || isAbsolute(normalized)
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.split("/").includes("..")
  ) {
    return null;
  }

  return normalized.replace(/^\.\//, "");
}

function readOptionalInteger(value: unknown, fallback: number, path: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer.`);
  }

  return value;
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }

  return value.trim();
}

function readThreshold(value: unknown, fallback: number, name: string): number {
  const threshold = value === undefined ? fallback : value;

  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`${RETRIEVAL_EVAL_PATH}.thresholds.${name} must be a number from 0 to 1.`);
  }

  return threshold;
}

function formatMetricValue(value: number): string {
  return value.toFixed(3);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
