import assert from "node:assert/strict";
import test from "node:test";
import { formatEffectiveSystemPrompt } from "../src/prompt.js";

test("formatEffectiveSystemPrompt shows base and project instructions", () => {
  const output = formatEffectiveSystemPrompt({
    path: "C:\\workspace\\CCAGENT.md",
    exists: true,
    content: "- Prefer Chinese responses.",
    bytes: 27,
    warnings: [],
  });

  assert.match(output, /Effective system prompt/);
  assert.match(output, /Project instructions loaded: yes/);
  assert.match(output, /System prompt chars: \d+/);
  assert.match(output, /You are CCAgent/);
  assert.match(output, /Project instructions from CCAGENT\.md/);
  assert.match(output, /Prefer Chinese responses/);
});

test("formatEffectiveSystemPrompt works without project instructions", () => {
  const output = formatEffectiveSystemPrompt({
    path: "C:\\workspace\\CCAGENT.md",
    exists: false,
    content: "",
    warnings: [],
  });

  assert.match(output, /Project instructions loaded: no/);
  assert.match(output, /You are CCAgent/);
  assert.doesNotMatch(output, /Project instructions from CCAGENT\.md/);
});
