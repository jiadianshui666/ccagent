import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { buildContextIndex } from "../src/contextIndex.js";
import type { ModelClient, ModelResult, ModelTurnInput } from "../src/model.js";
import { buildSemanticIndex } from "../src/semanticIndex.js";
import { prepareAutomaticTaskContext } from "../src/taskContext.js";

class ContextRecordingModel implements ModelClient {
  readonly name = "context-recording";
  readonly inputs: ModelTurnInput[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    this.inputs.push(input);
    return {
      content: "context captured",
      toolCalls: [],
    };
  }
}

test("prepareAutomaticTaskContext skips workspaces without a persistent index", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-auto-context-missing-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "provider smoke\n", "utf8");

    const context = await prepareAutomaticTaskContext(workspaceRoot, "provider smoke", {
      refresh: true,
    });

    assert.equal(context, null);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("prepareAutomaticTaskContext refreshes stale matches and respects the context budget", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-auto-context-refresh-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const providerPath = join(workspaceRoot, "src", "provider.ts");
    await writeFile(
      providerPath,
      "export const providerSmoke = 'relay provider smoke';\n",
      "utf8",
    );
    await buildContextIndex(workspaceRoot);
    await writeFile(
      providerPath,
      "export const providerSmoke = 'relay provider smoke changed';\n",
      "utf8",
    );
    const changedAt = new Date(Date.now() + 2_000);
    await utimes(providerPath, changedAt, changedAt);

    const context = await prepareAutomaticTaskContext(workspaceRoot, "provider smoke", {
      maxChars: 1_000,
      maxFiles: 3,
      refresh: false,
    });

    assert.ok(context);
    assert.equal(context.refreshed, true);
    assert.equal(context.retrievalMode, "lexical");
    assert.equal(context.semanticFiles, 0);
    assert.equal(context.staleFiles, 0);
    assert.deepEqual(context.files, ["src/provider.ts"]);
    assert.match(context.content, /src\/provider\.ts/);
    assert.match(context.content, /provider smoke changed/);
    assert.ok(context.content.length <= 1_000);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("prepareAutomaticTaskContext fuses lexical and local semantic results", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-auto-context-hybrid-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "docs"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "relay.ts"),
      "export const relayProbe = 'chat completions smoke checks';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "docs", "provider.md"),
      "# Provider compatibility\n\nRelay setup notes.\n",
      "utf8",
    );
    await buildContextIndex(workspaceRoot);
    await buildSemanticIndex(workspaceRoot);

    const context = await prepareAutomaticTaskContext(
      workspaceRoot,
      "provider compatibility",
      {
        maxFiles: 5,
        refresh: false,
      },
    );

    assert.ok(context);
    assert.equal(context.retrievalMode, "hybrid");
    assert.ok(context.semanticFiles > 0);
    assert.equal(context.files.includes("src/relay.ts"), true);
    assert.match(context.content, /Source: hybrid local context index/);
    assert.match(context.content, /src\/relay\.ts/);
    assert.match(context.content, /semantic: similarity/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("prepareAutomaticTaskContext ranks an exact symbol definition before noisy callers", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-auto-context-exact-symbol-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "taskContext.ts"),
      "export function prepareAutomaticTaskContext() { return 'context'; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "taskContext.test.ts"),
      [
        "import { prepareAutomaticTaskContext } from '../src/taskContext';",
        "test('prepareAutomaticTaskContext first caller', () => prepareAutomaticTaskContext());",
        "test('prepareAutomaticTaskContext second caller', () => prepareAutomaticTaskContext());",
        "test('prepareAutomaticTaskContext third caller', () => prepareAutomaticTaskContext());",
        "test('prepareAutomaticTaskContext fourth caller', () => prepareAutomaticTaskContext());",
        "test('prepareAutomaticTaskContext fifth caller', () => prepareAutomaticTaskContext());",
        "",
      ].join("\n"),
      "utf8",
    );
    await buildContextIndex(workspaceRoot);
    await buildSemanticIndex(workspaceRoot);

    const context = await prepareAutomaticTaskContext(
      workspaceRoot,
      "prepareAutomaticTaskContext",
      { maxFiles: 5, refresh: false },
    );

    assert.ok(context);
    assert.equal(context.retrievalMode, "hybrid");
    assert.equal(context.files[0], "src/taskContext.ts");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent supplies indexed workspace context without changing the saved user message", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-auto-context-agent-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "provider.ts"),
      "export function providerSmoke() { return 'relay chat smoke'; }\n",
      "utf8",
    );
    await buildContextIndex(workspaceRoot);
    const model = new ContextRecordingModel();
    const agent = new Agent(
      model,
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        enabled: true,
        refreshIntervalMs: 60_000,
      },
    );

    const response = await agent.handleUserMessage("review provider smoke");
    const session = agent.snapshotSession();

    assert.equal(response.content, "context captured");
    assert.equal(model.inputs[0]?.userMessage, "review provider smoke");
    assert.match(model.inputs[0]?.workspaceContext ?? "", /src\/provider\.ts/);
    assert.match(model.inputs[0]?.workspaceContext ?? "", /providerSmoke/);
    assert.equal(session.messages[0]?.content, "review provider smoke");
    assert.doesNotMatch(session.messages[0]?.content ?? "", /Automatic workspace context/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent refreshes automatic context after a successful shell tool invalidates it", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-auto-context-invalidation-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "provider.ts"),
      "export const providerSmoke = 'relay smoke';\n",
      "utf8",
    );
    await buildContextIndex(workspaceRoot);
    const model = new ContextRecordingModel();
    const agent = new Agent(
      model,
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        enabled: true,
        refreshIntervalMs: 60_000,
      },
    );

    await agent.handleUserMessage("review provider smoke");
    await agent.handleUserMessage("/run node --version");
    await writeFile(
      join(workspaceRoot, "src", "newFeature.ts"),
      "export const newFeatureMarker = 'automatic context invalidation';\n",
      "utf8",
    );
    await agent.handleUserMessage("review newFeatureMarker");

    assert.equal(model.inputs.length, 2);
    assert.match(model.inputs[1]?.workspaceContext ?? "", /src\/newFeature\.ts/);
    assert.match(model.inputs[1]?.workspaceContext ?? "", /newFeatureMarker/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
