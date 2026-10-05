import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateWritePathPolicy,
  evaluateWritePathsPolicy,
  extractPatchPaths,
  matchesWritePathRule,
} from "../src/pathPolicy.js";

test("extractPatchPaths reads paths from unified diff headers", () => {
  const paths = extractPatchPaths(
    [
      "diff --git a/src/demo.txt b/src/demo.txt",
      "--- a/src/demo.txt",
      "+++ b/src/demo.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
  );

  assert.deepEqual(paths, ["src/demo.txt"]);
});

test("matchesWritePathRule supports exact file and trailing slash directory rules", () => {
  assert.equal(matchesWritePathRule("package.json", "package.json"), true);
  assert.equal(matchesWritePathRule("./src/demo.txt", "src/"), true);
  assert.equal(matchesWritePathRule("src-deps/demo.txt", "src/"), false);
  assert.equal(matchesWritePathRule("src/demo.txt", "src"), false);
});

test("evaluateWritePathPolicy applies deny rules before allow rules", () => {
  const result = evaluateWritePathPolicy(
    [
      "diff --git a/src/locked.txt b/src/locked.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/locked.txt",
      "@@ -0,0 +1 @@",
      "+blocked",
      "",
    ].join("\n"),
    {
      allowWritePaths: ["src/"],
      denyWritePaths: ["src/locked.txt"],
    },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.path, "src/locked.txt");
    assert.match(result.reason, /denied by policy/);
  }
});

test("evaluateWritePathPolicy blocks paths outside a non-empty allow list", () => {
  const result = evaluateWritePathPolicy(
    [
      "diff --git a/test.txt b/test.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test.txt",
      "@@ -0,0 +1 @@",
      "+blocked",
      "",
    ].join("\n"),
    {
      allowWritePaths: ["src/"],
    },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.match(result.reason, /not allowed by policy/);
    assert.match(result.reason, /src\//);
  }
});

test("evaluateWritePathsPolicy handles direct restore paths", () => {
  const allowed = evaluateWritePathsPolicy(["src/demo.txt"], {
    allowWritePaths: ["src/"],
  });
  const denied = evaluateWritePathsPolicy(["note.txt"], {
    allowWritePaths: ["src/"],
  });

  assert.equal(allowed.ok, true);
  assert.equal(denied.ok, false);

  if (!denied.ok) {
    assert.equal(denied.path, "note.txt");
    assert.match(denied.reason, /not allowed by policy/);
  }
});
