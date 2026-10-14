import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createPasteGuardState,
  createPasteGuardStream,
  normalizePastedText,
  transformPasteChunk,
} from "../src/pasteGuard.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

test("normalizePastedText joins interior lines into one line", () => {
  assert.equal(normalizePastedText("a\nb\nc"), "a b c");
  assert.equal(normalizePastedText("a\r\nb"), "a b");
  assert.equal(normalizePastedText("  a\n\tb  "), "a b ");
  assert.equal(normalizePastedText("a\nb\n"), "a b\n");
  assert.equal(normalizePastedText("single"), "single");
});

test("transformPasteChunk merges a complete bracketed paste block", () => {
  const state = createPasteGuardState();
  assert.equal(transformPasteChunk(`${PASTE_START}line1\nline2\n${PASTE_END}tail`, state), "line1 line2\ntail");
  assert.equal(state.mode, "outside");
  assert.equal(state.pending, "");
});

test("transformPasteChunk handles a bracketed block split across chunks", () => {
  const state = createPasteGuardState();
  assert.equal(transformPasteChunk(`${PASTE_START}a\nb`, state), "");
  assert.equal(state.mode, "inside");
  assert.equal(transformPasteChunk(`c\nd${PASTE_END}tail`, state), "a bc dtail");
  assert.equal(state.mode, "outside");
});

test("transformPasteChunk holds back a split paste marker boundary", () => {
  const state = createPasteGuardState();
  assert.equal(transformPasteChunk("\x1b[20", state), "");
  assert.equal(state.pending, "\x1b[20");
  assert.equal(transformPasteChunk(`0~x\ny${PASTE_END}z`, state), "x yz");
  assert.equal(state.mode, "outside");
});

test("transformPasteChunk joins large multi-line pastes lacking markers", () => {
  const state = createPasteGuardState();
  const pasted = "first line of a pasted block\nsecond line of the block\n";
  assert.equal(transformPasteChunk(pasted, state), "first line of a pasted block second line of the block\n");
});

test("transformPasteChunk passes ordinary keypress chunks through untouched", () => {
  const state = createPasteGuardState();
  assert.equal(transformPasteChunk("hello", state), "hello");
  assert.equal(transformPasteChunk("\x12", state), "\x12");
  assert.equal(transformPasteChunk("\x1b[A", state), "\x1b[A");
  assert.equal(state.mode, "outside");
  assert.equal(state.pending, "");
});

test("transformPasteChunk keeps short embedded newlines literal", () => {
  const state = createPasteGuardState();
  assert.equal(transformPasteChunk("a\nb", state), "a\nb");
});

test("createPasteGuardStream forwards normalized chunks", async () => {
  const source = Readable.from([
    `${PASTE_START}one\ntwo${PASTE_END}`,
    " ",
    `${PASTE_START}three\nfour${PASTE_END}\n`,
  ]);
  const guard = createPasteGuardStream(source as unknown as NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => unknown;
  });
  const chunks: Buffer[] = [];

  for await (const chunk of guard) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  assert.equal(Buffer.concat(chunks).toString("utf8"), "one two three four\n");
});