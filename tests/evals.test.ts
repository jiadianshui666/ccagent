import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildOfflineEvalGateComparison,
  checkOfflineEvalCoverage,
  compareOfflineEvalReports,
  compareOfflineEvalReportAgainstLatest,
  exportOfflineEvalsReport,
  formatOfflineEvalCase,
  formatOfflineEvalCases,
  formatOfflineEvalCasesJson,
  formatOfflineEvalCaseJson,
  formatOfflineEvalBaseline,
  formatOfflineEvalTags,
  formatOfflineEvalTagsJson,
  formatOfflineEvals,
  formatOfflineEvalReportComparison,
  formatOfflineEvalReportComparisonJson,
  formatOfflineEvalReports,
  formatOfflineEvalReportsJson,
  formatOfflineEvalsJson,
  formatOfflineEvalsReport,
  formatOfflineEvalsReportJson,
  listOfflineEvalCases,
  listOfflineEvalReports,
  listOfflineEvalTags,
  OFFLINE_EVAL_CASE_NAMES,
  runOfflineEvalCase,
  runOfflineEvals,
  saveOfflineEvalBaseline,
  type OfflineEvalCaseTag,
  type OfflineEvalReportSummary,
  type OfflineEvalSuiteName,
} from "../src/evals.js";

test("runOfflineEvals runs the smoke suite by default", async () => {
  const result = await runOfflineEvals();

  assert.equal(result.suite, "smoke");
  assert.equal(result.failed, 0);
  assert.equal(result.results.length, 3);
  assert.equal(result.results.some((item) => item.name === "list_files"), true);
  assert.equal(result.results.some((item) => item.name === "workspace_info"), true);
  assert.equal(result.results.some((item) => item.name === "read_file"), true);
  assert.equal(result.results.some((item) => item.name === "plan_update"), false);
  assert.equal(result.results.some((item) => item.name === "replace_file"), false);
});

test("runOfflineEvalCase runs one named case", async () => {
  const result = await runOfflineEvalCase("list_files");
  const output = formatOfflineEvalCase(result);
  const json = JSON.parse(formatOfflineEvalCaseJson(result)) as typeof result;

  assert.equal(OFFLINE_EVAL_CASE_NAMES.includes("list_files"), true);
  assert.equal(result.caseName, "list_files");
  assert.equal(result.result.name, "list_files");
  assert.equal(result.result.status, "pass");
  assert.match(output, /Offline eval case \(list_files\)/);
  assert.match(output, /\[PASS\] list_files/);
  assert.equal(json.caseName, "list_files");
  assert.equal(json.result.status, "pass");
});

test("context graph retrieval eval reports ranking and recall metrics", async () => {
  const result = await runOfflineEvalCase("context_graph_retrieval");

  assert.equal(result.result.status, "pass");
  assert.match(result.result.summary, /graph recall@10 4\/4/);
  assert.match(result.result.summary, /exact MRR 1\.00/);
  assert.match(result.result.summary, /depth-two test yes/);
  assert.match(result.result.summary, /hybrid recall@5 4\/4/);
});

test("listOfflineEvalCases returns discoverable case metadata", () => {
  const result = listOfflineEvalCases();
  const output = formatOfflineEvalCases(result);
  const json = JSON.parse(formatOfflineEvalCasesJson(result)) as typeof result;
  const regression = listOfflineEvalCases("regression");
  const regressionOutput = formatOfflineEvalCases(regression);
  const repair = listOfflineEvalCases("regression", "repair");
  const repairOutput = formatOfflineEvalCases(repair);
  const listFiles = result.cases.find((item) => item.name === "list_files");
  const repairLoop = result.cases.find((item) => item.name === "repair_loop_multifile");

  assert.equal(result.count, OFFLINE_EVAL_CASE_NAMES.length);
  assert.equal(result.cases.length, OFFLINE_EVAL_CASE_NAMES.length);
  assert.deepEqual(listFiles?.suites, ["smoke", "benchmark"]);
  assert.deepEqual(listFiles?.tags, ["tool", "workspace"]);
  assert.deepEqual(repairLoop?.suites, ["regression", "benchmark"]);
  assert.deepEqual(repairLoop?.tags, ["editing", "multifile", "patch", "repair", "verification"]);
  assert.match(output, /Offline eval cases/);
  assert.match(output, /Count: 29/);
  assert.match(output, /- context_graph_retrieval/);
  assert.match(output, /- repair_loop_bad_patch_recovery/);
  assert.match(output, /- repair_loop_wrong_file_recovery/);
  assert.match(output, /- repair_loop_partial_multifile_recovery/);
  assert.match(output, /- repair_loop_multifile/);
  assert.match(output, /- repair_loop_service_contract/);
  assert.match(output, /- repair_loop_renamed_api_contract/);
  assert.match(output, /- repair_loop_stale_import_contract/);
  assert.match(output, /- repair_loop_contract_drift/);
  assert.match(output, /- repair_loop_multi_caller_contract_drift/);
  assert.match(output, /- repair_loop_cascading_dependency_chain/);
  assert.match(output, /- repair_loop_ambiguous_test_signal/);
  assert.match(output, /- repair_loop_large_repo_retrieval/);
  assert.match(output, /- repair_loop_process_cleanup/);
  assert.match(output, /- repair_loop_service_readiness/);
  assert.match(output, /- repair_loop_project_fixture/);
  assert.match(output, /- verification_flaky_guard/);
  assert.match(output, /- verification_environment_failures/);
  assert.match(output, /tags: editing, multifile, patch, repair, verification/);
  assert.match(output, /service\/API contract/);
  assert.match(output, /multi-file repair patch/);
  assert.equal(json.count, OFFLINE_EVAL_CASE_NAMES.length);
  assert.equal(json.cases.some((item) => item.name === "verification_failure_strategies"), true);
  assert.equal(regression.suite, "regression");
  assert.equal(regression.count, 26);
  assert.equal(regression.cases.some((item) => item.name === "list_files"), false);
  assert.equal(regression.cases.some((item) => item.name === "repair_loop_bad_patch_recovery"), true);
  assert.equal(regression.cases.some((item) => item.name === "repair_loop_wrong_file_recovery"), true);
  assert.equal(regression.cases.some((item) => item.name === "repair_loop_partial_multifile_recovery"), true);
  assert.equal(regression.cases.some((item) => item.name === "repair_loop_multifile"), true);
  assert.match(regressionOutput, /Suite: regression/);
  assert.match(regressionOutput, /Count: 26/);
  assert.equal(repair.suite, "regression");
  assert.equal(repair.tag, "repair");
  assert.equal(repair.count, 19);
  assert.deepEqual(repair.cases.map((item) => item.name), [
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
  ]);
  assert.match(repairOutput, /Suite: regression/);
  assert.match(repairOutput, /Tag: repair/);
});

test("listOfflineEvalTags returns tag metadata", () => {
  const result = listOfflineEvalTags();
  const output = formatOfflineEvalTags(result);
  const json = JSON.parse(formatOfflineEvalTagsJson(result)) as typeof result;
  const regression = listOfflineEvalTags("regression");
  const repair = result.tags.find((item) => item.name === "repair");

  assert.equal(result.count, 13);
  assert.equal(result.tags.some((item) => item.name === "retrieval"), true);
  assert.equal(result.tags.some((item) => item.name === "workspace"), true);
  assert.equal(repair?.count, 19);
  assert.deepEqual(repair?.suites, ["regression", "benchmark"]);
  assert.deepEqual(repair?.cases, [
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
  ]);
  assert.match(output, /Offline eval tags/);
  assert.match(output, /- repair/);
  assert.match(output, /case names: repair_loop, repair_loop_bad_patch_recovery, repair_loop_wrong_file_recovery, repair_loop_partial_multifile_recovery, repair_loop_multifile, repair_loop_service_contract, repair_loop_renamed_api_contract, repair_loop_stale_import_contract, repair_loop_contract_drift, repair_loop_multi_caller_contract_drift, repair_loop_cascading_dependency_chain, repair_loop_ambiguous_test_signal, repair_loop_large_repo_retrieval, repair_loop_process_cleanup, repair_loop_service_readiness, repair_loop_project_fixture, verification_failure_strategies, verification_environment_failures, verification_flaky_guard/);
  assert.equal(json.count, 13);
  assert.equal(json.tags.some((item) => item.name === "diagnostics"), true);

  assert.equal(regression.suite, "regression");
  assert.equal(regression.count, 12);
  assert.equal(regression.tags.some((item) => item.name === "retrieval"), true);
  assert.equal(regression.tags.some((item) => item.name === "tool"), false);
  assert.equal(regression.tags.some((item) => item.name === "repair"), true);
  assert.equal(regression.tags.some((item) => item.name === "workspace"), true);
  assert.match(formatOfflineEvalTags(regression), /Suite: regression/);
});

test("runOfflineEvals runs the full regression suite and a configurable benchmark", async () => {
  const regression = await runOfflineEvals("regression");
  const benchmark = await runOfflineEvals("benchmark", { iterations: 1, tag: "tool" });

  assert.equal(regression.suite, "regression");
  assert.equal(regression.failed, 0);
  assert.equal(regression.results.length, 26);
  assert.equal(regression.results.some((item) => item.name === "context_graph_retrieval"), true);
  assert.equal(regression.results.some((item) => item.name === "plan_update"), true);
  assert.equal(regression.results.some((item) => item.name === "replace_file"), true);
  assert.equal(regression.results.some((item) => item.name === "task_replace_file"), true);
  assert.equal(regression.results.some((item) => item.name === "missing_text_recovery"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_bad_patch_recovery"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_wrong_file_recovery"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_partial_multifile_recovery"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_multifile"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_service_contract"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_renamed_api_contract"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_stale_import_contract"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_contract_drift"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_multi_caller_contract_drift"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_cascading_dependency_chain"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_ambiguous_test_signal"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_large_repo_retrieval"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_process_cleanup"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_service_readiness"), true);
  assert.equal(regression.results.some((item) => item.name === "repair_loop_project_fixture"), true);
  assert.equal(regression.results.some((item) => item.name === "verification_failure_strategies"), true);
  assert.equal(regression.results.some((item) => item.name === "verification_environment_failures"), true);
  assert.equal(regression.results.some((item) => item.name === "verification_flaky_guard"), true);

  assert.equal(benchmark.suite, "benchmark");
  assert.equal(benchmark.failed, 0);
  assert.equal(benchmark.iterations, 1);
  assert.equal(benchmark.tag, "tool");
  assert.equal(benchmark.results.length, 3);
  assert.equal(benchmark.results.some((item) => item.name === "list_files"), true);
  assert.equal(benchmark.results.some((item) => item.name === "workspace_info"), true);
  assert.equal(benchmark.results.some((item) => item.name === "read_file"), true);
  assert.equal(benchmark.results.some((item) => item.name === "repair_loop"), false);
  assert.ok(benchmark.results.every((item) => item.summary.includes("runs")));
});

test("runOfflineEvals filters lightweight suites and benchmarks by tag", async () => {
  const smoke = await runOfflineEvals("smoke", { tag: "tool" });
  const benchmark = await runOfflineEvals("benchmark", { iterations: 1, tag: "tool" });
  const output = formatOfflineEvals(smoke);

  assert.equal(smoke.suite, "smoke");
  assert.equal(smoke.tag, "tool");
  assert.equal(smoke.failed, 0);
  assert.equal(smoke.results.length, 3);
  assert.match(output, /Tag: tool/);

  assert.equal(benchmark.suite, "benchmark");
  assert.equal(benchmark.tag, "tool");
  assert.equal(benchmark.iterations, 1);
  assert.equal(benchmark.results.length, 3);
  assert.equal(benchmark.results.some((item) => item.name === "list_files"), true);
  assert.equal(benchmark.results.some((item) => item.name === "workspace_info"), true);
  assert.equal(benchmark.results.some((item) => item.name === "read_file"), true);
  assert.ok(benchmark.results.every((item) => item.summary.includes("1/1 runs")));
});

test("runOfflineEvals validates benchmark iteration overrides", async () => {
  await assert.rejects(
    runOfflineEvals("benchmark", { iterations: 0 }),
    /benchmark iterations must be an integer between 1 and 20/,
  );
  await assert.rejects(
    runOfflineEvals("benchmark", { iterations: 21 }),
    /benchmark iterations must be an integer between 1 and 20/,
  );
  await assert.rejects(
    runOfflineEvals("smoke", { iterations: 1 }),
    /iterations is only supported for the benchmark suite/,
  );
});

test("formatOfflineEvals renders suite and benchmark summaries", () => {
  const smokeResult = {
    durationMs: 12,
    failed: 1,
    passed: 1,
    results: [
      {
        durationMs: 1,
        name: "pass_case",
        status: "pass",
        summary: "ok",
      },
      {
        durationMs: 2,
        name: "fail_case",
        status: "fail",
        summary: "bad",
      },
    ],
    suite: "smoke",
    skipped: 0,
  } as const;
  const benchmarkResult = {
    durationMs: 30,
    failed: 1,
    iterations: 3,
    passed: 1,
    results: [
      {
        durationMs: 4,
        name: "pass_case",
        status: "pass",
        summary: "passed 3/3 runs",
      },
      {
        durationMs: 5,
        name: "skip_case",
        status: "skip",
        summary: "skipped 3/3 runs",
      },
      {
        durationMs: 6,
        name: "fail_case",
        status: "fail",
        summary: "failed 1/3 runs, passed 2/3 runs",
      },
    ],
    suite: "benchmark",
    skipped: 1,
  } as const;

  const smokeOutput = formatOfflineEvals(smokeResult);
  const benchmarkOutput = formatOfflineEvals(benchmarkResult);
  const smokeJson = JSON.parse(formatOfflineEvalsJson(smokeResult)) as typeof smokeResult;
  const benchmarkJson = JSON.parse(formatOfflineEvalsJson(benchmarkResult)) as typeof benchmarkResult;

  assert.match(smokeOutput, /Offline evals \(smoke\)/);
  assert.match(smokeOutput, /Duration: 12ms/);
  assert.match(smokeOutput, /Passed: 1/);
  assert.match(smokeOutput, /Failed: 1/);
  assert.match(smokeOutput, /\[PASS\] pass_case \(1ms\): ok/);
  assert.match(smokeOutput, /\[FAIL\] fail_case \(2ms\): bad/);
  assert.match(benchmarkOutput, /Offline evals \(benchmark\)/);
  assert.match(benchmarkOutput, /Duration: 30ms total/);
  assert.match(benchmarkOutput, /Iterations: 3/);
  assert.match(benchmarkOutput, /Average iteration: 10ms/);
  assert.match(benchmarkOutput, /\[PASS\] pass_case \(4ms\): passed 3\/3 runs/);
  assert.match(benchmarkOutput, /\[FAIL\] fail_case \(6ms\): failed 1\/3 runs, passed 2\/3 runs/);
  assert.equal(smokeJson.suite, "smoke");
  assert.equal(benchmarkJson.suite, "benchmark");
  assert.equal(benchmarkJson.iterations, 3);
  assert.equal(benchmarkJson.results[2]?.name, "fail_case");
});

test("exportOfflineEvalsReport writes a readable Markdown report", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-evals-report-"));

  try {
    const report = await exportOfflineEvalsReport(workspaceRoot, "smoke");
    const output = formatOfflineEvalsReport(report);
    const json = JSON.parse(formatOfflineEvalsReportJson(report)) as typeof report;
    const content = await readFile(join(workspaceRoot, report.path), "utf8");
    const jsonContent = await readFile(join(workspaceRoot, report.jsonPath), "utf8");
    const savedJson = JSON.parse(jsonContent) as typeof report;

    assert.equal(report.suite, "smoke");
    assert.match(report.path, /^\.ccagent\/reports\/eval-report-smoke-.+\.md$/);
    assert.match(report.jsonPath, /^\.ccagent\/reports\/eval-report-smoke-.+\.json$/);
    assert.match(output, /Exported eval report/);
    assert.match(output, /Suite: smoke/);
    assert.match(output, /Path: \.ccagent\/reports\/eval-report-smoke-/);
    assert.equal(json.path, report.path);
    assert.equal(savedJson.jsonPath, report.jsonPath);
    assert.match(content, /# CCAgent Eval Report/);
    assert.match(content, /Suite: smoke/);
    assert.match(content, /\| list_files \| PASS \|/);
    assert.match(content, /\| workspace_info \| PASS \|/);
    assert.match(content, /\| read_file \| PASS \|/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("list and compare offline eval reports", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-evals-history-"));

  try {
    const first = await exportOfflineEvalsReport(workspaceRoot, "smoke");
    const second = await exportOfflineEvalsReport(workspaceRoot, "benchmark", { iterations: 1, tag: "tool" });
    const reports = await listOfflineEvalReports(workspaceRoot);
    const reportsOutput = formatOfflineEvalReports(reports);
    const reportsJson = JSON.parse(formatOfflineEvalReportsJson(reports)) as { reports: unknown[] };
    const comparison = await compareOfflineEvalReports(workspaceRoot);
    const namedComparison = await compareOfflineEvalReports(
      workspaceRoot,
      first.jsonFileName,
      second.jsonFileName,
    );

    assert.equal(reports.length, 2);
    assert.equal(reports[0]?.suite, "benchmark");
    assert.equal(reports[1]?.suite, "smoke");
    assert.match(reportsOutput, /Eval reports/);
    assert.match(reportsOutput, /Count: 2/);
    assert.match(reportsOutput, /benchmark/);
    assert.equal(reportsJson.reports.length, 2);

    assert.equal(comparison.ok, true);
    assert.equal(namedComparison.ok, true);

    if (comparison.ok) {
      const output = formatOfflineEvalReportComparison(comparison);
      const json = JSON.parse(formatOfflineEvalReportComparisonJson(comparison)) as {
        cases: Array<{ classification: string; regressed: boolean }>;
        left: { suite: string };
        right: { suite: string };
        summary: { status: string };
      };

      assert.equal(comparison.left.suite, "smoke");
      assert.equal(comparison.right.suite, "benchmark");
      assert.equal(comparison.summary.status, "informational");
      assert.equal(comparison.cases.length, 3);
      assert.match(output, /Eval report comparison/);
      assert.match(output, /Status: INFO/);
      assert.match(output, /Suite: smoke -> benchmark/);
      assert.match(output, /Regressions: none/);
      assert.match(output, /\| list_files \|/);
      assert.match(output, /\| workspace_info \|/);
      assert.match(output, /\| read_file \|/);
      assert.match(output, /\| Case \| Left ms \| Right ms \| Delta \| Left status \| Right status \| Classification \| Regression \|/);
      assert.equal(json.left.suite, "smoke");
      assert.equal(json.right.suite, "benchmark");
      assert.equal(json.summary.status, "informational");
      assert.equal(json.cases.length, 3);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("compareOfflineEvalReports flags duration regressions when threshold is exceeded", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-evals-compare-threshold-"));

  try {
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 10, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 20, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 30,
      exportedAt: "2026-07-11T10:00:00.000Z",
      suite: "smoke",
    });
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 20, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 40, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 60,
      exportedAt: "2026-07-11T10:05:00.000Z",
      suite: "smoke",
    });

    const comparison = await compareOfflineEvalReports(workspaceRoot, undefined, undefined, 5);

    assert.equal(comparison.ok, true);

    if (comparison.ok) {
      const output = formatOfflineEvalReportComparison(comparison);
      const json = JSON.parse(formatOfflineEvalReportComparisonJson(comparison)) as {
        cases: Array<{ classification: string; regressed: boolean }>;
        summary: { regressions: string[]; status: string };
      };

      assert.equal(comparison.summary.status, "regressed");
      assert.ok(comparison.summary.regressions.length > 0);
      assert.equal(comparison.cases.every((item) => item.regressed), true);
      assert.match(output, /Status: REGRESSED/);
      assert.match(output, /Duration threshold: 5ms/);
      assert.match(output, /Regressions:/);
      assert.match(output, /duration increased by \+30ms, above threshold 5ms/);
      assert.equal(json.summary.status, "regressed");
      assert.equal(json.cases.length, 2);
      assert.ok(json.summary.regressions.length > 0);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function buildFakeSummary(
  suite: OfflineEvalSuiteName,
  caseNames: string[],
  tag?: OfflineEvalCaseTag,
): OfflineEvalReportSummary {
  const results = caseNames.map((name) => ({
    durationMs: 10,
    name,
    status: "pass" as const,
    summary: "ok",
  }));

  return {
    exportedAt: "2026-07-11T10:00:00.000Z",
    fileName: "eval-report-smoke-fake.md",
    jsonFileName: "eval-report-smoke-fake.json",
    jsonPath: ".ccagent/reports/eval-report-smoke-fake.json",
    path: ".ccagent/reports/eval-report-smoke-fake.md",
    result: {
      durationMs: results.length * 10,
      failed: 0,
      passed: results.length,
      results,
      skipped: 0,
      suite,
      ...(tag ? { tag } : {}),
    },
    suite,
  };
}

test("checkOfflineEvalCoverage requires every expected case for untagged runs", () => {
  assert.deepEqual(
    checkOfflineEvalCoverage(buildFakeSummary("smoke", ["list_files", "workspace_info", "read_file"])),
    [],
  );
  assert.deepEqual(
    checkOfflineEvalCoverage(buildFakeSummary("smoke", ["list_files"])),
    ["workspace_info", "read_file"],
  );
  assert.deepEqual(checkOfflineEvalCoverage(buildFakeSummary("smoke", ["list_files"], "tool")), []);
});

test("buildOfflineEvalGateComparison marks missing coverage as a regression", () => {
  const left = buildFakeSummary("smoke", ["list_files", "workspace_info", "read_file"]);
  const right = buildFakeSummary("smoke", ["list_files"]);
  const comparison = buildOfflineEvalGateComparison(left, right, 100);

  assert.equal(comparison.summary.status, "regressed");
  assert.deepEqual(comparison.coverage?.missing, ["workspace_info", "read_file"]);
  assert.equal(
    comparison.summary.regressions.some((line) => /coverage: missing expected cases/.test(line)),
    true,
  );
});

test("saveOfflineEvalBaseline pins and replaces the latest report for a suite", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-evals-baseline-"));

  try {
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 10, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 10, name: "workspace_info", status: "pass", summary: "ok" },
        { durationMs: 10, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 30,
      exportedAt: "2026-07-11T10:00:00.000Z",
      suite: "smoke",
    });

    const saved = await saveOfflineEvalBaseline(workspaceRoot, "smoke");

    assert.equal(saved.ok, true);

    if (!saved.ok) {
      return;
    }

    assert.equal(saved.replaced, false);
    assert.equal(saved.suite, "smoke");
    const pinnedJson = JSON.parse(
      await readFile(join(workspaceRoot, saved.jsonPath), "utf8"),
    ) as { jsonFileName: string; suite: string };
    assert.equal(pinnedJson.suite, "smoke");
    assert.equal(pinnedJson.jsonFileName, "eval-baseline-smoke.json");
    assert.match(formatOfflineEvalBaseline(saved), /Gate against it with: \/evals gate --against baseline-smoke/);
    assert.equal((await listOfflineEvalReports(workspaceRoot)).length, 1);

    const replaced = await saveOfflineEvalBaseline(workspaceRoot, "smoke");
    assert.equal(replaced.ok && replaced.replaced, true);

    const missingSuite = await saveOfflineEvalBaseline(workspaceRoot, "regression");
    assert.equal(missingSuite.ok, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("compareOfflineEvalReportAgainstLatest gates against a named baseline", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-evals-gate-against-"));

  try {
    await writeEvalReportJson(workspaceRoot, {
      cases: [
        { durationMs: 10, name: "list_files", status: "pass", summary: "ok" },
        { durationMs: 10, name: "workspace_info", status: "pass", summary: "ok" },
        { durationMs: 10, name: "read_file", status: "pass", summary: "ok" },
      ],
      durationMs: 30,
      exportedAt: "2026-07-11T10:00:00.000Z",
      suite: "smoke",
    });
    const pinned = await saveOfflineEvalBaseline(workspaceRoot, "smoke");
    assert.equal(pinned.ok, true);
    await writeEvalReportJson(workspaceRoot, {
      cases: [{ durationMs: 10, name: "list_files", status: "pass", summary: "ok" }],
      durationMs: 10,
      exportedAt: "2026-07-11T10:05:00.000Z",
      suite: "smoke",
    });

    const comparison = await compareOfflineEvalReportAgainstLatest(workspaceRoot, "baseline-smoke");

    assert.equal(comparison.ok, true);

    if (comparison.ok) {
      assert.equal(comparison.summary.status, "regressed");
      assert.deepEqual(comparison.coverage?.missing, ["workspace_info", "read_file"]);
      assert.equal(comparison.left.jsonFileName, "eval-baseline-smoke.json");
    }

    const missingBaseline = await compareOfflineEvalReportAgainstLatest(workspaceRoot, "baseline-regression");
    assert.equal(missingBaseline.ok, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function writeEvalReportJson(
  workspaceRoot: string,
  report: {
    cases: Array<{
      durationMs: number;
      name: string;
      status: "pass" | "fail" | "skip";
      summary: string;
    }>;
    durationMs: number;
    exportedAt: string;
    suite: "smoke" | "regression" | "benchmark";
  },
): Promise<void> {
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileStamp = report.exportedAt.replace(/[:.]/g, "-");
  const jsonFileName = `eval-report-${report.suite}-${fileStamp}.json`;
  const fileName = `eval-report-${report.suite}-${fileStamp}.md`;
  const payload = {
    exportedAt: report.exportedAt,
    fileName,
    jsonFileName,
    jsonPath: `.ccagent/reports/${jsonFileName}`,
    path: `.ccagent/reports/${fileName}`,
    result: {
      durationMs: report.durationMs,
      failed: report.cases.filter((item) => item.status === "fail").length,
      passed: report.cases.filter((item) => item.status === "pass").length,
      results: report.cases,
      suite: report.suite,
      skipped: report.cases.filter((item) => item.status === "skip").length,
    },
    suite: report.suite,
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, jsonFileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
