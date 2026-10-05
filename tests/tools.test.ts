import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSemanticIndex,
  formatSemanticIndexSearch,
  searchSemanticIndex,
} from "../src/semanticIndex.js";
import { searchContextIndex } from "../src/contextIndex.js";
import type { EmbeddingProvider } from "../src/embeddingProvider.js";
import type { PlanState } from "../src/plan.js";
import {
  BuildContextIndexTool,
  ContextIndexStatusTool,
  SearchContextIndexTool,
} from "../src/tools/contextIndex.js";
import { ListFilesTool } from "../src/tools/listFiles.js";
import {
  ListPatchSnapshotsTool,
  PatchSnapshotHistoryTool,
  RestorePatchSnapshotTool,
  ShowPatchSnapshotTool,
} from "../src/tools/patchSnapshots.js";
import { ReadFileTool } from "../src/tools/readFile.js";
import { RunShellTool } from "../src/tools/runShell.js";
import {
  BuildSemanticIndexTool,
  SearchSemanticIndexTool,
  SemanticIndexStatusTool,
} from "../src/tools/semanticIndex.js";
import { SuggestContextTool } from "../src/tools/suggestContext.js";
import { ListSymbolsTool, SearchSymbolsTool } from "../src/tools/symbols.js";
import { UpdateTaskStateTool } from "../src/tools/taskState.js";
import { UpdatePlanTool } from "../src/tools/updatePlan.js";
import { SuggestVerificationTool } from "../src/tools/verifySuggest.js";
import { WorkspaceInfoTool } from "../src/tools/workspaceInfo.js";
import { updateTaskState, type TaskState } from "../src/taskState.js";

test("ReadFileTool reads files inside the workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-"));

  try {
    await writeFile(join(workspaceRoot, "hello.txt"), "hello");

    const result = await new ReadFileTool().execute(
      { path: "hello.txt" },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.equal(result.content, "hello");
      assert.equal(result.metadata?.path, "hello.txt");
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ReadFileTool rejects paths outside the workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-"));

  try {
    const result = await new ReadFileTool().execute(
      { path: "../outside.txt" },
      { workspaceRoot },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.match(result.error, /outside the workspace/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("RunShellTool reports timeouts and terminates the spawned process tree", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-shell-timeout-"));

  try {
    await writeFile(
      join(workspaceRoot, "hang.js"),
      [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync('child.pid', String(process.pid));",
        "console.log('all tests passed; server cleanup pending');",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await new RunShellTool({ timeoutMs: 500 }).execute(
      { command: "node hang.js" },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.match(result.content, /all tests passed; server cleanup pending/);
      assert.match(result.content, /command timed out after 500ms/);
      assert.match(result.content, /process tree was terminated/);
      assert.equal(result.metadata?.timedOut, true);
      assert.equal(result.metadata?.processTreeTerminated, true);
      assert.equal(typeof result.metadata?.exitCode === "number" || result.metadata?.exitCode === null, true);
    }

    const childPid = Number(await readFile(join(workspaceRoot, "child.pid"), "utf8"));
    assert.equal(Number.isInteger(childPid), true);
    assert.equal(await waitForProcessExit(childPid, 2_000), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ListFilesTool lists workspace files and excludes noisy folders", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(workspaceRoot, "dist"), { recursive: true });
    await mkdir(join(workspaceRoot, ".ccagent", "sessions"), { recursive: true });
    await mkdir(join(workspaceRoot, ".ccagent", "logs"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};");
    await writeFile(join(workspaceRoot, "node_modules", "pkg", "index.js"), "");
    await writeFile(join(workspaceRoot, "dist", "index.js"), "");
    await writeFile(join(workspaceRoot, ".ccagent", "history"), "list files\n");
    await writeFile(join(workspaceRoot, ".ccagent", "sessions", "current.json"), "{}");
    await writeFile(join(workspaceRoot, ".ccagent", "logs", "tool-audit-2026-01-01.jsonl"), "{}");

    const result = await new ListFilesTool().execute(
      { path: ".", maxDepth: 2 },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.match(result.content, /src\//);
      assert.match(result.content, /index\.ts/);
      assert.doesNotMatch(result.content, /node_modules/);
      assert.doesNotMatch(result.content, /dist/);
      assert.doesNotMatch(result.content, /history/);
      assert.doesNotMatch(result.content, /current\.json/);
      assert.doesNotMatch(result.content, /tool-audit/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ListFilesTool rejects paths outside the workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-"));

  try {
    const result = await new ListFilesTool().execute(
      { path: "..", maxDepth: 1 },
      { workspaceRoot },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.match(result.error, /outside the workspace/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("WorkspaceInfoTool summarizes workspace metadata without reading file contents", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-workspace-info-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, ".ccagent"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workspaceRoot, "package.json"), "{}\n");
    await writeFile(join(workspaceRoot, "CCAGENT.md"), "- test\n");
    await writeFile(join(workspaceRoot, ".ccagent", "config.json"), "{}\n");
    await writeFile(join(workspaceRoot, "src", "index.ts"), "secret content");
    await writeFile(join(workspaceRoot, "node_modules", "pkg", "index.js"), "");

    const result = await new WorkspaceInfoTool().execute({}, { workspaceRoot });

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.match(result.content, /Workspace info/);
      assert.match(result.content, /package\.json: yes/);
      assert.match(result.content, /\.git\/: yes/);
      assert.match(result.content, /CCAGENT\.md: yes/);
      assert.match(result.content, /\.ccagent\/config\.json: yes/);
      assert.match(result.content, /src\//);
      assert.match(result.content, /package\.json/);
      assert.doesNotMatch(result.content, /secret content/);
      assert.doesNotMatch(result.content, /node_modules/);
      assert.equal(result.metadata?.packageJson, true);
      assert.equal(result.metadata?.projectInstructions, true);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("WorkspaceInfoTool rejects unexpected parameters", async () => {
  const result = await new WorkspaceInfoTool().execute(
    { path: "." },
    { workspaceRoot: process.cwd() },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.match(result.error, /does not accept input parameters/);
  }
});

test("SuggestContextTool ranks relevant files and excludes noisy folders", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-suggest-context-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(workspaceRoot, "dist"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export function providerSmoke() {\n  return 'provider smoke relay chat';\n}\n",
    );
    await writeFile(
      join(workspaceRoot, "src", "unrelated.ts"),
      "export const unrelated = true;\n",
    );
    await writeFile(
      join(workspaceRoot, "node_modules", "pkg", "provider.js"),
      "provider smoke should be excluded\n",
    );
    await writeFile(join(workspaceRoot, "dist", "provider.js"), "provider smoke should be excluded\n");

    const result = await new SuggestContextTool().execute(
      { query: "provider smoke" },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.match(result.content, /Context suggestions for: provider smoke/);
      assert.match(result.content, /1\. src\/providerSmoke\.ts/);
      assert.match(result.content, /line 1: export function providerSmoke/);
      assert.match(result.content, /line 2: return 'provider smoke relay chat'/);
      assert.doesNotMatch(result.content, /node_modules/);
      assert.doesNotMatch(result.content, /dist\/provider/);
      assert.equal(result.metadata?.count, 1);
      assert.equal(result.metadata?.scanned, 2);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("SuggestContextTool fairly scans sibling modules when the file budget is truncated", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-suggest-context-large-"));

  try {
    const legacyRoot = join(workspaceRoot, "packages", "a-legacy");
    const targetRoot = join(workspaceRoot, "packages", "z-checkout", "src");
    await mkdir(legacyRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });

    for (let index = 0; index < 620; index += 1) {
      await writeFile(
        join(legacyRoot, `legacy-${String(index).padStart(3, "0")}.js`),
        `module.exports = { legacyFeature: ${index} };\n`,
        "utf8",
      );
    }

    await writeFile(
      join(targetRoot, "regional-tax-adapter.js"),
      [
        "function applyRegionalTaxAdapter(invoice) {",
        "  return { ...invoice, retrievalMarker: 'checkout nexus delta' };",
        "}",
        "",
        "module.exports = { applyRegionalTaxAdapter };",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await new SuggestContextTool().execute(
      { query: "checkout nexus delta" },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.match(result.content, /Scanned files: 500 \(truncated\)/);
      assert.match(result.content, /1\. packages\/z-checkout\/src\/regional-tax-adapter\.js/);
      assert.match(result.content, /retrievalMarker: 'checkout nexus delta'/);
      assert.equal(result.metadata?.scanned, 500);
      assert.equal(result.metadata?.truncated, true);
      assert.equal(result.metadata?.count, 1);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("SuggestContextTool rejects empty queries", async () => {
  const result = await new SuggestContextTool().execute(
    { query: "   " },
    { workspaceRoot: process.cwd() },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.match(result.error, /Missing context query/);
  }
});

test("context index tools build, report status, and search persisted index", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "docs"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export function providerSmoke() {\n  return 'provider smoke relay chat';\n}\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "docs", "setup.md"),
      "# Setup\n\nProvider relay smoke checks live here.\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "node_modules", "pkg", "provider.js"),
      "provider smoke should be excluded\n",
      "utf8",
    );

    const missing = await new ContextIndexStatusTool().execute({}, { workspaceRoot });
    const missingSearch = await new SearchContextIndexTool().execute(
      { query: "provider smoke", limit: 5 },
      { workspaceRoot },
    );
    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const status = await new ContextIndexStatusTool().execute({}, { workspaceRoot });
    const search = await new SearchContextIndexTool().execute(
      { query: "provider smoke", limit: 5 },
      { workspaceRoot },
    );

    assert.equal(missing.ok, true);
    assert.equal(missingSearch.ok, true);
    assert.equal(built.ok, true);
    assert.equal(status.ok, true);
    assert.equal(search.ok, true);

    if (missing.ok) {
      assert.match(missing.content, /Status: missing/);
    }

    if (missingSearch.ok) {
      assert.match(missingSearch.content, /Status: missing index/);
    }

    if (built.ok) {
      assert.match(built.content, /Context index built/);
      assert.match(built.content, /\.ccagent\/index\/context-index\.json/);
      assert.match(built.content, /Symbols: 2/);
      assert.equal(built.metadata?.filesIndexed, 2);
    }

    if (status.ok) {
      assert.match(status.content, /Status: ready/);
      assert.match(status.content, /Files indexed: 2/);
    }

    if (search.ok) {
      assert.match(search.content, /Context index search: provider smoke/);
      assert.match(search.content, /src\/providerSmoke\.ts/);
      assert.match(search.content, /line 1: export function providerSmoke/);
      assert.match(search.content, /docs\/setup\.md/);
      assert.doesNotMatch(search.content, /node_modules/);
      assert.equal(search.metadata?.indexed, true);
    }

    await access(join(workspaceRoot, ".ccagent", "index", "context-index.json"));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index search ranks exported symbols", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-symbols-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "symbols.ts"),
      [
        "export class ReviewBuffer {",
        "  flush() {}",
        "}",
        "",
        "export function buildReviewBuffer() {",
        "  return new ReviewBuffer();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await new SearchContextIndexTool().execute(
      { query: "ReviewBuffer", limit: 5 },
      { workspaceRoot },
    );

    assert.equal(built.ok, true);
    assert.equal(search.ok, true);

    if (built.ok) {
      assert.match(built.content, /Symbols: 2/);
      assert.equal(built.metadata?.symbols, 2);
    }

    if (search.ok) {
      assert.match(search.content, /symbol: class exported ReviewBuffer line 1 - export class ReviewBuffer/);
      assert.match(search.content, /symbol: function exported buildReviewBuffer line 5 - export function buildReviewBuffer/);
      assert.match(search.content, /symbols \d+\.\d+/);
      assert.equal(search.metadata?.indexed, true);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index search expands direct import graph neighbors", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-graph-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "api.ts"),
      "export function calculateTotal() {\n  return 42;\n}\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "service.ts"),
      [
        "import { calculateTotal } from './api';",
        "",
        "export function checkoutService() {",
        "  return calculateTotal();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "service.test.ts"),
      [
        "import { checkoutService } from '../src/service';",
        "",
        "test('checkout service uses totals', () => {",
        "  checkoutService();",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await new SearchContextIndexTool().execute(
      { query: "checkoutService", limit: 10 },
      { workspaceRoot },
    );

    assert.equal(built.ok, true);
    assert.equal(search.ok, true);

    if (built.ok) {
      assert.match(built.content, /Module edges: 2/);
      assert.equal(built.metadata?.moduleEdges, 2);
    }

    if (search.ok) {
      assert.match(search.content, /Graph-expanded files: 1 from 3 relation\(s\), max depth 1/);
      assert.match(search.content, /src\/api\.ts/);
      assert.match(search.content, /graph: imported by src\/service\.ts via import \(calculateTotal\)/);
      assert.match(search.content, /graph: imported by tests\/service\.test\.ts via import \(checkoutService\)/);
      assert.match(search.content, /tests\/service\.test\.ts/);
      assert.match(search.content, /graph: imports src\/service\.ts via import \(checkoutService\)/);
      assert.equal(search.metadata?.graphExpanded, 1);
      assert.equal(search.metadata?.graphMaxDepth, 1);
      assert.equal(search.metadata?.graphRelations, 3);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index uses TypeChecker symbol edges to bypass barrel re-exports", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-typechecker-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "service.ts"),
      "export class PrivateLedgerEngine { run() { return true; } }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "barrel.ts"),
      "export { PrivateLedgerEngine as PublicGateway } from './service';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "replacement.ts"),
      "export class PrivateLedgerEngine { run() { return 'replacement'; } }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "consumer.ts"),
      [
        "import { PublicGateway } from './barrel';",
        "export function createGateway(): PublicGateway {",
        "  return new PublicGateway();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await searchContextIndex(workspaceRoot, "PrivateLedgerEngine", 10);
    const consumer = search?.results.find((result) => result.path === "src/consumer.ts");

    assert.equal(built.ok, true);
    assert.ok(search);
    assert.equal(search?.index.moduleEdges.length, 2);
    assert.deepEqual(search?.index.symbolEdges, [
      {
        fromPath: "src/consumer.ts",
        kind: "symbol reference",
        specifier: "./barrel",
        symbols: ["PrivateLedgerEngine", "PublicGateway"],
        toPath: "src/service.ts",
      },
    ]);
    assert.equal(search?.index.stats.symbolEdges, 1);
    assert.equal(consumer?.graphDepth, 1);
    assert.match(
      consumer?.graphRelations.join("\n") ?? "",
      /imports src\/service\.ts via symbol reference \(PrivateLedgerEngine, PublicGateway\)/,
    );

    await writeFile(
      join(workspaceRoot, "src", "barrel.ts"),
      "export { PrivateLedgerEngine as PublicGateway } from './replacement';\n",
      "utf8",
    );
    await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const refreshed = await searchContextIndex(workspaceRoot, "PrivateLedgerEngine", 10);

    assert.equal(
      refreshed?.index.symbolEdges.some((edge) => edge.toPath === "src/service.ts"),
      false,
    );
    assert.equal(
      refreshed?.index.symbolEdges.some(
        (edge) => edge.fromPath === "src/consumer.ts" && edge.toPath === "src/replacement.ts",
      ),
      true,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index graph expansion reaches callers at depth two", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-depth-two-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "contract.ts"),
      "export interface LedgerBoundary { load(): string; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "service.ts"),
      "import type { LedgerBoundary } from './contract';\nexport function buildService(store: LedgerBoundary) { return store.load(); }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "controller.ts"),
      "import { buildService } from './service';\nexport function createController(input: Parameters<typeof buildService>[0]) { return buildService(input); }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "controller.test.ts"),
      "import { createController } from '../src/controller';\ntest('creates output', () => { void createController; });\n",
      "utf8",
    );
    await new BuildContextIndexTool().execute({}, { workspaceRoot });

    const search = await searchContextIndex(workspaceRoot, "LedgerBoundary", 10);
    const definition = search?.results.find((result) => result.path === "src/contract.ts");
    const controller = search?.results.find((result) => result.path === "src/controller.ts");
    const testFile = search?.results.find((result) => result.path === "tests/controller.test.ts");

    assert.ok(search);
    assert.ok(definition);
    assert.equal(definition.exactSymbolMatch, true);
    assert.ok(controller);
    assert.ok(testFile);
    assert.equal(search.graphMaxDepth, 2);
    assert.equal(controller.graphDepth, 1);
    assert.equal(testFile.graphDepth, 2);
    assert.match(testFile.graphRelations.join("\n"), /imports src\/controller\.ts via import \(createController\)/);
    assert.equal(search.results[0]?.path, "src/contract.ts");
    assert.ok(testFile.score < definition.score);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index resolves JSONC tsconfig aliases and baseUrl imports", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-aliases-"));

  try {
    await mkdir(join(workspaceRoot, "src", "contracts"), { recursive: true });
    await mkdir(join(workspaceRoot, "src", "services"), { recursive: true });
    await mkdir(join(workspaceRoot, "src", "controllers"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await mkdir(join(workspaceRoot, "configs"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "tsconfig.json"),
      "{ \"extends\": \"./configs/tsconfig.base\", \"compilerOptions\": {} }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "configs", "tsconfig.base.json"),
      [
        "{",
        "  // JSONC aliases inherited by the root config.",
        "  \"compilerOptions\": {",
        "    \"baseUrl\": \"../src\",",
        "    \"paths\": {",
        "      \"@contracts/*\": [\"missing/*\", \"contracts/*\"],",
        "      \"@controllers/*\": [\"controllers/*\"],",
        "    },",
        "  },",
        "}\n",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "contracts", "ledger.ts"),
      "export interface LedgerBoundary { load(): Promise<string>; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "services", "service.ts"),
      "import type { LedgerBoundary } from '@contracts/ledger';\nexport function buildService(store: LedgerBoundary) { return store.load(); }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "controllers", "controller.ts"),
      "import { buildService } from 'services/service';\nexport function createController(input: Parameters<typeof buildService>[0]) { return buildService(input); }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "controller.test.ts"),
      "import { createController } from '@controllers/controller';\ntest('controller', () => void createController);\n",
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await searchContextIndex(workspaceRoot, "LedgerBoundary", 10);

    assert.equal(built.ok, true);
    assert.equal(search?.index.moduleEdges.length, 3);
    assert.equal(search?.graphMaxDepth, 2);
    assert.equal(search?.results.find((result) => result.path === "src/controllers/controller.ts")?.graphDepth, 1);
    assert.equal(search?.results.find((result) => result.path === "tests/controller.test.ts")?.graphDepth, 2);
    assert.deepEqual(
      search?.index.moduleEdges.map((edge) => `${edge.fromPath} -> ${edge.toPath}`).sort(),
      [
        "src/controllers/controller.ts -> src/services/service.ts",
        "src/services/service.ts -> src/contracts/ledger.ts",
        "tests/controller.test.ts -> src/controllers/controller.ts",
      ],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index resolves package-based tsconfig extends without indexing dependencies", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-package-extends-"));

  try {
    await mkdir(join(workspaceRoot, "src", "contracts"), { recursive: true });
    await mkdir(join(workspaceRoot, "src", "services"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "@config", "base"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "tsconfig.json"),
      JSON.stringify({ extends: "@config/base/tsconfig", compilerOptions: {} }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "node_modules", "@config", "base", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "../../../",
          paths: {
            "@contracts/*": ["src/contracts/*"],
            "@services/*": ["src/services/*"],
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "contracts", "ledger.ts"),
      "export interface LedgerBoundary { load(): Promise<string>; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "contracts", "alternate.ts"),
      "export interface AlternateBoundary { load(): Promise<string>; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "services", "service.ts"),
      "import type { LedgerBoundary } from '@contracts/ledger';\nexport function buildService(store: LedgerBoundary) { return store.load(); }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "service.test.ts"),
      "import { buildService } from '@services/service';\ntest('service', () => void buildService);\n",
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await searchContextIndex(workspaceRoot, "LedgerBoundary", 10);

    assert.equal(built.ok, true);
    assert.ok(search);
    assert.equal(search?.index.files.some((file) => file.path.includes("node_modules")), false);
    assert.equal(search?.index.moduleEdges.some((edge) => edge.toPath.includes("node_modules")), false);
    assert.deepEqual(
      search?.index.moduleEdges.map((edge) => `${edge.fromPath} -> ${edge.toPath}`).sort(),
      [
        "src/services/service.ts -> src/contracts/ledger.ts",
        "tests/service.test.ts -> src/services/service.ts",
      ],
    );

    await writeFile(
      join(workspaceRoot, "node_modules", "@config", "base", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "../../../",
          paths: {
            "@contracts/*": ["src/contracts/alternate.ts"],
            "@services/*": ["src/services/*"],
          },
        },
      }),
      "utf8",
    );

    await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const refreshed = await searchContextIndex(workspaceRoot, "LedgerBoundary", 10);

    assert.deepEqual(
      refreshed?.index.moduleEdges.map((edge) => `${edge.fromPath} -> ${edge.toPath}`).sort(),
      [
        "src/services/service.ts -> src/contracts/alternate.ts",
        "tests/service.test.ts -> src/services/service.ts",
      ],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index resolves package.json tsconfig fields", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-package-manifest-"));

  try {
    await mkdir(join(workspaceRoot, "src", "domain"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "config-package", "configs"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "tsconfig.json"),
      JSON.stringify({ extends: "config-package" }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "node_modules", "config-package", "package.json"),
      JSON.stringify({ name: "config-package", tsconfig: "configs/base" }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "node_modules", "config-package", "configs", "base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "../../../",
          paths: { "@domain/*": ["src/domain/*"] },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "domain", "value.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "app.ts"),
      "import { value } from '@domain/value';\nexport const app = value;\n",
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await searchContextIndex(workspaceRoot, "value", 10);

    assert.equal(built.ok, true);
    assert.ok(search);
    assert.equal(
      search?.index.moduleEdges.some(
        (edge) => edge.fromPath === "src/app.ts" && edge.toPath === "src/domain/value.ts",
      ),
      true,
    );
    assert.equal(search?.index.files.some((file) => file.path.includes("node_modules")), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index rebuilds all module edges when alias configuration changes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-alias-refresh-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "configs"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "tsconfig.json"),
      JSON.stringify({ extends: "./configs/tsconfig.base.json" }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "configs", "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@api/*": ["src/*"] } } }),
      "utf8",
    );
    await writeFile(join(workspaceRoot, "src", "api.ts"), "export const api = 1;\n", "utf8");
    await writeFile(join(workspaceRoot, "src", "alternate.ts"), "export const alternate = 2;\n", "utf8");
    await writeFile(
      join(workspaceRoot, "src", "service.ts"),
      "import { api } from '@api/api';\nexport const service = api;\n",
      "utf8",
    );

    await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const first = await searchContextIndex(workspaceRoot, "service", 5);

    await writeFile(
      join(workspaceRoot, "configs", "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@api/*": ["src/alternate"] } } }),
      "utf8",
    );

    await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const second = await searchContextIndex(workspaceRoot, "service", 5);

    assert.equal(first?.index.moduleEdges.some((edge) => edge.toPath === "src/api.ts"), true);
    assert.equal(second?.index.moduleEdges.some((edge) => edge.toPath === "src/api.ts"), false);
    assert.equal(second?.index.moduleEdges.some((edge) => edge.toPath === "src/alternate.ts"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index resolves package.json workspaces and package exports", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-packages-"));

  try {
    await mkdir(join(workspaceRoot, "packages", "core", "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "packages", "service", "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "packages", "app", "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "workspace-root", private: true, workspaces: ["packages/*"] }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "core", "package.json"),
      JSON.stringify({
        name: "@acme/core",
        exports: {
          ".": "./src/index.ts",
          "./contracts": "./src/contracts.ts",
          "./*": "./src/*.ts",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "service", "package.json"),
      JSON.stringify({ name: "@acme/service", exports: { ".": "./src/index.ts" } }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "app", "package.json"),
      JSON.stringify({ name: "@acme/app", exports: { ".": "./src/index.ts" } }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "core", "src", "contracts.ts"),
      "export interface LedgerBoundary { load(): Promise<string>; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "core", "src", "index.ts"),
      "export { LedgerBoundary } from './contracts';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "service", "src", "index.ts"),
      "import type { LedgerBoundary } from '@acme/core/contracts';\nexport function buildService(store: LedgerBoundary) { return store.load(); }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "app", "src", "index.ts"),
      "import { buildService } from '@acme/service';\nexport function createApp(input: Parameters<typeof buildService>[0]) { return buildService(input); }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "app.test.ts"),
      "import { createApp } from '@acme/app';\ntest('app', () => void createApp);\n",
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await searchContextIndex(workspaceRoot, "LedgerBoundary", 10);

    assert.equal(built.ok, true);
    assert.equal(search?.index.moduleEdges.length, 4);
    assert.equal(search?.results.find((result) => result.path === "packages/app/src/index.ts")?.graphDepth, 1);
    assert.equal(search?.results.find((result) => result.path === "tests/app.test.ts")?.graphDepth, 2);
    assert.deepEqual(
      search?.index.moduleEdges.map((edge) => `${edge.fromPath} -> ${edge.toPath}`).sort(),
      [
        "packages/app/src/index.ts -> packages/service/src/index.ts",
        "packages/core/src/index.ts -> packages/core/src/contracts.ts",
        "packages/service/src/index.ts -> packages/core/src/contracts.ts",
        "tests/app.test.ts -> packages/app/src/index.ts",
      ],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index resolves pnpm workspace package manifests", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-pnpm-"));

  try {
    await mkdir(join(workspaceRoot, "modules", "core", "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "modules", "consumer", "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "pnpm-root" }), "utf8");
    await writeFile(
      join(workspaceRoot, "pnpm-workspace.yaml"),
      "packages:\n  - modules/*\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "modules", "core", "package.json"),
      JSON.stringify({ name: "@pnpm/core", exports: { ".": "./src/index.ts" } }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "modules", "consumer", "package.json"),
      JSON.stringify({ name: "@pnpm/consumer", exports: { ".": "./src/index.ts" } }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "modules", "core", "src", "index.ts"),
      "export const pnpmMarker = 'workspace';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "modules", "consumer", "src", "index.ts"),
      "import { pnpmMarker } from '@pnpm/core';\nexport const consumerMarker = pnpmMarker;\n",
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await searchContextIndex(workspaceRoot, "pnpmMarker", 5);

    assert.equal(built.ok, true);
    assert.equal(search?.index.moduleEdges.some(
      (edge) => edge.fromPath === "modules/consumer/src/index.ts" && edge.toPath === "modules/core/src/index.ts",
    ), true);

    await writeFile(
      join(workspaceRoot, "modules", "core", "package.json"),
      JSON.stringify({ name: "@pnpm/renamed", exports: { ".": "./src/index.ts" } }),
      "utf8",
    );
    await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const renamed = await searchContextIndex(workspaceRoot, "pnpmMarker", 5);

    assert.equal(renamed?.index.moduleEdges.some(
      (edge) => edge.fromPath === "modules/consumer/src/index.ts" && edge.toPath === "modules/core/src/index.ts",
    ), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index resolves TypeScript project and triple-slash type references", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-ts-references-"));

  try {
    await mkdir(join(workspaceRoot, "packages", "core"), { recursive: true });
    await mkdir(join(workspaceRoot, "packages", "app", "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "packages", "app", "types"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "packages", "core", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { composite: true } }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "app", "tsconfig.json"),
      JSON.stringify({ references: [{ path: "../core" }] }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "core", "package.json"),
      JSON.stringify({ name: "@acme/core" }),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "core", "contracts.d.ts"),
      "export interface ProjectBoundary { run(): void; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "app", "types", "global.d.ts"),
      "export interface GlobalBoundary { value: string; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "packages", "app", "src", "app.ts"),
      "/// <reference path=\"../types/global.d.ts\" />\nexport const app = 'type reference';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "app.test.ts"),
      "import { app } from '../packages/app/src/app';\ntest('app', () => void app);\n",
      "utf8",
    );

    const built = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const search = await searchContextIndex(workspaceRoot, "GlobalBoundary", 10);

    assert.equal(built.ok, true);
    assert.equal(search?.index.moduleEdges.some(
      (edge) => edge.fromPath === "packages/app/tsconfig.json"
        && edge.toPath === "packages/core/tsconfig.json"
        && edge.kind === "project reference",
    ), true);
    assert.equal(search?.index.moduleEdges.some(
      (edge) => edge.fromPath === "packages/app/src/app.ts"
        && edge.toPath === "packages/app/types/global.d.ts"
        && edge.kind === "type reference",
    ), true);
    assert.equal(search?.results.find((result) => result.path === "tests/app.test.ts")?.graphDepth, 2);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index graph expansion enforces file and relation budgets", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-graph-budgets-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const dependencyImports: string[] = [];

    for (let index = 0; index < 12; index += 1) {
      const symbol = `dependency${index}`;
      dependencyImports.push(`import { ${symbol} } from './dependency-${index}';`);
      await writeFile(
        join(workspaceRoot, "src", `dependency-${index}.ts`),
        `export const ${symbol} = ${index};\n`,
        "utf8",
      );
    }

    await writeFile(
      join(workspaceRoot, "src", "hub.ts"),
      `${dependencyImports.join("\n")}\nexport function SingularHubMarker() { return dependency0; }\n`,
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "anchor.ts"),
      "export const RareAnchor = 1;\n",
      "utf8",
    );

    for (let index = 0; index < 45; index += 1) {
      await writeFile(
        join(workspaceRoot, "src", `anchor-caller-${index}.ts`),
        `import { RareAnchor } from './anchor';\nexport const caller${index} = RareAnchor;\n`,
        "utf8",
      );
    }

    await new BuildContextIndexTool().execute({}, { workspaceRoot });

    const expansionSearch = await searchContextIndex(workspaceRoot, "SingularHubMarker", 25);
    const relationSearch = await searchContextIndex(workspaceRoot, "RareAnchor", 25);

    assert.ok(expansionSearch);
    assert.equal(expansionSearch.graphExpanded, 10);
    assert.equal(expansionSearch.graphMaxDepth, 1);
    assert.ok(relationSearch);
    assert.equal(relationSearch.graphRelations, 40);
    assert.ok(relationSearch.results.every((result) => result.graphRelations.length <= 4));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index graph expansion preserves exact symbol ranking", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-symbol-graph-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "taskContext.ts"),
      "export function prepareAutomaticTaskContext() { return 'context'; }\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "agent.ts"),
      "import { prepareAutomaticTaskContext } from './taskContext';\nexport function runAgent() { return prepareAutomaticTaskContext(); }\n",
      "utf8",
    );
    await new BuildContextIndexTool().execute({}, { workspaceRoot });

    const search = await searchContextIndex(workspaceRoot, "prepareAutomaticTaskContext", 5);
    const definition = search?.results.find((result) => result.path === "src/taskContext.ts");

    assert.ok(definition);
    assert.ok(definition.graphRelations.length > 0);
    assert.equal(
      definition.score,
      Math.max(
        definition.pathScore + definition.contentScore + definition.symbolScore,
        definition.graphScore,
      ),
    );
    assert.equal(search?.results[0]?.path, "src/taskContext.ts");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index reuses unchanged files and refreshes changed graph origins", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-incremental-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const apiPath = join(workspaceRoot, "src", "api.ts");
    const servicePath = join(workspaceRoot, "src", "service.ts");
    await writeFile(
      apiPath,
      "export function calculateTotal() {\n  return 42;\n}\n",
      "utf8",
    );
    await writeFile(
      servicePath,
      "import { calculateTotal } from './api';\nexport function checkoutService() { return calculateTotal(); }\n",
      "utf8",
    );

    const first = await new BuildContextIndexTool().execute({}, { workspaceRoot });
    const second = await new BuildContextIndexTool().execute({}, { workspaceRoot });

    await writeFile(
      servicePath,
      "import { calculateTotal } from './api';\nexport function checkoutService() { return calculateTotal() + 1; }\n",
      "utf8",
    );
    const changedAt = new Date(Date.now() + 2_000);
    await utimes(servicePath, changedAt, changedAt);
    const third = await new BuildContextIndexTool().execute({}, { workspaceRoot });

    await rm(apiPath);
    const fourth = await new BuildContextIndexTool().execute({}, { workspaceRoot });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, true);
    assert.equal(fourth.ok, true);

    if (first.ok) {
      assert.equal(first.metadata?.cacheStatus, "miss");
      assert.equal(first.metadata?.filesRebuilt, 2);
      assert.equal(first.metadata?.filesReused, 0);
      assert.equal(first.metadata?.moduleEdges, 1);
    }

    if (second.ok) {
      assert.equal(second.metadata?.cacheStatus, "reused");
      assert.equal(second.metadata?.filesRebuilt, 0);
      assert.equal(second.metadata?.filesReused, 2);
      assert.equal(second.metadata?.moduleEdges, 1);
    }

    if (third.ok) {
      assert.equal(third.metadata?.cacheStatus, "partial");
      assert.equal(third.metadata?.filesRebuilt, 1);
      assert.equal(third.metadata?.filesReused, 1);
      assert.equal(third.metadata?.moduleEdges, 1);
    }

    if (fourth.ok) {
      assert.equal(fourth.metadata?.cacheStatus, "reused");
      assert.equal(fourth.metadata?.filesRebuilt, 0);
      assert.equal(fourth.metadata?.filesReused, 1);
      assert.equal(fourth.metadata?.filesIndexed, 1);
      assert.equal(fourth.metadata?.moduleEdges, 0);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("context index search marks files changed after indexing as stale", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-context-index-stale-"));

  try {
    await writeFile(
      join(workspaceRoot, "provider.ts"),
      "export const providerSmoke = 'provider smoke';\n",
      "utf8",
    );

    await new BuildContextIndexTool().execute({}, { workspaceRoot });
    await writeFile(
      join(workspaceRoot, "provider.ts"),
      "export const providerSmoke = 'provider smoke changed';\n",
      "utf8",
    );
    const changedAt = new Date(Date.now() + 2_000);
    await utimes(join(workspaceRoot, "provider.ts"), changedAt, changedAt);

    const search = await searchContextIndex(workspaceRoot, "provider smoke", 5);

    assert.ok(search);
    assert.equal(search.results[0]?.path, "provider.ts");
    assert.equal(search.results[0]?.stale, true);
    assert.match(search.results[0]?.snippets[0] ?? "", /provider smoke changed/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("semantic index tools build, report status, and rank conceptual matches", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-semantic-index-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "docs"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export function providerSmoke() {\n  return 'relay smoke probes for chat completions';\n}\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "docs", "sessions.md"),
      "# Sessions\n\nCheckpoint history and compaction state are stored locally.\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "node_modules", "pkg", "relay.js"),
      "relay compatibility should be excluded\n",
      "utf8",
    );

    const missing = await new SemanticIndexStatusTool().execute({}, { workspaceRoot });
    const missingSearch = await new SearchSemanticIndexTool().execute(
      { query: "provider compatibility", limit: 5 },
      { workspaceRoot },
    );
    const built = await new BuildSemanticIndexTool().execute({}, { workspaceRoot });
    const status = await new SemanticIndexStatusTool().execute({}, { workspaceRoot });
    const search = await new SearchSemanticIndexTool().execute(
      { query: "provider compatibility", limit: 5 },
      { workspaceRoot },
    );

    assert.equal(missing.ok, true);
    assert.equal(missingSearch.ok, true);
    assert.equal(built.ok, true);
    assert.equal(status.ok, true);
    assert.equal(search.ok, true);

    if (missing.ok) {
      assert.match(missing.content, /Semantic vector index status/);
      assert.match(missing.content, /Status: missing/);
    }

    if (missingSearch.ok) {
      assert.match(missingSearch.content, /Status: missing index/);
    }

    if (built.ok) {
      assert.match(built.content, /Semantic vector index built/);
      assert.match(built.content, /\.ccagent\/index\/semantic-index\.json/);
      assert.match(built.content, /Chunks indexed: 2/);
      assert.match(built.content, /Cache: miss/);
      assert.equal(built.metadata?.filesIndexed, 2);
      assert.equal(built.metadata?.filesRebuilt, 2);
      assert.equal(built.metadata?.filesReused, 0);
      assert.equal(built.metadata?.model, "local-hash-v1");
    }

    if (status.ok) {
      assert.match(status.content, /Status: ready/);
      assert.match(status.content, /Model: local-hash-v1/);
      assert.match(status.content, /Chunks indexed: 2/);
      assert.match(status.content, /Files indexed: 2/);
    }

    if (search.ok) {
      assert.match(search.content, /Semantic vector search: provider compatibility/);
      assert.match(search.content, /src\/providerSmoke\.ts/);
      assert.match(search.content, /similarity/);
      assert.doesNotMatch(search.content, /node_modules/);
      assert.equal(search.metadata?.indexed, true);
      assert.equal(search.metadata?.model, "local-hash-v1");
    }

    await access(join(workspaceRoot, ".ccagent", "index", "semantic-index.json"));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("semantic index reuses unchanged local chunks and rebuilds changed files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-semantic-incremental-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "docs"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export const relayProbe = 'chat completions relay smoke';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "docs", "sessions.md"),
      "# Sessions\n\nCheckpoint history and compaction state are stored locally.\n",
      "utf8",
    );

    const first = await buildSemanticIndex(workspaceRoot);
    const rawIndex = JSON.parse(
      await readFile(join(workspaceRoot, ".ccagent", "index", "semantic-index.json"), "utf8"),
    ) as { files?: Array<{ contentHash?: string }> };
    const second = await buildSemanticIndex(workspaceRoot);
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export const relayProbe = 'provider compatibility smoke changed';\n",
      "utf8",
    );
    const third = await buildSemanticIndex(workspaceRoot);

    assert.equal(first.index.stats.cacheStatus, "miss");
    assert.equal(first.index.stats.filesRebuilt, 2);
    assert.equal(first.index.stats.filesReused, 0);
    assert.match(rawIndex.files?.[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);

    assert.equal(second.index.stats.cacheStatus, "reused");
    assert.equal(second.index.stats.filesRebuilt, 0);
    assert.equal(second.index.stats.filesReused, 2);
    assert.equal(second.index.stats.chunksRebuilt, 0);
    assert.equal(second.index.stats.chunksReused, 2);

    assert.equal(third.index.stats.cacheStatus, "partial");
    assert.equal(third.index.stats.filesRebuilt, 1);
    assert.equal(third.index.stats.filesReused, 1);
    assert.equal(third.index.stats.chunksRebuilt, 1);
    assert.equal(third.index.stats.chunksReused, 1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("semantic index splits large files into searchable line chunks", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-semantic-chunks-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const lines = Array.from({ length: 170 }, (_, index) => (
      index === 130
        ? "const uniqueChunkMarker = 'provider compatibility';"
        : `const line${index + 1} = ${index + 1};`
    ));
    await writeFile(join(workspaceRoot, "src", "large.ts"), `${lines.join("\n")}\n`, "utf8");

    const built = await buildSemanticIndex(workspaceRoot);
    const search = await searchSemanticIndex(workspaceRoot, "uniqueChunkMarker", 5);

    assert.equal(built.index.files.length, 1);
    assert.equal(built.index.files[0]?.chunks.length, 3);
    assert.equal(search?.results[0]?.path, "src/large.ts");
    assert.equal(search?.results[0]?.startLine, 71);
    assert.equal(search?.results[0]?.endLine, 150);
    assert.match(formatSemanticIndexSearch(search, "uniqueChunkMarker"), /src\/large\.ts:71-150/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("semantic index reuses provider embeddings and invalidates when provider settings change", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-provider-semantic-cache-"));
  let embeddedTexts = 0;
  const createProvider = (model: string, baseURL: string): EmbeddingProvider => ({
    baseURL,
    model,
    source: "openai",
    async embedTexts(texts: string[]) {
      embeddedTexts += texts.length;
      return texts.map((text) => (
        text.toLowerCase().includes("relay") || text.toLowerCase().includes("provider")
          ? [1, 0]
          : [0, 1]
      ));
    },
  });

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export const relayProbe = 'chat completions relay smoke';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "sessionStore.ts"),
      "export const checkpointState = 'conversation history compaction';\n",
      "utf8",
    );

    const first = await buildSemanticIndex(workspaceRoot, {
      provider: createProvider("fake-embedding-model-a", "https://relay-a.example/v1"),
    });
    const afterFirstBuild = embeddedTexts;
    const second = await buildSemanticIndex(workspaceRoot, {
      provider: createProvider("fake-embedding-model-a", "https://relay-a.example/v1"),
    });
    const afterSecondBuild = embeddedTexts;
    const third = await buildSemanticIndex(workspaceRoot, {
      provider: createProvider("fake-embedding-model-a", "https://relay-b.example/v1"),
    });
    const afterThirdBuild = embeddedTexts;
    const fourth = await buildSemanticIndex(workspaceRoot, {
      provider: createProvider("fake-embedding-model-b", "https://relay-b.example/v1"),
    });

    assert.equal(first.index.stats.cacheStatus, "miss");
    assert.equal(first.index.stats.filesRebuilt, 2);
    assert.equal(afterFirstBuild, 2);

    assert.equal(second.index.stats.cacheStatus, "reused");
    assert.equal(second.index.stats.filesRebuilt, 0);
    assert.equal(second.index.stats.filesReused, 2);
    assert.equal(afterSecondBuild, 2);

    assert.equal(third.index.stats.cacheStatus, "miss");
    assert.equal(third.index.stats.filesRebuilt, 2);
    assert.equal(third.index.stats.filesReused, 0);
    assert.equal(afterThirdBuild, 4);

    assert.equal(fourth.index.stats.cacheStatus, "miss");
    assert.equal(fourth.index.stats.filesRebuilt, 2);
    assert.equal(fourth.index.stats.filesReused, 0);
    assert.equal(fourth.index.model, "fake-embedding-model-b");
    assert.equal(embeddedTexts, 6);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("semantic index supports provider-backed embeddings", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-provider-semantic-index-"));
  const provider: EmbeddingProvider = {
    model: "fake-embedding-model",
    source: "openai",
    async embedTexts(texts: string[]) {
      return texts.map((text) => (
        text.toLowerCase().includes("relay") || text.toLowerCase().includes("provider")
          ? [1, 0, 0]
          : [0, 1, 0]
      ));
    },
  };

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export const relayProbe = 'chat completions relay smoke';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "src", "sessionStore.ts"),
      "export const checkpointState = 'conversation history compaction';\n",
      "utf8",
    );

    const built = await buildSemanticIndex(workspaceRoot, { provider });
    const search = await searchSemanticIndex(workspaceRoot, "provider compatibility", 5, { provider });

    assert.equal(built.index.provider, "openai");
    assert.equal(built.index.model, "fake-embedding-model");
    assert.equal(built.index.dimensions, 3);
    assert.equal(search?.index.provider, "openai");
    assert.equal(search?.results[0]?.path, "src/providerSmoke.ts");
    assert.match(formatSemanticIndexSearch(search, "provider compatibility"), /Provider: openai/);
    await assert.rejects(
      searchSemanticIndex(workspaceRoot, "provider compatibility", 5),
      /Semantic index was built with provider model fake-embedding-model/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("symbol tools list and search source symbols", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-symbols-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "agent.ts"),
      [
        "import type {",
        "  IgnoredImportType,",
        "} from './types';",
        "export class AgentRunner {",
        "  run() {}",
        "}",
        "export function createAgentRunner() {",
        "  return new AgentRunner();",
        "}",
        "const localHelper = () => true;",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "tests", "agent.test.ts"),
      'test("AgentRunner handles symbols", () => {});\n',
      "utf8",
    );
    await writeFile(join(workspaceRoot, "README.md"), "# Agent Symbols\n\n## Usage\n", "utf8");
    await writeFile(join(workspaceRoot, "node_modules", "pkg", "ignored.ts"), "export class Ignored {}\n", "utf8");

    const listed = await new ListSymbolsTool().execute(
      { limit: 20 },
      { workspaceRoot },
    );
    const searched = await new SearchSymbolsTool().execute(
      { query: "AgentRunner", limit: 10 },
      { workspaceRoot },
    );

    assert.equal(listed.ok, true);
    assert.equal(searched.ok, true);

    if (listed.ok) {
      assert.match(listed.content, /Symbol index/);
      assert.match(listed.content, /class exported AgentRunner src\/agent\.ts:4/);
      assert.match(listed.content, /function exported createAgentRunner src\/agent\.ts:7/);
      assert.match(listed.content, /test AgentRunner handles symbols tests\/agent\.test\.ts:1/);
      assert.match(listed.content, /heading Agent Symbols README\.md:1/);
      assert.doesNotMatch(listed.content, /Ignored/);
    }

    if (searched.ok) {
      assert.match(searched.content, /Symbol search: AgentRunner/);
      assert.match(searched.content, /class exported AgentRunner src\/agent\.ts:4/);
      assert.match(searched.content, /function exported createAgentRunner src\/agent\.ts:7/);
      assert.match(searched.content, /test AgentRunner handles symbols tests\/agent\.test\.ts:1/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("SuggestVerificationTool suggests focused checks from changed paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-verify-suggest-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `\uFEFF${JSON.stringify({
        scripts: {
          build: "tsc",
          typecheck: "tsc --noEmit",
          test: "node --import tsx --test tests/*.test.ts",
          "evals:smoke": "tsx src/index.ts --no-session /evals smoke",
          "release:check": "npm run build && node scripts/release-check.mjs",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "src", "model.ts"), "export const model = true;\n", "utf8");
    await writeFile(join(workspaceRoot, "tests", "model.test.ts"), "import test from 'node:test';\n", "utf8");

    const result = await new SuggestVerificationTool().execute(
      { paths: ["src/model.ts"] },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.match(result.content, /Verification suggestions/);
      assert.match(result.content, /Changed paths: 1 \(from input\)/);
      assert.match(result.content, /src\/model\.ts/);
      assert.match(result.content, /npm run build/);
      assert.match(result.content, /npm run typecheck/);
      assert.match(result.content, /node --import tsx --test tests\/model\.test\.ts/);
      assert.match(result.content, /npm test/);
      assert.match(result.content, /npm run evals:smoke/);
      assert.equal(result.metadata?.commandCount, 5);
      assert.deepEqual(result.metadata?.commands, [
        "npm run build",
        "npm run typecheck",
        "node --import tsx --test tests/model.test.ts",
        "npm test",
        "npm run evals:smoke",
      ]);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("patch snapshot tools list, show, and restore captured files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-patch-snapshots-"));

  try {
    const snapshotDir = join(workspaceRoot, ".ccagent", "patch-snapshots");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(workspaceRoot, "note.txt"), "new\n", "utf8");
    await writeFile(join(workspaceRoot, "created.txt"), "created\n", "utf8");
    await writeFile(
      join(snapshotDir, "patch-snapshot-test.json"),
      `${JSON.stringify({
        version: 1,
        createdAt: "2026-07-12T00:00:00.000Z",
        mode: "apply",
        paths: ["note.txt", "created.txt"],
        patch: "diff --git a/note.txt b/note.txt\n",
        files: [
          {
            path: "note.txt",
            exists: true,
            bytes: 4,
            contentBase64: Buffer.from("old\n").toString("base64"),
          },
          {
            path: "created.txt",
            exists: false,
            bytes: 0,
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const listed = await new ListPatchSnapshotsTool().execute(
      { limit: 10 },
      { workspaceRoot },
    );
    const shown = await new ShowPatchSnapshotTool().execute(
      { snapshotPath: "patch-snapshot-test.json" },
      { workspaceRoot },
    );
    const restoredFile = await new RestorePatchSnapshotTool().execute(
      { snapshotPath: "patch-snapshot-test.json", path: "note.txt" },
      { workspaceRoot },
    );
    const restoredMissing = await new RestorePatchSnapshotTool().execute(
      { snapshotPath: "patch-snapshot-test.json", path: "created.txt" },
      { workspaceRoot },
    );

    assert.equal(listed.ok, true);
    assert.equal(shown.ok, true);
    assert.equal(restoredFile.ok, true);
    assert.equal(restoredMissing.ok, true);

    if (listed.ok) {
      assert.match(listed.content, /Patch snapshots: \.ccagent\/patch-snapshots/);
      assert.match(listed.content, /patch-snapshot-test\.json/);
      assert.equal(listed.metadata?.count, 1);
    }

    if (shown.ok) {
      assert.match(shown.content, /Patch snapshot: \.ccagent\/patch-snapshots\/patch-snapshot-test\.json/);
      assert.match(shown.content, /note\.txt: exists, bytes=4, restorable/);
      assert.match(shown.content, /created\.txt: missing, bytes=0, restorable as deletion/);
    }

    assert.equal(await readFile(join(workspaceRoot, "note.txt"), "utf8"), "old\n");
    await assert.rejects(readFile(join(workspaceRoot, "created.txt"), "utf8"));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("PatchSnapshotHistoryTool shows newest rollback entries with restore commands", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-tools-patch-history-"));

  try {
    const snapshotDir = join(workspaceRoot, ".ccagent", "patch-snapshots");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      join(snapshotDir, "patch-snapshot-old.json"),
      `${JSON.stringify({
        version: 1,
        createdAt: "2026-07-12T00:00:00.000Z",
        mode: "apply",
        paths: ["note.txt"],
        patch: [
          "diff --git a/note.txt b/note.txt",
          "--- a/note.txt",
          "+++ b/note.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n"),
        files: [
          {
            path: "note.txt",
            exists: true,
            bytes: 4,
            contentBase64: Buffer.from("old\n").toString("base64"),
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(snapshotDir, "patch-snapshot-new.json"),
      `${JSON.stringify({
        version: 1,
        createdAt: "2026-07-12T00:01:00.000Z",
        mode: "apply",
        paths: ["src/app.ts"],
        patch: [
          "diff --git a/src/app.ts b/src/app.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/app.ts",
          "@@ -0,0 +1 @@",
          "+export {};",
          "",
        ].join("\n"),
        files: [
          {
            path: "src/app.ts",
            exists: false,
            bytes: 0,
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const history = await new PatchSnapshotHistoryTool().execute(
      { limit: 10 },
      { workspaceRoot },
    );

    assert.equal(history.ok, true);

    if (history.ok) {
      assert.match(history.content, /Patch rollback history: \.ccagent\/patch-snapshots/);
      assert.ok(
        history.content.indexOf("patch-snapshot-new.json") < history.content.indexOf("patch-snapshot-old.json"),
      );
      assert.match(history.content, /changes=\+1 -0/);
      assert.match(history.content, /changed paths: src\/app\.ts/);
      assert.match(history.content, /restorable files: src\/app\.ts/);
      assert.match(
        history.content,
        /restore: \/snapshots restore \.ccagent\/patch-snapshots\/patch-snapshot-new\.json src\/app\.ts/,
      );
      assert.match(history.content, /changes=\+1 -1/);
      assert.equal(history.metadata?.count, 2);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("UpdatePlanTool replaces plan through context callback", async () => {
  let updatedPlan: PlanState | null = null;
  const result = await new UpdatePlanTool().execute(
    {
      steps: [
        { content: "inspect files", status: "completed" },
        { content: "write code", status: "in_progress" },
      ],
    },
    {
      workspaceRoot: process.cwd(),
      updatePlan: (plan) => {
        updatedPlan = plan;
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(updatedPlan?.steps.length, 2);
  assert.equal(updatedPlan?.steps[1]?.status, "in_progress");

  if (result.ok) {
    assert.match(result.content, /\[>\] 2\. write code/);
  }
});

test("UpdateTaskStateTool persists compact task state through context callback", async () => {
  let taskState: TaskState | undefined;
  const result = await new UpdateTaskStateTool().execute(
    {
      objective: "Improve relay compatibility",
      status: "active",
      currentStep: "Add provider smoke regression",
      summary: "Need a compact checkpoint for long tasks.",
      files: ["src/model.ts", "tests/model.test.ts"],
      fileMode: "replace",
    },
    {
      workspaceRoot: process.cwd(),
      updateTaskState: (update) => {
        taskState = updateTaskState(taskState, update);
        return taskState;
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(taskState?.objective, "Improve relay compatibility");
  assert.equal(taskState?.status, "active");
  assert.deepEqual(taskState?.files, ["src/model.ts", "tests/model.test.ts"]);

  if (result.ok) {
    assert.match(result.content, /Task state/);
    assert.match(result.content, /Current step: Add provider smoke regression/);
    assert.equal(result.metadata?.status, "active");
  }
});

test("UpdateTaskStateTool requires an objective when task state is empty", async () => {
  const result = await new UpdateTaskStateTool().execute(
    {
      objective: "",
      status: "",
      currentStep: "",
      summary: "",
      files: [],
      fileMode: "keep",
    },
    {
      workspaceRoot: process.cwd(),
      updateTaskState: (update) => updateTaskState(undefined, update),
    },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.match(result.error, /objective is required/);
  }
});

test("UpdatePlanTool rejects multiple in-progress steps", async () => {
  const result = await new UpdatePlanTool().execute(
    {
      steps: [
        { content: "first", status: "in_progress" },
        { content: "second", status: "in_progress" },
      ],
    },
    {
      workspaceRoot: process.cwd(),
      updatePlan: () => {},
    },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.match(result.error, /at most one in_progress/);
  }
});

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  return !isProcessRunning(pid);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
