import assert from "node:assert/strict";
import test from "node:test";
import { createRichTheme } from "../src/richRenderer.js";
import { createStreamingTextPainter } from "../src/richText.js";

function capturePainter(columns: number, colors = false) {
  let output = "";
  const painter = createStreamingTextPainter({
    getColumns: () => columns,
    theme: createRichTheme(colors),
    write: (text) => {
      output += text;
    },
  });

  return {
    painter,
    read: () => output,
  };
}

test("streaming painter flushes an unterminated line on finish", () => {
  const { painter, read } = capturePainter(40);

  painter.consume("abc");
  assert.equal(read(), "abc");

  painter.finish();
  assert.equal(read(), "abc\n");
});

test("streaming painter wraps long lines at word boundaries", () => {
  const { painter, read } = capturePainter(8);

  painter.consume("hello world");
  painter.finish();

  assert.equal(read(), "hello\nworld\n");
});

test("streaming painter redraws the current line in place", () => {
  const { painter, read } = capturePainter(40);

  painter.consume("ab");
  painter.consume("cd");

  assert.equal(read(), "ab\r\x1b[2Kabcd");
});

test("streaming painter styles markdown headings, bullets, quotes, and inline spans", () => {
  const { painter, read } = capturePainter(40, true);

  painter.consume("# Title\n- one\n1. first\n> quoted\na **b** and `code`\n");

  const output = read();
  assert.match(output, /\x1b\[1m# Title\x1b\[0m\n/);
  assert.match(output, /\x1b\[32m- \x1b\[0mone\n/);
  assert.match(output, /\x1b\[32m1\. \x1b\[0mfirst\n/);
  assert.match(output, /\x1b\[90m> quoted\x1b\[0m\n/);
  assert.match(output, /a \x1b\[1mb\x1b\[0m and \x1b\[33mcode\x1b\[0m/);
});

test("streaming painter colors diff lines inside diff code fences", () => {
  const { painter, read } = capturePainter(40, true);

  painter.consume("```diff\n-old\n+new\n```\nafter\n");

  const output = read();
  assert.match(output, /\x1b\[90m```diff\x1b\[0m\n/);
  assert.match(output, /\x1b\[31m-old\x1b\[0m\n/);
  assert.match(output, /\x1b\[32m\+new\x1b\[0m\n/);
  assert.match(output, /\x1b\[90m```\x1b\[0m\n/);
  assert.match(output, /after\n$/);
});

test("streaming painter detects diff content inside plain code fences", () => {
  const { painter, read } = capturePainter(40, true);

  painter.consume("```\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```\n");

  const output = read();

  assert.match(output, /\x1b\[36m--- a\/x\x1b\[0m\n/);
  assert.match(output, /\x1b\[31m-old\x1b\[0m\n/);
  assert.match(output, /\x1b\[32m\+new\x1b\[0m\n/);
});

test("streaming painter hard-wraps words longer than the terminal width", () => {
  const { painter, read } = capturePainter(12);

  painter.consume("abcdefghijklmnopqrst");
  painter.finish();

  assert.equal(read(), "abcdefghijkl\nmnopqrst\n");
});

test("streaming painter syntax-highlights fenced code blocks", () => {
  const { painter, read } = capturePainter(40, true);

  painter.consume("```ts\nconst x = 1;\n```\nafter\n");

  const output = read();

  assert.match(output, /\x1b\[90m```ts\x1b\[0m\n/);
  assert.match(output, /\x1b\[35mconst\x1b\[0m x = \x1b\[33m1\x1b\[0m;\n/);
  assert.match(output, /\x1b\[90m```\x1b\[0m\n/);
  assert.match(output, /after\n$/);
});
