import assert from "node:assert/strict";
import test from "node:test";
import { RunSubagentTool } from "../src/tools/runSubagent.js";

test("RunSubagentTool delegates to the provided subagent runner", async () => {
  const tool = new RunSubagentTool();
  const result = await tool.execute(
    { prompt: "find the definition of X" },
    {
      workspaceRoot: ".",
      runSubagent: async (prompt) => `subagent result for: ${prompt}`,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.content : "", "subagent result for: find the definition of X");
});

test("RunSubagentTool rejects an empty prompt", async () => {
  const tool = new RunSubagentTool();
  const result = await tool.execute({ prompt: "   " }, { workspaceRoot: "." });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /non-empty string/);
});

test("RunSubagentTool reports an unavailable runner", async () => {
  const tool = new RunSubagentTool();
  const result = await tool.execute({ prompt: "do research" }, { workspaceRoot: "." });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /not available/);
});