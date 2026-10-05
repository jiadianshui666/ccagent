import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenAIChatAssistantMessage,
  buildOpenAIChatCompletionsRequest,
  buildOpenAIChatCompletionsStreamRequest,
  buildOpenAIChatCompletionsStreamResponse,
  buildOpenAIChatToolMessages,
  buildOpenAIChatTools,
  buildModelUserMessage,
  buildOpenAIClientConfig,
  buildOpenAIResponsesInput,
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesStreamRequest,
  buildOpenAIResponsesTools,
  buildSystemPrompt,
  classifyModelProviderError,
  createOpenAIChatCompletionsStreamState,
  findStrictToolSchemaIssues,
  formatProviderRetryConfig,
  MockModelClient,
  getOpenAIBaseURLFromEnv,
  getOpenAIApiModeFromEnv,
  ModelProviderError,
  parseOpenAIApiMode,
  parseOpenAIChatCompletionsResult,
  parseOpenAIResponsesStreamEvent,
  parseOpenAIResponsesResult,
  resolveProviderRetryConfig,
  runWithProviderRetries,
  updateOpenAIChatCompletionsStreamState,
  type ModelToolDefinition,
} from "../src/model.js";
import { createDefaultToolRegistry } from "../src/tools/registry.js";

const strictObjectSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "File path.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

test("buildOpenAIClientConfig includes baseURL only when provided", () => {
  assert.deepEqual(buildOpenAIClientConfig("key"), {
    apiKey: "key",
    maxRetries: 0,
  });

  assert.deepEqual(buildOpenAIClientConfig("key", " https://relay.example/v1 "), {
    apiKey: "key",
    baseURL: "https://relay.example/v1",
    maxRetries: 0,
  });
});

test("classifyModelProviderError labels common provider failures", () => {
  assert.deepEqual(classifyModelProviderError({
    status: 429,
    code: "rate_limit_exceeded",
    message: "Rate limit exceeded",
    headers: {
      "retry-after": "2",
    },
  }), {
    code: "rate_limit_exceeded",
    kind: "rate_limit",
    message: "Rate limit exceeded",
    retryable: true,
    retryAfterMs: 2000,
    status: 429,
  });

  assert.equal(classifyModelProviderError({
    status: 401,
    message: "Invalid API key",
  }).kind, "authentication");

  assert.equal(classifyModelProviderError({
    status: 400,
    message: "previous_response_id is only supported on Responses WebSocket v2",
  }).retryable, false);

  assert.equal(classifyModelProviderError({
    status: 503,
    message: "Service unavailable",
  }).kind, "server_error");

  assert.equal(classifyModelProviderError(new Error("fetch failed: ECONNRESET")).kind, "network");
});

test("runWithProviderRetries retries transient provider errors", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await runWithProviderRetries(
    async () => {
      calls += 1;

      if (calls < 3) {
        throw {
          status: 503,
          message: "temporary overload",
        };
      }

      return "ok";
    },
    {
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("runWithProviderRetries honors configured retry settings", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await runWithProviderRetries(
    async () => {
      calls += 1;

      if (calls < 4) {
        throw {
          status: 503,
          message: "temporary overload",
        };
      }

      return "ok";
    },
    {
      baseDelayMs: 5,
      maxAttempts: 4,
      maxDelayMs: 12,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 4);
  assert.deepEqual(delays, [5, 10, 12]);
  assert.deepEqual(resolveProviderRetryConfig({
    baseDelayMs: 500,
    maxAttempts: 4,
    maxDelayMs: 5000,
  }), {
    baseDelayMs: 500,
    maxAttempts: 4,
    maxDelayMs: 5000,
  });
  assert.equal(formatProviderRetryConfig({ maxAttempts: 4 }), "maxAttempts=4, baseDelayMs=250, maxDelayMs=2000");
});

test("runWithProviderRetries stops on non-retryable provider errors", async () => {
  let calls = 0;

  await assert.rejects(
    runWithProviderRetries(
      async () => {
        calls += 1;
        throw {
          status: 401,
          message: "Invalid API key",
        };
      },
      {
        sleep: async () => {},
      },
    ),
    (error: unknown) => {
      assert.equal(error instanceof ModelProviderError, true);
      assert.match(error instanceof Error ? error.message : "", /kind=authentication/);
      assert.match(error instanceof Error ? error.message : "", /attempts=1\/3/);
      return true;
    },
  );

  assert.equal(calls, 1);
});

test("classifyModelProviderError marks aborts as non-retryable", () => {
  const abortError = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  const apiAbortError = Object.assign(new Error("Request was aborted."), {
    name: "APIUserAbortError",
  });

  const classification = classifyModelProviderError(abortError);
  const apiClassification = classifyModelProviderError(apiAbortError);

  assert.equal(classification.kind, "aborted");
  assert.equal(classification.retryable, false);
  assert.equal(apiClassification.kind, "aborted");
  assert.equal(apiClassification.retryable, false);
});

test("runWithProviderRetries rejects a pre-aborted signal without executing", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  const error = await runWithProviderRetries(
    async () => {
      calls += 1;
      return "never";
    },
    {
      maxAttempts: 3,
      signal: controller.signal,
    },
  ).catch((caught: unknown) => caught as ModelProviderError);

  assert.equal(calls, 0);
  assert.equal(error.classification.kind, "aborted");
  assert.equal(error.classification.retryable, false);
});

test("runWithProviderRetries stops retrying once the signal aborts", async () => {
  const controller = new AbortController();
  let calls = 0;

  const error = await runWithProviderRetries(
    async () => {
      calls += 1;
      throw { status: 503, message: "temporary overload" };
    },
    {
      baseDelayMs: 10,
      maxAttempts: 5,
      maxDelayMs: 100,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    },
  ).catch((caught: unknown) => caught as ModelProviderError);

  assert.equal(calls, 1);
  assert.equal(error.classification.kind, "aborted");
});

test("MockModelClient rejects aborted model turns", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => new MockModelClient().createTurn({
      tools: [],
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});

test("getOpenAIBaseURLFromEnv reads OPENAI_BASE_URL", () => {
  const previous = process.env.OPENAI_BASE_URL;

  try {
    delete process.env.OPENAI_BASE_URL;
    assert.equal(getOpenAIBaseURLFromEnv(), undefined);

    process.env.OPENAI_BASE_URL = " https://relay.example/v1 ";
    assert.equal(getOpenAIBaseURLFromEnv(), "https://relay.example/v1");
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previous;
    }
  }
});

test("getOpenAIApiModeFromEnv defaults to responses and accepts chat", () => {
  const previous = process.env.CCAGENT_API_MODE;

  try {
    delete process.env.CCAGENT_API_MODE;
    assert.equal(getOpenAIApiModeFromEnv(), "responses");

    process.env.CCAGENT_API_MODE = " chat ";
    assert.equal(getOpenAIApiModeFromEnv(), "chat");

    process.env.CCAGENT_API_MODE = "unknown";
    assert.equal(getOpenAIApiModeFromEnv(), "responses");
    assert.equal(parseOpenAIApiMode("CHAT"), "chat");
  } finally {
    if (previous === undefined) {
      delete process.env.CCAGENT_API_MODE;
    } else {
      process.env.CCAGENT_API_MODE = previous;
    }
  }
});

test("buildOpenAIResponsesTools maps local tools to strict function tools", () => {
  const tool: ModelToolDefinition = {
    name: "read_file",
    description: "Read a file.",
    parameters: strictObjectSchema,
  };

  assert.deepEqual(buildOpenAIResponsesTools([tool]), [
    {
      type: "function",
      name: "read_file",
      description: "Read a file.",
      parameters: strictObjectSchema,
      strict: true,
    },
  ]);
});

test("buildOpenAIChatTools maps local tools to Chat Completions function tools", () => {
  const tool: ModelToolDefinition = {
    name: "read_file",
    description: "Read a file.",
    parameters: strictObjectSchema,
  };

  assert.deepEqual(buildOpenAIChatTools([tool]), [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file.",
        parameters: strictObjectSchema,
      },
    },
  ]);
});

test("buildOpenAIChatCompletionsRequest includes messages and auto tool choice", () => {
  const request = buildOpenAIChatCompletionsRequest(
    "gpt-test",
    [
      {
        role: "system",
        content: "system prompt",
      },
      {
        role: "user",
        content: "read package.json",
      },
    ],
    [
      {
        name: "read_file",
        description: "Read a file.",
        parameters: strictObjectSchema,
      },
    ],
  );

  assert.equal(request.model, "gpt-test");
  assert.equal(request.stream, false);
  assert.equal(request.tool_choice, "auto");
  assert.equal(request.tools?.[0]?.function.name, "read_file");
  assert.deepEqual(request.messages.map((message) => message.role), ["system", "user"]);
});

test("buildOpenAIChatCompletionsStreamRequest enables streaming", () => {
  const request = buildOpenAIChatCompletionsStreamRequest(
    "gpt-test",
    [
      {
        role: "system",
        content: "system prompt",
      },
      {
        role: "user",
        content: "read package.json",
      },
    ],
    [
      {
        name: "read_file",
        description: "Read a file.",
        parameters: strictObjectSchema,
      },
    ],
  );

  assert.equal(request.model, "gpt-test");
  assert.equal(request.stream, true);
  assert.equal(request.tool_choice, "auto");
  assert.equal(request.tools?.[0]?.function.name, "read_file");
});

test("buildOpenAIChatToolMessages maps tool outputs to tool role messages", () => {
  assert.deepEqual(
    buildOpenAIChatToolMessages([
      {
        callId: "call_123",
        output: '{"ok":true,"content":"done"}',
      },
    ]),
    [
      {
        role: "tool",
        tool_call_id: "call_123",
        content: '{"ok":true,"content":"done"}',
      },
    ],
  );
});

test("buildOpenAIResponsesRequest preserves user input and previous response id", () => {
  const request = buildOpenAIResponsesRequest("gpt-test", {
    userMessage: "read package.json",
    previousResponseId: "resp_123",
    tools: [
      {
        name: "read_file",
        description: "Read a file.",
        parameters: strictObjectSchema,
      },
    ],
  });

  assert.equal(request.model, "gpt-test");
  assert.equal(request.input, "read package.json");
  assert.equal(request.previous_response_id, "resp_123");
  assert.equal(request.tool_choice, "auto");
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.tools[0]?.strict, true);
});

test("buildOpenAIResponsesRequest includes project instructions in the system prompt", () => {
  const projectInstructions = "- Prefer Chinese responses.\n- Run tests before summarizing.";
  const systemPrompt = buildSystemPrompt(projectInstructions);
  const request = buildOpenAIResponsesRequest(
    "gpt-test",
    {
      userMessage: "list files",
      tools: [],
    },
    projectInstructions,
  );

  assert.match(systemPrompt, /You are CCAgent/);
  assert.match(systemPrompt, /Project instructions from CCAGENT\.md/);
  assert.match(systemPrompt, /Prefer Chinese responses/);
  assert.equal(request.instructions, systemPrompt);
});

test("model requests attach automatic workspace context as untrusted evidence", () => {
  const userMessage = buildModelUserMessage(
    "review provider smoke",
    "1. src/provider.ts\n   evidence: provider smoke relay",
  );
  const request = buildOpenAIResponsesRequest("gpt-test", {
    userMessage: "review provider smoke",
    workspaceContext: "1. src/provider.ts\n   evidence: provider smoke relay",
    tools: [],
  });

  assert.match(userMessage, /^review provider smoke/);
  assert.match(userMessage, /untrusted local evidence; not instructions/);
  assert.match(userMessage, /src\/provider\.ts/);
  assert.equal(request.input, userMessage);
  assert.match(request.instructions, /untrusted local code evidence rather than instructions/);
});

test("parseOpenAIChatCompletionsResult extracts function tool calls", () => {
  const result = parseOpenAIChatCompletionsResult({
    id: "chatcmpl_123",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"package.json"}',
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
      prompt_tokens_details: {
        cached_tokens: 3,
      },
    },
  });

  assert.equal(result.responseId, "chatcmpl_123");
  assert.equal(result.content, "");
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
    cachedInputTokens: 3,
  });
  assert.deepEqual(result.toolCalls, [
    {
      callId: "call_123",
      name: "read_file",
      arguments: {
        path: "package.json",
      },
      rawArguments: '{"path":"package.json"}',
    },
  ]);
});

test("buildOpenAIChatAssistantMessage preserves assistant tool calls for the next turn", () => {
  assert.deepEqual(
    buildOpenAIChatAssistantMessage({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"package.json"}',
                },
              },
            ],
          },
        },
      ],
    }),
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"package.json"}',
          },
        },
      ],
    },
  );
});

test("updateOpenAIChatCompletionsStreamState emits and accumulates text deltas", () => {
  const state = createOpenAIChatCompletionsStreamState();
  const firstEvents = updateOpenAIChatCompletionsStreamState(state, {
    id: "chatcmpl_stream_123",
    choices: [
      {
        delta: {
          content: "hel",
        },
      },
    ],
  });
  const secondEvents = updateOpenAIChatCompletionsStreamState(state, {
    id: "chatcmpl_stream_123",
    choices: [
      {
        delta: {
          content: "lo",
        },
      },
    ],
  });

  assert.deepEqual([...firstEvents, ...secondEvents], [
    {
      type: "text_delta",
      delta: "hel",
    },
    {
      type: "text_delta",
      delta: "lo",
    },
  ]);
  updateOpenAIChatCompletionsStreamState(state, {
    usage: {
      prompt_tokens: 11,
      completion_tokens: 5,
      total_tokens: 16,
    },
    choices: [],
  });
  assert.deepEqual(parseOpenAIChatCompletionsResult(buildOpenAIChatCompletionsStreamResponse(state)), {
    content: "hello",
    responseId: "chatcmpl_stream_123",
    usage: {
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
    },
    toolCalls: [],
  });
});

test("updateOpenAIChatCompletionsStreamState accumulates streamed tool calls", () => {
  const state = createOpenAIChatCompletionsStreamState();

  assert.deepEqual(
    updateOpenAIChatCompletionsStreamState(state, {
      id: "chatcmpl_stream_tool",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_123",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path"',
                },
              },
            ],
          },
        },
      ],
    }),
    [],
  );
  updateOpenAIChatCompletionsStreamState(state, {
    id: "chatcmpl_stream_tool",
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: ':"package.json"}',
              },
            },
          ],
        },
      },
    ],
  });

  assert.deepEqual(parseOpenAIChatCompletionsResult(buildOpenAIChatCompletionsStreamResponse(state)), {
    content: "",
    responseId: "chatcmpl_stream_tool",
    toolCalls: [
      {
        callId: "call_123",
        name: "read_file",
        arguments: {
          path: "package.json",
        },
        rawArguments: '{"path":"package.json"}',
      },
    ],
  });
});

test("buildOpenAIResponsesStreamRequest enables streaming", () => {
  const request = buildOpenAIResponsesStreamRequest("gpt-test", {
    userMessage: "hello",
    tools: [
      {
        name: "read_file",
        description: "Read a file.",
        parameters: strictObjectSchema,
      },
    ],
  });

  assert.equal(request.stream, true);
  assert.equal(request.input, "hello");
  assert.equal(request.tools[0]?.type, "function");
});

test("buildOpenAIResponsesInput maps tool outputs to function_call_output items", () => {
  assert.deepEqual(
    buildOpenAIResponsesInput({
      tools: [],
      toolOutputs: [
        {
          callId: "call_123",
          output: '{"ok":true,"content":"done"}',
        },
      ],
    }),
    [
      {
        type: "function_call_output",
        call_id: "call_123",
        output: '{"ok":true,"content":"done"}',
      },
    ],
  );
});

test("parseOpenAIResponsesStreamEvent extracts text deltas and completed responses", () => {
  assert.deepEqual(
    parseOpenAIResponsesStreamEvent({
      type: "response.output_text.delta",
      delta: "hello",
    }),
    {
      type: "text_delta",
      delta: "hello",
    },
  );

  const response = {
    id: "resp_123",
    output_text: "done",
    output: [],
  };

  assert.deepEqual(
    parseOpenAIResponsesStreamEvent({
      type: "response.completed",
      response,
    }),
    {
      type: "completed",
      response,
    },
  );
});

test("parseOpenAIResponsesResult extracts function tool calls", () => {
  const result = parseOpenAIResponsesResult({
    id: "resp_123",
    output_text: "",
    output: [
      {
        type: "reasoning",
        summary: [],
      },
      {
        type: "function_call",
        call_id: "call_123",
        name: "read_file",
        arguments: '{"path":"package.json"}',
      },
    ],
    usage: {
      input_tokens: 24,
      output_tokens: 9,
      total_tokens: 33,
      input_tokens_details: {
        cached_tokens: 8,
      },
      output_tokens_details: {
        reasoning_tokens: 4,
      },
    },
  });

  assert.equal(result.responseId, "resp_123");
  assert.equal(result.content, "");
  assert.deepEqual(result.usage, {
    inputTokens: 24,
    outputTokens: 9,
    totalTokens: 33,
    cachedInputTokens: 8,
  });
  assert.deepEqual(result.toolCalls, [
    {
      callId: "call_123",
      name: "read_file",
      arguments: {
        path: "package.json",
      },
      rawArguments: '{"path":"package.json"}',
    },
  ]);
});

test("MockModelClient createTurnStream emits text deltas and returns final result", async () => {
  const model = new MockModelClient();
  const deltas: string[] = [];
  const result = await model.createTurnStream(
    {
      userMessage: "hello",
      tools: [],
    },
    (event) => {
      deltas.push(event.delta);
    },
  );

  assert.equal(result.content, "[mock model] You said: hello");
  assert.equal(deltas.join(""), result.content);
  assert.equal(result.usage?.estimated, true);
  assert.equal(typeof result.usage?.inputTokens, "number");
  assert.equal(typeof result.usage?.outputTokens, "number");
  assert.equal(result.usage?.totalTokens, (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0));
});

test("MockModelClient requests workspace_info for workspace summaries", async () => {
  const model = new MockModelClient();
  const workspaceInfoTool: ModelToolDefinition = {
    name: "workspace_info",
    description: "Summarize workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };

  const result = await model.createTurn({
    userMessage: "workspace summary",
    tools: [workspaceInfoTool],
  });

  assert.equal(result.content, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "workspace_info");
  assert.deepEqual(result.toolCalls[0]?.arguments, {});
});

test("MockModelClient requests suggest_context for context suggestions", async () => {
  const model = new MockModelClient();
  const suggestContextTool: ModelToolDefinition = {
    name: "suggest_context",
    description: "Suggest context.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };

  const result = await model.createTurn({
    userMessage: "suggest context provider smoke",
    tools: [suggestContextTool],
  });

  assert.equal(result.content, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "suggest_context");
  assert.deepEqual(result.toolCalls[0]?.arguments, { query: "provider smoke" });
});

test("parseOpenAIResponsesResult reports invalid tool arguments", () => {
  const result = parseOpenAIResponsesResult({
    id: "resp_123",
    output_text: "",
    output: [
      {
        type: "function_call",
        call_id: "call_123",
        name: "read_file",
        arguments: "not json",
      },
    ],
  });

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.arguments !== undefined, true);
  assert.match(result.toolCalls[0]?.parseError ?? "", /Unexpected token|not valid JSON/);
});

test("default tool schemas are compatible with strict OpenAI function calling", () => {
  for (const tool of createDefaultToolRegistry().list()) {
    assert.deepEqual(
      findStrictToolSchemaIssues(tool.name, tool.parameters),
      [],
      tool.name,
    );
  }
});

test("strict schema checker rejects optional undeclared object fields", () => {
  const issues = findStrictToolSchemaIssues("bad_tool", {
    type: "object",
    properties: {
      value: {
        type: "string",
      },
    },
    required: [],
    additionalProperties: true,
  });

  assert.match(issues.join("\n"), /additionalProperties/);
  assert.match(issues.join("\n"), /missing "value"/);
});
