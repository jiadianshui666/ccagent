import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildLocalModuleEdges,
  buildTypeScriptSymbolEdges,
  extractLocalModuleReferences,
} from "../src/moduleGraph.js";

test("extractLocalModuleReferences parses multiline aliases and type imports with the TypeScript AST", async () => {
  const references = await extractLocalModuleReferences(
    [
      "/// <reference path=\"./ambient.d.ts\" />",
      "import DefaultClient, {",
      "  type Account as AccountRecord,",
      "  calculate as runCalculation,",
      "} from './client';",
      "import './setup';",
      "export {",
      "  type Config as PublicConfig,",
      "  helper,",
      "} from './config';",
      "export * as utils from './utils';",
      "import legacy = require('./legacy');",
      "const {",
      "  parse: parsePayload,",
      "  stringify,",
      "} = require('./codec');",
      "const lazy = await import('./lazy');",
      "const templateModule = import(`./template`);",
      "type Input = import('./types').Input;",
      "const fakeText = \"require('./fake-string')\";",
      "// import { ignored } from './fake-comment';",
      "void fakeText;",
    ].join("\n"),
    "src/consumer.ts",
  );
  const byReference = new Map(
    references.map((reference) => [`${reference.kind}:${reference.specifier}`, reference]),
  );

  assert.deepEqual(
    [...byReference.keys()].sort(),
    [
      "dynamic import:./lazy",
      "dynamic import:./template",
      "import:./client",
      "re-export:./config",
      "re-export:./utils",
      "require:./codec",
      "require:./legacy",
      "side-effect import:./setup",
      "type reference:./ambient.d.ts",
      "type reference:./types",
    ].sort(),
  );
  assert.deepEqual(
    [...(byReference.get("import:./client")?.symbols ?? [])].sort(),
    ["Account", "AccountRecord", "DefaultClient", "calculate", "runCalculation"].sort(),
  );
  assert.deepEqual(
    [...(byReference.get("re-export:./config")?.symbols ?? [])].sort(),
    ["Config", "PublicConfig", "helper"].sort(),
  );
  assert.deepEqual(byReference.get("re-export:./utils")?.symbols, ["utils"]);
  assert.deepEqual(
    [...(byReference.get("require:./codec")?.symbols ?? [])].sort(),
    ["parse", "parsePayload", "stringify"].sort(),
  );
  assert.deepEqual(byReference.get("require:./legacy")?.symbols, ["legacy"]);
  assert.deepEqual(byReference.get("dynamic import:./lazy")?.symbols, ["lazy"]);
  assert.deepEqual(byReference.get("dynamic import:./template")?.symbols, ["templateModule"]);
  assert.deepEqual(byReference.get("type reference:./types")?.symbols, ["Input"]);
  assert.equal(references.some((reference) => reference.specifier.startsWith("./fake-")), false);
});

test("buildLocalModuleEdges preserves original and local alias symbols from AST imports", async () => {
  const workspaceRoot = resolve("module-graph-ast-fixture");
  const edges = await buildLocalModuleEdges(workspaceRoot, [
    {
      absolutePath: resolve(workspaceRoot, "src/api.ts"),
      content: "export function calculateTotal() { return 42; }\n",
      path: "src/api.ts",
    },
    {
      absolutePath: resolve(workspaceRoot, "src/service.ts"),
      content: [
        "import {",
        "  calculateTotal as runTotal,",
        "} from './api';",
        "export const result = runTotal();",
        "",
      ].join("\n"),
      path: "src/service.ts",
    },
  ]);

  assert.deepEqual(edges, [
    {
      fromPath: "src/service.ts",
      kind: "import",
      specifier: "./api",
      symbols: ["calculateTotal", "runTotal"],
      toPath: "src/api.ts",
    },
  ]);
});

test("buildTypeScriptSymbolEdges links barrel imports to their final declarations", async () => {
  const workspaceRoot = resolve("module-graph-typechecker-fixture");
  const files = [
    {
      absolutePath: resolve(workspaceRoot, "src/service.ts"),
      content: "export class InternalService { run() { return true; } }\n",
      path: "src/service.ts",
    },
    {
      absolutePath: resolve(workspaceRoot, "src/barrel.ts"),
      content: "export { InternalService as PublicService } from './service';\n",
      path: "src/barrel.ts",
    },
    {
      absolutePath: resolve(workspaceRoot, "src/consumer.ts"),
      content: [
        "import { PublicService } from './barrel';",
        "export function createService(): PublicService {",
        "  return new PublicService();",
        "}",
        "",
      ].join("\n"),
      path: "src/consumer.ts",
    },
  ];
  const moduleEdges = await buildLocalModuleEdges(workspaceRoot, files);
  const symbolEdges = await buildTypeScriptSymbolEdges(workspaceRoot, files, moduleEdges);

  assert.deepEqual(
    moduleEdges.map((edge) => `${edge.fromPath} -> ${edge.toPath}`).sort(),
    [
      "src/barrel.ts -> src/service.ts",
      "src/consumer.ts -> src/barrel.ts",
    ],
  );
  assert.deepEqual(symbolEdges, [
    {
      fromPath: "src/consumer.ts",
      kind: "symbol reference",
      specifier: "./barrel",
      symbols: ["InternalService", "PublicService"],
      toPath: "src/service.ts",
    },
  ]);
});
