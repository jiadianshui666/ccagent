import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { MockModelClient } from "../src/model.js";
import {
  addPlanStep,
  createEmptyPlan,
  formatPlan,
  parsePlan,
  replacePlanSteps,
  setPlanStepStatus,
} from "../src/plan.js";
import {
  createEmptySession,
  formatLoadedSession,
  formatSessionCheckpointBackups,
  formatSessionCheckpointDiff,
  formatSessionCheckpointDetails,
  formatSessionCheckpoints,
  formatSessionDetails,
  formatSessionSearch,
  formatSessionStats,
  isValidSessionCheckpointName,
  SessionStore,
} from "../src/session.js";

test("plan state supports add and one in-progress step", () => {
  let plan = createEmptyPlan();
  plan = addPlanStep(plan, "inspect files");
  plan = addPlanStep(plan, "write code");
  plan = setPlanStepStatus(plan, 1, "in_progress") ?? plan;
  plan = setPlanStepStatus(plan, 2, "in_progress") ?? plan;

  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]?.status, "pending");
  assert.equal(plan.steps[1]?.status, "in_progress");
  assert.match(formatPlan(plan), /\[>\] 2\. write code/);
});

test("replacePlanSteps rebuilds ordered plan ids", () => {
  const plan = replacePlanSteps([
    { content: "inspect files", status: "completed" },
    { content: "write tests", status: "in_progress" },
  ]);

  assert.equal(plan.nextId, 3);
  assert.equal(plan.steps[0]?.id, 1);
  assert.equal(plan.steps[0]?.status, "completed");
  assert.equal(plan.steps[1]?.id, 2);
  assert.equal(plan.steps[1]?.status, "in_progress");
});

test("parsePlan ignores invalid plan data with warnings", () => {
  const warnings: string[] = [];
  const plan = parsePlan(
    {
      nextId: 1,
      steps: [
        {
          id: 3,
          content: "valid step",
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "bad",
          content: "",
          status: "unknown",
        },
      ],
    },
    warnings,
  );

  assert.equal(plan.nextId, 4);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.content, "valid step");
  assert.ok(warnings.some((warning) => warning.includes("invalid fields")));
});

test("Agent handles plan commands and includes plan in snapshots", async () => {
  const agent = new Agent(new MockModelClient());

  assert.match((await agent.handleUserMessage("/plan")).content, /Plan is empty/);
  assert.match((await agent.handleUserMessage("/plan add inspect files")).content, /inspect files/);
  assert.match((await agent.handleUserMessage("/plan start 1")).content, /\[>\] 1\. inspect files/);
  assert.match((await agent.handleUserMessage("/plan done 1")).content, /\[x\] 1\. inspect files/);

  const snapshot = agent.snapshotSession();
  assert.equal(snapshot.plan.steps.length, 1);
  assert.equal(snapshot.plan.steps[0]?.status, "completed");
});

test("Agent can update plan through a model tool call", async () => {
  const agent = new Agent(new MockModelClient());

  const response = await agent.handleUserMessage("plan inspect files; write tests");
  const snapshot = agent.snapshotSession();

  assert.match(response.content, /update_plan/);
  assert.equal(snapshot.plan.steps.length, 2);
  assert.equal(snapshot.plan.steps[0]?.content, "inspect files");
  assert.equal(snapshot.plan.steps[0]?.status, "in_progress");
  assert.equal(snapshot.plan.steps[1]?.content, "write tests");
  assert.equal(snapshot.plan.steps[1]?.status, "pending");
});

test("SessionStore preserves plan state", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-plan-session-"));

  try {
    const store = new SessionStore(workspaceRoot);
    let session = createEmptySession("mock");
    session = {
      ...session,
      plan: addPlanStep(session.plan, "persist this step"),
      lastPatch: {
        patch: "diff --git a/demo.txt b/demo.txt\n",
        paths: ["demo.txt"],
        appliedAt: "2026-01-01T00:00:00.000Z",
        snapshotPath: ".ccagent/patch-snapshots/patch-snapshot-test.json",
      },
      lastVerificationFailure: {
        command: "npm run build",
        diagnosis: {
          category: "code",
          label: "TypeScript compile/typecheck failure",
        },
        paths: ["src/model.ts"],
        failedAt: "2026-01-01T00:00:02.000Z",
        exitCode: 1,
        summary: ["exitCode: 1", "inspect: src/model.ts:1:7"],
        remediation: ["align the value or argument with the expected type"],
        locations: ["src/model.ts:1:7"],
        output: "stderr:\nsrc/model.ts(1,7): error TS2322\nexitCode: 1",
        stability: {
          baseline: "failed",
          checkedAt: "2026-01-01T00:00:03.000Z",
          failed: 3,
          passed: 0,
          runs: 3,
          status: "stable_failure",
        },
      },
      lastVerificationTarget: {
        command: "npm run build",
        paths: ["src/model.ts"],
        recordedAt: "2026-01-01T00:00:02.000Z",
      },
      lastVerificationRun: {
        command: "npm run build",
        paths: ["src/model.ts"],
        recordedAt: "2026-01-01T00:00:02.000Z",
        status: "failed",
        exitCode: 1,
      },
    };

    await store.save(session);
    const loaded = await store.load("mock");

    assert.equal(loaded.session.plan.steps.length, 1);
    assert.equal(loaded.session.plan.steps[0]?.content, "persist this step");
    assert.equal(loaded.session.lastPatch?.paths[0], "demo.txt");
    assert.equal(loaded.session.lastPatch?.snapshotPath, ".ccagent/patch-snapshots/patch-snapshot-test.json");
    assert.equal(loaded.session.lastVerificationFailure?.command, "npm run build");
    assert.equal(loaded.session.lastVerificationFailure?.diagnosis?.category, "code");
    assert.equal(loaded.session.lastVerificationFailure?.locations[0], "src/model.ts:1:7");
    assert.equal(loaded.session.lastVerificationFailure?.stability?.status, "stable_failure");
    assert.equal(loaded.session.lastVerificationFailure?.stability?.runs, 3);
    assert.equal(loaded.session.lastVerificationTarget?.command, "npm run build");
    assert.equal(loaded.session.lastVerificationRun?.status, "failed");
    assert.equal(loaded.session.lastVerificationTarget?.paths[0], "src/model.ts");
    assert.match(formatLoadedSession(loaded), /Plan steps: 1/);
    assert.match(formatLoadedSession(loaded), /Last patch: demo\.txt/);
    assert.match(formatLoadedSession(loaded), /Last patch snapshot: \.ccagent\/patch-snapshots\/patch-snapshot-test\.json/);
    assert.match(formatLoadedSession(loaded), /Last verification failure: npm run build/);
    assert.match(formatLoadedSession(loaded), /Last verification target: npm run build/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("SessionStore manages named session checkpoints", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-checkpoint-session-"));

  try {
    const store = new SessionStore(workspaceRoot);
    let session = createEmptySession("mock");
    session = {
      ...session,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      messages: [{ role: "user", content: "remember this" }],
      plan: addPlanStep(session.plan, "checkpoint plan"),
      lastPatch: {
        patch: "diff --git a/demo.txt b/demo.txt\n",
        paths: ["demo.txt"],
        appliedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    await store.saveCheckpoint("before_edit", session);
    const listed = await store.listCheckpoints("mock");
    const loaded = await store.loadCheckpoint("before_edit", "mock");

    assert.equal(isValidSessionCheckpointName("before_edit"), true);
    assert.equal(isValidSessionCheckpointName("../bad"), false);
    assert.equal(listed.checkpoints[0]?.name, "before_edit");
    assert.equal(listed.checkpoints[0]?.messageCount, 1);
    assert.equal(listed.checkpoints[0]?.planStepCount, 1);
    assert.deepEqual(listed.checkpoints[0]?.lastPatchPaths, ["demo.txt"]);
    assert.match(formatSessionCheckpoints(listed), /before_edit: messages=1 plan=1 model=mock/);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.session.messages[0]?.content, "remember this");
    assert.match(formatSessionCheckpointDetails("before_edit", loaded), /Session checkpoint: before_edit/);
    assert.match(formatSessionCheckpointDetails("before_edit", loaded), /Current plan:/);
    assert.match(formatSessionCheckpointDetails("before_edit", loaded), /1\. user: remember this/);
    assert.match(formatSessionDetails("Current session", loaded), /Current session/);
    assert.match(formatSessionDetails("Current session", loaded), /Recent messages: 1 of 1/);
    assert.match(formatSessionStats("Current session stats", loaded), /Current session stats/);
    assert.match(formatSessionStats("Current session stats", loaded), /user: 1 \(13 chars, ~4 tokens\)/);
    assert.match(formatSessionStats("Current session stats", loaded), /pending: 1/);
    assert.match(formatSessionSearch("Current session search", loaded, "remember"), /Matches: 1/);
    assert.match(formatSessionSearch("Current session search", loaded, "remember"), /1\. user: remember this/);
    assert.match(formatSessionSearch("Current session search", loaded, "missing"), /No matching session messages found/);
    const formattedBackups = formatSessionCheckpointBackups({
        ...listed,
        checkpoints: [
          ...(listed.checkpoints[0] ? [listed.checkpoints[0]] : []),
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            lastPatchPaths: [],
            messageCount: 0,
            modelName: "mock",
            name: "before-load-20260101T000000000Z",
            path: "backup.json",
            planStepCount: 0,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    assert.match(formattedBackups, /before-load-20260101T000000000Z/);
    assert.doesNotMatch(formattedBackups, /before_edit: messages=1/);

    const afterSession = {
      ...session,
      messages: [
        ...session.messages,
        { role: "assistant" as const, content: "remembered this" },
      ],
      plan: setPlanStepStatus(session.plan, 1, "completed") ?? session.plan,
    };

    await store.saveCheckpoint("after_edit", afterSession);
    const afterLoaded = await store.loadCheckpoint("after_edit", "mock");
    const diff = formatSessionCheckpointDiff("before_edit", loaded, "after_edit", afterLoaded);

    assert.match(diff, /Session checkpoint diff: before_edit -> after_edit/);
    assert.match(diff, /messages: 1 -> 2 \(\+1\)/);
    assert.match(diff, /common message prefix: 1/);
    assert.match(diff, /\* 1\. checkpoint plan \[pending\] -> checkpoint plan \[completed\]/);
    assert.match(diff, /\+ 2\. assistant: remembered this/);

    await assert.rejects(
      () => store.saveCheckpoint("../bad", session),
      /Checkpoint names may contain only/,
    );

    assert.equal((await store.deleteCheckpoint("before_edit")).deleted, true);
    assert.equal((await store.deleteCheckpoint("before_edit")).deleted, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatSessionDetails accepts a recent message limit", () => {
  const session = createEmptySession("mock");
  const loaded = {
    path: "current.json",
    exists: true,
    warnings: [],
    session: {
      ...session,
      messages: [
        { role: "user" as const, content: "first" },
        { role: "assistant" as const, content: "second" },
        { role: "user" as const, content: "third" },
        { role: "assistant" as const, content: "fourth" },
      ],
    },
  };

  const output = formatSessionDetails("Current session", loaded, { messageLimit: 2 });

  assert.match(output, /Recent messages: 2 of 4/);
  assert.match(output, /\.\.\. 2 older message\(s\) omitted/);
  assert.doesNotMatch(output, /1\. user: first/);
  assert.match(output, /3\. user: third/);
  assert.match(output, /4\. assistant: fourth/);

  const checkpointOutput = formatSessionCheckpointDetails("limited", loaded, { messageLimit: 1 });

  assert.match(checkpointOutput, /Session checkpoint: limited/);
  assert.match(checkpointOutput, /Recent messages: 1 of 4/);
  assert.doesNotMatch(checkpointOutput, /3\. user: third/);
  assert.match(checkpointOutput, /4\. assistant: fourth/);
});
