import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTaskResumePrompt,
  formatTaskState,
  recordTaskVerificationFailure,
  recordTaskVerificationSuccess,
  updateTaskState,
} from "../src/taskState.js";

test("task state records verification failure and recovers after passing verification", () => {
  const started = updateTaskState(undefined, {
    objective: "Improve provider compatibility",
    status: "active",
  });

  assert.ok(started);

  const failed = recordTaskVerificationFailure(started, {
    command: "npm test",
    failedAt: "2026-07-15T00:00:00.000Z",
    locations: [],
    output: "failed",
    paths: ["src/model.ts"],
    remediation: [],
    summary: ["Tests failed."],
    exitCode: 1,
  });

  assert.equal(failed?.status, "blocked");
  assert.equal(failed?.lastVerification?.ok, false);

  const passed = recordTaskVerificationSuccess(failed, {
    command: "npm test",
    paths: ["src/model.ts"],
    recordedAt: "2026-07-15T00:01:00.000Z",
  });

  assert.equal(passed?.status, "active");
  assert.equal(passed?.lastVerification?.ok, true);
  assert.match(formatTaskState(passed), /Last verification: passed npm test/);
});

test("task resume prompt summarizes task, plan, files, patch, and verification", () => {
  const taskState = updateTaskState(undefined, {
    objective: "Improve provider compatibility",
    currentStep: "Repair failing smoke test",
    files: ["src/model.ts"],
    fileMode: "replace",
    summary: "Retry behavior was changed; provider smoke still needs rerun.",
  });

  assert.ok(taskState);

  const prompt = formatTaskResumePrompt({
    taskState,
    plan: {
      nextId: 3,
      steps: [
        {
          id: 1,
          content: "Inspect provider code",
          status: "completed",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
        {
          id: 2,
          content: "Fix smoke test",
          status: "in_progress",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    },
    lastPatch: {
      appliedAt: "2026-07-15T00:01:00.000Z",
      patch: "diff --git a/src/model.ts b/src/model.ts\n",
      paths: ["src/model.ts", "tests/model.test.ts"],
      snapshotPath: ".ccagent/patch-snapshots/example.json",
    },
    lastVerificationFailure: {
      command: "npm test",
      failedAt: "2026-07-15T00:02:00.000Z",
      locations: ["tests/model.test.ts:10"],
      output: "failed",
      paths: ["tests/model.test.ts"],
      remediation: [],
      summary: ["Model test failed."],
      exitCode: 1,
    },
  });

  assert.match(prompt, /Task resume prompt/);
  assert.match(prompt, /Objective:\nImprove provider compatibility/);
  assert.match(prompt, /\[x\] 1\. Inspect provider code/);
  assert.match(prompt, /\[>\] 2\. Fix smoke test/);
  assert.match(prompt, /src\/model\.ts/);
  assert.match(prompt, /tests\/model\.test\.ts/);
  assert.match(prompt, /status: failed/);
  assert.match(prompt, /Repair the failing verification/);
});
