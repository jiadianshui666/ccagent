import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatProjectInstructions,
  initProjectInstructions,
  loadProjectInstructions,
} from "../src/instructions.js";

test("loadProjectInstructions returns empty state when CCAGENT.md is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-instructions-"));

  try {
    const loaded = await loadProjectInstructions(workspaceRoot);

    assert.equal(loaded.exists, false);
    assert.equal(loaded.content, "");
    assert.deepEqual(loaded.warnings, []);
    assert.match(formatProjectInstructions(loaded), /No CCAGENT\.md found/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadProjectInstructions reads and formats CCAGENT.md", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-instructions-"));

  try {
    await writeFile(
      join(workspaceRoot, "CCAGENT.md"),
      ["# CCAgent Instructions", "", "- Prefer Chinese responses.", ""].join("\n"),
    );

    const loaded = await loadProjectInstructions(workspaceRoot);
    const output = formatProjectInstructions(loaded);

    assert.equal(loaded.exists, true);
    assert.equal(loaded.content, "# CCAgent Instructions\n\n- Prefer Chinese responses.");
    assert.deepEqual(loaded.warnings, []);
    assert.match(output, /Loaded: yes/);
    assert.match(output, /Prefer Chinese responses/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadProjectInstructions warns when CCAGENT.md is not a file", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-instructions-"));

  try {
    await mkdir(join(workspaceRoot, "CCAGENT.md"));

    const loaded = await loadProjectInstructions(workspaceRoot);

    assert.equal(loaded.exists, false);
    assert.match(loaded.warnings.join("\n"), /not a file/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("initProjectInstructions creates a default CCAGENT.md when missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-instructions-"));

  try {
    const result = await initProjectInstructions(workspaceRoot);
    const content = await readFile(join(workspaceRoot, "CCAGENT.md"), "utf8");

    assert.equal(result.created, true);
    assert.equal(result.path, join(workspaceRoot, "CCAGENT.md"));
    assert.match(content, /# CCAgent Instructions/);
    assert.match(content, /Prefer Chinese responses/);
    assert.match(content, /apply_patch/);
    assert.match(content, /Never store OPENAI_API_KEY/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("initProjectInstructions does not overwrite an existing CCAGENT.md", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-instructions-"));
  const path = join(workspaceRoot, "CCAGENT.md");

  try {
    await writeFile(path, "custom instructions\n", "utf8");

    const result = await initProjectInstructions(workspaceRoot);
    const content = await readFile(path, "utf8");

    assert.equal(result.created, false);
    assert.equal(result.path, path);
    assert.equal(result.reason, "CCAGENT.md already exists.");
    assert.equal(content, "custom instructions\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
