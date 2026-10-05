import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCodeMap, exportCodeMapReport, formatCodeMap } from "../src/codeMap.js";

test("buildCodeMap summarizes top-level and source files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-code-map-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "package.json"), "{}\n", "utf8");
    await writeFile(join(workspaceRoot, "README.md"), "# Test\n", "utf8");
    await writeFile(join(workspaceRoot, "src", "cli.ts"), "export {};\n", "utf8");
    await writeFile(join(workspaceRoot, "src", "model.ts"), "export {};\n", "utf8");

    const result = await buildCodeMap(workspaceRoot);
    const output = formatCodeMap(result);

    assert.equal(result.root, workspaceRoot);
    assert.ok(result.rootFiles.includes("package.json"));
    assert.ok(result.srcFiles.includes("src/cli.ts"));
    assert.match(output, /CCAgent code map/);
    assert.match(output, /src\/agent\.ts: Model loop/);
    assert.match(output, /Top-level files:/);
    assert.match(output, /Key source files:/);
    assert.match(output, /src\/model\.ts/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("exportCodeMapReport writes a Markdown report", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-code-map-report-"));

  try {
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "cli.ts"), "export {};\n", "utf8");

    const report = await exportCodeMapReport(workspaceRoot);
    const content = await readFile(report.absolutePath, "utf8");

    assert.match(report.path, /^\.ccagent\/reports\/code-map-.+\.md$/);
    assert.match(content, /^# CCAgent Code Map/m);
    assert.match(content, /## Key Files/);
    assert.match(content, /`src\/cli\.ts`: CLI routing/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
