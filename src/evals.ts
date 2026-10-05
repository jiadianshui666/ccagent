import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Agent } from "./agent.js";
import { buildContextIndex, searchContextIndex } from "./contextIndex.js";
import { MockModelClient, type ModelClient, type ModelResult, type ModelTurnInput } from "./model.js";
import { buildSemanticIndex } from "./semanticIndex.js";
import { prepareAutomaticTaskContext } from "./taskContext.js";
import { createDefaultToolRegistry } from "./tools/registry.js";
import { fetchWebPage, searchWeb } from "./web.js";

const execFileAsync = promisify(execFile);
const BENCHMARK_ITERATIONS = 3;

export const OFFLINE_EVAL_SUITE_NAMES = ["smoke", "regression", "benchmark"] as const;
export type OfflineEvalSuiteName = (typeof OFFLINE_EVAL_SUITE_NAMES)[number];
export const OFFLINE_EVAL_CASE_NAMES = [
  "list_files",
  "workspace_info",
  "read_file",
  "context_graph_retrieval",
  "plan_update",
  "replace_file",
  "task_replace_file",
  "missing_text_recovery",
  "repair_loop",
  "repair_loop_bad_patch_recovery",
  "repair_loop_wrong_file_recovery",
  "repair_loop_partial_multifile_recovery",
  "repair_loop_multifile",
  "repair_loop_service_contract",
  "repair_loop_renamed_api_contract",
  "repair_loop_stale_import_contract",
  "repair_loop_contract_drift",
  "repair_loop_multi_caller_contract_drift",
  "repair_loop_cascading_dependency_chain",
  "repair_loop_ambiguous_test_signal",
  "repair_loop_large_repo_retrieval",
  "repair_loop_process_cleanup",
  "repair_loop_service_readiness",
  "repair_loop_project_fixture",
  "verification_failure_strategies",
  "verification_environment_failures",
  "verification_flaky_guard",
  "web_fetch",
  "web_search",
] as const;
export type OfflineEvalCaseName = (typeof OFFLINE_EVAL_CASE_NAMES)[number];
export const OFFLINE_EVAL_CASE_TAG_NAMES = [
  "diagnostics",
  "editing",
  "multifile",
  "patch",
  "plan",
  "repair",
  "retrieval",
  "safety",
  "state",
  "tool",
  "verification",
  "web",
  "workspace",
] as const;
export type OfflineEvalCaseTag = (typeof OFFLINE_EVAL_CASE_TAG_NAMES)[number];

export type OfflineEvalStatus = "pass" | "fail" | "skip";

export type OfflineEvalCaseResult = {
  durationMs: number;
  name: string;
  status: OfflineEvalStatus;
  summary: string;
};

export type OfflineEvalSuiteResult = {
  durationMs: number;
  failed: number;
  iterations?: number;
  passed: number;
  results: OfflineEvalCaseResult[];
  suite: OfflineEvalSuiteName;
  skipped: number;
  tag?: OfflineEvalCaseTag;
};

export type OfflineEvalRunOptions = {
  iterations?: number;
  tag?: OfflineEvalCaseTag;
};

export type OfflineEvalSingleCaseResult = {
  caseName: OfflineEvalCaseName;
  durationMs: number;
  result: OfflineEvalCaseResult;
};

export type OfflineEvalCaseInfo = {
  description: string;
  name: OfflineEvalCaseName;
  suites: OfflineEvalSuiteName[];
  tags: OfflineEvalCaseTag[];
};

export type OfflineEvalCasesResult = {
  cases: OfflineEvalCaseInfo[];
  count: number;
  tag?: OfflineEvalCaseTag;
  suite?: OfflineEvalSuiteName;
};

export type OfflineEvalTagInfo = {
  cases: OfflineEvalCaseName[];
  count: number;
  name: OfflineEvalCaseTag;
  suites: OfflineEvalSuiteName[];
};

export type OfflineEvalTagsResult = {
  count: number;
  suite?: OfflineEvalSuiteName;
  tags: OfflineEvalTagInfo[];
};

export type OfflineEvalReportResult = {
  exportedAt: string;
  fileName: string;
  jsonFileName: string;
  jsonPath: string;
  path: string;
  result: OfflineEvalSuiteResult;
  suite: OfflineEvalSuiteName;
};

export type OfflineEvalReportSummary = {
  exportedAt: string;
  fileName: string;
  jsonFileName: string;
  jsonPath: string;
  path: string;
  result: OfflineEvalSuiteResult;
  suite: OfflineEvalSuiteName;
};

export type OfflineEvalComparisonStatus = "ok" | "regressed" | "informational";

export type OfflineEvalCaseComparison = {
  classification: "added" | "faster" | "removed" | "slower" | "status_changed" | "unchanged";
  durationDeltaMs?: number;
  leftDurationMs?: number;
  leftStatus?: OfflineEvalStatus;
  name: string;
  reasons: string[];
  regressed: boolean;
  rightDurationMs?: number;
  rightStatus?: OfflineEvalStatus;
};

export type OfflineEvalReportComparison = {
  cases: OfflineEvalCaseComparison[];
  coverage?: {
    missing: string[];
  };
  left: OfflineEvalReportSummary;
  maxDurationDeltaMs?: number;
  ok: true;
  right: OfflineEvalReportSummary;
  summary: {
    durationDeltaMs: number;
    failedDelta: number;
    notes: string[];
    passedDelta: number;
    regressions: string[];
    skippedDelta: number;
    status: OfflineEvalComparisonStatus;
  };
};

export type SaveOfflineEvalBaselineResult =
  | {
      jsonPath: string;
      ok: true;
      path: string;
      replaced: boolean;
      suite: OfflineEvalSuiteName;
    }
  | {
      error: string;
      ok: false;
    };

const OFFLINE_EVAL_SUITE_CASES: Record<Exclude<OfflineEvalSuiteName, "benchmark">, OfflineEvalCaseName[]> = {
  smoke: ["list_files", "workspace_info", "read_file"],
  regression: [
    "context_graph_retrieval",
    "plan_update",
    "replace_file",
    "task_replace_file",
    "missing_text_recovery",
    "repair_loop",
    "repair_loop_bad_patch_recovery",
    "repair_loop_wrong_file_recovery",
    "repair_loop_partial_multifile_recovery",
    "repair_loop_multifile",
    "repair_loop_service_contract",
    "repair_loop_renamed_api_contract",
    "repair_loop_stale_import_contract",
    "repair_loop_contract_drift",
    "repair_loop_multi_caller_contract_drift",
    "repair_loop_cascading_dependency_chain",
    "repair_loop_ambiguous_test_signal",
    "repair_loop_large_repo_retrieval",
    "repair_loop_process_cleanup",
    "repair_loop_service_readiness",
    "repair_loop_project_fixture",
    "verification_failure_strategies",
    "verification_environment_failures",
    "verification_flaky_guard",
    "web_fetch",
    "web_search",
  ],
};

const OFFLINE_EVAL_CASE_RUNNERS: Record<OfflineEvalCaseName, () => Promise<string>> = {
  context_graph_retrieval: evalContextGraphRetrieval,
  list_files: evalListFiles,
  missing_text_recovery: evalMissingTextRecovery,
  plan_update: evalPlanUpdate,
  read_file: evalReadFile,
  replace_file: evalReplaceFile,
  repair_loop: evalRepairLoop,
  repair_loop_bad_patch_recovery: evalRepairLoopBadPatchRecovery,
  repair_loop_wrong_file_recovery: evalRepairLoopWrongFileRecovery,
  repair_loop_partial_multifile_recovery: evalRepairLoopPartialMultifileRecovery,
  repair_loop_multifile: evalRepairLoopMultifile,
  repair_loop_service_contract: evalRepairLoopServiceContract,
  repair_loop_renamed_api_contract: evalRepairLoopRenamedApiContract,
  repair_loop_stale_import_contract: evalRepairLoopStaleImportContract,
  repair_loop_contract_drift: evalRepairLoopContractDrift,
  repair_loop_multi_caller_contract_drift: evalRepairLoopMultiCallerContractDrift,
  repair_loop_cascading_dependency_chain: evalRepairLoopCascadingDependencyChain,
  repair_loop_ambiguous_test_signal: evalRepairLoopAmbiguousTestSignal,
  repair_loop_large_repo_retrieval: evalRepairLoopLargeRepoRetrieval,
  repair_loop_process_cleanup: evalRepairLoopProcessCleanup,
  repair_loop_service_readiness: evalRepairLoopServiceReadiness,
  repair_loop_project_fixture: evalRepairLoopProjectFixture,
  task_replace_file: evalTaskReplaceFile,
  verification_failure_strategies: evalVerificationFailureStrategies,
  verification_environment_failures: evalVerificationEnvironmentFailures,
  verification_flaky_guard: evalVerificationFlakyGuard,
  web_fetch: evalWebFetch,
  web_search: evalWebSearch,
  workspace_info: evalWorkspaceInfo,
};

const OFFLINE_EVAL_CASE_DESCRIPTIONS: Record<OfflineEvalCaseName, string> = {
  context_graph_retrieval: "Measures exact-definition ranking, depth-two graph recall, and hybrid recall with repository distractors.",
  list_files: "Lists workspace files through the list_files tool.",
  missing_text_recovery: "Verifies missing replacement text is reported without applying a patch.",
  plan_update: "Updates the in-memory task plan through update_plan.",
  read_file: "Reads a fixture file through the read_file tool.",
  replace_file: "Applies a direct single-file replacement patch.",
  repair_loop: "Runs a two-attempt repair loop until verification passes.",
  repair_loop_bad_patch_recovery: "Continues a repair loop after a malformed patch attempt and recovers on the next attempt.",
  repair_loop_wrong_file_recovery: "Continues a repair loop after an applied patch edits the wrong file and recovers on the next attempt.",
  repair_loop_partial_multifile_recovery: "Continues a repair loop after a partial multi-file fix and completes the remaining edit.",
  repair_loop_multifile: "Applies a multi-file repair patch and reruns verification.",
  repair_loop_service_contract: "Repairs a service/API contract across multiple source files and checks task resume context.",
  repair_loop_renamed_api_contract: "Repairs a stale caller after an API export is renamed in another module.",
  repair_loop_stale_import_contract: "Repairs a stale import path after a dependency moves to another module folder.",
  repair_loop_contract_drift: "Repairs a caller after a cross-file function contract changes from positional args to object args.",
  repair_loop_multi_caller_contract_drift: "Repairs multiple callers after a shared function contract changes.",
  repair_loop_cascading_dependency_chain: "Resolves cascading contract failures across a checkout dependency chain over multiple repair attempts.",
  repair_loop_ambiguous_test_signal: "Uses a command-referenced test to repair an ambiguous failure without editing a generated artifact.",
  repair_loop_large_repo_retrieval: "Uses fair context retrieval to repair two late-sorted modules behind more than 500 distractor files.",
  repair_loop_process_cleanup: "Repairs a test service that passes assertions but leaks a server process and times out.",
  repair_loop_service_readiness: "Repairs a local integration test that probes a delayed service before it is ready.",
  repair_loop_project_fixture: "Repairs a larger project fixture across business modules and verifies the project test command.",
  task_replace_file: "Runs a planned task workflow that reads and patches a file.",
  verification_failure_strategies: "Checks repair strategies for TypeScript, Node test, and npm script failures.",
  verification_environment_failures: "Diagnoses missing environment variables, port conflicts, network failures, and missing system commands before source repair.",
  verification_flaky_guard: "Classifies mixed verification outcomes as flaky and blocks automated source repair.",
  web_fetch: "Fetches a local HTML page and converts it to readable plain text with the title extracted.",
  web_search: "Parses DuckDuckGo result HTML into titled, snippet-bearing results with redirect URLs decoded.",
  workspace_info: "Summarizes workspace markers through the workspace_info tool.",
};

const OFFLINE_EVAL_CASE_TAGS: Record<OfflineEvalCaseName, OfflineEvalCaseTag[]> = {
  context_graph_retrieval: ["retrieval", "workspace"],
  list_files: ["tool", "workspace"],
  missing_text_recovery: ["editing", "patch", "safety"],
  plan_update: ["plan", "state"],
  read_file: ["tool", "workspace"],
  replace_file: ["editing", "patch"],
  repair_loop: ["repair", "verification"],
  repair_loop_bad_patch_recovery: ["diagnostics", "patch", "repair", "verification"],
  repair_loop_wrong_file_recovery: ["editing", "patch", "repair", "verification"],
  repair_loop_partial_multifile_recovery: ["editing", "multifile", "patch", "repair", "verification"],
  repair_loop_multifile: ["editing", "multifile", "patch", "repair", "verification"],
  repair_loop_service_contract: ["editing", "multifile", "patch", "repair", "state", "verification"],
  repair_loop_renamed_api_contract: ["editing", "multifile", "patch", "repair", "verification"],
  repair_loop_stale_import_contract: ["editing", "multifile", "patch", "repair", "verification"],
  repair_loop_contract_drift: ["editing", "multifile", "patch", "repair", "verification"],
  repair_loop_multi_caller_contract_drift: ["editing", "multifile", "patch", "repair", "verification"],
  repair_loop_cascading_dependency_chain: ["editing", "multifile", "patch", "repair", "verification"],
  repair_loop_ambiguous_test_signal: ["diagnostics", "editing", "patch", "repair", "verification"],
  repair_loop_large_repo_retrieval: ["diagnostics", "editing", "multifile", "patch", "repair", "verification", "workspace"],
  repair_loop_process_cleanup: ["diagnostics", "editing", "patch", "repair", "safety", "verification"],
  repair_loop_service_readiness: ["diagnostics", "editing", "patch", "repair", "safety", "verification"],
  repair_loop_project_fixture: ["editing", "multifile", "patch", "repair", "state", "verification"],
  task_replace_file: ["editing", "patch", "plan"],
  verification_failure_strategies: ["diagnostics", "repair", "verification"],
  verification_environment_failures: ["diagnostics", "repair", "safety", "verification"],
  verification_flaky_guard: ["diagnostics", "repair", "safety", "state", "verification"],
  web_fetch: ["web"],
  web_search: ["retrieval", "web"],
  workspace_info: ["tool", "workspace"],
};

class SkipEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipEvalError";
  }
}

export async function runOfflineEvals(
  suite: OfflineEvalSuiteName = "smoke",
  options: OfflineEvalRunOptions = {},
): Promise<OfflineEvalSuiteResult> {
  if (suite === "benchmark") {
    return runOfflineBenchmark(options);
  }

  if (options.iterations !== undefined) {
    throw new RangeError("iterations is only supported for the benchmark suite");
  }

  return runOfflineSuite(suite, options);
}

export async function runOfflineEvalCase(name: OfflineEvalCaseName): Promise<OfflineEvalSingleCaseResult> {
  const startedAt = Date.now();
  const result = await runEvalCaseByName(name);

  return {
    caseName: name,
    durationMs: Date.now() - startedAt,
    result,
  };
}

export function listOfflineEvalCases(
  suite?: OfflineEvalSuiteName,
  tag?: OfflineEvalCaseTag,
): OfflineEvalCasesResult {
  const allCases = OFFLINE_EVAL_CASE_NAMES.map((name) => ({
    description: OFFLINE_EVAL_CASE_DESCRIPTIONS[name],
    name,
    suites: getOfflineEvalCaseSuites(name),
    tags: OFFLINE_EVAL_CASE_TAGS[name],
  }));
  const cases = allCases.filter((item) =>
    (!suite || item.suites.includes(suite)) &&
    (!tag || item.tags.includes(tag)),
  );

  return {
    cases,
    count: cases.length,
    ...(tag ? { tag } : {}),
    ...(suite ? { suite } : {}),
  };
}

export function listOfflineEvalTags(suite?: OfflineEvalSuiteName): OfflineEvalTagsResult {
  const cases = listOfflineEvalCases(suite).cases;
  const tags = OFFLINE_EVAL_CASE_TAG_NAMES
    .map((name) => {
      const taggedCases = cases.filter((item) => item.tags.includes(name));

      return {
        cases: taggedCases.map((item) => item.name),
        count: taggedCases.length,
        name,
        suites: uniqueEvalSuites(taggedCases.flatMap((item) => item.suites)),
      };
    })
    .filter((item) => item.count > 0);

  return {
    count: tags.length,
    tags,
    ...(suite ? { suite } : {}),
  };
}

async function runOfflineSuite(
  suite: Exclude<OfflineEvalSuiteName, "benchmark">,
  options: OfflineEvalRunOptions = {},
): Promise<OfflineEvalSuiteResult> {
  const startedAt = Date.now();
  const results: OfflineEvalCaseResult[] = [];
  const caseNames = filterOfflineEvalCaseNames(OFFLINE_EVAL_SUITE_CASES[suite], options.tag);

  for (const caseName of caseNames) {
    results.push(await runEvalCaseByName(caseName));
  }

  return {
    durationMs: Date.now() - startedAt,
    failed: results.filter((result) => result.status === "fail").length,
    passed: results.filter((result) => result.status === "pass").length,
    results,
    suite,
    skipped: results.filter((result) => result.status === "skip").length,
    ...(options.tag ? { tag: options.tag } : {}),
  };
}

export async function exportOfflineEvalsReport(
  workspaceRoot: string,
  suite: OfflineEvalSuiteName = "benchmark",
  options: OfflineEvalRunOptions = {},
): Promise<OfflineEvalReportResult> {
  const result = await runOfflineEvals(suite, options);
  const exportedAt = new Date().toISOString();
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileName = `eval-report-${suite}-${formatExportTimestamp(exportedAt)}.md`;
  const jsonFileName = `eval-report-${suite}-${formatExportTimestamp(exportedAt)}.json`;
  const path = join(reportsDir, fileName);
  const jsonPath = join(reportsDir, jsonFileName);
  const content = buildOfflineEvalMarkdownReport({
    exportedAt,
    result,
    suite,
  });
  const report = {
    exportedAt,
    fileName,
    jsonFileName,
    jsonPath: `.ccagent/reports/${jsonFileName}`,
    path: `.ccagent/reports/${fileName}`,
    result,
    suite,
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(path, content, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return report;
}

async function runOfflineBenchmark(options: OfflineEvalRunOptions = {}): Promise<OfflineEvalSuiteResult> {
  const startedAt = Date.now();
  const iterations = resolveBenchmarkIterations(options.iterations);
  const benchmarkCaseNames = filterOfflineEvalCaseNames(
    [
      ...OFFLINE_EVAL_SUITE_CASES.smoke,
      ...OFFLINE_EVAL_SUITE_CASES.regression,
    ],
    options.tag,
  );
  const caseRuns = new Map<OfflineEvalCaseName, OfflineEvalCaseResult[]>(
    benchmarkCaseNames.map((caseName) => [caseName, []]),
  );

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const caseName of benchmarkCaseNames) {
      const result = await runEvalCaseByName(caseName);
      caseRuns.get(caseName)?.push(result);
    }
  }

  const results = benchmarkCaseNames.map((caseName) =>
    summarizeBenchmarkCase(caseName, caseRuns.get(caseName) ?? []),
  );

  return {
    durationMs: Date.now() - startedAt,
    failed: results.filter((result) => result.status === "fail").length,
    iterations,
    passed: results.filter((result) => result.status === "pass").length,
    results,
    suite: "benchmark",
    skipped: results.filter((result) => result.status === "skip").length,
    ...(options.tag ? { tag: options.tag } : {}),
  };
}

function resolveBenchmarkIterations(value: number | undefined): number {
  const iterations = value ?? BENCHMARK_ITERATIONS;

  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
    throw new RangeError("benchmark iterations must be an integer between 1 and 20");
  }

  return iterations;
}

export function formatOfflineEvals(result: OfflineEvalSuiteResult): string {
  const lines = [`Offline evals (${result.suite})`];

  if (result.iterations !== undefined) {
    lines.push(`Duration: ${result.durationMs}ms total`);
    lines.push(`Average iteration: ${Math.round(result.durationMs / result.iterations)}ms`);
    lines.push(`Iterations: ${result.iterations}`);
  } else {
    lines.push(`Duration: ${result.durationMs}ms`);
  }

  if (result.tag) {
    lines.push(`Tag: ${result.tag}`);
  }

  lines.push(`Passed: ${result.passed}`);
  lines.push(`Failed: ${result.failed}`);
  lines.push(`Skipped: ${result.skipped}`);

  if (result.iterations !== undefined) {
    lines.push("");
    lines.push("Benchmark case durations are averaged across iterations.");
  }

  lines.push("");
  lines.push(...result.results.map(formatEvalCaseLine));

  return lines.join("\n");
}

export function formatOfflineEvalsJson(result: OfflineEvalSuiteResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatOfflineEvalCase(result: OfflineEvalSingleCaseResult): string {
  return [
    `Offline eval case (${result.caseName})`,
    `Duration: ${result.durationMs}ms`,
    `Status: ${result.result.status.toUpperCase()}`,
    "",
    formatEvalCaseLine(result.result),
  ].join("\n");
}

export function formatOfflineEvalCaseJson(result: OfflineEvalSingleCaseResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatOfflineEvalCases(result: OfflineEvalCasesResult): string {
  return [
    "Offline eval cases",
    ...(result.suite ? [`Suite: ${result.suite}`] : []),
    ...(result.tag ? [`Tag: ${result.tag}`] : []),
    `Count: ${result.count}`,
    "",
    ...result.cases.map((item) =>
      [
        `- ${item.name}`,
        `  suites: ${item.suites.join(", ")}`,
        `  tags: ${item.tags.join(", ")}`,
        `  description: ${item.description}`,
      ].join("\n"),
    ),
  ].join("\n");
}

export function formatOfflineEvalCasesJson(result: OfflineEvalCasesResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatOfflineEvalTags(result: OfflineEvalTagsResult): string {
  return [
    "Offline eval tags",
    ...(result.suite ? [`Suite: ${result.suite}`] : []),
    `Count: ${result.count}`,
    "",
    ...result.tags.map((item) =>
      [
        `- ${item.name}`,
        `  cases: ${item.count}`,
        `  suites: ${item.suites.join(", ")}`,
        `  case names: ${item.cases.join(", ")}`,
      ].join("\n"),
    ),
  ].join("\n");
}

export function formatOfflineEvalTagsJson(result: OfflineEvalTagsResult): string {
  return JSON.stringify(result, null, 2);
}

function formatEvalCaseLine(item: OfflineEvalCaseResult): string {
  const label = item.status.toUpperCase().padEnd(4);
  return `[${label}] ${item.name} (${item.durationMs}ms): ${item.summary}`;
}

function getOfflineEvalCaseSuites(name: OfflineEvalCaseName): OfflineEvalSuiteName[] {
  const suites: OfflineEvalSuiteName[] = [];

  if (OFFLINE_EVAL_SUITE_CASES.smoke.includes(name)) {
    suites.push("smoke");
  }

  if (OFFLINE_EVAL_SUITE_CASES.regression.includes(name)) {
    suites.push("regression");
  }

  suites.push("benchmark");

  return suites;
}

function filterOfflineEvalCaseNames(
  names: OfflineEvalCaseName[],
  tag?: OfflineEvalCaseTag,
): OfflineEvalCaseName[] {
  return names.filter((name) => !tag || OFFLINE_EVAL_CASE_TAGS[name].includes(tag));
}

function uniqueEvalSuites(suites: OfflineEvalSuiteName[]): OfflineEvalSuiteName[] {
  return OFFLINE_EVAL_SUITE_NAMES.filter((suite) => suites.includes(suite));
}

export function formatOfflineEvalsReport(report: OfflineEvalReportResult): string {
  const lines = [
    "Exported eval report",
    `Path: ${report.path}`,
    `JSON: ${report.jsonPath}`,
    `Suite: ${report.suite}`,
    `Duration: ${report.result.durationMs}ms${report.result.iterations !== undefined ? " total" : ""}`,
    `Passed: ${report.result.passed}`,
    `Failed: ${report.result.failed}`,
    `Skipped: ${report.result.skipped}`,
  ];

  if (report.result.iterations !== undefined) {
    lines.push(`Iterations: ${report.result.iterations}`);
    lines.push(`Average iteration: ${Math.round(report.result.durationMs / report.result.iterations)}ms`);
  }

  lines.push(`Cases: ${report.result.results.length}`);

  return lines.join("\n");
}

export function formatOfflineEvalsReportJson(report: OfflineEvalReportResult): string {
  return JSON.stringify(report, null, 2);
}

export function formatOfflineEvalBaseline(
  result: Extract<SaveOfflineEvalBaselineResult, { ok: true }>,
): string {
  return [
    result.replaced ? "Replaced eval baseline" : "Saved eval baseline",
    `Suite: ${result.suite}`,
    `Markdown: ${result.path}`,
    `JSON: ${result.jsonPath}`,
    "",
    'Gate against it with: /evals gate --against baseline-' + result.suite,
  ].join("\n");
}

export async function listOfflineEvalReports(
  workspaceRoot: string,
  limit = 10,
): Promise<OfflineEvalReportSummary[]> {
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileNames = await findOfflineEvalReportJsonFiles(reportsDir);
  const reports = await Promise.all(
    fileNames.map((fileName) => readOfflineEvalReportJson(workspaceRoot, fileName)),
  );

  return reports
    .filter((report): report is OfflineEvalReportSummary => report !== null)
    .sort((left, right) => left.exportedAt.localeCompare(right.exportedAt))
    .slice(-limit)
    .reverse();
}

export function formatOfflineEvalReports(reports: OfflineEvalReportSummary[]): string {
  const lines = [
    "Eval reports",
    `Count: ${reports.length}`,
    "",
  ];

  if (reports.length === 0) {
    lines.push("No eval reports found in .ccagent/reports/.");
    return lines.join("\n");
  }

  reports.forEach((report, index) => {
    lines.push(
      `${index + 1}. ${report.suite} ${report.exportedAt} duration=${report.result.durationMs}ms passed=${report.result.passed} failed=${report.result.failed} skipped=${report.result.skipped}`,
    );
    lines.push(`   ${report.path}`);
  });

  return lines.join("\n");
}

export function formatOfflineEvalReportsJson(reports: OfflineEvalReportSummary[]): string {
  return JSON.stringify({ reports }, null, 2);
}

export async function compareOfflineEvalReports(
  workspaceRoot: string,
  leftName?: string,
  rightName?: string,
  maxDurationDeltaMs?: number,
): Promise<
  | OfflineEvalReportComparison
  | {
      ok: false;
      error: string;
    }
> {
  const reports = await listOfflineEvalReports(workspaceRoot, 100);

  if (leftName || rightName) {
    if (!leftName || !rightName) {
      return {
        ok: false,
        error: "Usage: /evals compare [left.json] [right.json] [--max-duration-delta <ms>]",
      };
    }

    const left = await readNamedOfflineEvalReport(workspaceRoot, leftName);
    const right = await readNamedOfflineEvalReport(workspaceRoot, rightName);

    if (!left || !right) {
      return {
        ok: false,
        error: "Eval report not found. Use /evals reports to list available reports.",
      };
    }

    return {
      ...buildOfflineEvalReportComparison(left, right, maxDurationDeltaMs),
    };
  }

  if (reports.length < 2) {
    return {
      ok: false,
      error: "Need at least two eval reports in .ccagent/reports/. Run /evals report twice first.",
    };
  }

  return {
    ...buildOfflineEvalReportComparison(
      reports[1] as OfflineEvalReportSummary,
      reports[0] as OfflineEvalReportSummary,
      maxDurationDeltaMs,
    ),
  };
}

export async function compareOfflineEvalReportAgainstLatest(
  workspaceRoot: string,
  baselineName: string,
  maxDurationDeltaMs?: number,
): Promise<
  | OfflineEvalReportComparison
  | {
      ok: false;
      error: string;
    }
> {
  const baseline = await readNamedOfflineEvalReport(workspaceRoot, baselineName);

  if (!baseline) {
    return {
      ok: false,
      error: `Eval report "${baselineName}" not found. Use /evals reports to list available reports.`,
    };
  }

  const reports = await listOfflineEvalReports(workspaceRoot, 100);
  const latest = reports.find((report) => report.jsonFileName !== baseline.jsonFileName);

  if (!latest) {
    return {
      ok: false,
      error: `No eval report to compare against "${baselineName}". Run "/evals report" first.`,
    };
  }

  return {
    ...buildOfflineEvalGateComparison(baseline, latest, maxDurationDeltaMs),
  };
}

export async function compareOfflineEvalReportsForGate(
  workspaceRoot: string,
  baselineName?: string,
  maxDurationDeltaMs?: number,
): Promise<
  | OfflineEvalReportComparison
  | {
      ok: false;
      error: string;
    }
> {
  if (baselineName !== undefined) {
    return compareOfflineEvalReportAgainstLatest(workspaceRoot, baselineName, maxDurationDeltaMs);
  }

  const reports = await listOfflineEvalReports(workspaceRoot, 100);

  if (reports.length < 2) {
    return {
      ok: false,
      error: "Need at least two eval reports in .ccagent/reports/. Run /evals report twice first.",
    };
  }

  return {
    ...buildOfflineEvalGateComparison(
      reports[1] as OfflineEvalReportSummary,
      reports[0] as OfflineEvalReportSummary,
      maxDurationDeltaMs,
    ),
  };
}

export function buildOfflineEvalGateComparison(
  left: OfflineEvalReportSummary,
  right: OfflineEvalReportSummary,
  maxDurationDeltaMs?: number,
): OfflineEvalReportComparison {
  const comparison = buildOfflineEvalReportComparison(left, right, maxDurationDeltaMs);
  const missing = checkOfflineEvalCoverage(right);

  if (missing.length > 0) {
    comparison.coverage = { missing };
    comparison.summary.regressions.push(
      `coverage: missing expected cases: ${missing.join(", ")}`,
    );

    if (comparison.summary.status === "ok") {
      comparison.summary.status = "regressed";
    }
  }

  return comparison;
}

export function checkOfflineEvalCoverage(report: OfflineEvalReportSummary): string[] {
  if (report.result.tag !== undefined) {
    return [];
  }

  const expected =
    report.suite === "benchmark"
      ? OFFLINE_EVAL_SUITE_CASES.regression
      : OFFLINE_EVAL_SUITE_CASES[report.suite];
  const present = new Set(report.result.results.map((item) => item.name));

  return expected.filter((name) => !present.has(name));
}

export async function saveOfflineEvalBaseline(
  workspaceRoot: string,
  suite: OfflineEvalSuiteName = "smoke",
): Promise<SaveOfflineEvalBaselineResult> {
  const reports = await listOfflineEvalReports(workspaceRoot, 100);
  const latest = reports.find((report) => report.suite === suite);

  if (!latest) {
    return {
      ok: false,
      error: `No ${suite} eval report found. Run "/evals report${suite === "smoke" ? "" : " " + suite}" first.`,
    };
  }

  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const jsonFileName = `eval-baseline-${suite}.json`;
  const markdownFileName = `eval-baseline-${suite}.md`;
  const jsonPath = `.ccagent/reports/${jsonFileName}`;
  const path = `.ccagent/reports/${markdownFileName}`;
  let replaced = false;

  try {
    await readFile(join(reportsDir, jsonFileName), "utf8");
    replaced = true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      replaced = false;
    } else {
      throw error;
    }
  }

  const exportedAt = new Date().toISOString();
  const summary: OfflineEvalReportSummary = {
    exportedAt,
    fileName: markdownFileName,
    jsonFileName,
    jsonPath,
    path,
    result: latest.result,
    suite,
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, jsonFileName), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(
    join(reportsDir, markdownFileName),
    `Eval baseline (pinned copy of the latest ${suite} run)\n\n${formatOfflineEvalsReport(summary)}\n`,
    "utf8",
  );

  return {
    jsonPath,
    ok: true,
    path,
    replaced,
    suite,
  };
}

export function formatOfflineEvalReportComparison(
  comparison: OfflineEvalReportComparison,
): string {
  const lines = [
    "Eval report comparison",
    `Left: ${comparison.left.path}`,
    `Right: ${comparison.right.path}`,
    `Suite: ${comparison.left.suite} -> ${comparison.right.suite}`,
    `Status: ${formatComparisonStatus(comparison.summary.status)}`,
    ...(comparison.maxDurationDeltaMs !== undefined
      ? [`Duration threshold: ${comparison.maxDurationDeltaMs}ms`]
      : []),
    `Duration: ${comparison.left.result.durationMs}ms -> ${comparison.right.result.durationMs}ms (${formatSignedNumber(comparison.right.result.durationMs - comparison.left.result.durationMs)}ms)`,
    `Passed: ${comparison.left.result.passed} -> ${comparison.right.result.passed} (${formatSignedNumber(comparison.right.result.passed - comparison.left.result.passed)})`,
    `Failed: ${comparison.left.result.failed} -> ${comparison.right.result.failed} (${formatSignedNumber(comparison.right.result.failed - comparison.left.result.failed)})`,
    `Skipped: ${comparison.left.result.skipped} -> ${comparison.right.result.skipped} (${formatSignedNumber(comparison.right.result.skipped - comparison.left.result.skipped)})`,
    "",
    ...comparison.summary.notes.map((note) => `Note: ${note}`),
    ...(comparison.summary.notes.length > 0 ? [""] : []),
    ...(comparison.summary.regressions.length > 0
      ? ["Regressions:", ...comparison.summary.regressions.map((reason) => `- ${reason}`), ""]
      : ["Regressions: none", ""]),
    "| Case | Left ms | Right ms | Delta | Left status | Right status | Classification | Regression |",
    "| --- | ---: | ---: | ---: | --- | --- | --- | --- |",
  ];

  for (const item of comparison.cases) {
    lines.push(
      `| ${escapeMarkdownTableCell(item.name)} | ${item.leftDurationMs ?? "n/a"} | ${item.rightDurationMs ?? "n/a"} | ${item.durationDeltaMs !== undefined ? formatSignedNumber(item.durationDeltaMs) : "n/a"} | ${item.leftStatus ?? "n/a"} | ${item.rightStatus ?? "n/a"} | ${item.classification} | ${item.regressed ? "yes" : "no"} |`,
    );
  }

  return lines.join("\n");
}

export function formatOfflineEvalReportComparisonJson(
  comparison: OfflineEvalReportComparison,
): string {
  return JSON.stringify(comparison, null, 2);
}

function buildOfflineEvalReportComparison(
  left: OfflineEvalReportSummary,
  right: OfflineEvalReportSummary,
  maxDurationDeltaMs?: number,
): OfflineEvalReportComparison {
  const sameSuite = left.suite === right.suite;
  const durationDeltaMs = right.result.durationMs - left.result.durationMs;
  const passedDelta = right.result.passed - left.result.passed;
  const failedDelta = right.result.failed - left.result.failed;
  const skippedDelta = right.result.skipped - left.result.skipped;
  const notes: string[] = [];
  const regressions: string[] = [];
  const cases = compareOfflineEvalCases(left, right, sameSuite, maxDurationDeltaMs);

  if (!sameSuite) {
    notes.push("Suites differ; regression status is informational. Compare reports from the same suite for gating.");
  } else {
    if (passedDelta < 0) {
      regressions.push(`passed count decreased by ${Math.abs(passedDelta)}`);
    }

    if (failedDelta > 0) {
      regressions.push(`failed count increased by ${failedDelta}`);
    }

    if (skippedDelta > 0) {
      regressions.push(`skipped count increased by ${skippedDelta}`);
    }

    if (maxDurationDeltaMs !== undefined && durationDeltaMs > maxDurationDeltaMs) {
      regressions.push(
        `total duration increased by ${formatSignedNumber(durationDeltaMs)}ms, above threshold ${maxDurationDeltaMs}ms`,
      );
    }

    for (const item of cases) {
      if (item.regressed) {
        regressions.push(
          `${item.name}: ${item.reasons.join("; ")}`,
        );
      }
    }
  }

  return {
    cases,
    left,
    maxDurationDeltaMs,
    ok: true,
    right,
    summary: {
      durationDeltaMs,
      failedDelta,
      notes,
      passedDelta,
      regressions,
      skippedDelta,
      status: sameSuite ? (regressions.length > 0 ? "regressed" : "ok") : "informational",
    },
  };
}

function compareOfflineEvalCases(
  left: OfflineEvalReportSummary,
  right: OfflineEvalReportSummary,
  sameSuite: boolean,
  maxDurationDeltaMs?: number,
): OfflineEvalCaseComparison[] {
  const leftCases = new Map(left.result.results.map((item) => [item.name, item]));
  const rightCases = new Map(right.result.results.map((item) => [item.name, item]));
  const caseNames = [...new Set([...leftCases.keys(), ...rightCases.keys()])].sort();

  return caseNames.map((name) => {
    const leftCase = leftCases.get(name);
    const rightCase = rightCases.get(name);
    const durationDeltaMs = leftCase && rightCase
      ? rightCase.durationMs - leftCase.durationMs
      : undefined;
    const reasons: string[] = [];

    if (!leftCase && rightCase) {
      if (sameSuite && rightCase.status === "fail") {
        reasons.push("new failing case");
      }

      return {
        classification: "added",
        leftDurationMs: undefined,
        leftStatus: undefined,
        name,
        reasons,
        regressed: reasons.length > 0,
        rightDurationMs: rightCase.durationMs,
        rightStatus: rightCase.status,
      };
    }

    if (leftCase && !rightCase) {
      if (sameSuite) {
        reasons.push("case was removed");
      }

      return {
        classification: "removed",
        leftDurationMs: leftCase.durationMs,
        leftStatus: leftCase.status,
        name,
        reasons,
        regressed: reasons.length > 0,
        rightDurationMs: undefined,
        rightStatus: undefined,
      };
    }

    if (!leftCase || !rightCase) {
      throw new Error(`Unexpected missing eval case while comparing ${name}`);
    }

    if (sameSuite && statusRank(rightCase.status) > statusRank(leftCase.status)) {
      reasons.push(`status regressed from ${leftCase.status} to ${rightCase.status}`);
    }

    if (
      sameSuite &&
      maxDurationDeltaMs !== undefined &&
      durationDeltaMs !== undefined &&
      durationDeltaMs > maxDurationDeltaMs
    ) {
      reasons.push(
        `duration increased by ${formatSignedNumber(durationDeltaMs)}ms, above threshold ${maxDurationDeltaMs}ms`,
      );
    }

    return {
      classification: classifyEvalCaseComparison(leftCase.status, rightCase.status, durationDeltaMs ?? 0),
      durationDeltaMs,
      leftDurationMs: leftCase.durationMs,
      leftStatus: leftCase.status,
      name,
      reasons,
      regressed: reasons.length > 0,
      rightDurationMs: rightCase.durationMs,
      rightStatus: rightCase.status,
    };
  });
}

function classifyEvalCaseComparison(
  leftStatus: OfflineEvalStatus,
  rightStatus: OfflineEvalStatus,
  durationDeltaMs: number,
): OfflineEvalCaseComparison["classification"] {
  if (leftStatus !== rightStatus) {
    return "status_changed";
  }

  if (durationDeltaMs > 0) {
    return "slower";
  }

  if (durationDeltaMs < 0) {
    return "faster";
  }

  return "unchanged";
}

function statusRank(status: OfflineEvalStatus): number {
  if (status === "pass") {
    return 0;
  }

  if (status === "skip") {
    return 1;
  }

  return 2;
}

function formatComparisonStatus(status: OfflineEvalComparisonStatus): string {
  if (status === "regressed") {
    return "REGRESSED";
  }

  if (status === "informational") {
    return "INFO";
  }

  return "OK";
}

async function runEvalCaseByName(name: OfflineEvalCaseName): Promise<OfflineEvalCaseResult> {
  return runEvalCase(name, OFFLINE_EVAL_CASE_RUNNERS[name]);
}

async function runEvalCase(
  name: string,
  run: () => Promise<string>,
): Promise<OfflineEvalCaseResult> {
  const startedAt = Date.now();

  try {
    const summary = await run();

    return {
      durationMs: Date.now() - startedAt,
      name,
      status: "pass",
      summary,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    if (error instanceof SkipEvalError) {
      return {
        durationMs,
        name,
        status: "skip",
        summary: error.message,
      };
    }

    return {
      durationMs,
      name,
      status: "fail",
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeBenchmarkCase(
  name: OfflineEvalCaseName,
  results: OfflineEvalCaseResult[],
): OfflineEvalCaseResult {
  const durationMs = Math.round(
    results.reduce((total, result) => total + result.durationMs, 0) / results.length,
  );
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const skipped = results.filter((result) => result.status === "skip").length;

  return {
    durationMs,
    name,
    status: failed > 0 ? "fail" : passed > 0 ? "pass" : "skip",
    summary: formatBenchmarkSummary(results.length, passed, failed, skipped),
  };
}

function formatBenchmarkSummary(
  runs: number,
  passed: number,
  failed: number,
  skipped: number,
): string {
  if (failed > 0) {
    const parts = [`failed ${failed}/${runs} runs`];

    if (passed > 0) {
      parts.push(`passed ${passed}/${runs}`);
    }

    if (skipped > 0) {
      parts.push(`skipped ${skipped}/${runs}`);
    }

    return parts.join(", ");
  }

  if (passed > 0) {
    const parts = [`passed ${passed}/${runs} runs`];

    if (skipped > 0) {
      parts.push(`skipped ${skipped}/${runs}`);
    }

    return parts.join(", ");
  }

  return `skipped ${skipped}/${runs} runs`;
}

function buildOfflineEvalMarkdownReport(report: {
  exportedAt: string;
  result: OfflineEvalSuiteResult;
  suite: OfflineEvalSuiteName;
}): string {
  const result = report.result;
  const lines = [
    "# CCAgent Eval Report",
    "",
    `Generated at: ${report.exportedAt}`,
    `Suite: ${report.suite}`,
    `Duration: ${result.durationMs}ms${result.iterations !== undefined ? " total" : ""}`,
    `Passed: ${result.passed}`,
    `Failed: ${result.failed}`,
    `Skipped: ${result.skipped}`,
  ];

  if (result.iterations !== undefined) {
    lines.push(`Iterations: ${result.iterations}`);
    lines.push(`Average iteration: ${Math.round(result.durationMs / result.iterations)}ms`);
  }

  lines.push("");
  lines.push("## Cases");
  lines.push("");
  lines.push("| Case | Status | Avg ms | Summary |");
  lines.push("| --- | --- | ---: | --- |");

  for (const item of result.results) {
    lines.push(
      `| ${escapeMarkdownTableCell(item.name)} | ${item.status.toUpperCase()} | ${item.durationMs} | ${escapeMarkdownTableCell(item.summary)} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatExportTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

async function findOfflineEvalReportJsonFiles(reportsDir: string): Promise<string[]> {
  let entries: string[];

  try {
    entries = await readdir(reportsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => /^eval-report-(smoke|regression|benchmark)-.+\.json$/.test(entry))
    .sort();
}

async function readNamedOfflineEvalReport(
  workspaceRoot: string,
  name: string,
): Promise<OfflineEvalReportSummary | null> {
  let normalizedFileName = basename(name.replaceAll("\\", "/"));
  const baselineShortName = /^baseline-(smoke|regression|benchmark)$/.exec(normalizedFileName);

  if (baselineShortName) {
    normalizedFileName = `eval-baseline-${baselineShortName[1]}.json`;
  } else if (normalizedFileName.endsWith(".md")) {
    normalizedFileName = `${normalizedFileName.slice(0, -".md".length)}.json`;
  }

  if (
    !/^eval-report-(smoke|regression|benchmark)-.+\.json$/.test(normalizedFileName) &&
    !/^eval-baseline-(smoke|regression|benchmark)\.json$/.test(normalizedFileName)
  ) {
    return null;
  }

  return readOfflineEvalReportJson(workspaceRoot, normalizedFileName);
}

async function readOfflineEvalReportJson(
  workspaceRoot: string,
  fileName: string,
): Promise<OfflineEvalReportSummary | null> {
  try {
    const content = await readFile(join(workspaceRoot, ".ccagent", "reports", fileName), "utf8");
    const parsed = JSON.parse(content) as unknown;

    return parseOfflineEvalReportSummary(parsed);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (isNodeError(error) && error.code === "ENOENT")
    ) {
      return null;
    }

    throw error;
  }
}

function parseOfflineEvalReportSummary(value: unknown): OfflineEvalReportSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const exportedAt = value.exportedAt;
  const fileName = value.fileName;
  const jsonFileName = value.jsonFileName;
  const jsonPath = value.jsonPath;
  const path = value.path;
  const result = parseOfflineEvalSuiteResult(value.result);
  const suite = value.suite;

  if (
    typeof exportedAt !== "string" ||
    typeof fileName !== "string" ||
    typeof jsonFileName !== "string" ||
    typeof jsonPath !== "string" ||
    typeof path !== "string" ||
    !result ||
    typeof suite !== "string" ||
    !isOfflineEvalSuiteName(suite)
  ) {
    return null;
  }

  return {
    exportedAt,
    fileName,
    jsonFileName,
    jsonPath,
    path,
    result,
    suite,
  };
}

function parseOfflineEvalSuiteResult(value: unknown): OfflineEvalSuiteResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const suite = value.suite;
  const results = value.results;

  if (
    typeof value.durationMs !== "number" ||
    typeof value.failed !== "number" ||
    typeof value.passed !== "number" ||
    typeof value.skipped !== "number" ||
    typeof suite !== "string" ||
    !isOfflineEvalSuiteName(suite) ||
    !Array.isArray(results)
  ) {
    return null;
  }

  if (
    value.iterations !== undefined &&
    typeof value.iterations !== "number"
  ) {
    return null;
  }

  if (
    value.tag !== undefined &&
    (typeof value.tag !== "string" || !isOfflineEvalCaseTagName(value.tag))
  ) {
    return null;
  }

  const parsedResults = results.map(parseOfflineEvalCaseResult);

  if (parsedResults.some((item) => item === null)) {
    return null;
  }

  return {
    durationMs: value.durationMs,
    failed: value.failed,
    iterations: value.iterations,
    passed: value.passed,
    results: parsedResults as OfflineEvalCaseResult[],
    suite,
    skipped: value.skipped,
    ...(value.tag ? { tag: value.tag } : {}),
  };
}

function parseOfflineEvalCaseResult(value: unknown): OfflineEvalCaseResult | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.durationMs !== "number" ||
    typeof value.name !== "string" ||
    typeof value.status !== "string" ||
    !isOfflineEvalStatus(value.status) ||
    typeof value.summary !== "string"
  ) {
    return null;
  }

  return {
    durationMs: value.durationMs,
    name: value.name,
    status: value.status,
    summary: value.summary,
  };
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function isOfflineEvalSuiteName(value: string): value is OfflineEvalSuiteName {
  return (OFFLINE_EVAL_SUITE_NAMES as readonly string[]).includes(value);
}

function isOfflineEvalCaseTagName(value: string): value is OfflineEvalCaseTag {
  return (OFFLINE_EVAL_CASE_TAG_NAMES as readonly string[]).includes(value);
}

function isOfflineEvalStatus(value: string): value is OfflineEvalStatus {
  return value === "pass" || value === "fail" || value === "skip";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function evalListFiles(): Promise<string> {
  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, "README.md"), "# Eval workspace\n", "utf8");

    const agent = createEvalAgent(workspaceRoot);
    const response = await agent.handleUserMessage("list files");

    expect(response.content.includes("README.md"), "expected list_files output to include README.md");

    return "listed README.md through the list_files tool";
  });
}

async function evalWorkspaceInfo(): Promise<string> {
  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "package.json"), "{}\n", "utf8");
    await writeFile(join(workspaceRoot, "CCAGENT.md"), "- eval\n", "utf8");
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");

    const agent = createEvalAgent(workspaceRoot);
    const response = await agent.handleUserMessage("workspace summary");

    expect(response.content.includes("Workspace info"), "expected workspace_info output to be returned");
    expect(response.content.includes("package.json"), "expected workspace summary to mention package.json");

    return "summarized the workspace root through the workspace_info tool";
  });
}

async function evalReadFile(): Promise<string> {
  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, "note.txt"), "hello eval\n", "utf8");

    const agent = createEvalAgent(workspaceRoot);
    const response = await agent.handleUserMessage("read note.txt");

    expect(response.content.includes("hello eval"), "expected read_file output to include file content");

    return "read note.txt through the read_file tool";
  });
}

type EvalWebHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function withEvalWebServer<T>(
  handler: EvalWebHandler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function evalWebFetch(): Promise<string> {
  return withEvalWebServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>Eval page</title></head><body><h1>Heading</h1><p>Body text.</p></body></html>");
    },
    async (baseUrl) => {
      const page = await fetchWebPage(`${baseUrl}/page`, { allowPrivateNetwork: true });

      expect(page.title === "Eval page", "expected the page title to be extracted");
      expect(page.text.includes("Heading"), "expected the body text to include Heading");
      expect(page.text.includes("Body text."), "expected the body text to include Body text.");
      expect(page.truncated === false, "expected the short page not to be truncated");

      return "fetched and converted an HTML page to readable plain text";
    },
  );
}

async function evalWebSearch(): Promise<string> {
  const html = [
    "<html><body>",
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Page</a>',
    '<a class="result__snippet" href="https://example.com/page">A first result snippet.</a>',
    '<a rel="nofollow" class="result__a" href="https://second.example/other">Second &amp; Page</a>',
    '<a class="result__snippet" href="https://second.example/other">Second snippet text.</a>',
    "</body></html>",
  ].join("");

  return withEvalWebServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    },
    async (baseUrl) => {
      const results = await searchWeb("eval query", { baseUrl: `${baseUrl}/html/` });

      expect(results.length === 2, "expected two parsed search results");
      expect(results[0]?.title === "Example Page", "expected the first title to be extracted");
      expect(results[0]?.url === "https://example.com/page", "expected the redirect URL to be decoded");
      expect(results[0]?.snippet === "A first result snippet.", "expected the snippet to be extracted");

      return "parsed DuckDuckGo results with redirect URLs decoded";
    },
  );
}

async function evalContextGraphRetrieval(): Promise<string> {
  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await mkdir(join(workspaceRoot, "archive"), { recursive: true });

    const distractorWrites: Promise<void>[] = [];

    for (let index = 0; index < 120; index += 1) {
      distractorWrites.push(writeFile(
        join(workspaceRoot, "archive", `worker-${String(index).padStart(3, "0")}.ts`),
        `export const archivedWorker${index} = 'unrelated cache migration worker';\n`,
        "utf8",
      ));
    }

    await Promise.all(distractorWrites);
    await writeFile(
      join(workspaceRoot, "src", "contract.ts"),
      "export interface LedgerBoundary { load(): Promise<string>; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "service.ts"),
      [
        "import type { LedgerBoundary } from './contract';",
        "",
        "export function buildService(store: LedgerBoundary) {",
        "  return store.load();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "controller.ts"),
      [
        "import { buildService } from './service';",
        "",
        "export function createController(input: Parameters<typeof buildService>[0]) {",
        "  return buildService(input);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "controller.test.ts"),
      [
        "import { createController } from '../src/controller';",
        "",
        "test('creates output', () => {",
        "  void createController;",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    await buildContextIndex(workspaceRoot);
    await buildSemanticIndex(workspaceRoot);

    const expectedPaths = [
      "src/contract.ts",
      "src/service.ts",
      "src/controller.ts",
      "tests/controller.test.ts",
    ];
    const graphSearch = await searchContextIndex(workspaceRoot, "LedgerBoundary", 10);

    expect(Boolean(graphSearch), "expected the lexical context index to be searchable");

    const graphResults = graphSearch?.results ?? [];
    const graphPaths = graphResults.map((result) => result.path);
    const definitionRank = graphPaths.indexOf("src/contract.ts") + 1;
    const graphHits = expectedPaths.filter((path) => graphPaths.includes(path)).length;
    const controller = graphResults.find((result) => result.path === "src/controller.ts");
    const testFile = graphResults.find((result) => result.path === "tests/controller.test.ts");

    expect(definitionRank === 1, `expected exact definition at rank 1, received rank ${definitionRank || "missing"}`);
    expect(graphHits === expectedPaths.length, `expected graph recall@10 4/4, received ${graphHits}/4`);
    expect(controller?.graphDepth === 1, `expected controller at graph depth 1, received ${controller?.graphDepth ?? "missing"}`);
    expect(testFile?.graphDepth === 2, `expected test at graph depth 2, received ${testFile?.graphDepth ?? "missing"}`);
    expect(graphSearch?.graphMaxDepth === 2, `expected graph max depth 2, received ${graphSearch?.graphMaxDepth ?? "missing"}`);

    const hybridContext = await prepareAutomaticTaskContext(
      workspaceRoot,
      "controller test for ledger boundary service",
      {
        maxChars: 12_000,
        maxFiles: 5,
        refresh: false,
      },
    );
    const hybridPaths = hybridContext?.files ?? [];
    const hybridHits = expectedPaths.filter((path) => hybridPaths.includes(path)).length;
    const distractorLeaks = hybridPaths.filter((path) => path.startsWith("archive/")).length;

    expect(hybridContext?.retrievalMode === "hybrid", "expected lexical and local semantic rank fusion");
    expect(hybridHits === expectedPaths.length, `expected hybrid recall@5 4/4, received ${hybridHits}/4`);
    expect(distractorLeaks <= 1, `expected at most one hybrid distractor, received ${distractorLeaks}`);
    expect(hybridContext?.staleFiles === 0, "expected fresh hybrid retrieval evidence");

    return [
      `graph recall@10 ${graphHits}/4`,
      `exact MRR ${(1 / definitionRank).toFixed(2)}`,
      `depth-two test ${testFile?.graphDepth === 2 ? "yes" : "no"}`,
      `hybrid recall@5 ${hybridHits}/4`,
      `distractors ${distractorLeaks}/5 from 120 archive files`,
    ].join("; ");
  });
}

async function evalPlanUpdate(): Promise<string> {
  return withEvalWorkspace(async (workspaceRoot) => {
    const agent = createEvalAgent(workspaceRoot);
    const response = await agent.handleUserMessage("plan inspect files; write tests");
    const plan = agent.snapshotSession().plan;

    expect(response.content.includes("update_plan"), "expected response to mention update_plan");
    expect(plan.steps.length === 2, "expected two plan steps");
    expect(plan.steps[0]?.status === "in_progress", "expected first plan step to be in progress");

    return "updated the in-memory plan through update_plan";
  });
}

async function evalReplaceFile(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; apply_patch eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n", "utf8");

    const agent = createEvalAgent(workspaceRoot);
    const response = await agent.handleUserMessage("replace note.txt hello => hi");
    const content = normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8"));

    expect(response.content.includes("apply_patch"), "expected response to mention apply_patch");
    expect(content === "hi world\n", "expected note.txt to be patched");

    return "patched note.txt through read_file and apply_patch";
  });
}

async function evalTaskReplaceFile(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; task patch eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n", "utf8");

    const agent = createEvalAgent(workspaceRoot);
    const response = await agent.handleUserMessage("task replace note.txt hello => hi");
    const content = normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8"));
    const plan = agent.snapshotSession().plan;

    expect(response.content.includes("update_plan"), "expected task workflow to call update_plan");
    expect(response.content.includes("read_file"), "expected task workflow to call read_file");
    expect(response.content.includes("apply_patch"), "expected task workflow to call apply_patch");
    expect(response.content.includes("Task complete"), "expected task workflow to finish cleanly");
    expect(content === "hi world\n", "expected task workflow to patch note.txt");
    expect(plan.steps.length === 4, "expected task workflow to persist four plan steps");
    expect(plan.steps.every((step) => step.status === "completed"), "expected all task plan steps to complete");

    return "completed task workflow through update_plan, read_file, and apply_patch";
  });
}

async function evalMissingTextRecovery(): Promise<string> {
  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n", "utf8");

    const agent = createEvalAgent(workspaceRoot);
    const response = await agent.handleUserMessage("replace note.txt missing => found");
    const content = normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8"));

    expect(response.content.includes("text not found"), "expected missing text to be reported");
    expect(!response.content.includes("apply_patch"), "expected missing text recovery to avoid apply_patch");
    expect(content === "hello world\n", "expected note.txt to remain unchanged");
    expect(agent.snapshotSession().lastPatch === undefined, "expected no last patch to be recorded");

    return "reported missing replacement text without applying a patch";
  });
}

async function evalRepairLoop(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; repair loop eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(
      join(workspaceRoot, "check.js"),
      [
        "const { existsSync, readFileSync } = require('node:fs');",
        "const value = existsSync('fixed.txt') ? readFileSync('fixed.txt', 'utf8').trim() : '';",
        "if (value !== 'fixed') {",
        "  console.error(`not fixed: ${value || 'missing'}`);",
        "  process.exit(1);",
        "}",
        "console.log('fixed after loop');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node check.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const agent = createEvalAgent(workspaceRoot, new TwoAttemptRepairEvalModel());
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const response = await agent.handleUserMessage("/repair-loop 2");
    const content = normalizeLineEndings(await readFile(join(workspaceRoot, "fixed.txt"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial verification to fail");
    expect(failed.content.includes("not fixed: missing"), "expected initial failure output to mention missing file");
    expect(response.content.includes("Repair loop"), "expected repair loop heading");
    expect(response.content.includes("Attempt 1/2"), "expected first repair attempt");
    expect(
      response.content.includes("Patch:\n  applied: yes\n  paths: fixed.txt"),
      "expected first attempt patch details",
    );
    expect(response.content.includes("status: failed (exitCode=1)"), "expected first rerun to fail");
    expect(response.content.includes("not fixed: almost"), "expected first rerun to see partial fix");
    expect(response.content.includes("Attempt 2/2"), "expected second repair attempt");
    expect(response.content.includes("status: passed"), "expected second rerun to pass");
    expect(response.content.includes("fixed after loop"), "expected successful command output");
    expect(
      response.content.includes("Repair loop passed after 2 attempt(s)."),
      "expected repair loop success summary",
    );
    expect(content === "fixed\n", "expected repair loop to leave fixed.txt repaired");
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop applied two patches and cleared verification state";
  });
}

async function evalRepairLoopBadPatchRecovery(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; bad-patch repair loop eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(
      join(workspaceRoot, "check.js"),
      [
        "const { existsSync, readFileSync } = require('node:fs');",
        "const value = existsSync('fixed.txt') ? readFileSync('fixed.txt', 'utf8').trim() : '';",
        "if (value !== 'fixed') {",
        "  console.error(`not fixed: ${value || 'missing'}`);",
        "  process.exit(1);",
        "}",
        "console.log('fixed after bad patch retry');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node check.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const agent = createEvalAgent(workspaceRoot, new BadPatchThenGoodRepairEvalModel());
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const response = await agent.handleUserMessage("/repair-loop 2");
    const content = normalizeLineEndings(await readFile(join(workspaceRoot, "fixed.txt"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial verification to fail");
    expect(failed.content.includes("not fixed: missing"), "expected initial failure output to mention missing file");
    expect(response.content.includes("Attempt 1/2"), "expected first repair attempt");
    expect(response.content.includes("Patch check failed"), "expected malformed patch failure to be reported");
    expect(response.content.includes("Patch:\n  applied: no"), "expected failed patch to be marked unapplied");
    expect(
      response.content.includes("Continuing: repair attempt 1 tried a patch, but it did not apply."),
      "expected repair loop to continue after a failed patch attempt",
    );
    expect(response.content.includes("Attempt 2/2"), "expected second repair attempt");
    expect(
      response.content.includes("Patch:\n  applied: yes\n  paths: fixed.txt"),
      "expected second attempt patch details",
    );
    expect(response.content.includes("status: passed"), "expected second rerun to pass");
    expect(response.content.includes("fixed after bad patch retry"), "expected successful command output");
    expect(
      response.content.includes("Repair loop passed after 2 attempt(s)."),
      "expected repair loop success summary",
    );
    expect(content === "fixed\n", "expected repair loop to leave fixed.txt repaired");
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "continued after a malformed patch attempt and recovered on retry";
  });
}

async function evalRepairLoopWrongFileRecovery(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; wrong-file repair loop eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(
      join(workspaceRoot, "check.js"),
      [
        "const { existsSync, readFileSync } = require('node:fs');",
        "const value = existsSync('fixed.txt') ? readFileSync('fixed.txt', 'utf8').trim() : '';",
        "if (value !== 'fixed') {",
        "  console.error(`not fixed: ${value || 'missing'}`);",
        "  process.exit(1);",
        "}",
        "console.log('fixed after wrong-file retry');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node check.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const agent = createEvalAgent(workspaceRoot, new WrongFileThenGoodRepairEvalModel());
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const response = await agent.handleUserMessage("/repair-loop 2");
    const fixedContent = normalizeLineEndings(await readFile(join(workspaceRoot, "fixed.txt"), "utf8"));
    const wrongFileContent = normalizeLineEndings(await readFile(join(workspaceRoot, "notes.txt"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial verification to fail");
    expect(failed.content.includes("not fixed: missing"), "expected initial failure output to mention missing file");
    expect(response.content.includes("Attempt 1/2"), "expected first repair attempt");
    expect(
      response.content.includes("Patch:\n  applied: yes\n  paths: notes.txt"),
      "expected first attempt to report the wrong-file patch",
    );
    expect(response.content.includes("status: failed (exitCode=1)"), "expected first rerun to fail");
    expect(
      response.content.includes("Continuing: repair attempt 1 applied a patch, but verification is still failing."),
      "expected repair loop to continue after an applied patch fails verification",
    );
    expect(response.content.includes("Attempt 2/2"), "expected second repair attempt");
    expect(
      response.content.includes("Patch:\n  applied: yes\n  paths: fixed.txt"),
      "expected second attempt patch details",
    );
    expect(response.content.includes("status: passed"), "expected second rerun to pass");
    expect(response.content.includes("fixed after wrong-file retry"), "expected successful command output");
    expect(
      response.content.includes("Repair loop passed after 2 attempt(s)."),
      "expected repair loop success summary",
    );
    expect(fixedContent === "fixed\n", "expected repair loop to leave fixed.txt repaired");
    expect(wrongFileContent === "looked in the wrong file\n", "expected first wrong-file patch to remain visible");
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "continued after a wrong-file patch and recovered on retry";
  });
}

async function evalRepairLoopPartialMultifileRecovery(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; partial multi-file repair loop eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "discount.js"),
      [
        "function calculateDiscount() {",
        "  return 0;",
        "}",
        "",
        "module.exports = { calculateDiscount };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "cart.js"),
      [
        "const { calculateDiscount } = require('./discount');",
        "",
        "function cartTotal(items) {",
        "  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
        "  return subtotal;",
        "}",
        "",
        "module.exports = { cartTotal };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "cart.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { cartTotal } = require('../src/cart');",
        "",
        "const total = cartTotal([",
        "  { price: 10, quantity: 2 },",
        "  { price: 5, quantity: 1 },",
        "]);",
        "",
        "assert.equal(total, 22.5);",
        "console.log('cart total ok after partial repair');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/cart.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const agent = createEvalAgent(workspaceRoot, new PartialMultiFileRepairEvalModel());
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 2");
    const cart = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "cart.js"), "utf8"));
    const discount = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "discount.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial cart test to fail");
    expect(failed.content.includes("npm test"), "expected package verification to run npm test");
    expect(repaired.content.includes("Attempt 1/2"), "expected first repair attempt");
    expect(
      repaired.content.includes("Patch:\n  applied: yes\n  paths: src/discount.js"),
      "expected first attempt to patch only discount.js",
    );
    expect(repaired.content.includes("status: failed (exitCode=1)"), "expected first rerun to still fail");
    expect(
      repaired.content.includes("Continuing: repair attempt 1 applied a patch, but verification is still failing."),
      "expected repair loop to continue after a partial multi-file patch",
    );
    expect(repaired.content.includes("Attempt 2/2"), "expected second repair attempt");
    expect(
      repaired.content.includes("Patch:\n  applied: yes\n  paths: src/cart.js"),
      "expected second attempt to patch the remaining file",
    );
    expect(repaired.content.includes("status: passed"), "expected repaired verification to pass");
    expect(repaired.content.includes("cart total ok after partial repair"), "expected successful test output");
    expect(
      repaired.content.includes("Repair loop passed after 2 attempt(s)."),
      "expected repair loop success summary",
    );
    expect(cart.includes("return subtotal - calculateDiscount(subtotal, items);"), "expected cart total to subtract discount");
    expect(discount.includes("return itemCount >= 3 ? subtotal * 0.1 : 0;"), "expected discount calculation to be fixed");
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop completed a partial multi-file fix across two attempts";
  });
}

async function evalRepairLoopMultifile(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; multi-file repair loop eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "discount.js"),
      [
        "function calculateDiscount() {",
        "  return 0;",
        "}",
        "",
        "module.exports = { calculateDiscount };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "cart.js"),
      [
        "const { calculateDiscount } = require('./discount');",
        "",
        "function cartTotal(items) {",
        "  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
        "  return subtotal;",
        "}",
        "",
        "module.exports = { cartTotal };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "cart.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { cartTotal } = require('../src/cart');",
        "",
        "const total = cartTotal([",
        "  { price: 10, quantity: 2 },",
        "  { price: 5, quantity: 1 },",
        "]);",
        "",
        "assert.equal(total, 22.5);",
        "console.log('cart total ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/cart.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const agent = createEvalAgent(workspaceRoot, new MultiFileRepairEvalModel());
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const cart = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "cart.js"), "utf8"));
    const discount = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "discount.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial cart test to fail");
    expect(failed.content.includes("npm test"), "expected package verification to run npm test");
    expect(repaired.content.includes("Repair loop"), "expected repair loop output");
    expect(repaired.content.includes("Attempt 1/1"), "expected one repair attempt");
    expect(repaired.content.includes("Patch:\n  applied: yes"), "expected repair loop to report patch application");
    expect(repaired.content.includes("src/cart.js"), "expected patch paths to include src/cart.js");
    expect(repaired.content.includes("src/discount.js"), "expected patch paths to include src/discount.js");
    expect(repaired.content.includes("status: passed"), "expected repaired verification to pass");
    expect(repaired.content.includes("cart total ok"), "expected successful test output");
    expect(repaired.content.includes("Repair loop passed after 1 attempt(s)."), "expected repair loop success summary");
    expect(cart.includes("return subtotal - calculateDiscount(subtotal, items);"), "expected cart total to subtract discount");
    expect(discount.includes("return itemCount >= 3 ? subtotal * 0.1 : 0;"), "expected discount calculation to be fixed");
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop applied a multi-file patch and passed the focused test";
  });
}

async function evalRepairLoopServiceContract(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; service contract repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "pricing.js"),
      [
        "function calculateOrderTotalCents(items) {",
        "  return items.length;",
        "}",
        "",
        "module.exports = { calculateOrderTotalCents };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "orders.js"),
      [
        "const { calculateOrderTotalCents } = require('./pricing');",
        "",
        "function serializeOrder(order) {",
        "  return {",
        "    id: order.id,",
        "    total: calculateOrderTotalCents(order.items),",
        "  };",
        "}",
        "",
        "module.exports = { serializeOrder };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "order-api.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { serializeOrder } = require('../src/orders');",
        "",
        "const response = serializeOrder({",
        "  id: 'ord_1',",
        "  status: 'ready',",
        "  items: [",
        "    { sku: 'book', unitCents: 1299, quantity: 1 },",
        "    { sku: 'pen', unitCents: 650, quantity: 2 },",
        "  ],",
        "});",
        "",
        "assert.deepEqual(response, {",
        "  id: 'ord_1',",
        "  status: 'ready',",
        "  itemCount: 3,",
        "  totalCents: 2599,",
        "});",
        "console.log('order api contract ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/order-api.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const agent = createEvalAgent(workspaceRoot, new ServiceContractRepairEvalModel());
    const task = await agent.handleUserMessage("/task-state set Repair order API contract");
    const step = await agent.handleUserMessage("/task-state step Restore order totals and response fields");
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const resume = await agent.handleUserMessage("/task-state resume");
    const orders = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "orders.js"), "utf8"));
    const pricing = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "pricing.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(task.content.includes("Repair order API contract"), "expected task state objective to be set");
    expect(step.content.includes("Restore order totals"), "expected task state step to be set");
    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial contract test to fail");
    expect(failed.content.includes("npm test"), "expected package verification to run npm test");
    expect(repaired.content.includes("Repair loop"), "expected repair loop output");
    expect(repaired.content.includes("src/orders.js"), "expected patch paths to include src/orders.js");
    expect(repaired.content.includes("src/pricing.js"), "expected patch paths to include src/pricing.js");
    expect(repaired.content.includes("status: passed"), "expected repaired verification to pass");
    expect(repaired.content.includes("order api contract ok"), "expected successful contract output");
    expect(repaired.content.includes("Repair loop passed after 1 attempt(s)."), "expected repair loop success");
    expect(orders.includes("totalCents: calculateOrderTotalCents(order.items),"), "expected API serializer totalCents");
    expect(orders.includes("itemCount: countOrderItems(order.items),"), "expected API serializer itemCount");
    expect(pricing.includes("sum + item.unitCents * item.quantity"), "expected pricing total calculation");
    expect(session.taskState?.lastVerification?.ok === true, "expected task state to record passing verification");
    expect(session.taskState?.files.includes("src/orders.js") === true, "expected task state to track orders file");
    expect(session.taskState?.files.includes("src/pricing.js") === true, "expected task state to track pricing file");
    expect(resume.content.includes("Task resume prompt"), "expected task resume prompt");
    expect(resume.content.includes("Repair order API contract"), "expected resume prompt objective");
    expect(resume.content.includes("Last verification:"), "expected resume prompt verification section");
    expect(resume.content.includes("status: passed"), "expected resume prompt to include passing verification");

    return "repair loop restored a service/API contract and preserved task resume context";
  });
}

async function evalRepairLoopRenamedApiContract(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; renamed API contract repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "inventory.js"),
      [
        "const stockBySku = {",
        "  pen: 4,",
        "  book: 1,",
        "};",
        "",
        "function getAvailableStock(sku) {",
        "  return stockBySku[sku] ?? 0;",
        "}",
        "",
        "module.exports = { getAvailableStock };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "orders.js"),
      [
        "const { lookupStock } = require('./inventory');",
        "",
        "function canReserveItem(sku, quantity) {",
        "  return lookupStock(sku) >= quantity;",
        "}",
        "",
        "module.exports = { canReserveItem };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "orders.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { canReserveItem } = require('../src/orders');",
        "",
        "assert.equal(canReserveItem('pen', 3), true);",
        "assert.equal(canReserveItem('book', 2), false);",
        "console.log('renamed api contract ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/orders.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const model = new RenamedApiContractRepairEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const orders = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "orders.js"), "utf8"));
    const inventory = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "inventory.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial renamed API test to fail");
    expect(failed.content.includes("lookupStock is not a function"), "expected stale import failure");
    expect(repaired.content.includes("Repair loop"), "expected repair loop output");
    expect(repaired.content.includes("Attempt 1/1"), "expected one repair attempt");
    expect(model.userMessages[0]?.includes("Initial repair file context"), "expected initial file context in repair prompt");
    expect(model.userMessages[0]?.includes("lookupStock"), "expected repair prompt to include stale caller context");
    expect(repaired.content.includes("Patch:\n  applied: yes\n  paths: src/orders.js"), "expected caller patch details");
    expect(repaired.content.includes("status: passed"), "expected repaired verification to pass");
    expect(repaired.content.includes("renamed api contract ok"), "expected successful renamed API output");
    expect(orders.includes("const { getAvailableStock } = require('./inventory');"), "expected stale import to be updated");
    expect(orders.includes("return getAvailableStock(sku) >= quantity;"), "expected stale call to be updated");
    expect(inventory.includes("module.exports = { getAvailableStock };"), "expected renamed API export to remain");
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop updated a stale caller after an API rename";
  });
}

async function evalRepairLoopStaleImportContract(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; stale import contract repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src", "domain"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "domain", "tax.js"),
      [
        "function calculateTaxCents(subtotalCents, rate) {",
        "  return Math.round(subtotalCents * rate);",
        "}",
        "",
        "module.exports = { calculateTaxCents };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "orders.js"),
      [
        "const { calculateTaxCents } = require('./tax');",
        "",
        "function summarizeOrder(order, config) {",
        "  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
        "  return {",
        "    id: order.id,",
        "    taxCents: calculateTaxCents(subtotalCents, config.taxRate),",
        "  };",
        "}",
        "",
        "module.exports = { summarizeOrder };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "orders.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { summarizeOrder } = require('../src/orders');",
        "",
        "const summary = summarizeOrder({",
        "  id: 'ord_1',",
        "  items: [{ unitCents: 1000, quantity: 3 }],",
        "}, { taxRate: 0.0825 });",
        "",
        "assert.deepEqual(summary, { id: 'ord_1', taxCents: 248 });",
        "console.log('stale import contract ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/orders.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const model = new StaleImportContractRepairEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const orders = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "orders.js"), "utf8"));
    const tax = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "domain", "tax.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial stale import test to fail");
    expect(failed.content.includes("Cannot find module './tax'"), "expected missing old import path");
    expect(model.userMessages[0]?.includes("Initial repair file context"), "expected initial file context in repair prompt");
    expect(model.userMessages[0]?.includes("require('./tax')"), "expected repair prompt to include stale import context");
    expect(repaired.content.includes("Repair loop"), "expected repair loop output");
    expect(repaired.content.includes("Patch:\n  applied: yes\n  paths: src/orders.js"), "expected caller import patch");
    expect(repaired.content.includes("status: passed"), "expected repaired verification to pass");
    expect(repaired.content.includes("stale import contract ok"), "expected successful stale import output");
    expect(orders.includes("const { calculateTaxCents } = require('./domain/tax');"), "expected import path to be updated");
    expect(tax.includes("module.exports = { calculateTaxCents };"), "expected moved dependency to remain unchanged");
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop updated a stale import after a module move";
  });
}

async function evalRepairLoopContractDrift(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; contract drift repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "pricing.js"),
      [
        "function calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents }) {",
        "  return subtotalCents + shippingCents + taxCents;",
        "}",
        "",
        "module.exports = { calculateInvoiceTotalCents };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "orders.js"),
      [
        "const { calculateInvoiceTotalCents } = require('./pricing');",
        "",
        "function summarizeOrder(order, config) {",
        "  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
        "  const shippingCents = config.shippingCents;",
        "  const taxCents = Math.round(subtotalCents * config.taxRate);",
        "",
        "  return {",
        "    id: order.id,",
        "    totalCents: calculateInvoiceTotalCents(subtotalCents, shippingCents, taxCents),",
        "  };",
        "}",
        "",
        "module.exports = { summarizeOrder };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "orders.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { summarizeOrder } = require('../src/orders');",
        "",
        "const summary = summarizeOrder({",
        "  id: 'ord_1',",
        "  items: [{ unitCents: 1000, quantity: 1 }],",
        "}, { shippingCents: 125, taxRate: 0.0825 });",
        "",
        "assert.equal(summary.totalCents, 1208);",
        "console.log('contract drift ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/orders.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const model = new ContractDriftRepairEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const orders = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "orders.js"), "utf8"));
    const pricing = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "pricing.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial contract drift test to fail");
    expect(failed.content.includes("AssertionError"), "expected assertion failure from stale contract call");
    expect(model.userMessages[0]?.includes("Initial repair file context"), "expected initial file context in repair prompt");
    expect(model.userMessages[0]?.includes("orders.test.js"), "expected repair prompt to include failing test context");
    expect(repaired.content.includes("Repair loop"), "expected repair loop output");
    expect(repaired.content.includes("Patch:\n  applied: yes\n  paths: src/orders.js"), "expected caller contract patch");
    expect(repaired.content.includes("status: passed"), "expected repaired verification to pass");
    expect(repaired.content.includes("contract drift ok"), "expected successful contract drift output");
    expect(
      orders.includes("calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents })"),
      "expected caller to pass object contract",
    );
    expect(
      pricing.includes("function calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents })"),
      "expected callee contract to remain object-based",
    );
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop updated a caller after cross-file contract drift";
  });
}

async function evalRepairLoopMultiCallerContractDrift(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; multi-caller contract drift repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "pricing.js"),
      [
        "function calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents }) {",
        "  return subtotalCents + shippingCents + taxCents;",
        "}",
        "",
        "module.exports = { calculateInvoiceTotalCents };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "orders.js"),
      [
        "const { calculateInvoiceTotalCents } = require('./pricing');",
        "",
        "function summarizeOrder(order, config) {",
        "  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
        "  const shippingCents = config.shippingCents;",
        "  const taxCents = Math.round(subtotalCents * config.taxRate);",
        "  return calculateInvoiceTotalCents(subtotalCents, shippingCents, taxCents);",
        "}",
        "",
        "module.exports = { summarizeOrder };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "quotes.js"),
      [
        "const { calculateInvoiceTotalCents } = require('./pricing');",
        "",
        "function previewQuote(draft) {",
        "  const subtotalCents = draft.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);",
        "  const shippingCents = draft.shippingCents;",
        "  const taxCents = Math.round(subtotalCents * draft.taxRate);",
        "  return calculateInvoiceTotalCents(subtotalCents, shippingCents, taxCents);",
        "}",
        "",
        "module.exports = { previewQuote };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "billing.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { summarizeOrder } = require('../src/orders');",
        "const { previewQuote } = require('../src/quotes');",
        "",
        "assert.equal(summarizeOrder({",
        "  items: [{ unitCents: 1000, quantity: 1 }],",
        "}, { shippingCents: 125, taxRate: 0.0825 }), 1208);",
        "",
        "assert.equal(previewQuote({",
        "  lines: [{ unitCents: 2500, quantity: 2 }],",
        "  shippingCents: 0,",
        "  taxRate: 0.08,",
        "}), 5400);",
        "",
        "console.log('multi-caller contract drift ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/billing.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const model = new MultiCallerContractDriftRepairEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const orders = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "orders.js"), "utf8"));
    const quotes = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "quotes.js"), "utf8"));
    const pricing = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "pricing.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial multi-caller contract test to fail");
    expect(failed.content.includes("AssertionError"), "expected assertion failure from stale caller contract");
    expect(model.userMessages[0]?.includes("Initial repair file context"), "expected initial file context in repair prompt");
    expect(model.userMessages[0]?.includes("billing.test.js"), "expected repair prompt to include failing test context");
    expect(repaired.content.includes("Repair loop"), "expected repair loop output");
    expect(repaired.content.includes("src/orders.js"), "expected patch paths to include orders caller");
    expect(repaired.content.includes("src/quotes.js"), "expected patch paths to include quotes caller");
    expect(repaired.content.includes("status: passed"), "expected repaired verification to pass");
    expect(repaired.content.includes("multi-caller contract drift ok"), "expected successful multi-caller output");
    expect(
      orders.includes("calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents })"),
      "expected orders caller to pass object contract",
    );
    expect(
      quotes.includes("calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents })"),
      "expected quotes caller to pass object contract",
    );
    expect(
      pricing.includes("function calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents })"),
      "expected shared callee contract to remain object-based",
    );
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop updated multiple callers after shared contract drift";
  });
}

async function evalRepairLoopCascadingDependencyChain(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; cascading dependency chain repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "pricing.js"),
      [
        "function priceItems({ items, discountRate }) {",
        "  const subtotalCents = items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
        "  const discountCents = Math.round(subtotalCents * discountRate);",
        "  return {",
        "    subtotalCents,",
        "    discountCents,",
        "    netSubtotalCents: subtotalCents - discountCents,",
        "  };",
        "}",
        "",
        "module.exports = { priceItems };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "shipping.js"),
      [
        "function quoteShipping({ netSubtotalCents, policy }) {",
        "  return netSubtotalCents >= policy.freeThresholdCents ? 0 : policy.baseShippingCents;",
        "}",
        "",
        "module.exports = { quoteShipping };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "invoice.js"),
      [
        "const { priceItems } = require('./pricing');",
        "const { quoteShipping } = require('./shipping');",
        "",
        "function buildInvoice({ order, pricingConfig, shippingConfig }) {",
        "  const pricing = priceItems(order.items, pricingConfig.discountRate);",
        "  const shippingCents = quoteShipping(pricing.netSubtotalCents, shippingConfig);",
        "  return {",
        "    id: order.id,",
        "    subtotalCents: pricing.subtotalCents,",
        "    discountCents: pricing.discountCents,",
        "    shippingCents,",
        "    totalCents: pricing.subtotalCents + shippingCents,",
        "  };",
        "}",
        "",
        "module.exports = { buildInvoice };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "checkout.js"),
      [
        "const { buildInvoice } = require('./invoice');",
        "",
        "function checkout(order, config) {",
        "  return buildInvoice(order, config);",
        "}",
        "",
        "module.exports = { checkout };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "checkout.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { checkout } = require('../src/checkout');",
        "",
        "const invoice = checkout({",
        "  id: 'checkout_1',",
        "  items: [{ unitCents: 2000, quantity: 2 }],",
        "}, {",
        "  pricing: { discountRate: 0.1 },",
        "  shipping: { freeThresholdCents: 5000, standardShippingCents: 799 },",
        "});",
        "",
        "assert.deepEqual(invoice, {",
        "  id: 'checkout_1',",
        "  subtotalCents: 4000,",
        "  discountCents: 400,",
        "  shippingCents: 799,",
        "  totalCents: 4399,",
        "});",
        "console.log('cascading dependency chain ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/checkout.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const model = new CascadingDependencyChainRepairEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 3");
    const checkout = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "checkout.js"), "utf8"));
    const invoice = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "invoice.js"), "utf8"));
    const pricing = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "pricing.js"), "utf8"));
    const shipping = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "shipping.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial dependency-chain test to fail");
    expect(failed.content.includes("reading 'items'"), "expected outer contract failure to surface first");
    expect(repaired.content.includes("Attempt 1/3"), "expected first dependency-chain repair attempt");
    expect(repaired.content.includes("Attempt 2/3"), "expected second dependency-chain repair attempt");
    expect(repaired.content.includes("Attempt 3/3"), "expected third dependency-chain repair attempt");
    expect(repaired.content.includes("paths: src/checkout.js"), "expected outer caller patch");
    expect(repaired.content.includes("paths: src/invoice.js"), "expected intermediate dependency patch");
    expect(repaired.content.includes("paths: src/shipping.js"), "expected leaf dependency patch");
    expect(repaired.content.includes("reading 'reduce'"), "expected pricing contract failure after the first repair");
    expect(repaired.content.includes("AssertionError"), "expected shipping assertion failure after the second repair");
    expect(repaired.content.includes("status: passed"), "expected repaired dependency-chain verification to pass");
    expect(repaired.content.includes("cascading dependency chain ok"), "expected successful dependency-chain output");
    expect(model.userMessages.length === 3, "expected one repair prompt for each cascading failure");
    expect(model.userMessages[0]?.includes("checkout.test.js"), "expected initial prompt to include failing test context");
    expect(model.userMessages[1]?.includes("reading 'reduce'"), "expected second prompt to include the newly exposed failure");
    expect(model.userMessages[2]?.includes("AssertionError"), "expected third prompt to include the final assertion failure");
    expect(checkout.includes("pricingConfig: config.pricing"), "expected checkout to adapt the invoice contract");
    expect(invoice.includes("const pricing = priceItems({"), "expected invoice to call the object-based pricing contract");
    expect(invoice.includes("discountRate: pricingConfig.discountRate"), "expected invoice to forward pricing configuration");
    expect(invoice.includes("netSubtotalCents: pricing.netSubtotalCents"), "expected invoice to adapt the shipping contract");
    expect(invoice.includes("totalCents: pricing.netSubtotalCents + shippingCents"), "expected invoice total to use the discounted subtotal");
    expect(pricing.includes("netSubtotalCents: subtotalCents - discountCents"), "expected canonical pricing module to remain unchanged");
    expect(shipping.includes("policy.standardShippingCents"), "expected shipping policy field to be repaired");
    expect(session.lastVerificationFailure === undefined, "expected verification failure state to be cleared");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop resolved three cascading failures across a checkout dependency chain";
  });
}

async function evalRepairLoopAmbiguousTestSignal(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; ambiguous test signal repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await mkdir(join(workspaceRoot, "dist"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "cart.js"),
      [
        "function calculateCartSubtotalCents(lines) {",
        "  return lines.reduce((sum, line) => sum + line.unitCents, 0);",
        "}",
        "",
        "module.exports = { calculateCartSubtotalCents };",
        "",
      ].join("\n"),
      "utf8",
    );
    const generatedArtifact = [
      "// Generated artifact. Repair source files instead.",
      "module.exports = { artifactVersion: 1 };",
      "",
    ].join("\n");
    await writeFile(join(workspaceRoot, "dist", "cart.generated.js"), generatedArtifact, "utf8");
    await writeFile(
      join(workspaceRoot, "tests", "cart.test.js"),
      [
        "const { calculateCartSubtotalCents } = require('../src/cart');",
        "",
        "const actual = calculateCartSubtotalCents([{ unitCents: 2000, quantity: 2 }]);",
        "",
        "if (actual !== 4000) {",
        "  console.error(`cart subtotal mismatch: expected 4000, received ${actual}`);",
        "  console.error('diagnostic artifact: dist/cart.generated.js');",
        "  process.exit(1);",
        "}",
        "",
        "console.log('ambiguous test signal ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/cart.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const model = new AmbiguousTestSignalRepairEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const cart = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "cart.js"), "utf8"));
    const generated = normalizeLineEndings(await readFile(join(workspaceRoot, "dist", "cart.generated.js"), "utf8"));
    const session = agent.snapshotSession();
    const repairPrompt = model.userMessages[0] ?? "";

    expect(failed.content.includes("status: failed (exitCode=1)"), "expected ambiguous test to fail initially");
    expect(failed.content.includes("cart subtotal mismatch: expected 4000, received 2000"), "expected only the partial failure signal");
    expect(session.lastVerificationFailure === undefined, "expected passing repair verification to clear failure state");
    expect(repairPrompt.includes("Initial repair file context"), "expected automatic initial repair context");
    expect(repairPrompt.includes("Path: tests/cart.test.js"), "expected command-referenced test context");
    expect(repairPrompt.includes("require('../src/cart')"), "expected the test import to reveal the source module");
    expect(!repairPrompt.includes("Path: dist/cart.generated.js"), "expected generated artifact to be excluded from initial reads");
    expect(repaired.content.includes("[tool] read_file ->"), "expected source inspection before editing");
    expect(
      repaired.content.includes("return lines.reduce((sum, line) => sum + line.unitCents, 0)"),
      "expected the model to read the imported source module",
    );
    expect(repaired.content.includes("paths: src/cart.js"), "expected the repair to patch source code");
    expect(repaired.content.includes("status: passed"), "expected repaired ambiguous verification to pass");
    expect(repaired.content.includes("ambiguous test signal ok"), "expected successful ambiguous-test output");
    expect(cart.includes("line.unitCents * line.quantity"), "expected source subtotal logic to respect quantity");
    expect(generated === generatedArtifact, "expected generated artifact to remain unchanged");
    expect(session.lastVerificationTarget === undefined, "expected verification target state to be cleared");

    return "repair loop used a command-referenced test to fix source while preserving generated output";
  });
}

async function evalRepairLoopLargeRepoRetrieval(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; large-repository retrieval repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    const legacyRoot = join(workspaceRoot, "packages", "a-legacy");
    const checkoutRoot = join(workspaceRoot, "packages", "z-checkout", "src");
    const taxRoot = join(workspaceRoot, "packages", "z-tax", "src");
    await mkdir(legacyRoot, { recursive: true });
    await mkdir(checkoutRoot, { recursive: true });
    await mkdir(taxRoot, { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });

    const distractorWrites: Promise<void>[] = [];

    for (let index = 0; index < 620; index += 1) {
      distractorWrites.push(writeFile(
        join(legacyRoot, `legacy-${String(index).padStart(3, "0")}.js`),
        `module.exports = { legacyFeature: ${index}, note: 'unrelated archive module' };\n`,
        "utf8",
      ));
    }

    await Promise.all(distractorWrites);
    await writeFile(
      join(checkoutRoot, "regional-tax-adapter.js"),
      [
        "const { calculateRegionalTaxCents } = require('../../z-tax/src/nexus-policy');",
        "",
        "// checkout nexus delta coordinates the checkout and tax packages.",
        "function buildRegionalInvoice(order, taxConfig) {",
        "  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
        "  return {",
        "    id: order.id,",
        "    subtotalCents,",
        "    taxCents: calculateRegionalTaxCents(subtotalCents, order.region, taxConfig),",
        "  };",
        "}",
        "",
        "module.exports = { buildRegionalInvoice };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(taxRoot, "nexus-policy.js"),
      [
        "// checkout nexus delta owns the regional tax policy contract.",
        "function calculateRegionalTaxCents({ subtotalCents, region, ratesByRegion }) {",
        "  const rate = ratesByRegion.default ?? 0;",
        "  return Math.round(subtotalCents * rate);",
        "}",
        "",
        "module.exports = { calculateRegionalTaxCents };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "regional-invoice.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { buildRegionalInvoice } = require('../packages/z-checkout/src/regional-tax-adapter');",
        "",
        "try {",
        "  const invoice = buildRegionalInvoice({",
        "    id: 'invoice_1',",
        "    region: 'eu-west',",
        "    items: [{ unitCents: 2500, quantity: 2 }],",
        "  }, { 'eu-west': 0.2 });",
        "",
        "  assert.deepEqual(invoice, {",
        "    id: 'invoice_1',",
        "    subtotalCents: 5000,",
        "    taxCents: 1000,",
        "    totalCents: 6000,",
        "  });",
        "  console.log('large repo regional invoice ok');",
        "} catch (error) {",
        "  console.error('checkout nexus delta contract mismatch');",
        "  console.error(error);",
        "  process.exit(1);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { test: "node tests/regional-invoice.test.js" } }, null, 2)}\n`,
      "utf8",
    );

    const model = new LargeRepoRetrievalRepairEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const adapter = normalizeLineEndings(await readFile(join(checkoutRoot, "regional-tax-adapter.js"), "utf8"));
    const policy = normalizeLineEndings(await readFile(join(taxRoot, "nexus-policy.js"), "utf8"));
    const legacy = normalizeLineEndings(await readFile(join(legacyRoot, "legacy-000.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(failed.content.includes("checkout nexus delta contract mismatch"), "expected path-free retrieval marker in failure output");
    expect(repaired.content.includes("[tool] suggest_context ->"), "expected repair to invoke context retrieval");
    expect(repaired.content.includes("Scanned files: 500 (truncated)"), "expected large-repository scan budget to be exercised");
    expect(repaired.content.includes("packages/z-checkout/src/regional-tax-adapter.js"), "expected checkout module retrieval");
    expect(repaired.content.includes("packages/z-tax/src/nexus-policy.js"), "expected tax policy retrieval");
    expect(repaired.content.includes("[tool] read_file ->"), "expected retrieved modules to be read before editing");
    expect(
      repaired.content.includes("paths: packages/z-checkout/src/regional-tax-adapter.js, packages/z-tax/src/nexus-policy.js"),
      `expected two-module repair patch; response was:\n${repaired.content}`,
    );
    expect(repaired.content.includes("status: passed"), "expected repaired large-repository verification to pass");
    expect(repaired.content.includes("large repo regional invoice ok"), "expected successful cross-module output");
    expect(model.discoveredPaths.includes("packages/z-checkout/src/regional-tax-adapter.js"), "expected checkout path to come from retrieval output");
    expect(model.discoveredPaths.includes("packages/z-tax/src/nexus-policy.js"), "expected policy path to come from retrieval output");
    expect(adapter.includes("calculateRegionalTaxCents({ subtotalCents, region: order.region, ratesByRegion: taxConfig })"), "expected caller contract repair");
    expect(adapter.includes("totalCents: subtotalCents + taxCents"), "expected invoice total repair");
    expect(policy.includes("if (!(region in ratesByRegion))"), "expected policy to reject unknown regions");
    expect(legacy.includes("legacyFeature: 0"), "expected distractor module to remain unchanged");
    expect(session.lastVerificationFailure === undefined, "expected passing retrieval repair to clear failure state");

    return "retrieved late-sorted modules behind 620 distractors, repaired their contract, and passed verification";
  });
}

async function evalRepairLoopProcessCleanup(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; process cleanup repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "service.js"),
      [
        "const http = require('node:http');",
        "",
        "function startService() {",
        "  return new Promise((resolve) => {",
        "    const server = http.createServer((request, response) => {",
        "      response.writeHead(request.url === '/health' ? 200 : 404);",
        "      response.end(request.url === '/health' ? 'ok' : 'not found');",
        "    });",
        "    server.listen(0, '127.0.0.1', () => resolve(server));",
        "  });",
        "}",
        "",
        "function stopService(server) {",
        "  return new Promise((resolve, reject) => {",
        "    server.close((error) => error ? reject(error) : resolve());",
        "  });",
        "}",
        "",
        "module.exports = { startService, stopService };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "service.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { startService, stopService } = require('../src/service');",
        "",
        "(async () => {",
        "  const server = await startService();",
        "  const address = server.address();",
        "  const response = await fetch(`http://127.0.0.1:${address.port}/health`);",
        "  assert.equal(response.status, 200);",
        "  assert.equal(await response.text(), 'ok');",
        "  console.log('all tests passed; server cleanup pending');",
        "})().catch((error) => {",
        "  console.error(error);",
        "  process.exitCode = 1;",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { test: "node tests/service.test.js" } }, null, 2)}\n`,
      "utf8",
    );

    const model = new ProcessCleanupRepairEvalModel();
    const agent = new Agent(
      model,
      createDefaultToolRegistry({ shellCommandTimeoutMs: 1_200 }),
      workspaceRoot,
      async () => true,
    );
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const preview = await agent.handleUserMessage("/repair-preview");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const testFile = normalizeLineEndings(await readFile(join(workspaceRoot, "tests", "service.test.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(
      failed.content.includes("likely: process cleanup/lifecycle failure"),
      `expected process cleanup diagnosis; response was:\n${failed.content}`,
    );
    expect(failed.content.includes("command timed out after 1200ms"), "expected timeout evidence to be preserved");
    expect(failed.content.includes("process tree was terminated"), "expected timed-out process tree cleanup");
    expect(preview.content.includes("process lifecycle defect"), "expected lifecycle-specific repair strategy");
    expect(preview.content.includes("Do not force process.exit(0)"), "expected unsafe workaround guard");
    expect(repaired.content.includes("paths: tests/service.test.js"), "expected test teardown patch");
    expect(repaired.content.includes("status: passed"), "expected repaired service test to exit cleanly");
    expect(repaired.content.includes("all tests passed; server cleanup complete"), "expected repaired test output");
    expect(testFile.includes("finally {\n    await stopService(server);\n  }"), "expected awaited server teardown in finally");
    expect(session.lastVerificationFailure === undefined, "expected passing rerun to clear process cleanup failure");
    expect(model.userMessages[0]?.includes("process cleanup/lifecycle failure") === true, "expected model repair prompt to include diagnosis");

    return "diagnosed a leaked service process, terminated it on timeout, repaired teardown, and passed verification";
  });
}

async function evalRepairLoopServiceReadiness(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; service readiness repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "delayed-service.js"),
      [
        "const http = require('node:http');",
        "",
        "const port = Number(process.env.PORT);",
        "const server = http.createServer((request, response) => {",
        "  response.writeHead(request.url === '/health' ? 200 : 404);",
        "  response.end(request.url === '/health' ? 'ok' : 'not found');",
        "});",
        "",
        "setTimeout(() => {",
        "  server.listen(port, '127.0.0.1', () => {",
        "    console.log(`service listening on http://127.0.0.1:${port}`);",
        "  });",
        "}, 350);",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "service-readiness.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { spawn } = require('node:child_process');",
        "const { createServer } = require('node:net');",
        "",
        "const READY_TIMEOUT_MS = 2000;",
        "",
        "function allocatePort() {",
        "  return new Promise((resolve, reject) => {",
        "    const reservation = createServer();",
        "    reservation.once('error', reject);",
        "    reservation.listen(0, '127.0.0.1', () => {",
        "      const address = reservation.address();",
        "      reservation.close((error) => error ? reject(error) : resolve(address.port));",
        "    });",
        "  });",
        "}",
        "",
        "function stopChild(child) {",
        "  return new Promise((resolve) => {",
        "    if (child.exitCode !== null || child.signalCode !== null) {",
        "      resolve();",
        "      return;",
        "    }",
        "    child.once('exit', resolve);",
        "    child.kill();",
        "  });",
        "}",
        "",
        "async function waitForHealthy(url) {",
        "  return fetch(url);",
        "}",
        "",
        "(async () => {",
        "  const port = await allocatePort();",
        "  const healthUrl = `http://127.0.0.1:${port}/health`;",
        "  console.log(`Starting local service for integration tests at ${healthUrl}.`);",
        "  const child = spawn(process.execPath, ['src/delayed-service.js'], {",
        "    cwd: process.cwd(),",
        "    env: { ...process.env, PORT: String(port) },",
        "    stdio: ['ignore', 'pipe', 'pipe'],",
        "  });",
        "  child.stdout.pipe(process.stdout);",
        "  child.stderr.pipe(process.stderr);",
        "",
        "  try {",
        "    const response = await waitForHealthy(healthUrl);",
        "    assert.equal(response.status, 200);",
        "    assert.equal(await response.text(), 'ok');",
        "    console.log('service readiness check passed');",
        "  } catch (error) {",
        "    console.error(`Health check failed for ${healthUrl}.`);",
        "    console.error(error);",
        "    process.exitCode = 1;",
        "  } finally {",
        "    await stopChild(child);",
        "  }",
        "})();",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { test: "node tests/service-readiness.test.js" } }, null, 2)}\n`,
      "utf8",
    );

    const model = new ServiceReadinessRepairEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const preview = await agent.handleUserMessage("/repair-preview");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const testFile = normalizeLineEndings(await readFile(join(workspaceRoot, "tests", "service-readiness.test.js"), "utf8"));
    const session = agent.snapshotSession();

    expect(
      failed.content.includes("likely: local service readiness/startup failure"),
      `expected service readiness diagnosis; response was:\n${failed.content}`,
    );
    expect(failed.content.includes("ECONNREFUSED"), "expected initial local connection failure evidence");
    expect(preview.content.includes("local service startup synchronization defect"), "expected readiness-specific repair strategy");
    expect(preview.content.includes("bounded deadline and short backoff"), "expected bounded readiness guidance");
    expect(preview.content.includes("do not use a fixed long sleep"), "expected unsafe readiness workaround guard");
    expect(repaired.content.includes("paths: tests/service-readiness.test.js"), "expected readiness helper patch");
    expect(repaired.content.includes("status: passed"), "expected repaired readiness test to pass");
    expect(repaired.content.includes("service readiness check passed"), "expected successful readiness output");
    expect(testFile.includes("const deadline = Date.now() + timeoutMs;"), "expected a bounded readiness deadline");
    expect(testFile.includes("lastError = error;"), "expected final startup failure evidence to be preserved");
    expect(testFile.includes("setTimeout(resolve, 50)"), "expected short readiness retry backoff");
    expect(testFile.includes("{ cause: lastError }"), "expected timeout error to retain the last connection failure");
    expect(testFile.includes("await stopChild(child);"), "expected child service cleanup to remain in finally");
    expect(session.lastVerificationFailure === undefined, "expected passing rerun to clear readiness failure");
    expect(model.userMessages[0]?.includes("local service readiness/startup failure") === true, "expected repair prompt to include readiness diagnosis");

    return "diagnosed a local startup race, added bounded health polling, cleaned up the service, and passed verification";
  });
}

async function evalRepairLoopProjectFixture(): Promise<string> {
  if (!(await hasGit())) {
    throw new SkipEvalError("git is not available; project fixture repair eval skipped");
  }

  return withEvalWorkspace(async (workspaceRoot) => {
    await mkdir(join(workspaceRoot, "src", "domain"), { recursive: true });
    await mkdir(join(workspaceRoot, "src", "infra"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "domain", "shipping.js"),
      [
        "const FREE_SHIPPING_THRESHOLD_CENTS = 5000;",
        "",
        "function calculateShippingCents(order) {",
        "  return 0;",
        "}",
        "",
        "module.exports = { FREE_SHIPPING_THRESHOLD_CENTS, calculateShippingCents };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "domain", "tax.js"),
      [
        "function calculateTaxCents(subtotalCents, taxRate) {",
        "  return Math.round(subtotalCents * taxRate);",
        "}",
        "",
        "module.exports = { calculateTaxCents };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "domain", "orders.js"),
      [
        "const { calculateShippingCents } = require('./shipping');",
        "const { calculateTaxCents } = require('./tax');",
        "",
        "function summarizeOrder(order, config) {",
        "  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents, 0);",
        "  const shippingCents = calculateShippingCents(order);",
        "  const taxCents = calculateTaxCents(subtotalCents, config.taxRate);",
        "",
        "  return {",
        "    id: order.id,",
        "    subtotalCents,",
        "    shippingCents,",
        "    taxCents,",
        "    grandTotalCents: subtotalCents + taxCents,",
        "  };",
        "}",
        "",
        "module.exports = { summarizeOrder };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "infra", "config.js"),
      [
        "module.exports = {",
        "  taxRate: 0.08,",
        "  shippingCents: 799,",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "index.js"),
      [
        "const config = require('./infra/config');",
        "const { summarizeOrder } = require('./domain/orders');",
        "",
        "module.exports = { config, summarizeOrder };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "order-summary.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const { config, summarizeOrder } = require('../src');",
        "",
        "const summary = summarizeOrder({",
        "  id: 'order_fixture_1',",
        "  items: [",
        "    { sku: 'desk', unitCents: 3200, quantity: 1 },",
        "    { sku: 'lamp', unitCents: 1200, quantity: 2 },",
        "  ],",
        "}, config);",
        "",
        "assert.deepEqual(summary, {",
        "  id: 'order_fixture_1',",
        "  subtotalCents: 5600,",
        "  shippingCents: 0,",
        "  taxCents: 448,",
        "  grandTotalCents: 6048,",
        "});",
        "console.log('project fixture order summary ok');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "README.md"),
      [
        "# Order Service Fixture",
        "",
        "This file is intentionally unrelated to the failing order summary behavior.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/order-summary.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const agent = createEvalAgent(workspaceRoot, new ProjectFixtureRepairEvalModel());
    const task = await agent.handleUserMessage("/task-state set Repair project fixture order totals");
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 1");
    const orders = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "domain", "orders.js"), "utf8"));
    const shipping = normalizeLineEndings(await readFile(join(workspaceRoot, "src", "domain", "shipping.js"), "utf8"));
    const readme = normalizeLineEndings(await readFile(join(workspaceRoot, "README.md"), "utf8"));
    const session = agent.snapshotSession();

    expect(task.content.includes("Repair project fixture order totals"), "expected task objective to be set");
    expect(failed.content.includes("status: failed (exitCode=1)"), "expected initial project fixture test to fail");
    expect(repaired.content.includes("src/domain/orders.js"), "expected patch paths to include orders module");
    expect(repaired.content.includes("src/domain/shipping.js"), "expected patch paths to include shipping module");
    expect(repaired.content.includes("status: passed"), "expected repaired fixture verification to pass");
    expect(repaired.content.includes("project fixture order summary ok"), "expected project fixture test output");
    expect(orders.includes("sum + item.unitCents * item.quantity"), "expected subtotal to respect quantity");
    expect(orders.includes("grandTotalCents: subtotalCents + shippingCents + taxCents,"), "expected grand total to include shipping");
    expect(shipping.includes("return subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : config.shippingCents;"), "expected shipping threshold logic");
    expect(readme.includes("intentionally unrelated"), "expected unrelated README to remain intact");
    expect(session.taskState?.lastVerification?.ok === true, "expected task state to record passing project verification");
    expect(session.taskState?.files.includes("src/domain/orders.js") === true, "expected task state to track orders module");
    expect(session.taskState?.files.includes("src/domain/shipping.js") === true, "expected task state to track shipping module");

    return "repair loop fixed a larger project fixture and passed project verification";
  });
}

async function evalVerificationFailureStrategies(): Promise<string> {
  await evalVerificationFailureStrategyScenario({
    checkRequest: "/verify-run src/model.ts",
    expectedPreview: [
      "Repair strategy:",
      "Fix the first TypeScript diagnostic before chasing secondary errors.",
      "For assignability errors, align the real value, function argument, or type definition; avoid suppressions and broad casts.",
    ],
    expectedResponse: [
      "likely: TypeScript compile/typecheck failure",
      "inspect: src/model.ts:1:7",
      "align the value or argument with the expected type",
    ],
    files: [
      {
        path: "src/model.ts",
        content: "const value: number = 'bad';\n",
      },
    ],
    scripts: {
      build: "node -e \"console.error('src/model.ts(1,7): error TS2322: Type string is not assignable to type number.'); process.exit(1)\"",
    },
  });

  await evalVerificationFailureStrategyScenario({
    checkRequest: "/verify-run package.json",
    expectedPreview: [
      "Repair strategy:",
      "Treat the failing test name and assertion diff as the behavioral contract.",
      "Patch source behavior before changing tests, unless the captured output clearly shows the test contract is outdated.",
    ],
    expectedResponse: [
      "likely: Node test runner failure",
      "next: inspect the failing subtest/assertion, fix the behavior, then rerun the focused test",
      "rerun the smallest failing test",
    ],
    scripts: {
      test: "node -e \"console.error('# Subtest: bad math'); console.error('not ok 1 - bad math'); process.exit(1)\"",
    },
  });

  await evalVerificationFailureStrategyScenario({
    checkRequest: "/verify-run package.json",
    expectedPreview: [
      "Repair strategy:",
      "Inspect package.json scripts and the child command output; fix the underlying script or command before changing npm configuration.",
    ],
    expectedResponse: [
      "likely: npm script failure",
      "run npm run to list available scripts",
    ],
    scripts: {
      build: "npm run missing-script-for-eval",
    },
  });

  return "classified TypeScript, Node test, and npm script failures with repair strategies";
}

async function evalVerificationEnvironmentFailures(): Promise<string> {
  const scenarios = [
    {
      expectedPreview: [
        "Treat this as an environment/configuration failure",
        "Do not hardcode secret values",
      ],
      expectedResponse: [
        "likely: missing environment variable",
        "set the required environment variable (DATABASE_URL)",
      ],
      output: "Error: environment variable DATABASE_URL is required",
    },
    {
      expectedPreview: [
        "Treat this as a runtime resource conflict",
        "Do not remove server startup checks",
      ],
      expectedResponse: [
        "likely: port already in use",
        "identify the process listening on the requested port",
      ],
      output: "Error: listen EADDRINUSE: address already in use 127.0.0.1:3000",
    },
    {
      expectedPreview: [
        "Treat this as an external dependency or network-path failure",
        "Do not disable TLS verification",
      ],
      expectedResponse: [
        "likely: network/DNS dependency failure",
        "check the hostname or base URL, DNS resolution",
      ],
      output: "TypeError: fetch failed\nCaused by: getaddrinfo ENOTFOUND api.internal.example",
    },
    {
      expectedPreview: [
        "Treat this as a toolchain/PATH failure",
        "Do not replace application behavior",
      ],
      expectedResponse: [
        "likely: missing system command",
        "install or enable the missing command (rg)",
      ],
      output: "Error: spawn rg ENOENT\nnpm ERR! Lifecycle script failed",
    },
  ];

  for (const scenario of scenarios) {
    const output = Buffer.from(scenario.output, "utf8").toString("base64");
    await evalVerificationFailureStrategyScenario({
      checkRequest: "/verify-run package.json",
      expectedPreview: scenario.expectedPreview,
      expectedResponse: scenario.expectedResponse,
      forbiddenResponse: ["likely: npm script failure"],
      scripts: {
        test: `node -e \"console.error(Buffer.from('${output}','base64').toString('utf8')); process.exit(1)\"`,
      },
    });
  }

  return "diagnosed environment prerequisites before npm wrapper errors and source repair";
}

async function evalVerificationFlakyGuard(): Promise<string> {
  return withEvalWorkspace(async (workspaceRoot) => {
    await writeFile(
      join(workspaceRoot, "flaky.js"),
      [
        "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
        "const count = existsSync('.flaky-count') ? Number(readFileSync('.flaky-count', 'utf8')) + 1 : 1;",
        "writeFileSync('.flaky-count', String(count));",
        "if (count % 2 === 1) {",
        "  console.error(`flaky failure on run ${count}`);",
        "  process.exit(1);",
        "}",
        "console.log(`flaky pass on run ${count}`);",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { test: "node flaky.js" } }, null, 2)}\n`,
      "utf8",
    );
    const model = new CountingEvalModel();
    const agent = createEvalAgent(workspaceRoot, model);
    const failed = await agent.handleUserMessage("/verify-run package.json");
    const stability = await agent.handleUserMessage("/verify-stability 3");
    const preview = await agent.handleUserMessage("/repair-preview");
    const repair = await agent.handleUserMessage("/repair-loop 2");
    const session = agent.snapshotSession();

    expect(failed.content.includes("flaky failure on run 1"), "expected initial flaky failure");
    expect(stability.content.includes("Classification: flaky"), "expected flaky classification");
    expect(stability.content.includes("2 passed, 2 failed"), "expected mixed stability counts");
    expect(preview.content.includes("Repair preview blocked"), "expected flaky repair preview guard");
    expect(repair.content.includes("Repair blocked: the verification result is flaky"), "expected repair-loop guard");
    expect(model.calls === 0, "expected flaky guard to avoid model calls");
    expect(session.lastPatch === undefined, "expected flaky guard to avoid patches");
    expect(session.lastVerificationFailure?.stability?.status === "flaky", "expected flaky state to persist");

    return "classified mixed verification outcomes as flaky and blocked automated repair";
  });
}

type VerificationFailureStrategyScenario = {
  checkRequest: string;
  expectedPreview: string[];
  expectedResponse: string[];
  forbiddenResponse?: string[];
  files?: Array<{
    content: string;
    path: string;
  }>;
  scripts: Record<string, string>;
};

async function evalVerificationFailureStrategyScenario(
  scenario: VerificationFailureStrategyScenario,
): Promise<void> {
  await withEvalWorkspace(async (workspaceRoot) => {
    for (const file of scenario.files ?? []) {
      const fullPath = join(workspaceRoot, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, "utf8");
    }

    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: scenario.scripts }, null, 2)}\n`,
      "utf8",
    );

    const agent = createEvalAgent(workspaceRoot);
    const response = await agent.handleUserMessage(scenario.checkRequest);
    const preview = await agent.handleUserMessage("/repair-preview");

    for (const expected of scenario.expectedResponse) {
      expect(response.content.includes(expected), `expected verification response to include ${expected}`);
    }

    for (const expected of scenario.expectedPreview) {
      expect(preview.content.includes(expected), `expected repair preview to include ${expected}`);
    }

    for (const forbidden of scenario.forbiddenResponse ?? []) {
      expect(!response.content.includes(forbidden), `expected verification response to exclude ${forbidden}`);
    }
  });
}

async function withEvalWorkspace<T>(run: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-eval-"));

  try {
    return await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

function createEvalAgent(workspaceRoot: string, model: ModelClient = new MockModelClient()): Agent {
  return new Agent(model, undefined, workspaceRoot, async () => true);
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function hasGit(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], {
      windowsHide: true,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function parseEvalToolContent(output: string | undefined): string {
  if (!output) {
    throw new Error("expected eval tool output");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`expected JSON eval tool output, received:\n${output}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected eval tool output to be an object");
  }

  const record = parsed as Record<string, unknown>;

  if (record.ok !== true || typeof record.content !== "string") {
    throw new Error(`expected successful eval tool output, received:\n${output}`);
  }

  return record.content;
}

class CountingEvalModel implements ModelClient {
  readonly name = "counting-eval";
  calls = 0;

  async createTurn(): Promise<ModelResult> {
    this.calls += 1;
    return {
      content: "unexpected model call",
      toolCalls: [],
    };
  }
}

class TwoAttemptRepairEvalModel implements ModelClient {
  readonly name = "two-attempt-repair-eval";
  private repairAttempts = 0;

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs) {
      return {
        content: `repair attempt ${this.repairAttempts} patch applied`,
        toolCalls: [],
      };
    }

    this.repairAttempts += 1;
    const patch = this.repairAttempts === 1
      ? [
          "diff --git a/fixed.txt b/fixed.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/fixed.txt",
          "@@ -0,0 +1 @@",
          "+almost",
          "",
        ].join("\n")
      : [
          "diff --git a/fixed.txt b/fixed.txt",
          "--- a/fixed.txt",
          "+++ b/fixed.txt",
          "@@ -1 +1 @@",
          "-almost",
          "+fixed",
          "",
        ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: `repair-loop-eval-patch-${this.repairAttempts}`,
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class BadPatchThenGoodRepairEvalModel implements ModelClient {
  readonly name = "bad-patch-then-good-repair-eval";
  private repairAttempts = 0;

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs) {
      return {
        content: `repair attempt ${this.repairAttempts} patch response`,
        toolCalls: [],
      };
    }

    this.repairAttempts += 1;
    const patch = this.repairAttempts === 1
      ? [
          "diff --git a/fixed.txt b/fixed.txt",
          "@@ -0,0 +1 @@",
          "+broken patch without file headers",
          "",
        ].join("\n")
      : [
          "diff --git a/fixed.txt b/fixed.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/fixed.txt",
          "@@ -0,0 +1 @@",
          "+fixed",
          "",
        ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: `bad-patch-repair-loop-eval-${this.repairAttempts}`,
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class WrongFileThenGoodRepairEvalModel implements ModelClient {
  readonly name = "wrong-file-then-good-repair-eval";
  private repairAttempts = 0;

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs) {
      return {
        content: `wrong-file repair attempt ${this.repairAttempts} patch response`,
        toolCalls: [],
      };
    }

    this.repairAttempts += 1;
    const patch = this.repairAttempts === 1
      ? [
          "diff --git a/notes.txt b/notes.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/notes.txt",
          "@@ -0,0 +1 @@",
          "+looked in the wrong file",
          "",
        ].join("\n")
      : [
          "diff --git a/fixed.txt b/fixed.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/fixed.txt",
          "@@ -0,0 +1 @@",
          "+fixed",
          "",
        ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: `wrong-file-repair-loop-eval-${this.repairAttempts}`,
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class PartialMultiFileRepairEvalModel implements ModelClient {
  readonly name = "partial-multifile-repair-eval";
  private repairAttempts = 0;

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs) {
      return {
        content: `partial multi-file repair attempt ${this.repairAttempts} patch applied`,
        toolCalls: [],
      };
    }

    this.repairAttempts += 1;
    const patch = this.repairAttempts === 1
      ? [
          "diff --git a/src/discount.js b/src/discount.js",
          "--- a/src/discount.js",
          "+++ b/src/discount.js",
          "@@ -1,5 +1,6 @@",
          "-function calculateDiscount() {",
          "-  return 0;",
          "+function calculateDiscount(subtotal, items) {",
          "+  const itemCount = items.reduce((count, item) => count + item.quantity, 0);",
          "+  return itemCount >= 3 ? subtotal * 0.1 : 0;",
          " }",
          " ",
          " module.exports = { calculateDiscount };",
          "",
        ].join("\n")
      : [
          "diff --git a/src/cart.js b/src/cart.js",
          "--- a/src/cart.js",
          "+++ b/src/cart.js",
          "@@ -2,7 +2,7 @@",
          " ",
          " function cartTotal(items) {",
          "   const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
          "-  return subtotal;",
          "+  return subtotal - calculateDiscount(subtotal, items);",
          " }",
          " ",
          " module.exports = { cartTotal };",
          "",
        ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: `partial-multifile-repair-loop-eval-${this.repairAttempts}`,
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class MultiFileRepairEvalModel implements ModelClient {
  readonly name = "multi-file-repair-eval";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs) {
      return {
        content: "multi-file repair patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/src/discount.js b/src/discount.js",
      "--- a/src/discount.js",
      "+++ b/src/discount.js",
      "@@ -1,5 +1,6 @@",
      "-function calculateDiscount() {",
      "-  return 0;",
      "+function calculateDiscount(subtotal, items) {",
      "+  const itemCount = items.reduce((count, item) => count + item.quantity, 0);",
      "+  return itemCount >= 3 ? subtotal * 0.1 : 0;",
      " }",
      " ",
      " module.exports = { calculateDiscount };",
      "diff --git a/src/cart.js b/src/cart.js",
      "--- a/src/cart.js",
      "+++ b/src/cart.js",
      "@@ -2,7 +2,7 @@",
      " ",
      " function cartTotal(items) {",
      "   const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
      "-  return subtotal;",
      "+  return subtotal - calculateDiscount(subtotal, items);",
      " }",
      " ",
      " module.exports = { cartTotal };",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "multi-file-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class ServiceContractRepairEvalModel implements ModelClient {
  readonly name = "service-contract-repair-eval";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs) {
      return {
        content: "service contract repair patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/src/pricing.js b/src/pricing.js",
      "--- a/src/pricing.js",
      "+++ b/src/pricing.js",
      "@@ -1,5 +1,9 @@",
      " function calculateOrderTotalCents(items) {",
      "-  return items.length;",
      "+  return items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
      "+}",
      "+",
      "+function countOrderItems(items) {",
      "+  return items.reduce((count, item) => count + item.quantity, 0);",
      " }",
      " ",
      "-module.exports = { calculateOrderTotalCents };",
      "+module.exports = { calculateOrderTotalCents, countOrderItems };",
      "diff --git a/src/orders.js b/src/orders.js",
      "--- a/src/orders.js",
      "+++ b/src/orders.js",
      "@@ -1,10 +1,12 @@",
      "-const { calculateOrderTotalCents } = require('./pricing');",
      "+const { calculateOrderTotalCents, countOrderItems } = require('./pricing');",
      " ",
      " function serializeOrder(order) {",
      "   return {",
      "     id: order.id,",
      "-    total: calculateOrderTotalCents(order.items),",
      "+    status: order.status,",
      "+    itemCount: countOrderItems(order.items),",
      "+    totalCents: calculateOrderTotalCents(order.items),",
      "   };",
      " }",
      " ",
      " module.exports = { serializeOrder };",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "service-contract-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class RenamedApiContractRepairEvalModel implements ModelClient {
  readonly name = "renamed-api-contract-repair-eval";
  readonly userMessages: string[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: "renamed API contract patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/src/orders.js b/src/orders.js",
      "--- a/src/orders.js",
      "+++ b/src/orders.js",
      "@@ -1,7 +1,7 @@",
      "-const { lookupStock } = require('./inventory');",
      "+const { getAvailableStock } = require('./inventory');",
      " ",
      " function canReserveItem(sku, quantity) {",
      "-  return lookupStock(sku) >= quantity;",
      "+  return getAvailableStock(sku) >= quantity;",
      " }",
      " ",
      " module.exports = { canReserveItem };",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "renamed-api-contract-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class StaleImportContractRepairEvalModel implements ModelClient {
  readonly name = "stale-import-contract-repair-eval";
  readonly userMessages: string[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: "stale import contract patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/src/orders.js b/src/orders.js",
      "--- a/src/orders.js",
      "+++ b/src/orders.js",
      "@@ -1,4 +1,4 @@",
      "-const { calculateTaxCents } = require('./tax');",
      "+const { calculateTaxCents } = require('./domain/tax');",
      " ",
      " function summarizeOrder(order, config) {",
      "   const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "stale-import-contract-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class ContractDriftRepairEvalModel implements ModelClient {
  readonly name = "contract-drift-repair-eval";
  readonly userMessages: string[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: "contract drift patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/src/orders.js b/src/orders.js",
      "--- a/src/orders.js",
      "+++ b/src/orders.js",
      "@@ -7,7 +7,7 @@",
      " ",
      "   return {",
      "     id: order.id,",
      "-    totalCents: calculateInvoiceTotalCents(subtotalCents, shippingCents, taxCents),",
      "+    totalCents: calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents }),",
      "   };",
      " }",
      " ",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "contract-drift-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class MultiCallerContractDriftRepairEvalModel implements ModelClient {
  readonly name = "multi-caller-contract-drift-repair-eval";
  readonly userMessages: string[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: "multi-caller contract drift patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/src/orders.js b/src/orders.js",
      "--- a/src/orders.js",
      "+++ b/src/orders.js",
      "@@ -4,7 +4,7 @@",
      "   const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
      "   const shippingCents = config.shippingCents;",
      "   const taxCents = Math.round(subtotalCents * config.taxRate);",
      "-  return calculateInvoiceTotalCents(subtotalCents, shippingCents, taxCents);",
      "+  return calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents });",
      " }",
      " ",
      " module.exports = { summarizeOrder };",
      "diff --git a/src/quotes.js b/src/quotes.js",
      "--- a/src/quotes.js",
      "+++ b/src/quotes.js",
      "@@ -4,7 +4,7 @@",
      "   const subtotalCents = draft.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);",
      "   const shippingCents = draft.shippingCents;",
      "   const taxCents = Math.round(subtotalCents * draft.taxRate);",
      "-  return calculateInvoiceTotalCents(subtotalCents, shippingCents, taxCents);",
      "+  return calculateInvoiceTotalCents({ subtotalCents, shippingCents, taxCents });",
      " }",
      " ",
      " module.exports = { previewQuote };",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "multi-caller-contract-drift-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class CascadingDependencyChainRepairEvalModel implements ModelClient {
  readonly name = "cascading-dependency-chain-repair-eval";
  readonly userMessages: string[] = [];
  private repairAttempts = 0;

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: `cascading dependency repair attempt ${this.repairAttempts} patch applied`,
        toolCalls: [],
      };
    }

    this.repairAttempts += 1;
    let patch: string;

    if (this.repairAttempts === 1) {
      patch = [
        "diff --git a/src/checkout.js b/src/checkout.js",
        "--- a/src/checkout.js",
        "+++ b/src/checkout.js",
        "@@ -1,7 +1,11 @@",
        " const { buildInvoice } = require('./invoice');",
        " ",
        " function checkout(order, config) {",
        "-  return buildInvoice(order, config);",
        "+  return buildInvoice({",
        "+    order,",
        "+    pricingConfig: config.pricing,",
        "+    shippingConfig: config.shipping,",
        "+  });",
        " }",
        " ",
        " module.exports = { checkout };",
        "",
      ].join("\n");
    } else if (this.repairAttempts === 2) {
      patch = [
        "diff --git a/src/invoice.js b/src/invoice.js",
        "--- a/src/invoice.js",
        "+++ b/src/invoice.js",
        "@@ -4,11 +4,17 @@",
        " function buildInvoice({ order, pricingConfig, shippingConfig }) {",
        "-  const pricing = priceItems(order.items, pricingConfig.discountRate);",
        "-  const shippingCents = quoteShipping(pricing.netSubtotalCents, shippingConfig);",
        "+  const pricing = priceItems({",
        "+    items: order.items,",
        "+    discountRate: pricingConfig.discountRate,",
        "+  });",
        "+  const shippingCents = quoteShipping({",
        "+    netSubtotalCents: pricing.netSubtotalCents,",
        "+    policy: shippingConfig,",
        "+  });",
        "   return {",
        "     id: order.id,",
        "     subtotalCents: pricing.subtotalCents,",
        "     discountCents: pricing.discountCents,",
        "     shippingCents,",
        "-    totalCents: pricing.subtotalCents + shippingCents,",
        "+    totalCents: pricing.netSubtotalCents + shippingCents,",
        "   };",
        " }",
        "",
      ].join("\n");
    } else {
      patch = [
        "diff --git a/src/shipping.js b/src/shipping.js",
        "--- a/src/shipping.js",
        "+++ b/src/shipping.js",
        "@@ -1,5 +1,5 @@",
        " function quoteShipping({ netSubtotalCents, policy }) {",
        "-  return netSubtotalCents >= policy.freeThresholdCents ? 0 : policy.baseShippingCents;",
        "+  return netSubtotalCents >= policy.freeThresholdCents ? 0 : policy.standardShippingCents;",
        " }",
        " ",
        " module.exports = { quoteShipping };",
        "",
      ].join("\n");
    }

    return {
      content: "",
      toolCalls: [
        {
          callId: `cascading-dependency-chain-repair-patch-${this.repairAttempts}`,
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class AmbiguousTestSignalRepairEvalModel implements ModelClient {
  readonly name = "ambiguous-test-signal-repair-eval";
  readonly userMessages: string[] = [];
  private phase: "read_source" | "apply_patch" | "done" = "read_source";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (this.phase === "read_source") {
      this.phase = "apply_patch";
      return {
        content: "",
        toolCalls: [
          {
            callId: "ambiguous-test-signal-read-source-1",
            name: "read_file",
            arguments: { path: "src/cart.js" },
            rawArguments: JSON.stringify({ path: "src/cart.js" }),
          },
        ],
      };
    }

    if (this.phase === "apply_patch") {
      this.phase = "done";
      const patch = [
        "diff --git a/src/cart.js b/src/cart.js",
        "--- a/src/cart.js",
        "+++ b/src/cart.js",
        "@@ -1,5 +1,5 @@",
        " function calculateCartSubtotalCents(lines) {",
        "-  return lines.reduce((sum, line) => sum + line.unitCents, 0);",
        "+  return lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);",
        " }",
        " ",
        " module.exports = { calculateCartSubtotalCents };",
        "",
      ].join("\n");

      return {
        content: "",
        toolCalls: [
          {
            callId: "ambiguous-test-signal-repair-patch-1",
            name: "apply_patch",
            arguments: { patch },
            rawArguments: JSON.stringify({ patch }),
          },
        ],
      };
    }

    return {
      content: "ambiguous test signal patch applied",
      toolCalls: [],
    };
  }
}

class LargeRepoRetrievalRepairEvalModel implements ModelClient {
  readonly name = "large-repo-retrieval-repair-eval";
  readonly userMessages: string[] = [];
  readonly discoveredPaths: string[] = [];
  private readonly readPathByCallId = new Map<string, string>();
  private phase: "search" | "read" | "patch" | "done" = "search";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (this.phase === "search") {
      this.phase = "read";
      return {
        content: "",
        toolCalls: [
          {
            callId: "large-repo-context-search-1",
            name: "suggest_context",
            arguments: { query: "checkout nexus delta" },
            rawArguments: JSON.stringify({ query: "checkout nexus delta" }),
          },
        ],
      };
    }

    if (this.phase === "read") {
      const searchContent = parseEvalToolContent(input.toolOutputs?.[0]?.output);
      const paths = [...searchContent.matchAll(/^\d+\.\s+([^\s]+\.js)\s+\(score/gm)]
        .map((match) => match[1])
        .filter((path): path is string => Boolean(path?.startsWith("packages/") && !path.includes("/a-legacy/")))
        .slice(0, 4);

      if (paths.length < 2) {
        throw new Error(`large-repository retrieval returned fewer than two source modules:\n${searchContent}`);
      }

      this.discoveredPaths.push(...paths);
      this.phase = "patch";
      const toolCalls = paths.map((path, index) => {
        const callId = `large-repo-read-${index + 1}`;
        this.readPathByCallId.set(callId, path);
        return {
          callId,
          name: "read_file",
          arguments: { path },
          rawArguments: JSON.stringify({ path }),
        };
      });

      return {
        content: "",
        toolCalls,
      };
    }

    if (this.phase === "patch") {
      let adapterPath: string | undefined;
      let policyPath: string | undefined;

      for (const output of input.toolOutputs ?? []) {
        const path = this.readPathByCallId.get(output.callId);
        const content = parseEvalToolContent(output.output);

        if (content.includes("function buildRegionalInvoice")) {
          adapterPath = path;
        } else if (content.includes("function calculateRegionalTaxCents")) {
          policyPath = path;
        }
      }

      if (!adapterPath || !policyPath) {
        throw new Error("retrieved files did not expose both the invoice adapter and tax policy contracts");
      }

      this.phase = "done";
      const patch = [
        `diff --git a/${adapterPath} b/${adapterPath}`,
        `--- a/${adapterPath}`,
        `+++ b/${adapterPath}`,
        "@@ -3,10 +3,12 @@",
        " // checkout nexus delta coordinates the checkout and tax packages.",
        " function buildRegionalInvoice(order, taxConfig) {",
        "   const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
        "+  const taxCents = calculateRegionalTaxCents({ subtotalCents, region: order.region, ratesByRegion: taxConfig });",
        "   return {",
        "     id: order.id,",
        "     subtotalCents,",
        "-    taxCents: calculateRegionalTaxCents(subtotalCents, order.region, taxConfig),",
        "+    taxCents,",
        "+    totalCents: subtotalCents + taxCents,",
        "   };",
        " }",
        " ",
        `diff --git a/${policyPath} b/${policyPath}`,
        `--- a/${policyPath}`,
        `+++ b/${policyPath}`,
        "@@ -1,7 +1,10 @@",
        " // checkout nexus delta owns the regional tax policy contract.",
        " function calculateRegionalTaxCents({ subtotalCents, region, ratesByRegion }) {",
        "-  const rate = ratesByRegion.default ?? 0;",
        "+  if (!(region in ratesByRegion)) {",
        "+    throw new Error(`Missing regional tax rate: ${region}`);",
        "+  }",
        "+  const rate = ratesByRegion[region];",
        "   return Math.round(subtotalCents * rate);",
        " }",
        " ",
        " module.exports = { calculateRegionalTaxCents };",
        "",
      ].join("\n");

      return {
        content: "",
        toolCalls: [
          {
            callId: "large-repo-retrieval-patch-1",
            name: "apply_patch",
            arguments: { patch },
            rawArguments: JSON.stringify({ patch }),
          },
        ],
      };
    }

    return {
      content: "large-repository retrieval repair patch applied",
      toolCalls: [],
    };
  }
}

class ProcessCleanupRepairEvalModel implements ModelClient {
  readonly name = "process-cleanup-repair-eval";
  readonly userMessages: string[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: "process cleanup patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/tests/service.test.js b/tests/service.test.js",
      "--- a/tests/service.test.js",
      "+++ b/tests/service.test.js",
      "@@ -2,13 +2,17 @@",
      " const { startService, stopService } = require('../src/service');",
      " ",
      " (async () => {",
      "   const server = await startService();",
      "-  const address = server.address();",
      "-  const response = await fetch(`http://127.0.0.1:${address.port}/health`);",
      "-  assert.equal(response.status, 200);",
      "-  assert.equal(await response.text(), 'ok');",
      "-  console.log('all tests passed; server cleanup pending');",
      "+  try {",
      "+    const address = server.address();",
      "+    const response = await fetch(`http://127.0.0.1:${address.port}/health`);",
      "+    assert.equal(response.status, 200);",
      "+    assert.equal(await response.text(), 'ok');",
      "+    console.log('all tests passed; server cleanup complete');",
      "+  } finally {",
      "+    await stopService(server);",
      "+  }",
      " })().catch((error) => {",
      "   console.error(error);",
      "   process.exitCode = 1;",
      " });",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "process-cleanup-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class ServiceReadinessRepairEvalModel implements ModelClient {
  readonly name = "service-readiness-repair-eval";
  readonly userMessages: string[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: "service readiness patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/tests/service-readiness.test.js b/tests/service-readiness.test.js",
      "--- a/tests/service-readiness.test.js",
      "+++ b/tests/service-readiness.test.js",
      "@@ -29,3 +29,19 @@",
      "-async function waitForHealthy(url) {",
      "-  return fetch(url);",
      "+async function waitForHealthy(url, timeoutMs = READY_TIMEOUT_MS) {",
      "+  const deadline = Date.now() + timeoutMs;",
      "+  let lastError;",
      "+",
      "+  while (Date.now() < deadline) {",
      "+    try {",
      "+      const response = await fetch(url);",
      "+      if (response.ok) {",
      "+        return response;",
      "+      }",
      "+      lastError = new Error(`Health check returned ${response.status}`);",
      "+    } catch (error) {",
      "+      lastError = error;",
      "+    }",
      "+    await new Promise((resolve) => setTimeout(resolve, 50));",
      "+  }",
      "+",
      "+  throw new Error(`Timed out waiting for ${url}`, { cause: lastError });",
      " }",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "service-readiness-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class ProjectFixtureRepairEvalModel implements ModelClient {
  readonly name = "project-fixture-repair-eval";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs) {
      return {
        content: "project fixture repair patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/src/domain/shipping.js b/src/domain/shipping.js",
      "--- a/src/domain/shipping.js",
      "+++ b/src/domain/shipping.js",
      "@@ -1,7 +1,8 @@",
      " const FREE_SHIPPING_THRESHOLD_CENTS = 5000;",
      " ",
      "-function calculateShippingCents(order) {",
      "-  return 0;",
      "+function calculateShippingCents(order, config) {",
      "+  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
      "+  return subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : config.shippingCents;",
      " }",
      " ",
      " module.exports = { FREE_SHIPPING_THRESHOLD_CENTS, calculateShippingCents };",
      "diff --git a/src/domain/orders.js b/src/domain/orders.js",
      "--- a/src/domain/orders.js",
      "+++ b/src/domain/orders.js",
      "@@ -2,8 +2,8 @@",
      " const { calculateTaxCents } = require('./tax');",
      " ",
      " function summarizeOrder(order, config) {",
      "-  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents, 0);",
      "-  const shippingCents = calculateShippingCents(order);",
      "+  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);",
      "+  const shippingCents = calculateShippingCents(order, config);",
      "   const taxCents = calculateTaxCents(subtotalCents, config.taxRate);",
      " ",
      "   return {",
      "@@ -11,7 +11,7 @@",
      "     subtotalCents,",
      "     shippingCents,",
      "     taxCents,",
      "-    grandTotalCents: subtotalCents + taxCents,",
      "+    grandTotalCents: subtotalCents + shippingCents + taxCents,",
      "   };",
      " }",
      " ",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "project-fixture-repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}
