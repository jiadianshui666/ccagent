import assert from "node:assert/strict";
import test from "node:test";
import { extractSymbols } from "../src/tools/symbols.js";

test("extractSymbols captures CommonJS named exports", () => {
  const content = [
    "exports.isObject = val => val !== null && typeof val === 'object' && !Array.isArray(val);",
    "exports.escapeRegex = str => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, '\\\\$1');",
    "module.exports.serialize = function serialize(input) { return input; };",
    "module.exports = picomatch;",
    "module.exports = require('./lib/picomatch');",
    "const internal = 1;",
  ].join("\n");

  const symbols = extractSymbols("lib/utils.js", content);
  const names = symbols.map((symbol) => symbol.name);

  assert.ok(names.includes("isObject"));
  assert.ok(names.includes("escapeRegex"));
  assert.ok(names.includes("serialize"));
  assert.ok(names.includes("picomatch"));
  assert.ok(!names.includes("require"));

  for (const name of ["isObject", "escapeRegex", "serialize", "picomatch"]) {
    const symbol = symbols.find((candidate) => candidate.name === name);

    assert.ok(symbol);
    assert.equal(symbol.exported, true);
    assert.equal(symbol.kind, "const");
  }

  const internal = symbols.find((candidate) => candidate.name === "internal");

  assert.ok(internal);
  assert.equal(internal.exported, false);
});

test("extractSymbols keeps ESM export detection unchanged", () => {
  const content = [
    "export const bgBlack = init(40, 49);",
    "export default function chain(input) { return input; }",
    "function helper() {}",
  ].join("\n");

  const symbols = extractSymbols("colors.mjs", content);
  const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));

  assert.equal(byName.get("bgBlack")?.exported, true);
  assert.equal(byName.get("bgBlack")?.kind, "const");
  assert.equal(byName.get("chain")?.exported, true);
  assert.equal(byName.get("chain")?.kind, "function");
  assert.equal(byName.get("helper")?.exported, false);
});