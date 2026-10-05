import assert from "node:assert/strict";
import test from "node:test";
import {
  formatApprovalFullDetails,
  formatApprovalSummary,
  parseApprovalChoice,
} from "../src/cli.js";

test("parseApprovalChoice recognizes approval menu choices", () => {
  assert.equal(parseApprovalChoice("y"), "approve");
  assert.equal(parseApprovalChoice("YES"), "approve");
  assert.equal(parseApprovalChoice("n"), "deny");
  assert.equal(parseApprovalChoice(""), "deny");
  assert.equal(parseApprovalChoice(null), "deny");
  assert.equal(parseApprovalChoice("summary"), "summary");
  assert.equal(parseApprovalChoice("s"), "summary");
  assert.equal(parseApprovalChoice("diff"), "diff");
  assert.equal(parseApprovalChoice("d"), "diff");
  assert.equal(parseApprovalChoice("maybe"), "unknown");
});

test("formatApprovalSummary hides patch preview until requested", () => {
  const request = {
    toolName: "apply_patch",
    input: {
      patch: "diff --git a/demo.txt b/demo.txt\n+hello\n",
    },
    message: [
      "Apply this patch:",
      "Files: demo.txt",
      "Changes: +1 -0",
      "",
      "Preview:",
      "diff --git a/demo.txt b/demo.txt",
      "+hello",
    ].join("\n"),
  };

  assert.equal(
    formatApprovalSummary(request),
    ["Apply this patch:", "Files: demo.txt", "Changes: +1 -0"].join("\n"),
  );
  assert.equal(
    formatApprovalFullDetails(request),
    "diff --git a/demo.txt b/demo.txt\n+hello\n",
  );
});

test("formatApprovalSummary keeps non-patch approval messages intact", () => {
  const request = {
    toolName: "run_shell",
    input: {
      command: "npm test",
    },
    message: "Run shell command:\nnpm test",
  };

  assert.equal(formatApprovalSummary(request), "Run shell command:\nnpm test");
  assert.equal(formatApprovalFullDetails(request), "Run shell command:\nnpm test");
});
