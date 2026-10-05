import assert from "node:assert/strict";
import test from "node:test";
import { createToolPreflight, formatToolPreflight } from "../src/preflight.js";

test("createToolPreflight marks read-only tools as low risk", () => {
  const preflight = createToolPreflight({
    input: { path: ".", maxDepth: 1 },
    toolName: "list_files",
  });

  assert.equal(preflight.risk, "low");
  assert.equal(preflight.workspaceImpact, "read-only");
  assert.equal(preflight.requiresApproval, false);
  assert.equal(preflight.deniedByPolicy, false);
  assert.match(preflight.summary, /list_files risk=low impact=read-only/);
  assert.deepEqual(preflight.reasons, ["tool only reads workspace or git state"]);

  const workspaceInfoPreflight = createToolPreflight({
    input: {},
    toolName: "workspace_info",
  });

  assert.equal(workspaceInfoPreflight.risk, "low");
  assert.equal(workspaceInfoPreflight.workspaceImpact, "read-only");
  assert.match(workspaceInfoPreflight.summary, /workspace_info risk=low impact=read-only/);

  const suggestContextPreflight = createToolPreflight({
    input: { query: "provider smoke" },
    toolName: "suggest_context",
  });
  const patchHistoryPreflight = createToolPreflight({
    input: { limit: 10 },
    toolName: "patch_snapshot_history",
  });
  const symbolSearchPreflight = createToolPreflight({
    input: { query: "Agent", limit: 10 },
    toolName: "search_symbols",
  });
  const contextIndexStatusPreflight = createToolPreflight({
    input: {},
    toolName: "context_index_status",
  });
  const contextIndexSearchPreflight = createToolPreflight({
    input: { query: "Agent", limit: 10 },
    toolName: "search_context_index",
  });
  const semanticIndexStatusPreflight = createToolPreflight({
    input: {},
    toolName: "semantic_index_status",
  });
  const semanticIndexSearchPreflight = createToolPreflight({
    input: { query: "Agent", limit: 10 },
    toolName: "search_semantic_index",
  });
  const verificationPreflight = createToolPreflight({
    input: { paths: ["src/model.ts"] },
    toolName: "suggest_verification",
  });

  assert.equal(suggestContextPreflight.risk, "low");
  assert.equal(suggestContextPreflight.workspaceImpact, "read-only");
  assert.match(suggestContextPreflight.summary, /suggest_context risk=low impact=read-only/);
  assert.equal(patchHistoryPreflight.risk, "low");
  assert.equal(patchHistoryPreflight.workspaceImpact, "read-only");
  assert.match(patchHistoryPreflight.summary, /patch_snapshot_history risk=low impact=read-only/);
  assert.equal(symbolSearchPreflight.risk, "low");
  assert.equal(symbolSearchPreflight.workspaceImpact, "read-only");
  assert.match(symbolSearchPreflight.summary, /search_symbols risk=low impact=read-only/);
  assert.equal(contextIndexStatusPreflight.risk, "low");
  assert.equal(contextIndexStatusPreflight.workspaceImpact, "read-only");
  assert.equal(contextIndexSearchPreflight.risk, "low");
  assert.equal(contextIndexSearchPreflight.workspaceImpact, "read-only");
  assert.equal(semanticIndexStatusPreflight.risk, "low");
  assert.equal(semanticIndexStatusPreflight.workspaceImpact, "read-only");
  assert.equal(semanticIndexSearchPreflight.risk, "low");
  assert.equal(semanticIndexSearchPreflight.workspaceImpact, "read-only");
  assert.equal(verificationPreflight.risk, "low");
  assert.equal(verificationPreflight.workspaceImpact, "read-only");
  assert.match(verificationPreflight.summary, /suggest_verification risk=low impact=read-only/);
});

test("createToolPreflight marks context index build as local metadata write", () => {
  const preflight = createToolPreflight({
    input: {},
    toolName: "build_context_index",
  });
  const semanticPreflight = createToolPreflight({
    input: {},
    toolName: "build_semantic_index",
  });

  assert.equal(preflight.risk, "low");
  assert.equal(preflight.workspaceImpact, "workspace-write");
  assert.match(preflight.summary, /build_context_index risk=low impact=workspace-write/);
  assert.equal(
    preflight.reasons.some((reason) => reason.includes(".ccagent/index")),
    true,
  );
  assert.equal(semanticPreflight.risk, "low");
  assert.equal(semanticPreflight.workspaceImpact, "workspace-write");
  assert.match(semanticPreflight.summary, /build_semantic_index risk=low impact=workspace-write/);
  assert.equal(
    semanticPreflight.reasons.some((reason) => reason.includes("semantic index")),
    true,
  );
});

test("createToolPreflight marks task state updates as plan-only", () => {
  const preflight = createToolPreflight({
    input: {
      objective: "Improve provider compatibility",
      status: "active",
      currentStep: "write tests",
      summary: "",
      files: [],
      fileMode: "keep",
    },
    toolName: "update_task_state",
  });

  assert.equal(preflight.risk, "low");
  assert.equal(preflight.workspaceImpact, "plan-only");
  assert.match(preflight.summary, /update_task_state risk=low impact=plan-only/);
  assert.equal(
    preflight.reasons.some((reason) => reason.includes("task state")),
    true,
  );
});

test("createToolPreflight promotes approval-gated safe tools to medium risk", () => {
  const preflight = createToolPreflight({
    input: { path: "package.json" },
    requiresApproval: true,
    toolName: "read_file",
  });

  assert.equal(preflight.risk, "medium");
  assert.equal(preflight.workspaceImpact, "read-only");
  assert.equal(preflight.requiresApproval, true);
  assert.equal(preflight.reasons.at(-1), "approval is required before execution");
});

test("createToolPreflight marks file edits and shell commands as high risk", () => {
  const patchPreflight = createToolPreflight({
    input: { patch: "diff --git a/demo.txt b/demo.txt\n" },
    requiresApproval: true,
    toolName: "apply_patch",
  });
  const shellPreflight = createToolPreflight({
    input: { command: "npm test" },
    toolName: "run_shell",
  });
  const restorePreflight = createToolPreflight({
    input: { path: "note.txt" },
    toolName: "restore_patch_snapshot",
  });

  assert.equal(patchPreflight.risk, "high");
  assert.equal(patchPreflight.workspaceImpact, "workspace-write");
  assert.equal(patchPreflight.requiresApproval, true);
  assert.equal(
    patchPreflight.reasons.some((reason) => reason.includes("modify files")),
    true,
  );
  assert.equal(shellPreflight.risk, "high");
  assert.equal(shellPreflight.workspaceImpact, "shell");
  assert.equal(
    shellPreflight.reasons.some((reason) => reason.includes("npm test")),
    true,
  );
  assert.equal(restorePreflight.risk, "high");
  assert.equal(restorePreflight.workspaceImpact, "workspace-write");
  assert.equal(
    restorePreflight.reasons.some((reason) => reason.includes("note.txt")),
    true,
  );
});

test("createToolPreflight marks denied tools as high risk", () => {
  const preflight = createToolPreflight({
    deniedByPolicy: true,
    input: { path: "package.json" },
    toolName: "read_file",
  });

  assert.equal(preflight.risk, "high");
  assert.equal(preflight.workspaceImpact, "read-only");
  assert.equal(preflight.deniedByPolicy, true);
  assert.equal(preflight.reasons[0], "tool is disabled by project policy");
});

test("formatToolPreflight returns a readable multiline summary", () => {
  const preflight = createToolPreflight({
    input: {},
    toolName: "unknown_tool",
  });

  assert.equal(preflight.risk, "medium");
  assert.equal(preflight.workspaceImpact, "unknown");
  assert.match(formatToolPreflight(preflight), /Risk: medium/);
  assert.match(formatToolPreflight(preflight), /Workspace impact: unknown/);
  assert.match(formatToolPreflight(preflight), /tool has no known risk profile/);
});
