import assert from "node:assert/strict";
import test from "node:test";
import { formatRuntimeContext } from "../src/context.js";

test("formatRuntimeContext summarizes runtime state", () => {
  const output = formatRuntimeContext({
    allowEdits: true,
    json: false,
    loadedConfig: {
      path: "C:\\workspace\\.ccagent\\config.json",
      exists: true,
      config: {
        model: "gpt-test",
        context: {
          auto: false,
        },
        openai: {
          apiMode: "chat",
          baseURL: "https://relay.example/v1",
          retry: {
            maxAttempts: 4,
            baseDelayMs: 500,
            maxDelayMs: 5000,
          },
        },
      },
      warnings: ["config warning"],
    },
    mcp: {
      enabled: true,
      prompts: 4,
      resources: 3,
      servers: 1,
      templates: 5,
      tools: 2,
    },
    modelName: "openai-chat:gpt-test@https://relay.example/v1",
    projectCommands: {
      path: "C:\\workspace\\.ccagent\\commands",
      commands: [
        {
          name: "review",
          path: "C:\\workspace\\.ccagent\\commands\\review.md",
          content: "# Review {{args}}",
          summary: "Review {{args}}",
        },
        {
          name: "test",
          path: "C:\\workspace\\.ccagent\\commands\\test.md",
          content: "# Test workflow",
          summary: "Test workflow",
        },
      ],
      warnings: ["commands warning"],
    },
    projectInstructions: {
      path: "C:\\workspace\\CCAGENT.md",
      exists: true,
      content: "- Prefer Chinese responses.",
      bytes: 27,
      warnings: ["instructions warning"],
    },
    projectSkills: {
      path: "C:\\workspace\\.ccagent\\skills",
      skills: [{
        name: "code-review",
        path: "C:\\workspace\\.ccagent\\skills\\code-review\\SKILL.md",
        content: "# Code review",
        summary: "Code review workflow.",
      }],
      warnings: ["skills warning"],
    },
    sessionCreatedAt: "2026-01-02T03:04:05.000Z",
    sessionPath: "C:\\workspace\\.ccagent\\sessions\\current.json",
    stream: true,
    systemPromptLength: 1234,
    toolCount: 9,
    useSession: true,
    verifyCommand: "npm test",
    workspaceRoot: "C:\\workspace",
  });

  assert.match(output, /Runtime context/);
  assert.match(output, /Workspace: C:\\workspace/);
  assert.match(output, /Model: openai-chat:gpt-test@https:\/\/relay\.example\/v1/);
  assert.match(output, /--allow-edits: on/);
  assert.match(output, /--verify: npm test/);
  assert.match(output, /openai\.apiMode: chat/);
  assert.match(output, /context\.auto: off/);
  assert.match(output, /openai\.retry\.maxAttempts: 4/);
  assert.match(output, /openai\.retry\.baseDelayMs: 500/);
  assert.match(output, /openai\.retry\.maxDelayMs: 5000/);
  assert.match(output, /mcp\.enabled: on/);
  assert.match(output, /mcp\.servers: 1/);
  assert.match(output, /mcp\.tools: 2/);
  assert.match(output, /mcp\.resources: 3/);
  assert.match(output, /mcp\.prompts: 4/);
  assert.match(output, /mcp\.templates: 5/);
  assert.match(output, /CCAGENT\.md/);
  assert.match(output, /Project commands/);
  assert.match(output, /count: 2/);
  assert.match(output, /names: review, test/);
  assert.match(output, /Project skills/);
  assert.match(output, /names: code-review/);
  assert.match(output, /system prompt chars: 1234/);
  assert.match(output, /registered: 9/);
  assert.match(output, /loaded: yes/);
  assert.match(output, /config: config warning/);
  assert.match(output, /instructions: instructions warning/);
  assert.match(output, /commands: commands warning/);
  assert.match(output, /skills: skills warning/);
});
