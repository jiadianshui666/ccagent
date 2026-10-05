import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  completeInteractiveInput,
  completeInteractiveInputWithWorkspace,
  completeSlashCommandHints,
} from "../src/completion.js";

test("completeSlashCommandHints feeds the prompt hint bar", () => {
  assert.deepEqual(completeSlashCommandHints("hello"), []);

  const all = completeSlashCommandHints("/");

  assert.equal(all.length, 12);
  assert.ok(all.includes("/help"));
  assert.ok(all.includes("/mcp"));

  const mcp = completeSlashCommandHints("/mcp ");

  assert.ok(mcp.length > 3);
  assert.ok(mcp.every((hint) => hint.startsWith("/mcp ")));
  assert.ok(mcp.includes("/mcp status"));

  assert.ok(!completeSlashCommandHints("/help").includes("/help"));
  assert.ok(completeSlashCommandHints("/model").includes("/model-smoke"));

  const limited = completeSlashCommandHints("/", 3);

  assert.equal(limited.length, 3);
});

test("completeInteractiveInput returns slash command completions", () => {
  assert.deepEqual(completeInteractiveInput("hello"), [[], "hello"]);

  const [helpMatches, helpCompleted] = completeInteractiveInput("/he");

  assert.equal(helpCompleted, "/he");
  assert.deepEqual(helpMatches, ["/hello", "/help"]);

  const [helloMatches] = completeInteractiveInput("/hell");

  assert.deepEqual(helloMatches, ["/hello"]);

  const [helpTopicMatches] = completeInteractiveInput("/help wo");

  assert.deepEqual(helpTopicMatches, ["/help workspace"]);

  const [helpCompletionTopicMatches] = completeInteractiveInput("/help comp");

  assert.deepEqual(helpCompletionTopicMatches, ["/help completion"]);

  const [completionMatches] = completeInteractiveInput("/compl");
  const [codeMapMatches] = completeInteractiveInput("/code-");
  const [codeMapAliasMatches] = completeInteractiveInput("/codem");
  const [diagnosticsMatches] = completeInteractiveInput("/diag");
  const [architectureMatches] = completeInteractiveInput("/ar");
  const [architectureTopicMatches] = completeInteractiveInput("/architecture ");
  const [keyMatches] = completeInteractiveInput("/ke");

  assert.deepEqual(completionMatches, ["/completion"]);
  assert.deepEqual(codeMapMatches, ["/code-map", "/code-map export"]);
  assert.deepEqual(codeMapAliasMatches, ["/codemap", "/codemap export"]);
  assert.deepEqual(diagnosticsMatches, ["/diagnostics", "/diagnostics export"]);
  assert.deepEqual(architectureMatches, ["/arch", "/architecture"]);
  assert.deepEqual(architectureTopicMatches, [
    "/architecture evals ",
    "/architecture exercises ",
    "/architecture loop ",
    "/architecture model ",
    "/architecture overview ",
    "/architecture sources ",
    "/architecture state ",
    "/architecture tools ",
  ]);
  assert.deepEqual(keyMatches, ["/keys"]);

  const [historyMatches] = completeInteractiveInput("/history --");

  assert.deepEqual(historyMatches, ["/history --all"]);

  const [evalMatches] = completeInteractiveInput("/eval");

  assert.deepEqual(evalMatches, [
    "/evals",
    "/evals --json ",
    "/evals benchmark ",
    "/evals benchmark --iterations 1 ",
    "/evals benchmark --json ",
    "/evals benchmark --tag repair ",
    "/evals benchmark --tag retrieval ",
    "/evals case ",
    "/evals case context_graph_retrieval ",
    "/evals case list_files ",
    "/evals case missing_text_recovery ",
    "/evals case plan_update ",
    "/evals case read_file ",
    "/evals case repair_loop ",
    "/evals case repair_loop_multifile ",
    "/evals case replace_file ",
    "/evals case task_replace_file ",
    "/evals case verification_failure_strategies ",
    "/evals case workspace_info ",
    "/evals cases ",
    "/evals cases --json ",
    "/evals cases --tag repair ",
    "/evals cases --tag retrieval ",
    "/evals cases --tag verification ",
    "/evals cases benchmark ",
    "/evals cases benchmark --json ",
    "/evals cases regression ",
    "/evals cases regression --json ",
    "/evals cases regression --tag repair ",
    "/evals cases regression --tag retrieval ",
    "/evals cases regression --tag verification ",
    "/evals cases smoke ",
    "/evals cases smoke --json ",
    "/evals compare ",
    "/evals compare --json ",
    "/evals compare --max-duration-delta 100 ",
    "/evals gate ",
    "/evals gate --json ",
    "/evals gate --max-duration-delta 100 ",
    "/evals regression ",
    "/evals regression --json ",
    "/evals regression --tag repair ",
    "/evals regression --tag retrieval ",
    "/evals regression --tag verification ",
    "/evals report ",
    "/evals report --json ",
    "/evals report benchmark ",
    "/evals report benchmark --iterations 1 ",
    "/evals report benchmark --json ",
    "/evals report regression ",
    "/evals report regression --json ",
    "/evals report smoke ",
    "/evals report smoke --json ",
    "/evals reports ",
    "/evals reports --json ",
    "/evals reports 10 ",
    "/evals run ",
    "/evals run --json ",
    "/evals run --tag retrieval ",
    "/evals run --tag tool ",
    "/evals smoke ",
    "/evals smoke --json ",
    "/evals smoke --tag tool ",
    "/evals tags ",
    "/evals tags --json ",
    "/evals tags benchmark ",
    "/evals tags benchmark --json ",
    "/evals tags regression ",
    "/evals tags regression --json ",
    "/evals tags smoke ",
    "/evals tags smoke --json ",
  ]);

  const [modelMatches] = completeInteractiveInput("/model");
  const [roadmapMatches] = completeInteractiveInput("/roa");
  const [indexMatches] = completeInteractiveInput("/ind");
  const [modelSmokeMatches] = completeInteractiveInput("/model-s");
  const [modelSmokeOptionMatches] = completeInteractiveInput("/model-smoke --");
  const [providerSmokeMatches] = completeInteractiveInput("/provider");
  const [repairMatches] = completeInteractiveInput("/repair");
  const [suggestContextMatches] = completeInteractiveInput("/suggest");
  const [symbolsMatches] = completeInteractiveInput("/sym");
  const [taskStateMatches] = completeInteractiveInput("/task-state s");
  const [taskStatePromptMatches] = completeInteractiveInput("/task-state p");
  const [verifySuggestMatches] = completeInteractiveInput("/ver");
  const [verifyRunMatches] = completeInteractiveInput("/verify-r");
  const [verifyLastMatches] = completeInteractiveInput("/verify-l");
  const [snapshotsMatches] = completeInteractiveInput("/snapshots");
  const [workspaceToolMatches] = completeInteractiveInput("/tool w");
  const [mcpMatches] = completeInteractiveInput("/mcp");

  assert.deepEqual(modelMatches, [
    "/model-smoke ",
    "/model-smoke --stream ",
    "/model-smoke --tool ",
    "/model-trace ",
    "/models",
  ]);
  assert.deepEqual(roadmapMatches, ["/roadmap"]);
  assert.deepEqual(indexMatches, [
    "/index",
    "/index build",
    "/index eval",
    "/index eval init",
    "/index eval run",
    "/index eval run --json",
    "/index eval status",
    "/index search ",
    "/index semantic",
    "/index semantic build",
    "/index semantic search ",
    "/index semantic status",
    "/index status",
  ]);
  assert.deepEqual(modelSmokeMatches, [
    "/model-smoke ",
    "/model-smoke --stream ",
    "/model-smoke --tool ",
  ]);
  assert.deepEqual(modelSmokeOptionMatches, ["/model-smoke --stream ", "/model-smoke --tool "]);
  assert.deepEqual(providerSmokeMatches, [
    "/provider-compare ",
    "/provider-compare --json ",
    "/provider-gate ",
    "/provider-gate --json ",
    "/provider-matrix",
    "/provider-reports ",
    "/provider-reports --json ",
    "/provider-reports 10 ",
    "/provider-smoke ",
    "/provider-smoke --full ",
    "/provider-smoke --full --save ",
    "/provider-smoke --json ",
    "/provider-smoke --json --save ",
    "/provider-smoke --profile full ",
    "/provider-smoke --profile full --save ",
    "/provider-smoke --profile quick ",
    "/provider-smoke --save ",
    "/providers",
  ]);
  assert.deepEqual(repairMatches, [
    "/repair-last",
    "/repair-loop ",
    "/repair-preview",
    "/repair-run",
  ]);
  assert.deepEqual(suggestContextMatches, ["/suggest-context "]);
  assert.deepEqual(symbolsMatches, ["/symbols", "/symbols list ", "/symbols search "]);
  assert.deepEqual(taskStateMatches, [
    "/task-state set ",
    "/task-state status ",
    "/task-state step ",
  ]);
  assert.deepEqual(taskStatePromptMatches, ["/task-state prompt"]);
  assert.deepEqual(verifySuggestMatches, [
    "/verify-clear",
    "/verify-failure",
    "/verify-last",
    "/verify-rerun",
    "/verify-run ",
    "/verify-stability ",
    "/verify-suggest ",
  ]);
  assert.deepEqual(verifyRunMatches, ["/verify-rerun", "/verify-run "]);
  assert.deepEqual(verifyLastMatches, ["/verify-last"]);
  assert.deepEqual(snapshotsMatches, [
    "/snapshots history ",
    "/snapshots list ",
    "/snapshots restore ",
    "/snapshots show ",
  ]);
  assert.deepEqual(workspaceToolMatches, ["/tool workspace_info"]);
  assert.deepEqual(mcpMatches, [
    "/mcp --json ",
    "/mcp prompt ",
    "/mcp prompts",
    "/mcp prompts --json ",
    "/mcp read ",
    "/mcp reload",
    "/mcp reload --json ",
    "/mcp resources",
    "/mcp resources --json ",
    "/mcp status",
    "/mcp status --json ",
    "/mcp templates",
    "/mcp templates --json ",
    "/mcp tools",
    "/mcp tools --json ",
  ]);

  const [sessionLimitMatches] = completeInteractiveInput("/session show --l");

  assert.deepEqual(sessionLimitMatches, ["/session show --limit "]);

  const [checkpointShowLimitMatches] = completeInteractiveInput("/checkpoint show before-edit --l");

  assert.deepEqual(checkpointShowLimitMatches, ["/checkpoint show before-edit --limit "]);

  const [checkpointMatches] = completeInteractiveInput("/checkpoint d");

  assert.deepEqual(checkpointMatches, ["/checkpoint delete ", "/checkpoint diff ", "/checkpoint diff-current "]);
});

test("completeInteractiveInput completes tool names", () => {
  const [matches] = completeInteractiveInput("/tool r");

  assert.deepEqual(matches, [
    "/tool read_file",
    "/tool read_skill",
    "/tool restore_patch_snapshot",
    "/tool reverse_patch",
    "/tool run_shell",
  ]);

  const [suggestMatches] = completeInteractiveInput("/tool s");

  assert.deepEqual(suggestMatches, [
    "/tool search_context_index",
    "/tool search_files",
    "/tool search_semantic_index",
    "/tool search_symbols",
    "/tool semantic_index_status",
    "/tool show_patch_snapshot",
    "/tool suggest_context",
    "/tool suggest_verification",
  ]);

  const [toolsMatches] = completeInteractiveInput("/tools --v");
  const [mcpToolMatches] = completeInteractiveInput("/tool mcp_", {
    toolNames: ["mcp_fixture_echo_text"],
  });

  assert.deepEqual(toolsMatches, ["/tools --verbose"]);
  assert.deepEqual(mcpToolMatches, ["/tool mcp_fixture_echo_text"]);

  const [skillMatches] = completeInteractiveInput("/skill c", {
    skillNames: ["code-review", "release"],
  });

  assert.deepEqual(skillMatches, ["/skill code-review"]);
});

test("completeInteractiveInput completes checkpoint names", () => {
  const context = {
    checkpointNames: ["before-edit", "after-beta"],
  };

  const [showMatches] = completeInteractiveInput("/checkpoint show be", context);
  const [loadMatches] = completeInteractiveInput("/checkpoint load af", context);
  const [searchMatches] = completeInteractiveInput("/checkpoint search be", context);
  const [diffLeftMatches] = completeInteractiveInput("/checkpoint diff be", context);
  const [diffRightMatches] = completeInteractiveInput("/checkpoint diff before-edit af", context);
  const [emptyNameMatches] = completeInteractiveInput("/checkpoint show ", context);
  const [emptyDiffRightMatches] = completeInteractiveInput("/checkpoint diff before-edit ", context);
  const [checkpointShowLimitMatches] = completeInteractiveInput(
    "/checkpoint show before-edit --l",
    context,
  );

  assert.deepEqual(showMatches, ["/checkpoint show before-edit"]);
  assert.deepEqual(loadMatches, ["/checkpoint load after-beta"]);
  assert.deepEqual(searchMatches, ["/checkpoint search before-edit "]);
  assert.deepEqual(diffLeftMatches, ["/checkpoint diff before-edit "]);
  assert.deepEqual(diffRightMatches, ["/checkpoint diff before-edit after-beta"]);
  assert.deepEqual(emptyNameMatches, ["/checkpoint show after-beta", "/checkpoint show before-edit"]);
  assert.deepEqual(emptyDiffRightMatches, [
    "/checkpoint diff before-edit after-beta",
    "/checkpoint diff before-edit before-edit",
  ]);
  assert.deepEqual(checkpointShowLimitMatches, ["/checkpoint show before-edit --limit "]);
});

test("completeInteractiveInput completes project commands, aliases, and tags", () => {
  const [cmdMatches] = completeInteractiveInput("/cmd r", {
    projectCommands: [
      {
        aliases: ["rv"],
        name: "review",
        tags: ["quality"],
      },
    ],
  });

  assert.deepEqual(cmdMatches, ["/cmd review ", "/cmd rv "]);

  const [aliasMatches] = completeInteractiveInput("/cmd-preview rv", {
    projectCommands: [
      {
        aliases: ["rv"],
        name: "review",
      },
    ],
  });

  assert.deepEqual(aliasMatches, ["/cmd-preview rv "]);

  const [tagMatches] = completeInteractiveInput("/commands q", {
    projectCommands: [
      {
        name: "review",
        tags: ["quality"],
      },
    ],
  });

  assert.deepEqual(tagMatches, ["/commands quality"]);
});

test("completeInteractiveInputWithWorkspace completes file paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-completion-paths-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(workspaceRoot, "dist"), { recursive: true });
    await mkdir(join(workspaceRoot, ".ccagent", "sessions"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "agent.ts"), "");
    await writeFile(join(workspaceRoot, "src", "cli.ts"), "");
    await writeFile(join(workspaceRoot, "README.md"), "");
    await writeFile(join(workspaceRoot, "node_modules", "pkg", "index.js"), "");
    await writeFile(join(workspaceRoot, "dist", "index.js"), "");
    await writeFile(join(workspaceRoot, ".ccagent", "history"), "read src/agent.ts\n");

    const [rootMatches] = await completeInteractiveInputWithWorkspace("/read R", {
      workspaceRoot,
    });
    const [srcMatches] = await completeInteractiveInputWithWorkspace("/read src/", {
      workspaceRoot,
    });
    const [directoryMatches] = await completeInteractiveInputWithWorkspace("/ls s", {
      workspaceRoot,
    });
    const [hiddenMatches] = await completeInteractiveInputWithWorkspace("/read .ccagent/h", {
      workspaceRoot,
    });
    const [nodeModulesMatches] = await completeInteractiveInputWithWorkspace("/read node", {
      workspaceRoot,
    });
    const [distMatches] = await completeInteractiveInputWithWorkspace("/read d", {
      workspaceRoot,
    });

    assert.deepEqual(rootMatches, ["/read README.md "]);
    assert.deepEqual(srcMatches, ["/read src/agent.ts ", "/read src/cli.ts "]);
    assert.deepEqual(directoryMatches, ["/ls src/"]);
    assert.deepEqual(hiddenMatches, []);
    assert.deepEqual(nodeModulesMatches, []);
    assert.deepEqual(distMatches, []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("completeInteractiveInputWithWorkspace rejects unsafe path completions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-completion-unsafe-"));

  try {
    assert.deepEqual(await completeInteractiveInputWithWorkspace("/read ../", { workspaceRoot }), [
      [],
      "/read ../",
    ]);
    assert.deepEqual(await completeInteractiveInputWithWorkspace("/read src/file name", { workspaceRoot }), [
      [],
      "/read src/file name",
    ]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
