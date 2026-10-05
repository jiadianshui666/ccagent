import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { ModelClient, ModelResult, ModelTurnInput } from "../src/model.js";
import { RunSubagentsTool } from "../src/tools/runSubagents.js";

test("RunSubagentsTool delegates to the provided parallel runner", async () => {
  const tool = new RunSubagentsTool();
  const result = await tool.execute(
    { prompts: ["find A", "summarize B"] },
    {
      workspaceRoot: ".",
      runSubagents: async (prompts) => prompts.map((prompt) => `result for: ${prompt}`),
    },
  );

  assert.equal(result.ok, true);
  const content = result.ok ? result.content : "";
  assert.match(content, /result for: find A/);
  assert.match(content, /result for: summarize B/);
  assert.match(content, /## Subagent 1/);
  assert.match(content, /## Subagent 2/);
});

test("RunSubagentsTool rejects an empty prompts array", async () => {
  const tool = new RunSubagentsTool();
  const result = await tool.execute({ prompts: [] }, { workspaceRoot: "." });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /non-empty array/);
});

test("RunSubagentsTool rejects a missing prompts array", async () => {
  const tool = new RunSubagentsTool();
  const result = await tool.execute({}, { workspaceRoot: "." });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /non-empty array/);
});

test("RunSubagentsTool rejects non-string or blank prompts", async () => {
  const tool = new RunSubagentsTool();
  const result = await tool.execute({ prompts: ["ok", "   ", 7] }, { workspaceRoot: "." });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /non-empty strings/);
});

test("RunSubagentsTool reports an unavailable runner", async () => {
  const tool = new RunSubagentsTool();
  const result = await tool.execute({ prompts: ["do research"] }, { workspaceRoot: "." });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /not available/);
});

class ParallelSubagentHostModel implements ModelClient {
  readonly name = "parallel-host";
  childCount = 0;
  private readonly state = { inFlight: 0, maxConcurrent: 0 };

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs && input.toolOutputs.length > 0) {
      return { content: input.toolOutputs[0]?.output ?? "", toolCalls: [] };
    }

    return {
      content: "",
      toolCalls: [
        {
          callId: "delegate-parallel",
          name: "run_subagents",
          arguments: { prompts: ["task A", "task B", "task C"] },
          rawArguments: JSON.stringify({ prompts: ["task A", "task B", "task C"] }),
        },
      ],
    };
  }

  createChild(): ModelClient {
    this.childCount += 1;
    return new ProbingChildModel(this.state, `child ${this.childCount}`);
  }

  maxConcurrency(): number {
    return this.state.maxConcurrent;
  }
}

class ProbingChildModel implements ModelClient {
  readonly name = "probing-child";

  constructor(
    private readonly state: { inFlight: number; maxConcurrent: number },
    private readonly reply: string,
  ) {}

  async createTurn(): Promise<ModelResult> {
    this.state.inFlight += 1;
    this.state.maxConcurrent = Math.max(this.state.maxConcurrent, this.state.inFlight);

    await new Promise((resolve) => setTimeout(resolve, 20));

    this.state.inFlight -= 1;
    return { content: this.reply, toolCalls: [] };
  }
}

test("Agent runs parallel read-only subagents concurrently and combines results", async () => {
  const model = new ParallelSubagentHostModel();
  const agent = new Agent(model, undefined, ".", async () => true);
  const response = await agent.handleUserMessage("research three topics in parallel");

  assert.match(response.content, /child 1/);
  assert.match(response.content, /child 2/);
  assert.match(response.content, /child 3/);
  assert.equal(model.childCount, 3);
  assert.ok(
    model.maxConcurrency() >= 2,
    `expected concurrent subagents, observed max concurrency ${model.maxConcurrency()}`,
  );
});