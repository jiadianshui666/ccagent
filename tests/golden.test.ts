import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agent, type AgentStreamEvent } from "../src/agent.js";
import type { ModelClient, ModelResult, ModelToolCall, ModelTurnInput } from "../src/model.js";

type GoldenToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

type GoldenTurn =
  | { toolCalls: GoldenToolCall[] }
  | { final: string };

type GoldenScenario = {
  name: string;
  prompt: string;
  files?: Record<string, string>;
  turns: GoldenTurn[];
  expect: {
    toolSequence: string[];
    finalText: string;
    fileAfter?: Record<string, string>;
  };
};

const scenarioPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "golden-scenarios.json",
);

class ReplayModelClient implements ModelClient {
  readonly name = "golden-replay";
  private turnIndex = 0;

  constructor(private readonly turns: GoldenTurn[]) {}

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    const turn = this.turns[this.turnIndex];
    assert.ok(turn, `golden scenario ran out of scripted turns at index ${this.turnIndex}`);

    if (this.turnIndex === 0 && "final" in turn) {
      throw new Error("golden scenario cannot start with a final turn");
    }

    this.turnIndex += 1;

    if ("final" in turn) {
      return {
        content: turn.final,
        responseId: `golden-final-${this.turnIndex}`,
        toolCalls: [],
        usage: { totalTokens: 10, estimated: true },
      };
    }

    return {
      content: "",
      responseId: `golden-tools-${this.turnIndex}`,
      toolCalls: turn.toolCalls.map(
        (toolCall): ModelToolCall => ({
          callId: toolCall.callId,
          name: toolCall.name,
          arguments: toolCall.arguments,
          rawArguments: JSON.stringify(toolCall.arguments),
        }),
      ),
      usage: { totalTokens: 10, estimated: true },
    };
  }
}

const scenarios = JSON.parse(await readFile(scenarioPath, "utf8")) as GoldenScenario[];

for (const scenario of scenarios) {
  test(`golden replay: ${scenario.name}`, async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), `ccagent-golden-${scenario.name}-`));

    try {
      for (const [path, content] of Object.entries(scenario.files ?? {})) {
        await writeFile(join(workspaceRoot, path), content, "utf8");
      }

      const events: AgentStreamEvent[] = [];
      const agent = new Agent(
        new ReplayModelClient(scenario.turns),
        undefined,
        workspaceRoot,
        async () => true,
      );
      const response = await agent.handleUserMessage(scenario.prompt, {
        onStreamEvent: (event) => {
          events.push(event);
        },
      });

      const executed = events
        .filter((event): event is Extract<AgentStreamEvent, { type: "tool_start" }> => {
          return event.type === "tool_start";
        })
        .map((event) => event.toolName);

      assert.deepEqual(executed, scenario.expect.toolSequence);
      assert.match(response.content, new RegExp(`${escapeRegex(scenario.expect.finalText)}$`));

      const finishedOk = events
        .filter((event): event is Extract<AgentStreamEvent, { type: "tool_finish" }> => {
          return event.type === "tool_finish";
        })
        .map((event) => event.ok);

      assert.equal(finishedOk.some((ok) => !ok), false);

      for (const [path, content] of Object.entries(scenario.expect.fileAfter ?? {})) {
        const actual = (await readFile(join(workspaceRoot, path), "utf8")).replaceAll("\r\n", "\n");
        assert.equal(actual, content);
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
