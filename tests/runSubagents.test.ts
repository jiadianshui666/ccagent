import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { AuditLogger, ToolAuditEvent } from "../src/audit.js";
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

class MemoryAuditLogger implements AuditLogger {
  readonly events: ToolAuditEvent[] = [];

  async record(event: ToolAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const HOST_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const CHILD_USAGE = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

function sumModelTurnTokens(audit: MemoryAuditLogger): number {
  return audit.events.reduce(
    (sum, event) => sum + (event.type === "model_turn" ? (event.totalTokens ?? 0) : 0),
    0,
  );
}

class FixedUsageChildModel implements ModelClient {
  readonly name = "usage-child";

  async createTurn(): Promise<ModelResult> {
    return { content: "child finding", toolCalls: [], usage: { ...CHILD_USAGE } };
  }
}

class SingleSubagentUsageModel implements ModelClient {
  readonly name = "usage-host";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs && input.toolOutputs.length > 0) {
      return { content: "done", toolCalls: [], usage: { ...HOST_USAGE } };
    }

    return {
      content: "",
      toolCalls: [
        {
          callId: "usage-run-subagent",
          name: "run_subagent",
          arguments: { prompt: "research X" },
          rawArguments: JSON.stringify({ prompt: "research X" }),
        },
      ],
      usage: { ...HOST_USAGE },
    };
  }

  createChild(): ModelClient {
    return new FixedUsageChildModel();
  }
}

class ParallelSubagentsUsageModel implements ModelClient {
  readonly name = "usage-host-parallel";

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    if (input.toolOutputs && input.toolOutputs.length > 0) {
      return { content: "done", toolCalls: [], usage: { ...HOST_USAGE } };
    }

    return {
      content: "",
      toolCalls: [
        {
          callId: "usage-run-subagents",
          name: "run_subagents",
          arguments: { prompts: ["research A", "research B"] },
          rawArguments: JSON.stringify({ prompts: ["research A", "research B"] }),
        },
      ],
      usage: { ...HOST_USAGE },
    };
  }

  createChild(): ModelClient {
    return new FixedUsageChildModel();
  }
}

test("run_subagent rolls child model usage into the parent's cumulative usage and audit", async () => {
  const audit = new MemoryAuditLogger();
  const agent = new Agent(
    new SingleSubagentUsageModel(),
    undefined,
    ".",
    async () => true,
    undefined,
    undefined,
    {},
    audit,
  );

  const response = await agent.handleUserMessage("delegate research");

  assert.equal(response.usage?.turns, 3);
  assert.equal(response.usage?.inputTokens, 120);
  assert.equal(response.usage?.outputTokens, 60);
  assert.equal(response.usage?.totalTokens, 180);

  assert.equal(audit.events.filter((event) => event.type === "model_turn").length, 3);
  assert.equal(sumModelTurnTokens(audit), 180);
});

test("run_subagents rolls parallel child model usage into cumulative totals and audit", async () => {
  const audit = new MemoryAuditLogger();
  const agent = new Agent(
    new ParallelSubagentsUsageModel(),
    undefined,
    ".",
    async () => true,
    undefined,
    undefined,
    {},
    audit,
  );

  const response = await agent.handleUserMessage("delegate parallel research");

  assert.equal(response.usage?.turns, 4);
  assert.equal(response.usage?.inputTokens, 220);
  assert.equal(response.usage?.outputTokens, 110);
  assert.equal(response.usage?.totalTokens, 330);

  assert.equal(audit.events.filter((event) => event.type === "model_turn").length, 4);
  assert.equal(sumModelTurnTokens(audit), 330);
});