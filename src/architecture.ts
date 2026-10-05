export const ARCHITECTURE_TOPIC_NAMES = [
  "overview",
  "loop",
  "model",
  "tools",
  "state",
  "evals",
  "sources",
  "exercises",
] as const;
export type ArchitectureTopicName = (typeof ARCHITECTURE_TOPIC_NAMES)[number];

export function formatArchitectureOverview(topic = ""): string {
  const normalized = normalizeArchitectureTopic(topic);

  if (normalized === "overview") {
    return formatOverview();
  }

  if (normalized === "loop") {
    return formatLoopTopic();
  }

  if (normalized === "model") {
    return formatModelTopic();
  }

  if (normalized === "tools") {
    return formatToolsTopic();
  }

  if (normalized === "state") {
    return formatStateTopic();
  }

  if (normalized === "evals") {
    return formatEvalsTopic();
  }

  if (normalized === "sources") {
    return formatSourcesTopic();
  }

  if (normalized === "exercises") {
    return formatExercisesTopic();
  }

  return [
    `Unknown architecture topic: ${topic}`,
    "",
    formatArchitectureUsage(),
  ].join("\n");
}

function formatOverview(): string {
  return [
    "CCAgent architecture",
    "",
    formatArchitectureUsage(),
    "",
    "Main flow:",
    "  CLI -> Agent -> ModelClient -> ToolRegistry -> Tools -> Renderer",
    "  Session, Plan, Audit, and Evals sit around that loop.",
    "",
    "One prompt lifecycle:",
    "  1. cli.ts parses flags, config, session, instructions, and slash commands.",
    "  2. Agent builds a model turn from user input, conversation, plan, and tools.",
    "  3. ModelClient returns text and optional tool calls.",
    "  4. Agent preflights each tool for risk, policy, and approval.",
    "  5. ToolRegistry finds the tool implementation and runs it in the workspace.",
    "  6. Tool output is appended back into the conversation.",
    "  7. The loop continues until the model returns a final answer.",
    "  8. Renderer prints terminal text or JSON Lines events.",
    "",
    "Core modules:",
    "  src/cli.ts                  CLI flags, interactive loop, slash commands.",
    "  src/agent.ts                Agent loop, tool execution, approvals, session snapshot.",
    "  src/model.ts                Mock client, OpenAI Responses, Chat Completions adapters.",
    "  src/tools/registry.ts       Tool registry and default tool list.",
    "  src/tools/*.ts              Individual workspace tools.",
    "  src/session.ts              Current session and named checkpoints.",
    "  src/conversation.ts         Conversation messages and compaction.",
    "  src/plan.ts                 In-memory task plan.",
    "  src/audit.ts                Tool/model/project-command logs and reports.",
    "  src/evals.ts                Offline mock-agent regression and benchmark checks.",
    "  src/retrievalEval.ts        Repository retrieval manifests, Recall@K, and MRR.",
    "  src/contextIndex.ts          Persistent lexical index and fused graph traversal.",
    "  src/moduleGraph.ts           Module resolution and lazy code-analysis orchestration.",
    "  src/typescriptReferences.ts  TypeScript AST and bounded TypeChecker symbol edges.",
    "  src/renderer.ts             Terminal and JSON Lines output.",
    "",
    "Two command paths:",
    "  Slash commands run locally and usually do not call the model.",
    "  Natural language prompts go through Agent -> ModelClient and may call tools.",
    "",
    "Learning order:",
    "  1. Read src/cli.ts handleInput for command routing.",
    "  2. Read src/agent.ts handleUserMessage for the agent loop.",
    "  3. Read src/model.ts MockModelClient before OpenAI clients.",
    "  4. Read src/tools/registry.ts, then one simple tool such as readFile.ts.",
    "  5. Read tests/evals.test.ts to see repeatable agent behavior checks.",
    "  6. Use /architecture sources for search commands and source landmarks.",
    "  7. Use /architecture exercises for small hands-on changes.",
  ].join("\n");
}

function formatLoopTopic(): string {
  return [
    "Architecture: agent loop",
    "",
    "Main files:",
    "  src/cli.ts",
    "  src/agent.ts",
    "  src/renderer.ts",
    "",
    "Flow:",
    "  1. cli.ts creates Runtime with config, instructions, session, renderer, and Agent.",
    "  2. handleInput routes slash commands locally before falling back to the model.",
    "  3. runUserPrompt sends natural language into Agent.handleUserMessage.",
    "  4. Agent calls ModelClient and receives text plus optional tool calls.",
    "  5. Tool results are appended and the loop repeats until the model stops calling tools.",
    "",
    "What to study first:",
    "  src/cli.ts handleInput",
    "  src/agent.ts handleUserMessage",
    "  src/agent.ts executeTool",
  ].join("\n");
}

function formatModelTopic(): string {
  return [
    "Architecture: model clients",
    "",
    "Main files:",
    "  src/model.ts",
    "  src/doctor.ts",
    "  tests/model.test.ts",
    "",
    "Clients:",
    "  MockModelClient keeps evals deterministic and works without an API key.",
    "  auth.ts stores an optional OpenAI API key in ~/.ccagent/auth.json; OPENAI_API_KEY env still wins.",
    "  config.ts merges ~/.ccagent/config.json user defaults under project .ccagent/config.json.",
    "  OpenAIModelClient uses /v1/responses.",
    "  OpenAIChatCompletionsModelClient uses /v1/chat/completions for relay providers.",
    "",
    "Important boundary:",
    "  ModelClient returns tool call requests. It does not execute tools.",
    "  Agent owns preflight, approval, execution, and feeding tool output back.",
  ].join("\n");
}

function formatToolsTopic(): string {
  return [
    "Architecture: tools",
    "",
    "Focus: Tool registry and tool execution.",
    "",
    "Main files:",
    "  src/tools/registry.ts",
    "  src/tools/types.ts",
    "  src/tools/readFile.ts",
    "  src/tools/workspaceInfo.ts",
    "  src/tools/suggestContext.ts",
    "  src/tools/applyPatch.ts",
    "",
    "Tool path:",
    "  1. Tool definitions are registered in createDefaultToolRegistry.",
    "  2. model.ts exposes those definitions as strict function schemas.",
    "  3. Agent preflights risk and policy before execution.",
    "  4. Tool implementation validates input and workspace boundaries.",
    "  5. Agent records audit events and returns the tool result to the model.",
    "",
    "Study order:",
    "  list_files/workspace_info/read_file first, then suggest_context/search_context_index/search_semantic_index/search_files, then apply_patch/reverse_patch.",
  ].join("\n");
}

function formatStateTopic(): string {
  return [
    "Architecture: state",
    "",
    "Main files:",
    "  src/session.ts",
    "  src/conversation.ts",
    "  src/plan.ts",
    "  src/terminalHistory.ts",
    "",
    "State layers:",
    "  Conversation stores model-facing messages.",
    "  Session persists conversation, plan, and checkpoints under .ccagent/sessions/.",
    "  Plan tracks task steps independently from the model text.",
    "  Terminal history stores local typed inputs for interactive recall.",
    "",
    "Important boundary:",
    "  Terminal input history is not model conversation history.",
  ].join("\n");
}

function formatEvalsTopic(): string {
  return [
    "Architecture: evals",
    "",
    "Main files:",
    "  src/evals.ts",
    "  scripts/evals-gate.mjs",
    "  tests/evals.test.ts",
    "  tests/evals-gate.test.ts",
    "",
    "Purpose:",
    "  Offline evals use MockModelClient and temporary workspaces.",
    "  Smoke evals check basic read/list/workspace-summary tool behavior.",
    "  Regression evals check plan and patch flows.",
    "  Benchmark evals repeat cases and average durations.",
    "  Reports and compare/gate commands make behavior drift visible.",
    "",
    "Useful commands:",
    "  npm run evals:smoke",
    "  npm run evals:report",
    "  npm run evals:gate",
  ].join("\n");
}

function formatSourcesTopic(): string {
  return [
    "Architecture: source landmarks",
    "",
    "Use these commands from the project root when you want to read the code path directly.",
    "",
    "Agent loop:",
    "  rg -n \"async function handleInput|async handleUserMessage|private async executeTool\" src/cli.ts src/agent.ts",
    "",
    "Model clients:",
    "  rg -n \"export interface ModelClient|class MockModelClient|class OpenAI.*ModelClient|createModelClient\" src/model.ts",
    "",
    "Tool registry and schemas:",
    "  rg -n \"createDefaultToolRegistry|class ToolRegistry|ToolDefinition|parameters\" src/tools src/model.ts",
    "",
    "State and session:",
    "  rg -n \"class SessionStore|compact|PlanState|terminal history\" src/session.ts src/conversation.ts src/plan.ts src/terminalHistory.ts",
    "",
    "Audit and evals:",
    "  rg -n \"model_turn|tool_start|runOfflineEvals|compareOfflineEvalReports\" src/audit.ts src/evals.ts",
    "",
    "Useful reading pattern:",
    "  1. Find the symbol with rg.",
    "  2. Read the tests around that behavior.",
    "  3. Run the matching command in CCAgent.",
    "  4. Change one small thing and run npm run check.",
  ].join("\n");
}

function formatExercisesTopic(): string {
  return [
    "Architecture: learning exercises",
    "",
    "Use these as small, safe changes when learning how agent systems are built.",
    "",
    "Exercise 1: trace a local slash command",
    "  Goal: follow /hello from CLI routing to completion, help, docs, and tests.",
    "  Try: ccagent --no-session /hello",
    "  Files: src/cli.ts, src/completion.ts, src/help.ts, tests/cli.test.ts, tests/completion.test.ts, tests/help.test.ts, README.md.",
    "  Verify: npm run build && node --import tsx --test tests/cli.test.ts tests/completion.test.ts tests/help.test.ts",
    "",
    "Exercise 2: trace a read-only tool",
    "  Goal: follow workspace_info from the tool registry to the agent output.",
    "  Files: src/tools/workspaceInfo.ts, src/tools/suggestContext.ts, src/tools/registry.ts, src/preflight.ts, src/completion.ts, src/help.ts, tests/tools.test.ts, tests/preflight.test.ts, tests/completion.test.ts.",
    "  Verify: npm run build && node --import tsx --test tests/tools.test.ts tests/preflight.test.ts tests/completion.test.ts",
    "",
    "Exercise 3: add one eval case",
    "  Goal: make the mock agent prove the new behavior keeps working.",
    "  Files: src/evals.ts, tests/evals.test.ts.",
    "  Verify: npm run evals:smoke or npm run evals:regression.",
    "",
    "Exercise 4: inspect one real loop",
    "  Goal: run one prompt, then inspect audit and model trace output.",
    "  Commands:",
    "    ccagent --no-session \"list files\"",
    "    ccagent --no-session /audit",
    "    ccagent --no-session /model-trace",
    "",
    "Rule for learning changes:",
    "  Change one module at a time, add one focused test, then run npm run check.",
  ].join("\n");
}

function formatArchitectureUsage(): string {
  return "Usage: /architecture [overview|loop|model|tools|state|evals|sources|exercises]";
}

function normalizeArchitectureTopic(topic: string): ArchitectureTopicName | null {
  const normalized = topic.trim().toLowerCase();

  if (!normalized || normalized === "main") {
    return "overview";
  }

  if (normalized === "agent") {
    return "loop";
  }

  if (normalized === "models" || normalized === "provider") {
    return "model";
  }

  if (normalized === "tool") {
    return "tools";
  }

  if (normalized === "session" || normalized === "sessions" || normalized === "plan") {
    return "state";
  }

  if (normalized === "eval" || normalized === "evaluation") {
    return "evals";
  }

  if (normalized === "source" || normalized === "landmarks" || normalized === "map") {
    return "sources";
  }

  if (normalized === "exercise" || normalized === "tasks" || normalized === "practice") {
    return "exercises";
  }

  return (ARCHITECTURE_TOPIC_NAMES as readonly string[]).includes(normalized)
    ? normalized as ArchitectureTopicName
    : null;
}
