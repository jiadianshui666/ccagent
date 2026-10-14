import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addTerminalHistoryEntry,
  clearTerminalHistory,
  formatTerminalHistory,
  getTerminalHistoryPath,
  loadTerminalHistory,
  normalizeTerminalHistoryEntries,
  saveTerminalHistory,
  searchTerminalHistoryEntries,
  shouldPersistTerminalHistoryEntry,
} from "../src/terminalHistory.js";

test("terminal history normalizes recent entries and filters unsafe values", () => {
  assert.deepEqual(
    normalizeTerminalHistoryEntries([
      " list files ",
      "",
      "read package.json",
      "list files",
      "exit",
      "OPENAI_API_KEY=sk-secretvalue123456789",
    ]),
    ["list files", "read package.json"],
  );

  assert.deepEqual(addTerminalHistoryEntry(["read package.json"], "list files"), [
    "list files",
    "read package.json",
  ]);
  assert.equal(shouldPersistTerminalHistoryEntry("/input-history"), false);
  assert.equal(shouldPersistTerminalHistoryEntry("/input-history clear"), false);
  assert.equal(shouldPersistTerminalHistoryEntry("/input-history 10"), false);
  assert.equal(shouldPersistTerminalHistoryEntry("run echo hello"), true);
  assert.equal(shouldPersistTerminalHistoryEntry("token=abc123"), false);
});

test("terminal history search ranks prefix and exact matches", () => {
  const entries = [
    "/help model",
    "list files",
    "list skillsling",
    "/ls src",
    "explain list_files output",
    "list",
    "list files and skills",
  ];

  assert.deepEqual(searchTerminalHistoryEntries(entries, "list"), [
    "list",
    "list files",
    "list skillsling",
    "list files and skills",
    "explain list_files output",
  ]);
  assert.deepEqual(searchTerminalHistoryEntries(entries, "skills"), [
    "list skillsling",
    "list files and skills",
  ]);
  assert.deepEqual(searchTerminalHistoryEntries(entries, ""), []);
  assert.deepEqual(searchTerminalHistoryEntries(entries, "missing"), []);
  assert.deepEqual(searchTerminalHistoryEntries(entries, "list", 2), ["list", "list files"]);
});

test("terminal history saves, loads, formats, and clears the workspace file", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-terminal-history-"));

  try {
    const saved = await saveTerminalHistory(workspaceRoot, ["first", "second", "first"]);
    const raw = await readFile(getTerminalHistoryPath(workspaceRoot), "utf8");
    const loaded = await loadTerminalHistory(workspaceRoot);

    assert.equal(saved.path, getTerminalHistoryPath(workspaceRoot));
    assert.equal(raw, "first\nsecond\n");
    assert.deepEqual(loaded.entries, ["first", "second"]);
    assert.match(formatTerminalHistory(loaded), /Terminal input history:/);
    assert.match(formatTerminalHistory(loaded), /1\. first/);

    await clearTerminalHistory(workspaceRoot);

    const cleared = await loadTerminalHistory(workspaceRoot);

    assert.deepEqual(cleared.entries, []);
    assert.match(formatTerminalHistory(cleared), /No terminal input history found/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("terminal history redacts secrets before persisting entries", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-history-redact-"));

  try {
    const saved = await saveTerminalHistory(workspaceRoot, [
      "OPENAI_API_KEY=sk-history-secret-abcdef1234567890",
      "ccagent login --api-key sk-ant-history-secret-abcdef1234567890",
      "plain command",
    ]);
    const loaded = await loadTerminalHistory(workspaceRoot);

    assert.equal(saved.entries.length, 2);
    assert.equal(loaded.entries.length, 2);
    assert.equal(loaded.entries[0], "ccagent login --api-key sk-...[redacted]");
    assert.equal(loaded.entries[1], "plain command");
    assert.doesNotMatch(loaded.entries.join("\n"), /sk-history-secret/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
