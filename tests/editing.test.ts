import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Agent, type AgentStreamEvent } from "../src/agent.js";
import { MockModelClient, type ModelClient, type ModelResult, type ModelTurnInput } from "../src/model.js";
import { ApplyPatchTool, ReversePatchTool } from "../src/tools/applyPatch.js";
import { EditTool } from "../src/tools/edit.js";
import { createDefaultToolRegistry } from "../src/tools/registry.js";

const execFileAsync = promisify(execFile);

class CapturingRepairModel implements ModelClient {
  readonly name = "capture";
  readonly userMessages: string[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    this.userMessages.push(input.userMessage ?? "");

    return {
      content: "repair prompt received",
      toolCalls: [],
    };
  }
}

class NoPatchRepairModel implements ModelClient {
  readonly name = "no-patch-repair";

  async createTurn(): Promise<ModelResult> {
    return {
      content: "I cannot find a safe patch.",
      toolCalls: [],
    };
  }
}

class PatchRepairModel implements ModelClient {
  readonly name = "patch-repair";
  readonly userMessages: string[] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    this.userMessages.push(input.userMessage ?? "");

    if (input.toolOutputs) {
      return {
        content: "repair patch applied",
        toolCalls: [],
      };
    }

    const patch = [
      "diff --git a/fixed.txt b/fixed.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/fixed.txt",
      "@@ -0,0 +1 @@",
      "+fixed",
      "",
    ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: "repair-patch-1",
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class TwoAttemptRepairModel implements ModelClient {
  readonly name = "two-attempt-repair";
  readonly userMessages: string[] = [];
  private repairAttempts = 0;

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: `repair attempt ${this.repairAttempts} patch applied`,
        toolCalls: [],
      };
    }

    this.repairAttempts += 1;
    const patch = this.repairAttempts === 1
      ? [
          "diff --git a/fixed.txt b/fixed.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/fixed.txt",
          "@@ -0,0 +1 @@",
          "+almost",
          "",
        ].join("\n")
      : [
          "diff --git a/fixed.txt b/fixed.txt",
          "--- a/fixed.txt",
          "+++ b/fixed.txt",
          "@@ -1 +1 @@",
          "-almost",
          "+fixed",
          "",
        ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: `repair-loop-patch-${this.repairAttempts}`,
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class BadPatchThenGoodRepairModel implements ModelClient {
  readonly name = "bad-patch-then-good-repair";
  private repairAttempts = 0;

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs) {
      return {
        content: `repair attempt ${this.repairAttempts} patch response`,
        toolCalls: [],
      };
    }

    this.repairAttempts += 1;
    const patch = this.repairAttempts === 1
      ? [
          "diff --git a/fixed.txt b/fixed.txt",
          "@@ -0,0 +1 @@",
          "+broken patch without file headers",
          "",
        ].join("\n")
      : [
          "diff --git a/fixed.txt b/fixed.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/fixed.txt",
          "@@ -0,0 +1 @@",
          "+fixed",
          "",
        ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: `bad-patch-repair-loop-${this.repairAttempts}`,
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

class StalePatchThenGoodRepairModel implements ModelClient {
  readonly name = "stale-patch-then-good-repair";
  readonly userMessages: string[] = [];
  private repairAttempts = 0;

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.userMessage !== undefined) {
      this.userMessages.push(input.userMessage);
    }

    if (input.toolOutputs) {
      return {
        content: `stale repair attempt ${this.repairAttempts} patch response`,
        toolCalls: [],
      };
    }

    this.repairAttempts += 1;
    const patch = this.repairAttempts === 1
      ? [
          "diff --git a/fixed.txt b/fixed.txt",
          "--- a/fixed.txt",
          "+++ b/fixed.txt",
          "@@ -1 +1 @@",
          "-old",
          "+fixed",
          "",
        ].join("\n")
      : [
          "diff --git a/fixed.txt b/fixed.txt",
          "--- a/fixed.txt",
          "+++ b/fixed.txt",
          "@@ -1 +1 @@",
          "-current",
          "+fixed",
          "",
        ].join("\n");

    return {
      content: "",
      toolCalls: [
        {
          callId: `stale-patch-repair-loop-${this.repairAttempts}`,
          name: "apply_patch",
          arguments: { patch },
          rawArguments: JSON.stringify({ patch }),
        },
      ],
    };
  }
}

test("ApplyPatchTool applies a safe create-file patch", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-apply-patch-"));

  try {
    const result = await new ApplyPatchTool().execute(
      {
        patch: [
          "diff --git a/demo.txt b/demo.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/demo.txt",
          "@@ -0,0 +1 @@",
          "+hello from patch",
          "",
        ].join("\n"),
      },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);
    assert.match(result.ok ? result.content : "", /Pre-edit snapshot: \.ccagent\/patch-snapshots\//);

    const snapshotPath = result.ok && typeof result.metadata?.snapshotPath === "string"
      ? result.metadata.snapshotPath
      : "";
    const snapshot = JSON.parse(await readFile(join(workspaceRoot, snapshotPath), "utf8")) as {
      files: Array<{ exists: boolean; path: string }>;
      mode: string;
      paths: string[];
    };

    assert.equal(snapshot.mode, "apply");
    assert.deepEqual(snapshot.paths, ["demo.txt"]);
    assert.deepEqual(snapshot.files.map((file) => ({ exists: file.exists, path: file.path })), [
      { exists: false, path: "demo.txt" },
    ]);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "demo.txt"), "utf8")),
      "hello from patch\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ApplyPatchTool snapshots existing file content before replacing it", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-apply-patch-snapshot-"));

  try {
    await writeFile(join(workspaceRoot, "demo.txt"), "old\n", "utf8");

    const result = await new ApplyPatchTool().execute(
      {
        patch: [
          "diff --git a/demo.txt b/demo.txt",
          "--- a/demo.txt",
          "+++ b/demo.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n"),
      },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);

    const snapshotPath = result.ok && typeof result.metadata?.snapshotPath === "string"
      ? result.metadata.snapshotPath
      : "";
    const snapshot = JSON.parse(await readFile(join(workspaceRoot, snapshotPath), "utf8")) as {
      files: Array<{ contentBase64?: string; exists: boolean; path: string }>;
    };
    const snapshotFile = snapshot.files[0];

    assert.equal(snapshotFile?.exists, true);
    assert.equal(snapshotFile?.path, "demo.txt");
    assert.equal(
      Buffer.from(snapshotFile?.contentBase64 ?? "", "base64").toString("utf8"),
      "old\n",
    );
    assert.equal(normalizeLineEndings(await readFile(join(workspaceRoot, "demo.txt"), "utf8")), "new\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ReversePatchTool reverses a previously applied patch", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-reverse-patch-"));
  const patch = [
    "diff --git a/demo.txt b/demo.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/demo.txt",
    "@@ -0,0 +1 @@",
    "+hello from patch",
    "",
  ].join("\n");

  try {
    const applied = await new ApplyPatchTool().execute({ patch }, { workspaceRoot });
    assert.equal(applied.ok, true);
    assert.equal(await fileExists(join(workspaceRoot, "demo.txt")), true);

    const reversed = await new ReversePatchTool().execute({ patch }, { workspaceRoot });
    assert.equal(reversed.ok, true);
    assert.equal(await fileExists(join(workspaceRoot, "demo.txt")), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ApplyPatchTool rejects unsafe patch paths before running git", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-apply-patch-"));

  try {
    const result = await new ApplyPatchTool().execute(
      {
        patch: [
          "diff --git a/../outside.txt b/../outside.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/../outside.txt",
          "@@ -0,0 +1 @@",
          "+unsafe",
          "",
        ].join("\n"),
      },
      { workspaceRoot },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.match(result.error, /unsafe path/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ApplyPatchTool diagnoses stale patch hunks", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-apply-patch-stale-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "current\n", "utf8");

    const result = await new ApplyPatchTool().execute(
      {
        patch: [
          "diff --git a/note.txt b/note.txt",
          "--- a/note.txt",
          "+++ b/note.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n"),
      },
      { workspaceRoot },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.match(result.error, /Patch check failed/);
      assert.match(result.error, /diagnosis:/);
      assert.match(result.error, /Patch hunks did not match the current workspace state/);
      assert.match(result.error, /reread the file and regenerate the patch/);
      assert.match(result.error, /suggested next reads:/);
      assert.match(result.error, /read_file note\.txt/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ApplyPatchTool approvalMessage summarizes patch before preview", () => {
  const message = new ApplyPatchTool().approvalMessage({
    patch: [
      "diff --git a/demo.txt b/demo.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/demo.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n"),
  });

  assert.match(message ?? "", /Apply this patch:/);
  assert.match(message ?? "", /Files: demo\.txt/);
  assert.match(message ?? "", /Changes: \+2 -0/);
  assert.match(message ?? "", /Patch review:/);
  assert.match(message ?? "", /Overall risk: medium/);
  assert.match(message ?? "", /Medium risk files:/);
  assert.match(message ?? "", /- demo\.txt: create, \+2 -0, hunks=1/);
  assert.match(message ?? "", /Preview:/);
  assert.match(message ?? "", /diff --git a\/demo\.txt b\/demo\.txt/);
});

test("ReversePatchTool approvalMessage describes a reverse patch", () => {
  const message = new ReversePatchTool().approvalMessage({
    patch: [
      "diff --git a/demo.txt b/demo.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/demo.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n"),
  });

  assert.match(message ?? "", /Reverse this patch:/);
  assert.match(message ?? "", /Files: demo\.txt/);
  assert.match(message ?? "", /Changes: \+0 -1/);
  assert.match(message ?? "", /Patch review:/);
  assert.match(message ?? "", /Overall risk: high/);
  assert.match(message ?? "", /High risk files:/);
  assert.match(message ?? "", /- demo\.txt: delete, \+0 -1, hunks=1/);
});

test("ApplyPatchTool documents the required unified diff format", () => {
  const description = new ApplyPatchTool().parameters.properties.patch.description;

  assert.match(description, /diff --git a\/<path> b\/<path>/);
  assert.match(description, /--- a\/<path>/);
  assert.match(description, /\+\+\+ b\/<path>/);
  assert.match(description, /@@ -<oldStart>,<oldCount> \+<newStart>,<newCount> @@/);
});

test("EditTool replaces an exact string and writes a snapshot", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-edit-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src/orders.js"), "const a = 1;\nconst b = 2;\n", "utf8");

    const result = await new EditTool().execute(
      { path: "src/orders.js", old_string: "const a = 1;", new_string: "const a = 10;" },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "src/orders.js"), "utf8")),
      "const a = 10;\nconst b = 2;\n",
    );
    assert.match(result.ok ? result.content : "", /Pre-edit snapshot: \.ccagent\/patch-snapshots\//);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("EditTool rejects an old_string that is not present", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-edit-"));

  try {
    await writeFile(join(workspaceRoot, "demo.txt"), "hello\n", "utf8");

    const result = await new EditTool().execute(
      { path: "demo.txt", old_string: "missing", new_string: "x" },
      { workspaceRoot },
    );

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /was not found/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("EditTool requires replace_all when old_string is ambiguous", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-edit-"));

  try {
    await writeFile(join(workspaceRoot, "demo.txt"), "[x]\n[x]\n", "utf8");

    const result = await new EditTool().execute(
      { path: "demo.txt", old_string: "[x]", new_string: "[y]" },
      { workspaceRoot },
    );

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /matches 2 locations/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("EditTool replace_all replaces every occurrence", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-edit-"));

  try {
    await writeFile(join(workspaceRoot, "demo.txt"), "[x]\n[x]\n", "utf8");

    const result = await new EditTool().execute(
      { path: "demo.txt", old_string: "[x]", new_string: "[y]", replace_all: true },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);
    assert.equal(normalizeLineEndings(await readFile(join(workspaceRoot, "demo.txt"), "utf8")), "[y]\n[y]\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("EditTool deletes old_string when new_string is empty", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-edit-"));

  try {
    await writeFile(join(workspaceRoot, "demo.txt"), "keep\ndrop\n", "utf8");

    const result = await new EditTool().execute(
      { path: "demo.txt", old_string: "drop\n", new_string: "" },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);
    assert.equal(normalizeLineEndings(await readFile(join(workspaceRoot, "demo.txt"), "utf8")), "keep\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("EditTool rejects unsafe paths", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-edit-"));

  try {
    const result = await new EditTool().execute(
      { path: "../outside.txt", old_string: "a", new_string: "b" },
      { workspaceRoot },
    );

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /unsafe path/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ApplyPatchTool recovers incorrect hunk line counts via --recount", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-apply-patch-recount-"));

  try {
    await writeFile(join(workspaceRoot, "demo.txt"), "a\nb\nc\n", "utf8");

    const result = await new ApplyPatchTool().execute(
      {
        patch: [
          "diff --git a/demo.txt b/demo.txt",
          "--- a/demo.txt",
          "+++ b/demo.txt",
          "@@ -1,99 +1,99 @@",
          " a",
          "-b",
          "+B",
          " c",
          "",
        ].join("\n"),
      },
      { workspaceRoot },
    );

    assert.equal(result.ok, true);
    assert.equal(normalizeLineEndings(await readFile(join(workspaceRoot, "demo.txt"), "utf8")), "a\nB\nc\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ApplyPatchTool approvalMessage groups files by patch risk", () => {
  const message = new ApplyPatchTool().approvalMessage({
    patch: [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-TOKEN=old",
      "+TOKEN=new",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export {};",
      "diff --git a/docs/readme.md b/docs/readme.md",
      "--- a/docs/readme.md",
      "+++ b/docs/readme.md",
      "@@ -1 +1,2 @@",
      " hello",
      "+world",
      "",
    ].join("\n"),
  });

  assert.match(message ?? "", /Overall risk: high/);
  assert.match(message ?? "", /High risk files:\n- \.env: modify, \+1 -1, hunks=1/);
  assert.match(message ?? "", /Medium risk files:\n- src\/new\.ts: create, \+1 -0, hunks=1/);
  assert.match(message ?? "", /Low risk files:\n- docs\/readme\.md: modify, \+1 -0, hunks=1/);
});

class DelegatingSubagentModel implements ModelClient {
  readonly name = "delegating";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (!input.toolOutputs || input.toolOutputs.length === 0) {
      return {
        content: "",
        toolCalls: [
          {
            callId: "delegate-1",
            name: "run_subagent",
            arguments: { prompt: "edit demo.txt: replace old\n with new\n" },
            rawArguments: JSON.stringify({ prompt: "edit demo.txt" }),
          },
        ],
      };
    }

    return { content: "delegated edit done", toolCalls: [] };
  }

  createChild(): ModelClient {
    return new EditingSubagentModel();
  }
}

class EditingSubagentModel implements ModelClient {
  readonly name = "editing-subagent";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (!input.toolOutputs || input.toolOutputs.length === 0) {
      return {
        content: "",
        toolCalls: [
          {
            callId: "child-edit-1",
            name: "edit",
            arguments: { path: "demo.txt", old_string: "old\n", new_string: "new\n" },
            rawArguments: JSON.stringify({ path: "demo.txt", old_string: "old\n", new_string: "new\n" }),
          },
        ],
      };
    }

    return { content: "edited", toolCalls: [] };
  }

  createChild(): ModelClient {
    return new EditingSubagentModel();
  }
}

test("Agent adopts a subagent edit for undo", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-subagent-undo-"));

  try {
    await writeFile(join(workspaceRoot, "demo.txt"), "old\n", "utf8");

    const agent = new Agent(new DelegatingSubagentModel(), undefined, workspaceRoot, async () => true);
    await agent.handleUserMessage("delegate an edit of demo.txt");

    assert.equal(normalizeLineEndings(await readFile(join(workspaceRoot, "demo.txt"), "utf8")), "new\n");

    await agent.handleUserMessage("/undo");
    assert.equal(normalizeLineEndings(await readFile(join(workspaceRoot, "demo.txt"), "utf8")), "old\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

class StaleApplyPatchModel implements ModelClient {
  readonly name = "stale-apply-patch";
  receivedToolOutput = "";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs && input.toolOutputs.length > 0) {
      this.receivedToolOutput = input.toolOutputs[0]?.output ?? "";
      return { content: "retried with refreshed content", toolCalls: [] };
    }

    return {
      content: "",
      toolCalls: [
        {
          callId: "stale-1",
          name: "apply_patch",
          arguments: {
            patch: [
              "diff --git a/note.txt b/note.txt",
              "--- a/note.txt",
              "+++ b/note.txt",
              "@@ -1 +1 @@",
              "-stale line",
              "+new line",
              "",
            ].join("\n"),
          },
          rawArguments: JSON.stringify({ patch: "stale" }),
        },
      ],
    };
  }
}

test("Agent re-reads file content after a stale patch failure", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-stale-reread-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "actual content\n", "utf8");

    const model = new StaleApplyPatchModel();
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);
    await agent.handleUserMessage("fix note.txt");

    assert.match(model.receivedToolOutput, /Reread current content of note\.txt/);
    assert.match(model.receivedToolOutput, /actual content/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can apply a mock generated patch when approved", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-patch-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const events: AgentStreamEvent[] = [];
    const response = await agent.handleUserMessage("patch note.txt hello", {
      onStreamEvent: (event) => {
        events.push(event);
      },
    });
    const applyFinish = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "tool_finish" }> =>
        event.type === "tool_finish" && event.toolName === "apply_patch",
    );

    assert.match(response.content, /apply_patch/);
    assert.match(applyFinish?.summary ?? "", /snapshot=yes/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8")),
      "hello\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent suggests verification commands after an approved patch", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-patch-verify-suggest-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "tsc",
          typecheck: "tsc --noEmit",
          test: "node --import tsx --test tests/*.test.ts",
          "evals:smoke": "tsx src/index.ts --no-session /evals smoke",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "tests", "model.test.ts"), "import test from 'node:test';\n", "utf8");
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("patch src/model.ts hello");

    assert.match(response.content, /apply_patch/);
    assert.match(response.content, /Suggested verification:/);
    assert.match(response.content, /Verification suggestions/);
    assert.match(response.content, /npm run build/);
    assert.match(response.content, /npm run typecheck/);
    assert.match(response.content, /node --import tsx --test tests\/model\.test\.ts/);
    assert.match(response.content, /Run suggested commands with approval: \/verify-run src\/model\.ts/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent blocks apply_patch outside configured allowed write paths", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-path-allow-deny-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        allowWritePaths: ["src/"],
      },
    );

    const response = await agent.handleUserMessage("patch note.txt hello");

    assert.match(response.content, /Write path is not allowed by policy/);
    assert.equal(await fileExists(join(workspaceRoot, "note.txt")), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent allows apply_patch inside configured allowed write paths", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-path-allow-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        allowWritePaths: ["src/"],
      },
    );

    const response = await agent.handleUserMessage("patch src/note.txt hello");

    assert.match(response.content, /apply_patch/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "src", "note.txt"), "utf8")),
      "hello\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent blocks apply_patch to configured denied write paths", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-path-deny-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        denyWritePaths: ["note.txt"],
      },
    );

    const response = await agent.handleUserMessage("patch note.txt hello");

    assert.match(response.content, /Write path is denied by policy/);
    assert.equal(await fileExists(join(workspaceRoot, "note.txt")), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can undo the most recently applied patch", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-undo-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    await agent.handleUserMessage("patch note.txt hello");
    assert.equal(await fileExists(join(workspaceRoot, "note.txt")), true);
    assert.equal(agent.snapshotSession().lastPatch?.paths[0], "note.txt");
    assert.match(agent.snapshotSession().lastPatch?.snapshotPath ?? "", /^\.ccagent\/patch-snapshots\//);

    const undoResponse = await agent.handleUserMessage("/undo");

    assert.match(undoResponse.content, /Undo succeeded/);
    assert.equal(await fileExists(join(workspaceRoot, "note.txt")), false);
    assert.equal(agent.snapshotSession().lastPatch, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can list, show, and restore a patch snapshot", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-snapshots-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n", "utf8");
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    await agent.handleUserMessage("replace note.txt hello => hi");
    const snapshotPath = agent.snapshotSession().lastPatch?.snapshotPath ?? "";
    assert.match(snapshotPath, /^\.ccagent\/patch-snapshots\//);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8")),
      "hi world\n",
    );

    const listed = await agent.handleUserMessage("/snapshots");
    const history = await agent.handleUserMessage("/snapshots history");
    const shown = await agent.handleUserMessage(`/snapshots show ${snapshotPath}`);
    const restored = await agent.handleUserMessage(`/snapshots restore ${snapshotPath} note.txt`);

    assert.match(listed.content, /Tool list_patch_snapshots succeeded/);
    assert.match(listed.content, /patch-snapshot-/);
    assert.match(history.content, /Tool patch_snapshot_history succeeded/);
    assert.match(history.content, /Patch rollback history/);
    assert.match(history.content, /restore: \/snapshots restore .* note\.txt/);
    assert.match(shown.content, /Tool show_patch_snapshot succeeded/);
    assert.match(shown.content, /note\.txt: exists/);
    assert.match(restored.content, /Tool restore_patch_snapshot succeeded/);
    assert.match(restored.content, /Restored snapshot file: note\.txt/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8")),
      "hello world\n",
    );
    assert.equal(agent.snapshotSession().lastPatch, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent blocks patch snapshot restore outside configured allowed write paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-snapshot-policy-"));

  try {
    const snapshotDir = join(workspaceRoot, ".ccagent", "patch-snapshots");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(workspaceRoot, "note.txt"), "new\n", "utf8");
    await writeFile(
      join(snapshotDir, "patch-snapshot-test.json"),
      `${JSON.stringify({
        version: 1,
        createdAt: "2026-07-12T00:00:00.000Z",
        mode: "apply",
        paths: ["note.txt"],
        patch: "",
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
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        allowWritePaths: ["src/"],
      },
    );

    const response = await agent.handleUserMessage(
      "/snapshots restore patch-snapshot-test.json note.txt",
    );

    assert.match(response.content, /Write path is not allowed by policy/);
    assert.equal(await readFile(join(workspaceRoot, "note.txt"), "utf8"), "new\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent blocks reverse_patch outside configured allowed write paths", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-path-undo-"));
  const patch = [
    "diff --git a/note.txt b/note.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/note.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "",
  ].join("\n");

  try {
    const applied = await new ApplyPatchTool().execute({ patch }, { workspaceRoot });
    assert.equal(applied.ok, true);

    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        allowWritePaths: ["src/"],
      },
    );
    agent.loadSession({
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelName: "mock",
      messages: [],
      plan: {
        nextId: 1,
        steps: [],
      },
      lastPatch: {
        patch,
        paths: ["note.txt"],
        appliedAt: new Date().toISOString(),
      },
    });

    const response = await agent.handleUserMessage("/undo");

    assert.match(response.content, /Write path is not allowed by policy/);
    assert.equal(await fileExists(join(workspaceRoot, "note.txt")), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent reports when there is no patch to undo", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-undo-empty-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/undo");

    assert.match(response.content, /No patch to undo/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent shows tool details and parameter schema", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-tool-details-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/tool read_file");

    assert.match(response.content, /Tool: read_file/);
    assert.match(response.content, /Description: Read a text file/);
    assert.match(response.content, /effective behavior: runs without approval/);
    assert.match(response.content, /"path"/);
    assert.match(response.content, /"additionalProperties": false/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can run suggest-context as a local slash command", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-suggest-context-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "context.ts"),
      "export const contextRetrieval = 'suggest context files';\n",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/suggest-context context retrieval");

    assert.match(response.content, /Tool suggest_context succeeded/);
    assert.match(response.content, /Context suggestions for: context retrieval/);
    assert.match(response.content, /src\/context\.ts/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can list and search symbols as local slash commands", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-symbols-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "symbols.ts"),
      "export function buildSymbolIndex() {\n  return [];\n}\n",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const listed = await agent.handleUserMessage("/symbols 10");
    const searched = await agent.handleUserMessage("/symbols search buildSymbolIndex");

    assert.match(listed.content, /Tool list_symbols succeeded/);
    assert.match(listed.content, /function exported buildSymbolIndex src\/symbols\.ts:1/);
    assert.match(searched.content, /Tool search_symbols succeeded/);
    assert.match(searched.content, /Symbol search: buildSymbolIndex/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can build and search the context index as local slash commands", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-context-index-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export function providerSmoke() {\n  return 'provider smoke relay chat';\n}\n",
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const missing = await agent.handleUserMessage("/index");
    const built = await agent.handleUserMessage("/index build");
    const searched = await agent.handleUserMessage("/index search provider smoke");

    assert.match(missing.content, /Tool context_index_status succeeded/);
    assert.match(missing.content, /Status: missing/);
    assert.match(built.content, /Tool build_context_index succeeded/);
    assert.match(built.content, /Context index built/);
    assert.match(searched.content, /Tool search_context_index succeeded/);
    assert.match(searched.content, /Context index search: provider smoke/);
    assert.match(searched.content, /src\/providerSmoke\.ts/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can build and search the semantic index as local slash commands", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-semantic-index-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "providerSmoke.ts"),
      "export function providerSmoke() {\n  return 'relay smoke probes for chat completions';\n}\n",
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const missing = await agent.handleUserMessage("/index semantic");
    const built = await agent.handleUserMessage("/index semantic build");
    const searched = await agent.handleUserMessage("/index semantic search provider compatibility");

    assert.match(missing.content, /Tool semantic_index_status succeeded/);
    assert.match(missing.content, /Status: missing/);
    assert.match(built.content, /Tool build_semantic_index succeeded/);
    assert.match(built.content, /Semantic vector index built/);
    assert.match(searched.content, /Tool search_semantic_index succeeded/);
    assert.match(searched.content, /Semantic vector search: provider compatibility/);
    assert.match(searched.content, /src\/providerSmoke\.ts/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can initialize and run repository retrieval evals", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-retrieval-eval-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "provider.ts"),
      "export function providerSmoke() { return 'relay compatibility'; }\n",
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const missing = await agent.handleUserMessage("/index eval");
    const initialized = await agent.handleUserMessage("/index eval init");
    await writeFile(
      join(workspaceRoot, ".ccagent", "retrieval-eval.json"),
      `${JSON.stringify({
        version: 1,
        k: 5,
        cases: [{
          name: "provider-definition",
          query: "providerSmoke",
          expected: ["src/provider.ts"],
        }],
      }, null, 2)}\n`,
      "utf8",
    );
    const built = await agent.handleUserMessage("/index build");
    const semantic = await agent.handleUserMessage("/index semantic build");
    const status = await agent.handleUserMessage("/index eval status");
    const evaluated = await agent.handleUserMessage("/index eval run");
    const evaluatedJson = await agent.handleUserMessage("/index eval run --json");
    const parsed = JSON.parse(evaluatedJson.content) as {
      automatic: { recallAtK: number };
      lexical: { recallAtK: number };
      retrievalMode: string;
      status: string;
    };

    assert.match(missing.content, /Status: missing/);
    assert.match(initialized.content, /manifest initialized/);
    assert.match(built.content, /Context index built/);
    assert.match(semantic.content, /Semantic vector index built/);
    assert.match(status.content, /Status: ready/);
    assert.match(status.content, /Cases: 1/);
    assert.match(evaluated.content, /Retrieval eval/);
    assert.match(evaluated.content, /Status: PASS/);
    assert.equal(parsed.status, "pass");
    assert.equal(parsed.retrievalMode, "hybrid");
    assert.equal(parsed.lexical.recallAtK, 1);
    assert.equal(parsed.automatic.recallAtK, 1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can suggest verification commands as a local slash command", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-suggest-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "tsc",
          typecheck: "tsc --noEmit",
          test: "node --import tsx --test tests/*.test.ts",
          "evals:smoke": "tsx src/index.ts --no-session /evals smoke",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "tests", "model.test.ts"), "import test from 'node:test';\n", "utf8");
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/verify-suggest src/model.ts");

    assert.match(response.content, /Tool suggest_verification succeeded/);
    assert.match(response.content, /Verification suggestions/);
    assert.match(response.content, /npm run build/);
    assert.match(response.content, /node --import tsx --test tests\/model\.test\.ts/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can run suggested verification commands as a local slash command", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-run-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.log('build ok')\"",
          typecheck: "node -e \"console.log('typecheck ok')\"",
          test: "node -e \"console.log('test ok')\"",
          "evals:smoke": "node -e \"console.log('smoke ok')\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/verify-run src/model.ts");

    assert.match(response.content, /Verification run/);
    assert.match(response.content, /npm run build/);
    assert.match(response.content, /npm run typecheck/);
    assert.match(response.content, /npm test/);
    assert.match(response.content, /npm run evals:smoke/);
    assert.match(response.content, /build ok/);
    assert.match(response.content, /typecheck ok/);
    assert.match(response.content, /test ok/);
    assert.match(response.content, /smoke ok/);
    assert.match(response.content, /Verification run passed: 4\/4 command\(s\)\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can run suggested verification for the last patch", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-last-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.log('build ok')\"",
          typecheck: "node -e \"console.log('typecheck ok')\"",
          test: "node -e \"console.log('test ok')\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const missing = await agent.handleUserMessage("/verify-last");
    const patched = await agent.handleUserMessage("patch src/model.ts hello");
    const verified = await agent.handleUserMessage("/verify-last");

    assert.match(missing.content, /No last patch to verify/);
    assert.match(patched.content, /Suggested verification/);
    assert.match(verified.content, /Last patch verification/);
    assert.match(verified.content, /Paths: src\/model\.ts/);
    assert.match(verified.content, /Snapshot: \.ccagent\/patch-snapshots\//);
    assert.match(verified.content, /npm run build/);
    assert.match(verified.content, /npm run typecheck/);
    assert.match(verified.content, /npm test/);
    assert.match(verified.content, /build ok/);
    assert.match(verified.content, /typecheck ok/);
    assert.match(verified.content, /test ok/);
    assert.match(verified.content, /Verification run passed: 3\/3 command\(s\)\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent summarizes failed suggested verification output", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-run-failure-summary-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.error('BUILD_ERROR bad import'); process.exit(2)\"",
          typecheck: "node -e \"console.log('typecheck should not run')\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/verify-run src/model.ts");

    assert.match(response.content, /Verification run/);
    assert.match(response.content, /1\. npm run build/);
    assert.match(response.content, /status: failed \(exitCode=1\)/);
    assert.match(response.content, /failure summary:/);
    assert.match(response.content, /exitCode: 1/);
    assert.match(response.content, /likely: command output reported an error/);
    assert.match(response.content, /next: inspect the key stderr\/stdout line above and rerun the smallest failing command/);
    assert.match(response.content, /stderr: BUILD_ERROR bad import/);
    assert.match(response.content, /remediation:/);
    assert.match(response.content, /reproduce the exact failed command/);
    assert.match(response.content, /Stopped after command 1\./);
    assert.doesNotMatch(response.content, /typecheck should not run/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent classifies TypeScript verification failures", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-run-ts-failure-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.error('src/model.ts(1,7): error TS2322: Type string is not assignable to type number.'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/verify-run src/model.ts");

    assert.match(response.content, /failure summary:/);
    assert.match(response.content, /likely: TypeScript compile\/typecheck failure/);
    assert.match(response.content, /next: open the reported file and line, fix the type error, then rerun typecheck/);
    assert.match(response.content, /inspect: src\/model\.ts:1:7/);
    assert.match(response.content, /remediation:/);
    assert.match(response.content, /start with src\/model\.ts:1:7/);
    assert.match(response.content, /align the value or argument with the expected type/);
    assert.match(response.content, /stderr: src\/model\.ts\(1,7\): error TS2322/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can start a repair loop from the last verification failure", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-repair-last-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "model.ts"), "const value: number = 'bad';\n", "utf8");
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.error('src/model.ts(1,7): error TS2322: Type string is not assignable to type number.'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const model = new CapturingRepairModel();
    const agent = new Agent(
      model,
      undefined,
      workspaceRoot,
      async () => true,
    );

    const failed = await agent.handleUserMessage("/verify-run src/model.ts");
    const failure = agent.snapshotSession().lastVerificationFailure;
    const failureView = await agent.handleUserMessage("/verify-failure");
    const previewed = await agent.handleUserMessage("/repair-preview");
    const repaired = await agent.handleUserMessage("/repair-last");
    const repairPrompt = model.userMessages.at(-1) ?? "";

    assert.match(failed.content, /failure summary:/);
    assert.match(failed.content, /remediation:/);
    assert.equal(failure?.command, "npm run build");
    assert.deepEqual(failure?.paths, ["src/model.ts"]);
    assert.equal(failure?.exitCode, 1);
    assert.match(failure?.locations[0] ?? "", /src\/model\.ts:1:7/);
    assert.match(failureView.content, /Last verification failure/);
    assert.match(failureView.content, /Command: npm run build/);
    assert.match(failureView.content, /Locations: src\/model\.ts:1:7/);
    assert.match(failureView.content, /Use \/repair-preview to inspect the repair prompt/);
    assert.match(previewed.content, /Repair preview/);
    assert.match(previewed.content, /Failed command: npm run build/);
    assert.match(previewed.content, /Inspect first: src\/model\.ts:1:7/);
    assert.match(previewed.content, /Repair strategy:/);
    assert.match(previewed.content, /Fix the first TypeScript diagnostic/);
    assert.equal(model.userMessages.length, 1);
    assert.equal(repaired.content, "repair prompt received");
    assert.match(repairPrompt, /Repair the most recent verification failure/);
    assert.match(repairPrompt, /Failed command: npm run build/);
    assert.match(repairPrompt, /Changed paths: src\/model\.ts/);
    assert.match(repairPrompt, /Inspect first: src\/model\.ts:1:7/);
    assert.match(repairPrompt, /Additional repair context:/);
    assert.match(repairPrompt, /Initial repair file context:/);
    assert.match(repairPrompt, /Path: src\/model\.ts/);
    assert.doesNotMatch(repairPrompt, /Path: src\/model\.ts:1/);
    assert.match(repairPrompt, /const value: number = 'bad';/);
    assert.match(repairPrompt, /align the value or argument with the expected type/);
    assert.match(repairPrompt, /For assignability errors, align the real value/);
    assert.match(repairPrompt, /Use apply_patch for edits/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent reads command-referenced tests for ambiguous repair failures and skips generated paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-repair-ambiguous-context-"));

  try {
    await mkdir(join(workspaceRoot, "tests"), { recursive: true });
    await mkdir(join(workspaceRoot, "dist"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "tests", "cart.test.js"),
      [
        "console.error('cart subtotal mismatch');",
        "console.error('diagnostic artifact: dist/cart.generated.js');",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(workspaceRoot, "dist", "cart.generated.js"), "module.exports = 'generated';\n", "utf8");
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node tests/cart.test.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const model = new CapturingRepairModel();
    const agent = new Agent(
      model,
      undefined,
      workspaceRoot,
      async () => true,
    );

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-last");
    const repairPrompt = model.userMessages.at(-1) ?? "";

    assert.match(failed.content, /cart subtotal mismatch/);
    assert.deepEqual(agent.snapshotSession().lastVerificationFailure?.locations, []);
    assert.equal(repaired.content, "repair prompt received");
    assert.match(repairPrompt, /Initial repair file context:/);
    assert.match(repairPrompt, /Path: tests\/cart\.test\.js/);
    assert.match(repairPrompt, /Path: package\.json/);
    assert.match(repairPrompt, /diagnostic artifact: dist\/cart\.generated\.js/);
    assert.doesNotMatch(repairPrompt, /Path: dist\/cart\.generated\.js/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent reports when there is no verification failure to repair", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-repair-last-empty-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/repair-last");
    const preview = await agent.handleUserMessage("/repair-preview");
    const run = await agent.handleUserMessage("/repair-run");
    const loop = await agent.handleUserMessage("/repair-loop");
    const invalidLoop = await agent.handleUserMessage("/repair-loop 6");
    const clear = await agent.handleUserMessage("/verify-clear");
    const failure = await agent.handleUserMessage("/verify-failure");
    const rerun = await agent.handleUserMessage("/verify-rerun");

    assert.match(response.content, /No verification failure to repair/);
    assert.match(response.content, /\/verify-run \[paths\.\.\.\] or \/verify-last/);
    assert.match(preview.content, /No verification failure to preview/);
    assert.match(run.content, /No verification failure to repair and rerun/);
    assert.match(loop.content, /No verification failure to repair loop/);
    assert.match(invalidLoop.content, /Usage: \/repair-loop \[attempts\]/);
    assert.match(invalidLoop.content, /number from 1 to 5/);
    assert.match(clear.content, /No verification failure or rerun target to clear/);
    assert.match(failure.content, /No verification failure recorded/);
    assert.match(rerun.content, /No verification failure to rerun/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent validates verification stability run counts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-stability-invalid-"));

  try {
    const agent = new Agent(new MockModelClient(), undefined, workspaceRoot, async () => true);
    const missing = await agent.handleUserMessage("/verify-stability");
    const zero = await agent.handleUserMessage("/verify-stability 0");
    const tooMany = await agent.handleUserMessage("/verify-stability 11");
    const invalid = await agent.handleUserMessage("/verify-stability many");

    assert.match(missing.content, /No verification command to check/);
    assert.match(zero.content, /Usage: \/verify-stability \[runs\]/);
    assert.match(tooMany.content, /Runs must be a number from 1 to 10/);
    assert.match(invalid.content, /Runs must be a number from 1 to 10/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can clear stored verification state", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-clear-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.error('BUILD_ERROR stale state'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const cleared = await agent.handleUserMessage("/verify-clear");
    const failure = await agent.handleUserMessage("/verify-failure");
    const rerun = await agent.handleUserMessage("/verify-rerun");

    assert.match(failed.content, /status: failed \(exitCode=1\)/);
    assert.equal(agent.snapshotSession().lastVerificationFailure, undefined);
    assert.equal(agent.snapshotSession().lastVerificationTarget, undefined);
    assert.match(cleared.content, /Verification state cleared/);
    assert.match(cleared.content, /Cleared failure: yes/);
    assert.match(cleared.content, /Cleared rerun target: yes/);
    assert.match(failure.content, /No verification failure recorded/);
    assert.match(rerun.content, /No verification failure to rerun/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can rerun and clear the last verification failure", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-rerun-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.error('BUILD_ERROR still broken'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const targetAfterFailure = agent.snapshotSession().lastVerificationTarget;
    const failedAgain = await agent.handleUserMessage("/verify-rerun");
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.log('build fixed')\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const passed = await agent.handleUserMessage("/verify-rerun");

    assert.match(failed.content, /1\. npm run build/);
    assert.match(failed.content, /status: failed \(exitCode=1\)/);
    assert.equal(targetAfterFailure?.command, "npm run build");
    assert.match(failedAgain.content, /Verification rerun/);
    assert.match(failedAgain.content, /Command: npm run build/);
    assert.match(failedAgain.content, /status: failed \(exitCode=1\)/);
    assert.match(failedAgain.content, /failure summary:/);
    assert.match(passed.content, /Verification rerun/);
    assert.match(passed.content, /status: passed/);
    assert.match(passed.content, /Last verification failure cleared/);
    assert.match(passed.content, /build fixed/);
    assert.equal(agent.snapshotSession().lastVerificationFailure, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent classifies flaky verification and blocks source repair", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-stability-flaky-"));

  try {
    await writeFile(
      join(workspaceRoot, "flaky.js"),
      [
        "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
        "const count = existsSync('.flaky-count') ? Number(readFileSync('.flaky-count', 'utf8')) + 1 : 1;",
        "writeFileSync('.flaky-count', String(count));",
        "if (count % 2 === 1) {",
        "  console.error(`flaky failure on run ${count}`);",
        "  process.exit(1);",
        "}",
        "console.log(`flaky pass on run ${count}`);",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { test: "node flaky.js" } }, null, 2)}\n`,
      "utf8",
    );
    const model = new CapturingRepairModel();
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const stability = await agent.handleUserMessage("/verify-stability 3");
    const failureView = await agent.handleUserMessage("/verify-failure");
    const preview = await agent.handleUserMessage("/repair-preview");
    const repair = await agent.handleUserMessage("/repair-last");
    const repairRun = await agent.handleUserMessage("/repair-run");
    const repairLoop = await agent.handleUserMessage("/repair-loop 2");
    const session = agent.snapshotSession();

    assert.match(failed.content, /flaky failure on run 1/);
    assert.match(stability.content, /Verification stability check/);
    assert.match(stability.content, /Summary: 2 passed, 2 failed \(4 total including baseline\)/);
    assert.match(stability.content, /Classification: flaky/);
    assert.equal(session.lastVerificationFailure?.stability?.status, "flaky");
    assert.equal(session.lastVerificationFailure?.stability?.runs, 4);
    assert.match(failureView.content, /Stability: flaky \(2 passed, 2 failed\)/);
    assert.match(preview.content, /Repair preview blocked/);
    assert.match(repair.content, /Repair blocked: the verification result is flaky/);
    assert.match(repairRun.content, /Repair blocked: the verification result is flaky/);
    assert.match(repairLoop.content, /Repair blocked: the verification result is flaky/);
    assert.equal(model.userMessages.length, 0);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent records stable verification failure as repair evidence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-stability-failure-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node -e \"console.error('stable failure'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const model = new CapturingRepairModel();
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);

    await agent.handleUserMessage("/verify-run package.json");
    const stability = await agent.handleUserMessage("/verify-stability 2");
    const preview = await agent.handleUserMessage("/repair-preview");
    const repaired = await agent.handleUserMessage("/repair-last");
    const session = agent.snapshotSession();

    assert.match(stability.content, /Summary: 0 passed, 3 failed \(3 total including baseline\)/);
    assert.match(stability.content, /Classification: stable failure/);
    assert.equal(session.lastVerificationFailure?.stability?.status, "stable_failure");
    assert.match(preview.content, /Verification stability: stable_failure \(0 passed, 3 failed across 3 runs\)/);
    assert.equal(repaired.content, "repair prompt received");
    assert.match(model.userMessages[0] ?? "", /stability: stable_failure/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent clears a repaired verification target after stable passes", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-stability-pass-"));

  try {
    await writeFile(
      join(workspaceRoot, "check.js"),
      [
        "const { existsSync } = require('node:fs');",
        "if (!existsSync('fixed.txt')) {",
        "  console.error('missing fixed marker');",
        "  process.exit(1);",
        "}",
        "console.log('stable fixed marker');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { build: "node check.js" } }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(new PatchRepairModel(), undefined, workspaceRoot, async () => true);

    await agent.handleUserMessage("/verify-run package.json");
    const patched = await agent.handleUserMessage("/repair-last");
    const targetBefore = agent.snapshotSession().lastVerificationTarget;
    const stability = await agent.handleUserMessage("/verify-stability 2");
    const session = agent.snapshotSession();

    assert.match(patched.content, /repair patch applied/);
    assert.equal(targetBefore?.command, "npm run build");
    assert.match(stability.content, /Summary: 2 passed, 0 failed \(2 total\)/);
    assert.match(stability.content, /Classification: stable pass/);
    assert.equal(session.lastVerificationFailure, undefined);
    assert.equal(session.lastVerificationTarget, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent checks stability after an initially passing verification", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-stability-initial-pass-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { test: "node -e \"console.log('always passes')\"" } }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(new MockModelClient(), undefined, workspaceRoot, async () => true);

    const verified = await agent.handleUserMessage("/verify-run package.json");
    const run = agent.snapshotSession().lastVerificationRun;
    const stability = await agent.handleUserMessage("/verify-stability 2");

    assert.match(verified.content, /Verification run passed/);
    assert.equal(run?.status, "passed");
    assert.equal(run?.command, "npm test");
    assert.match(stability.content, /Baseline: passed verification/);
    assert.match(stability.content, /Summary: 3 passed, 0 failed \(3 total including baseline\)/);
    assert.match(stability.content, /Classification: stable pass/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can repair and rerun verification in one command", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-repair-run-"));

  try {
    await writeFile(
      join(workspaceRoot, "check.js"),
      [
        "const { existsSync } = require('node:fs');",
        "if (!existsSync('fixed.txt')) {",
        "  console.error('missing fixed marker');",
        "  process.exit(1);",
        "}",
        "console.log('fixed marker present');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node check.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const model = new PatchRepairModel();
    const agent = new Agent(
      model,
      undefined,
      workspaceRoot,
      async () => true,
    );

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-run");

    assert.match(failed.content, /status: failed \(exitCode=1\)/);
    assert.match(failed.content, /missing fixed marker/);
    assert.match(repaired.content, /Repair run/);
    assert.match(repaired.content, /Repair:/);
    assert.match(repaired.content, /apply_patch/);
    assert.match(repaired.content, /repair patch applied/);
    assert.match(repaired.content, /Verification:/);
    assert.match(repaired.content, /Verification rerun/);
    assert.match(repaired.content, /status: passed/);
    assert.match(repaired.content, /fixed marker present/);
    assert.equal(await fileExists(join(workspaceRoot, "fixed.txt")), true);
    assert.equal(agent.snapshotSession().lastVerificationFailure, undefined);
    assert.equal(agent.snapshotSession().lastVerificationTarget, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can repair loop until verification passes", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-repair-loop-"));

  try {
    await writeFile(
      join(workspaceRoot, "check.js"),
      [
        "const { existsSync, readFileSync } = require('node:fs');",
        "const value = existsSync('fixed.txt') ? readFileSync('fixed.txt', 'utf8').trim() : '';",
        "if (value !== 'fixed') {",
        "  console.error(`not fixed: ${value || 'missing'}`);",
        "  process.exit(1);",
        "}",
        "console.log('fixed after loop');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node check.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const model = new TwoAttemptRepairModel();
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 2");

    assert.match(failed.content, /status: failed \(exitCode=1\)/);
    assert.match(failed.content, /not fixed: missing/);
    assert.match(repaired.content, /Repair loop/);
    assert.match(repaired.content, /Max attempts: 2/);
    assert.match(repaired.content, /Attempt 1\/2/);
    assert.match(repaired.content, /repair attempt 1 patch applied/);
    assert.match(repaired.content, /Patch:\n  applied: yes\n  paths: fixed\.txt/);
    assert.match(repaired.content, /status: failed \(exitCode=1\)/);
    assert.match(repaired.content, /not fixed: almost/);
    assert.match(repaired.content, /Continuing: repair attempt 1 applied a patch, but verification is still failing\./);
    assert.match(repaired.content, /Attempt 2\/2/);
    assert.match(repaired.content, /repair attempt 2 patch applied/);
    assert.match(repaired.content, /status: passed/);
    assert.match(repaired.content, /fixed after loop/);
    assert.match(repaired.content, /Repair loop passed after 2 attempt\(s\)\./);
    assert.match(model.userMessages[1] ?? "", /Recent patch paths: fixed\.txt/);
    assert.match(model.userMessages[1] ?? "", /reread current file contents before writing another patch/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "fixed.txt"), "utf8")),
      "fixed\n",
    );
    assert.equal(agent.snapshotSession().lastVerificationFailure, undefined);
    assert.equal(agent.snapshotSession().lastVerificationTarget, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent continues repair loop after a failed patch attempt", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-repair-loop-bad-patch-"));

  try {
    await writeFile(
      join(workspaceRoot, "check.js"),
      [
        "const { existsSync, readFileSync } = require('node:fs');",
        "const value = existsSync('fixed.txt') ? readFileSync('fixed.txt', 'utf8').trim() : '';",
        "if (value !== 'fixed') {",
        "  console.error(`not fixed: ${value || 'missing'}`);",
        "  process.exit(1);",
        "}",
        "console.log('fixed after bad patch retry');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node check.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new BadPatchThenGoodRepairModel(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 2");

    assert.match(failed.content, /status: failed \(exitCode=1\)/);
    assert.match(repaired.content, /Attempt 1\/2/);
    assert.match(repaired.content, /Patch check failed/);
    assert.match(repaired.content, /Patch:\n  applied: no/);
    assert.match(repaired.content, /Continuing: repair attempt 1 tried a patch, but it did not apply\./);
    assert.match(repaired.content, /Attempt 2\/2/);
    assert.match(repaired.content, /Patch:\n  applied: yes\n  paths: fixed\.txt/);
    assert.match(repaired.content, /status: passed/);
    assert.match(repaired.content, /fixed after bad patch retry/);
    assert.match(repaired.content, /Repair loop passed after 2 attempt\(s\)\./);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "fixed.txt"), "utf8")),
      "fixed\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent automatically rereads suggested files after a stale patch failure", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-repair-loop-stale-patch-"));

  try {
    await writeFile(join(workspaceRoot, "fixed.txt"), "current\n", "utf8");
    await writeFile(
      join(workspaceRoot, "check.js"),
      [
        "const { readFileSync } = require('node:fs');",
        "const value = readFileSync('fixed.txt', 'utf8').trim();",
        "if (value !== 'fixed') {",
        "  console.error(`not fixed: ${value}`);",
        "  process.exit(1);",
        "}",
        "console.log('fixed after stale reread');",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node check.js",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const model = new StalePatchThenGoodRepairModel();
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 2");

    assert.match(failed.content, /status: failed \(exitCode=1\)/);
    assert.match(failed.content, /not fixed: current/);
    assert.match(repaired.content, /Patch hunks did not match the current workspace state/);
    assert.match(repaired.content, /suggested next reads:/);
    assert.match(repaired.content, /Automatic reread:\n  fixed\.txt: read \d+ chars/);
    assert.match(repaired.content, /Continuing: repair attempt 1 tried a patch, but it did not apply\./);
    assert.match(repaired.content, /Attempt 2\/2/);
    assert.match(repaired.content, /Patch:\n  applied: yes\n  paths: fixed\.txt/);
    assert.match(repaired.content, /status: passed/);
    assert.match(repaired.content, /fixed after stale reread/);
    assert.match(model.userMessages[1] ?? "", /Additional repair context:/);
    assert.match(model.userMessages[1] ?? "", /Automatic reread after failed patch:/);
    assert.match(model.userMessages[1] ?? "", /Path: fixed\.txt/);
    assert.match(model.userMessages[1] ?? "", /current/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "fixed.txt"), "utf8")),
      "fixed\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent stops repair loop when an attempt applies no patch", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-repair-loop-no-patch-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.error('still failing'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new NoPatchRepairModel(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const repaired = await agent.handleUserMessage("/repair-loop 2");

    assert.match(failed.content, /status: failed \(exitCode=1\)/);
    assert.match(repaired.content, /Repair loop/);
    assert.match(repaired.content, /Attempt 1\/2/);
    assert.match(repaired.content, /I cannot find a safe patch/);
    assert.match(repaired.content, /Patch:\n  applied: no/);
    assert.match(repaired.content, /status: failed \(exitCode=1\)/);
    assert.match(repaired.content, /Stopped: repair attempt 1 did not apply a patch/);
    assert.doesNotMatch(repaired.content, /Attempt 2\/2/);
    assert.match(repaired.content, /Repair loop stopped after 1 attempt\(s\); verification is still failing\./);
    assert.equal(agent.snapshotSession().lastPatch, undefined);
    assert.equal(agent.snapshotSession().lastVerificationFailure?.command, "npm run build");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent keeps a rerun target after a repair patch clears failure details", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-rerun-after-patch-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.error('BUILD_ERROR before repair'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const failed = await agent.handleUserMessage("/verify-run package.json");
    const patched = await agent.handleUserMessage("patch note.txt repair marker");
    const targetAfterPatch = agent.snapshotSession().lastVerificationTarget;
    const targetView = await agent.handleUserMessage("/verify-failure");
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.log('build fixed after repair')\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const rerun = await agent.handleUserMessage("/verify-rerun");

    assert.match(failed.content, /status: failed \(exitCode=1\)/);
    assert.match(patched.content, /apply_patch/);
    assert.equal(agent.snapshotSession().lastVerificationFailure, undefined);
    assert.equal(targetAfterPatch?.command, "npm run build");
    assert.match(targetView.content, /Use \/verify-rerun to rerun the repair verification target/);
    assert.match(rerun.content, /Verification rerun/);
    assert.match(rerun.content, /Target recorded at:/);
    assert.match(rerun.content, /status: passed/);
    assert.match(rerun.content, /build fixed after repair/);
    assert.equal(agent.snapshotSession().lastVerificationTarget, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent extracts colon-style verification failure locations", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-run-location-failure-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node -e \"console.error('tests/foo.test.ts:12:3: AssertionError expected true'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/verify-run package.json");

    assert.match(response.content, /1\. npm test/);
    assert.match(response.content, /failure summary:/);
    assert.match(response.content, /likely: command output reported an error/);
    assert.match(response.content, /inspect: tests\/foo\.test\.ts:12:3/);
    assert.match(response.content, /remediation:/);
    assert.match(response.content, /start with tests\/foo\.test\.ts:12:3/);
    assert.match(response.content, /Stopped after command 1\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent classifies Node test runner verification failures", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-run-node-test-failure-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node -e \"console.error('# Subtest: bad math'); console.error('not ok 1 - bad math'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/verify-run package.json");
    const preview = await agent.handleUserMessage("/repair-preview");

    assert.match(response.content, /1\. npm test/);
    assert.match(response.content, /failure summary:/);
    assert.match(response.content, /likely: Node test runner failure/);
    assert.match(response.content, /next: inspect the failing subtest\/assertion, fix the behavior, then rerun the focused test/);
    assert.match(response.content, /remediation:/);
    assert.match(response.content, /rerun the smallest failing test/);
    assert.match(response.content, /Stopped after command 1\./);
    assert.match(preview.content, /Repair strategy:/);
    assert.match(preview.content, /Treat the failing test name and assertion diff as the behavioral contract/);
    assert.match(preview.content, /Patch source behavior before changing tests/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent includes npm script repair strategy for npm verification failures", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-run-npm-failure-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "npm run missing-script-for-test",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/verify-run package.json");
    const preview = await agent.handleUserMessage("/repair-preview");

    assert.match(response.content, /failure summary:/);
    assert.match(response.content, /likely: npm script failure/);
    assert.match(response.content, /remediation:/);
    assert.match(response.content, /run npm run to list available scripts/);
    assert.match(preview.content, /Repair strategy:/);
    assert.match(preview.content, /Inspect package\.json scripts and the child command output/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent classifies environment dependency failures before npm wrapper errors", async () => {
  const scenarios = [
    {
      name: "missing environment variable",
      output: "Error: environment variable DATABASE_URL is required",
      expectedResponse: [
        "likely: missing environment variable",
        "set the required environment variable (DATABASE_URL)",
        "do not hardcode secret values",
      ],
      expectedPreview: [
        "Treat this as an environment/configuration failure",
        "Do not hardcode secret values",
        "Only edit repository configuration when the captured evidence proves that configuration is wrong",
      ],
    },
    {
      name: "port already in use",
      output: "Error: listen EADDRINUSE: address already in use 127.0.0.1:3000",
      expectedResponse: [
        "likely: port already in use",
        "identify the process listening on the requested port",
        "do not remove startup checks",
      ],
      expectedPreview: [
        "Treat this as a runtime resource conflict",
        "Identify the process listening on the requested port",
        "Do not remove server startup checks",
      ],
    },
    {
      name: "network DNS failure",
      output: "TypeError: fetch failed\nCaused by: getaddrinfo ENOTFOUND api.internal.example",
      expectedResponse: [
        "likely: network/DNS dependency failure",
        "check the hostname or base URL, DNS resolution",
        "do not disable TLS verification",
      ],
      expectedPreview: [
        "Treat this as an external dependency or network-path failure",
        "Verify the hostname/base URL, DNS, proxy, VPN, TLS",
        "Do not disable TLS verification",
      ],
    },
    {
      name: "local dependency unavailable without startup evidence",
      output: "Error: connect ECONNREFUSED 127.0.0.1:5432",
      expectedResponse: [
        "likely: network/DNS dependency failure",
        "check the hostname or base URL, DNS resolution",
      ],
      expectedPreview: [
        "Treat this as an external dependency or network-path failure",
        "Verify the hostname/base URL, DNS, proxy, VPN, TLS",
      ],
    },
    {
      name: "missing system command",
      output: "Error: spawn rg ENOENT\nnpm ERR! Lifecycle script failed",
      expectedResponse: [
        "likely: missing system command",
        "install or enable the missing command (rg)",
        "visible on PATH",
      ],
      expectedPreview: [
        "Treat this as a toolchain/PATH failure",
        "Confirm the command is installed and visible on PATH",
        "Do not replace application behavior",
      ],
    },
  ];

  for (const scenario of scenarios) {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-environment-failure-"));

    try {
      const encodedOutput = Buffer.from(scenario.output, "utf8").toString("base64");
      await writeFile(
        join(workspaceRoot, "package.json"),
        `${JSON.stringify({
          scripts: {
            test: `node -e \"console.error(Buffer.from('${encodedOutput}','base64').toString('utf8')); process.exit(1)\"`,
          },
        }, null, 2)}\n`,
        "utf8",
      );
      const agent = new Agent(new MockModelClient(), undefined, workspaceRoot, async () => true);
      const response = await agent.handleUserMessage("/verify-run package.json");
      const preview = await agent.handleUserMessage("/repair-preview");

      for (const expected of scenario.expectedResponse) {
        assert.match(response.content, new RegExp(escapeRegExp(expected), "i"), scenario.name);
      }

      for (const expected of scenario.expectedPreview) {
        assert.match(preview.content, new RegExp(escapeRegExp(expected), "i"), scenario.name);
      }

      assert.doesNotMatch(response.content, /likely: npm script failure/, scenario.name);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
});

test("Agent classifies a local service startup race as a repairable readiness failure", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-service-readiness-"));

  try {
    const output = [
      "Starting local service for integration tests.",
      "Health check failed for http://127.0.0.1:43123/health.",
      "Error: connect ECONNREFUSED 127.0.0.1:43123",
    ].join("\n");
    const encodedOutput = Buffer.from(output, "utf8").toString("base64");
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: `node -e "console.error(Buffer.from('${encodedOutput}','base64').toString('utf8')); process.exit(1)"`,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const model = new CapturingRepairModel();
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);

    const response = await agent.handleUserMessage("/verify-run package.json");
    const preview = await agent.handleUserMessage("/repair-preview");
    const repair = await agent.handleUserMessage("/repair-last");
    const session = agent.snapshotSession();

    assert.equal(session.lastVerificationFailure?.diagnosis?.category, "code");
    assert.equal(session.lastVerificationFailure?.diagnosis?.label, "local service readiness/startup failure");
    assert.match(response.content, /likely: local service readiness\/startup failure/);
    assert.match(response.content, /bounded readiness probe for http:\/\/127\.0\.0\.1:43123\/health/);
    assert.match(preview.content, /local service startup synchronization defect/);
    assert.match(preview.content, /explicit ready\/listening signal or poll the health endpoint with a bounded deadline/);
    assert.match(preview.content, /do not use a fixed long sleep, unbounded retries, disabled health assertions, or swallowed failures/i);
    assert.match(repair.content, /repair prompt received/);
    assert.equal(model.userMessages.length, 1);
    assert.match(model.userMessages[0] ?? "", /local service readiness\/startup failure/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent blocks automatic repair for environment dependency failures", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-environment-repair-guard-"));

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "node -e \"console.error('Error: environment variable DATABASE_URL is required'); process.exit(1)\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const model = new CapturingRepairModel();
    const agent = new Agent(model, undefined, workspaceRoot, async () => true);

    await agent.handleUserMessage("/verify-run package.json");
    const failure = await agent.handleUserMessage("/verify-failure");
    const preview = await agent.handleUserMessage("/repair-preview");
    const repair = await agent.handleUserMessage("/repair-last");
    const repairRun = await agent.handleUserMessage("/repair-run");
    const repairLoop = await agent.handleUserMessage("/repair-loop 2");
    const session = agent.snapshotSession();

    assert.equal(session.lastVerificationFailure?.diagnosis?.category, "environment");
    assert.equal(session.lastVerificationFailure?.diagnosis?.label, "missing environment variable");
    assert.match(failure.content, /Diagnosis: environment\/missing environment variable/);
    assert.match(preview.content, /Treat this as an environment\/configuration failure/);
    assert.match(repair.content, /Repair blocked: verification indicates missing environment variable/);
    assert.match(repairRun.content, /Repair blocked: verification indicates missing environment variable/);
    assert.match(repairLoop.content, /Repair blocked: verification indicates missing environment variable/);
    assert.equal(model.userMessages.length, 0);
    assert.equal(session.lastPatch, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent does not classify an unqualified command timeout as a process cleanup defect", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-timeout-no-cleanup-signal-"));

  try {
    await writeFile(
      join(workspaceRoot, "slow.js"),
      [
        "console.log('long-running build step started');",
        "setTimeout(() => console.log('build finished'), 5000);",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { build: "node slow.js" } }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      createDefaultToolRegistry({ shellCommandTimeoutMs: 400 }),
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("/verify-run package.json");
    const session = agent.snapshotSession();

    assert.match(response.content, /command timed out after 400ms/);
    assert.doesNotMatch(response.content, /likely: process cleanup\/lifecycle failure/);
    assert.notEqual(session.lastVerificationFailure?.diagnosis?.label, "process cleanup/lifecycle failure");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent stops suggested verification when shell approval is denied", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-run-denied-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "node -e \"console.log('build ok')\"",
          typecheck: "node -e \"console.log('typecheck ok')\"",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => false,
    );

    const response = await agent.handleUserMessage("/verify-run src/model.ts");

    assert.match(response.content, /Verification run/);
    assert.match(response.content, /1\. npm run build/);
    assert.match(response.content, /status: failed to start/);
    assert.match(response.content, /User denied approval for run_shell/);
    assert.match(response.content, /Stopped after command 1\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent shows concise and verbose tool lists", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-tools-list-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const summary = await agent.handleUserMessage("/tools");
    const verbose = await agent.handleUserMessage("/tools --verbose");
    const usage = await agent.handleUserMessage("/tools --bad");

    assert.match(summary.content, /Tools summary/);
    assert.match(summary.content, /Read-only tools:/);
    assert.match(summary.content, /list_files\s+risk=low behavior=auto/);
    assert.match(summary.content, /workspace_info\s+risk=low behavior=auto/);
    assert.match(summary.content, /apply_patch\s+risk=high behavior=approval/);
    assert.doesNotMatch(summary.content, /description:/);

    assert.match(verbose.content, /Tools verbose/);
    assert.match(verbose.content, /- read_file/);
    assert.match(verbose.content, /description: Read a text file/);
    assert.match(verbose.content, /- workspace_info/);
    assert.match(verbose.content, /description: Summarize the current workspace/);
    assert.match(verbose.content, /workspace impact: read-only/);

    assert.match(usage.content, /Usage: \/tools \[--verbose\]/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent tool summary reflects project policy behavior", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-tools-policy-list-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        denyTools: ["run_shell"],
        requireApprovalTools: ["read_file"],
      },
    );

    const summary = await agent.handleUserMessage("/tools");

    assert.match(summary.content, /run_shell\s+risk=high behavior=blocked/);
    assert.match(summary.content, /read_file\s+risk=low behavior=approval/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent tool details include policy state", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-tool-policy-details-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        denyRiskLevels: ["high"],
        denyTools: ["run_shell"],
        requireApprovalRiskLevels: ["low"],
        requireApprovalTools: ["read_file"],
      },
    );

    const deniedTool = await agent.handleUserMessage("/tool run_shell");
    const approvalTool = await agent.handleUserMessage("/tool read_file");
    const workspaceTool = await agent.handleUserMessage("/tool workspace_info");
    const missingTool = await agent.handleUserMessage("/tool missing_tool");

    assert.match(deniedTool.content, /denied: yes/);
    assert.match(deniedTool.content, /base risk: high/);
    assert.match(deniedTool.content, /denied by risk policy: yes/);
    assert.match(deniedTool.content, /built-in approval prompt: yes/);
    assert.match(deniedTool.content, /effective behavior: blocked by project policy/);
    assert.match(approvalTool.content, /approval required by policy: yes/);
    assert.match(approvalTool.content, /base risk: low/);
    assert.match(approvalTool.content, /approval required by risk policy: yes/);
    assert.match(approvalTool.content, /asks for approval because of project policy/);
    assert.match(workspaceTool.content, /Tool: workspace_info/);
    assert.match(workspaceTool.content, /base risk: low/);
    assert.match(workspaceTool.content, /effective behavior: asks for approval because of project policy/);
    assert.match(missingTool.content, /Unknown tool: missing_tool/);
    assert.match(missingTool.content, /Available tools:/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent denies a tool disabled by policy", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-policy-deny-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello\n");
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        denyTools: ["read_file"],
      },
    );

    const response = await agent.handleUserMessage("/read note.txt");

    assert.match(response.content, /Tool read_file failed/);
    assert.match(response.content, /disabled by policy/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent denies tools by preflight risk policy", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-policy-deny-risk-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello\n");
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      undefined,
      {
        denyRiskLevels: ["low"],
      },
    );

    const response = await agent.handleUserMessage("/read note.txt");

    assert.match(response.content, /Tool read_file failed/);
    assert.match(response.content, /disabled by policy/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can require approval for an otherwise safe tool", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-policy-approval-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello\n");
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => false,
      undefined,
      undefined,
      {
        requireApprovalTools: ["read_file"],
      },
    );

    const response = await agent.handleUserMessage("/read note.txt");

    assert.match(response.content, /Tool read_file failed/);
    assert.match(response.content, /User denied approval for read_file/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can require approval by preflight risk policy", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-policy-risk-approval-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello\n");
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => false,
      undefined,
      undefined,
      {
        requireApprovalRiskLevels: ["low"],
      },
    );

    const response = await agent.handleUserMessage("/read note.txt");

    assert.match(response.content, /Tool read_file failed/);
    assert.match(response.content, /User denied approval for read_file/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent runs verification command after an approved patch", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-verify-"));

  try {
    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      "node --version",
    );

    const response = await agent.handleUserMessage("patch verified.txt hello");

    assert.match(response.content, /apply_patch/);
    assert.match(response.content, /Verification command/);
    assert.match(response.content, /node --version/);
    assert.match(response.content, /exitCode: 0/);
    assert.doesNotMatch(response.content, /Suggested verification/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "verified.txt"), "utf8")),
      "hello\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent runs verification command after replacing existing file", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-replace-verify-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n");

    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      "node --version",
    );

    const response = await agent.handleUserMessage("replace note.txt hello => hi");

    assert.match(response.content, /read_file/);
    assert.match(response.content, /apply_patch/);
    assert.match(response.content, /Verification command/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8")),
      "hi world\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent task state slash commands persist patch and verification checkpoints", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-task-state-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n");

    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      "node --version",
    );

    const started = await agent.handleUserMessage("/task-state set Update note text");
    const stepped = await agent.handleUserMessage("/task-state step Replace greeting");
    const response = await agent.handleUserMessage("replace note.txt hello => hi");
    const snapshot = agent.snapshotSession();
    const reloaded = new Agent(new MockModelClient(), undefined, workspaceRoot, async () => true);

    reloaded.loadSession(snapshot);
    const restored = await reloaded.handleUserMessage("/task-state");
    const resume = await reloaded.handleUserMessage("/task-state resume");

    assert.match(started.content, /Objective: Update note text/);
    assert.match(stepped.content, /Current step: Replace greeting/);
    assert.match(response.content, /Verification command/);
    assert.equal(snapshot.taskState?.status, "active");
    assert.equal(snapshot.taskState?.objective, "Update note text");
    assert.deepEqual(snapshot.taskState?.files, ["note.txt"]);
    assert.equal(snapshot.taskState?.lastPatch?.paths[0], "note.txt");
    assert.equal(snapshot.taskState?.lastVerification?.ok, true);
    assert.equal(snapshot.taskState?.lastVerification?.command, "node --version");
    assert.match(restored.content, /Task state/);
    assert.match(restored.content, /Objective: Update note text/);
    assert.match(resume.content, /Task resume prompt/);
    assert.match(resume.content, /Objective:\nUpdate note text/);
    assert.match(resume.content, /Relevant files:/);
    assert.match(resume.content, /note\.txt/);
    assert.match(resume.content, /Last verification:/);
    assert.match(resume.content, /node --version/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can run a planned task workflow", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-task-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n");

    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
      undefined,
      "node --version",
    );

    const response = await agent.handleUserMessage("task replace note.txt hello => hi");
    const snapshot = agent.snapshotSession();

    assert.match(response.content, /update_plan/);
    assert.match(response.content, /read_file/);
    assert.match(response.content, /apply_patch/);
    assert.match(response.content, /Task complete/);
    assert.match(response.content, /Verification command/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8")),
      "hi world\n",
    );
    assert.equal(snapshot.plan.steps.length, 4);
    assert.equal(snapshot.plan.steps.every((step) => step.status === "completed"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent task workflow reports missing text without patching", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-task-missing-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n");

    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("task replace note.txt missing => found");

    assert.match(response.content, /Task failed/);
    assert.match(response.content, /text not found/);
    assert.doesNotMatch(response.content, /apply_patch/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8")),
      "hello world\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent can read and patch an existing file when approved", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not available");
    return;
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-replace-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\nsecond line\n");

    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("replace note.txt hello => hi");

    assert.match(response.content, /read_file/);
    assert.match(response.content, /apply_patch/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8")),
      "hi world\nsecond line\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agent reports when replacement text is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-agent-replace-missing-"));

  try {
    await writeFile(join(workspaceRoot, "note.txt"), "hello world\n");

    const agent = new Agent(
      new MockModelClient(),
      undefined,
      workspaceRoot,
      async () => true,
    );

    const response = await agent.handleUserMessage("replace note.txt missing => found");

    assert.match(response.content, /text not found/);
    assert.equal(
      normalizeLineEndings(await readFile(join(workspaceRoot, "note.txt"), "utf8")),
      "hello world\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function hasGit(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
