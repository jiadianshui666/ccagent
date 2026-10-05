import assert from "node:assert/strict";
import test from "node:test";
import { highlightCodeLine, normalizeCodeLanguage } from "../src/richCode.js";
import { createRichTheme } from "../src/richRenderer.js";

const theme = createRichTheme(true);

test("normalizeCodeLanguage maps fence tags to highlighting families", () => {
  assert.equal(normalizeCodeLanguage("ts"), "ts");
  assert.equal(normalizeCodeLanguage("javascript"), "ts");
  assert.equal(normalizeCodeLanguage("python"), "py");
  assert.equal(normalizeCodeLanguage("bash"), "sh");
  assert.equal(normalizeCodeLanguage("json"), "json");
  assert.equal(normalizeCodeLanguage("rust"), "rust");
  assert.equal(normalizeCodeLanguage("something-else"), "plain");
});

test("highlightCodeLine colors TypeScript keywords, numbers, strings, and comments", () => {
  const line = highlightCodeLine(`const x: number = 1; // note`, {
    language: "ts",
    theme,
    inBlockComment: false,
  });

  assert.equal(
    line.text,
    `\x1b[35mconst\x1b[0m x: \x1b[35mnumber\x1b[0m = \x1b[33m1\x1b[0m; \x1b[90m// note\x1b[0m`,
  );
  assert.equal(line.inBlockComment, false);

  const stringLine = highlightCodeLine(`const s = "hi \\"there\\"";`, {
    language: "ts",
    theme,
    inBlockComment: false,
  });

  assert.match(stringLine.text, /\x1b\[32m"hi \\"there\\""\x1b\[0m/);
});

test("highlightCodeLine carries block comments across lines", () => {
  const first = highlightCodeLine(`start /* open`, {
    language: "ts",
    theme,
    inBlockComment: false,
  });

  assert.match(first.text, /start \x1b\[90m\/\* open\x1b\[0m$/);
  assert.equal(first.inBlockComment, true);

  const second = highlightCodeLine(`close */ end`, {
    language: "ts",
    theme,
    inBlockComment: true,
  });

  assert.equal(second.text, `\x1b[90mclose *\/\x1b[0m end`);
  assert.equal(second.inBlockComment, false);
});

test("highlightCodeLine handles Python comments and keywords", () => {
  const line = highlightCodeLine(`def f(): # note`, {
    language: "py",
    theme,
    inBlockComment: false,
  });

  assert.equal(line.text, `\x1b[35mdef\x1b[0m f(): \x1b[90m# note\x1b[0m`);
});

test("highlightCodeLine falls back to generic numbers and strings for unknown languages", () => {
  const line = highlightCodeLine(`const x = 1;`, {
    language: "brainfuck",
    theme,
    inBlockComment: false,
  });

  assert.equal(line.text, `const x = \x1b[33m1\x1b[0m;`);
});
