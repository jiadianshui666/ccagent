import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildContextIndex } from "../src/contextIndex.js";
import {
  formatRetrievalEval,
  getRetrievalEvalManifestStatus,
  initRetrievalEvalManifest,
  runRetrievalEval,
} from "../src/retrievalEval.js";
import { buildSemanticIndex } from "../src/semanticIndex.js";

test("retrieval eval manifest initializes once and rejects unsafe expected paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-retrieval-eval-init-"));

  try {
    const missing = await getRetrievalEvalManifestStatus(workspaceRoot);
    const initialized = await initRetrievalEvalManifest(workspaceRoot);
    const existing = await initRetrievalEvalManifest(workspaceRoot);
    const raw = await readFile(
      join(workspaceRoot, ".ccagent", "retrieval-eval.json"),
      "utf8",
    );

    assert.equal(missing.exists, false);
    assert.equal(initialized.created, true);
    assert.equal(existing.created, false);
    assert.deepEqual(JSON.parse(raw).cases, []);

    await writeFile(
      join(workspaceRoot, ".ccagent", "retrieval-eval.json"),
      `${JSON.stringify({
        version: 1,
        k: 5,
        cases: [{
          name: "unsafe",
          query: "outside",
          expected: ["../outside.ts"],
        }],
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      getRetrievalEvalManifestStatus(workspaceRoot),
      /must stay inside the workspace/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("retrieval eval measures lexical and automatic repository queries", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-retrieval-eval-run-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, ".ccagent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "provider.ts"),
      "export function providerSmoke() { return 'relay compatibility'; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "README.md"),
      "# Project overview\n\nProvider setup and workspace usage.\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, ".ccagent", "retrieval-eval.json"),
      `${JSON.stringify({
        version: 1,
        k: 5,
        thresholds: {
          lexicalRecallAtK: 1,
          lexicalMrr: 0.5,
          automaticRecallAtK: 1,
          automaticMrr: 0.5,
        },
        cases: [
          {
            name: "provider-definition",
            query: "providerSmoke",
            expected: ["src/provider.ts"],
          },
          {
            name: "project-overview",
            query: "project overview setup",
            expected: ["README.md"],
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    await buildContextIndex(workspaceRoot);
    await buildSemanticIndex(workspaceRoot);

    const result = await runRetrievalEval(workspaceRoot);
    const output = formatRetrievalEval(result);

    assert.equal(result.status, "pass");
    assert.equal(result.retrievalMode, "hybrid");
    assert.equal(result.lexical.recallAtK, 1);
    assert.equal(result.automatic.recallAtK, 1);
    assert.equal(result.cases.length, 2);
    assert.match(output, /Status: PASS/);
    assert.match(output, /Lexical: recall@5 1\.000/);
    assert.match(output, /Automatic: recall@5 1\.000/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
