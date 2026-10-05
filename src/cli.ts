import { createInterface, type Interface } from "node:readline/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stdin as input, stderr, stdout as output } from "node:process";
import { CLI_VERSION, formatCliUsage, parseCliArgs } from "./args.js";
import {
  clearStoredApiKey,
  loadApiKeyStatus,
  loadStoredApiKey,
  storeApiKey,
  type ApiKeySource,
  type ApiKeyStatus,
} from "./auth.js";
import {
  describeShellSandbox,
  resolveShellSandbox,
  type ShellSandboxSettings,
} from "./sandbox.js";
import {
  applyProviderProfile,
  formatProviderProfileApplication,
} from "./providerProfiles.js";
import { formatArchitectureOverview } from "./architecture.js";
import { findRepairTask, listRepairTaskNames, REPAIR_TASKS, type RepairTask } from "./repairTasks.js";
import {
  buildBootGreeting,
  getMascotTheme,
  LOGO_COLS,
  MIN_SPLASH_COLUMNS,
  renderBootSplash,
} from "./mascot.js";
import {
  exportAuditData,
  exportAuditReport,
  FileAuditLogger,
  formatAuditCall,
  formatAuditReplay,
  formatAuditSummary,
  formatAuditTimeline,
  formatModelTrace,
  formatProjectCommandHistory,
  formatProjectCommandStats,
  formatRecentToolAudit,
  formatUsageModels,
  formatUsageSummary,
  type AuditLogger,
  type ProjectCommandAuditEventInput,
} from "./audit.js";
import { Agent, type ToolApprovalRequest } from "./agent.js";
import {
  expandProjectCommand,
  formatExpandedProjectCommand,
  formatProjectCommandDetails,
  formatProjectCommandError,
  formatProjectCommandsCheck,
  formatProjectCommands,
  initProjectCommand,
  isValidProjectCommandName,
  loadProjectCommands,
  readProjectCommand,
  validateProjectCommandArgs,
  type ParsedProjectCommandArgs,
  type ProjectCommand,
} from "./commands.js";
import { buildCodeMap, exportCodeMapReport, formatCodeMap } from "./codeMap.js";
import {
  completeInteractiveInputWithWorkspace,
  completeSlashCommandHints,
} from "./completion.js";
import {
  addMcpServer,
  formatConfigGetResult,
  formatConfigSetResult,
  formatConfigUnsetResult,
  formatUserConfigGetResult,
  formatUserConfigSetResult,
  formatUserConfigUnsetResult,
  formatLoadedConfig,
  formatMcpConfigResult,
  formatPermissions,
  getConfigValue,
  getUserConfigValue,
  initConfig,
  isAutoApprovedShellCommand,
  loadConfig,
  loadUserConfig,
  mergeUserDefaults,
  removeMcpServer,
  setConfigValue,
  setMcpEnabled,
  setUserConfigValue,
  unsetConfigValue,
  unsetUserConfigValue,
  type LoadedConfig,
  type LoadedUserConfig,
} from "./config.js";
import { formatRuntimeContext } from "./context.js";
import { createDebugLogger, isDebugEnvEnabled, type DebugLogger } from "./debug.js";
import { exportDiagnosticsReport, formatDiagnosticsReportResult } from "./diagnostics.js";
import {
  formatDoctorReport,
  resolveOpenAIApiMode,
  resolveOpenAIBaseURL,
  resolveOpenAIModel,
  runDoctor,
} from "./doctor.js";
import {
  formatMcpPromptResult,
  formatMcpPrompts,
  formatMcpResourceReadResult,
  formatMcpResourceTemplates,
  formatMcpResources,
  formatMcpReloadResult,
  formatMcpStatus,
  formatMcpTools,
  loadMcpTools,
  parseMcpCommand,
  type McpToolLoadResult,
} from "./mcp.js";
import {
  compareOfflineEvalReports,
  compareOfflineEvalReportsForGate,
  exportOfflineEvalsReport,
  formatOfflineEvalCase,
  formatOfflineEvalCases,
  formatOfflineEvalCasesJson,
  formatOfflineEvalCaseJson,
  formatOfflineEvalBaseline,
  formatOfflineEvalTags,
  formatOfflineEvalTagsJson,
  formatOfflineEvals,
  formatOfflineEvalsJson,
  formatOfflineEvalReportComparison,
  formatOfflineEvalReportComparisonJson,
  formatOfflineEvalReports,
  formatOfflineEvalReportsJson,
  formatOfflineEvalsReport,
  formatOfflineEvalsReportJson,
  listOfflineEvalCases,
  listOfflineEvalReports,
  listOfflineEvalTags,
  OFFLINE_EVAL_CASE_NAMES,
  OFFLINE_EVAL_CASE_TAG_NAMES,
  OFFLINE_EVAL_SUITE_NAMES,
  runOfflineEvalCase,
  runOfflineEvals,
  saveOfflineEvalBaseline,
  type OfflineEvalCaseName,
  type OfflineEvalCaseTag,
  type OfflineEvalSuiteName,
} from "./evals.js";
import { formatCompletionHelp, formatHelp, formatHelpTopic } from "./help.js";
import {
  formatProjectInstructions,
  initProjectInstructions,
  loadProjectInstructions,
  type LoadedProjectInstructions,
} from "./instructions.js";
import {
  formatProjectSkill,
  formatProjectSkills,
  initProjectSkill,
  loadProjectSkills,
  readProjectSkill,
  type LoadedProjectSkills,
} from "./skills.js";
import {
  buildSystemPrompt,
  createModelClient,
  formatProviderRetryConfig,
  type ModelClient,
  type ModelResult,
  type ModelToolDefinition,
  type ModelUsage,
} from "./model.js";
import { formatEffectiveSystemPrompt } from "./prompt.js";
import {
  buildProviderSmokeCompatibilityProfile,
  diagnoseProviderSmoke,
  formatProviderCompatibilityMatrix,
  formatProviderSmokeCompatibilityProfile,
  formatProviderSmokeDiagnosis,
  type ProviderSmokeDiagnosis,
  type ProviderSmokeCompatibilityProfile,
} from "./providers.js";
import { formatProjectRoadmap } from "./roadmap.js";
import {
  createJsonLinesRenderer,
  createTerminalRenderer,
  type OutputRenderer,
} from "./renderer.js";
import {
  createDefaultRichTheme,
  createRichRenderer,
} from "./richRenderer.js";
import {
  CHECKPOINT_LOAD_BACKUP_PREFIX,
  formatLoadedSession,
  formatSessionCheckpointBackups,
  formatSessionCheckpointDiff,
  formatSessionCheckpointNameRules,
  formatSessionCheckpointDetails,
  formatSessionCheckpoints,
  formatSessionDetails,
  formatSessionSearch,
  formatSessionStats,
  isValidSessionCheckpointName,
  SessionStore,
} from "./session.js";
import { createDefaultToolRegistry, type ToolRegistry } from "./tools/registry.js";
import {
  addTerminalHistoryEntry,
  clearTerminalHistory,
  formatTerminalHistory,
  loadTerminalHistory,
  saveTerminalHistory,
  TERMINAL_HISTORY_LIMIT,
  type TerminalHistoryState,
} from "./terminalHistory.js";

class LineReader {
  private readonly iterator: AsyncIterator<string>;
  private pinnedHistory: string[] | null = null;

  constructor(
    private readonly rl: Interface,
    private readonly outputStream: typeof output,
    private readonly inputStream: NodeJS.ReadableStream = input,
    onInterrupt: (() => void) | null = null,
  ) {
    this.iterator = rl[Symbol.asyncIterator]();

    if (onInterrupt) {
      rl.on("SIGINT", onInterrupt);
    }
  }

  async read(
    prompt: string,
    options: {
      keepReadlineHistory?: boolean;
      onInput?: (line: string) => void | Promise<void>;
      promptLine?: (prompt: string) => void | Promise<void>;
    } = {},
  ): Promise<string | null> {
    this.rl.setPrompt(prompt);

    const stopListeningForInput =
      options.onInput !== undefined
        ? (() => {
            const listener = () => {
              void Promise.resolve(options.onInput?.(this.rl.line)).catch(() => undefined);
            };

            this.inputStream.on("keypress", listener);

            return () => {
              this.inputStream.removeListener("keypress", listener);
            };
          })()
        : () => undefined;

    if (options.promptLine) {
      await options.promptLine(prompt);
    } else {
      this.outputStream.write(prompt);
    }

    try {
      const next = await this.iterator.next();

      if (next.done) {
        return null;
      }

      if (!options.keepReadlineHistory && this.pinnedHistory) {
        this.setHistory(this.pinnedHistory);
      }

      return next.value;
    } finally {
      stopListeningForInput();
    }
  }

  setHistory(entries: string[]): void {
    this.pinnedHistory = [...entries];

    const rlWithHistory = this.rl as Interface & { history?: string[] };

    if (Array.isArray(rlWithHistory.history)) {
      rlWithHistory.history.splice(0, rlWithHistory.history.length, ...entries);
    }
  }

  close(): void {
    this.rl.close();
  }
}

type Runtime = {
  agent: Agent;
  allowEdits: boolean;
  apiKeyStatus: ApiKeyStatus;
  auditLogger: AuditLogger;
  debug: DebugLogger;
  loadedConfig: LoadedConfig;
  mcp: McpToolLoadResult;
  json: boolean;
  openAIApiKey?: string;
  renderer: OutputRenderer;
  reader: LineReader;
  sessionStore: SessionStore | null;
  sessionCreatedAt: string | null;
  terminalHistory: TerminalHistoryState | null;
  toolRegistry: ToolRegistry;
  projectInstructions: LoadedProjectInstructions;
  rich: boolean;
  stream: boolean;
  userConfig: LoadedUserConfig;
  useSession: boolean;
  verifyCommand?: string;
  turnController: AbortController | null;
  shellSandbox: ShellSandboxSettings;
};

type HandleResult = {
  shouldExit: boolean;
  shouldResetSessionCreatedAt: boolean;
};

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function startCli(argv: string[] = []): Promise<void> {
  const args = parseCliArgs(argv);
  const debug = createDebugLogger(args.verbose || isDebugEnvEnabled(process.env.CCAGENT_DEBUG), (line) =>
    stderr.write(`${line}\n`),
  );
  const rich =
    args.mode === "interactive" &&
    !args.json &&
    !args.plain &&
    output.isTTY === true;
  debug("cli.start", {
    mode: args.mode,
    allowEdits: args.allowEdits,
    json: args.json,
    plain: args.plain,
    sandbox: args.sandbox,
    rich,
    stream: args.stream,
    useSession: args.useSession,
    verifyCommand: args.verifyCommand ?? null,
    verbose: args.verbose,
  });

  if (args.mode === "help") {
    await createModeRenderer(args.json).writeFinalResponse({
      content: `${formatCliUsage()}\n\n${formatHelp()}`,
    });
    return;
  }

  if (args.mode === "version") {
    await createModeRenderer(args.json).writeFinalResponse({
      content: `ccagent ${CLI_VERSION}`,
    });
    return;
  }

  if (args.mode === "init") {
    const result = await initConfig(process.cwd());
    const renderer = createModeRenderer(args.json);

    if (result.created) {
      await renderer.writeFinalResponse({ content: `Created config: ${result.path}` });
    } else {
      await renderer.writeFinalResponse({ content: `${result.reason} Path: ${result.path}` });
    }

    return;
  }

  if (args.mode === "initInstructions") {
    const result = await initProjectInstructions(process.cwd());
    const renderer = createModeRenderer(args.json);

    if (result.created) {
      await renderer.writeFinalResponse({ content: `Created instructions: ${result.path}` });
    } else {
      await renderer.writeFinalResponse({ content: `${result.reason} Path: ${result.path}` });
    }

    return;
  }

  if (args.mode === "initCommand") {
    const result = await initProjectCommand(process.cwd(), args.name);
    const renderer = createModeRenderer(args.json);

    if (result.created) {
      await renderer.writeFinalResponse({ content: `Created project command: ${result.path}` });
    } else {
      await renderer.writeFinalResponse({ content: `${result.reason} Path: ${result.path}` });
    }

    return;
  }

  if (args.mode === "initSkill") {
    const result = await initProjectSkill(process.cwd(), args.name);
    const renderer = createModeRenderer(args.json);

    if (result.created) {
      await renderer.writeFinalResponse({ content: `Created project skill: ${result.path}` });
    } else {
      await renderer.writeFinalResponse({ content: `${result.reason} Path: ${result.path}` });
    }

    return;
  }

  if (args.mode === "doctor") {
    await createModeRenderer(args.json).writeFinalResponse({
      content: formatDoctorReport(await runDoctor(process.cwd())),
    });
    return;
  }

  if (args.mode === "provider") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatProviderProfileApplication(
          await applyProviderProfile(args.providerId),
        ),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `Provider profile update failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "providerError") {
    await createModeRenderer(args.json).writeFinalResponse({
      content: args.message,
    });
    return;
  }

  if (args.mode === "login") {
    const renderer = createModeRenderer(args.json);

    try {
      let apiKey = args.apiKey?.trim() ?? "";

      if (!apiKey && !process.stdin.isTTY) {
        apiKey = (await readAllStdin()).trim();
      }

      if (apiKey) {
        const result = await storeApiKey(apiKey);
        const action = result.action === "stored" ? "Stored" : "Updated";

        await renderer.writeFinalResponse({
          content: `Logged in.\n${action} auth file: ${result.authPath} (the key value is never printed).`,
        });
      } else {
        const status = await loadApiKeyStatus();

        if (status.source === "auth-file") {
          await renderer.writeFinalResponse({
            content: `Already logged in.\nAuth file: ${status.authPath}\nOverwrite with "ccagent login --api-key <key>". Remove it with "ccagent logout".`,
          });
        } else {
          await renderer.writeFinalResponse({
            content: [
              "No API key stored.",
              `Auth file: ${status.authPath}`,
              "Configure one with:",
              "  ccagent login --api-key <key>",
              "  ccagent login < key.txt   (read the key from stdin)",
              "Priority: OPENAI_API_KEY env > stored auth.json key > mock model.",
            ].join("\n"),
          });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `Login failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "logout") {
    const renderer = createModeRenderer(args.json);

    try {
      const result = await clearStoredApiKey();

      await renderer.writeFinalResponse({
        content: result.removed
          ? `Logged out.\nRemoved auth file: ${result.authPath}`
          : `Not logged in.\nAuth file: ${result.authPath}`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `Logout failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "configSet") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatConfigSetResult(await setConfigValue(process.cwd(), args.key, args.value)),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `Config update failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "configGet") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatConfigGetResult(await getConfigValue(process.cwd(), args.key)),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `Config read failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "configUnset") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatConfigUnsetResult(await unsetConfigValue(process.cwd(), args.key)),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `Config update failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "userConfigSet") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatUserConfigSetResult(await setUserConfigValue(args.key, args.value)),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `User config update failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "userConfigGet") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatUserConfigGetResult(await getUserConfigValue(args.key)),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `User config read failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "userConfigUnset") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatUserConfigUnsetResult(await unsetUserConfigValue(args.key)),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({
        content: `User config update failed: ${reason}`,
      });
    }

    return;
  }

  if (args.mode === "mcpAdd") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatMcpConfigResult(await addMcpServer(
          process.cwd(),
          args.name,
          args.command,
          args.args,
        )),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({ content: `MCP configuration failed: ${reason}` });
    }

    return;
  }

  if (args.mode === "mcpRemove") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatMcpConfigResult(await removeMcpServer(process.cwd(), args.name)),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({ content: `MCP configuration failed: ${reason}` });
    }

    return;
  }

  if (args.mode === "mcpEnable" || args.mode === "mcpDisable") {
    const renderer = createModeRenderer(args.json);

    try {
      await renderer.writeFinalResponse({
        content: formatMcpConfigResult(await setMcpEnabled(
          process.cwd(),
          args.mode === "mcpEnable",
        )),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      await renderer.writeFinalResponse({ content: `MCP configuration failed: ${reason}` });
    }

    return;
  }

  let runtime: Runtime | undefined;
  const terminalHistory = args.useSession ? await loadTerminalHistory(process.cwd()) : null;
  let lastSigintAt = 0;
  let sigintExiting = false;
  const handleSigint = (): void => {
    const now = Date.now();

    if (now - lastSigintAt < 100) {
      return;
    }

    lastSigintAt = now;

    const controller = runtime?.turnController;

    if (controller && !controller.signal.aborted) {
      controller.abort();
      return;
    }

    if (!runtime || sigintExiting) {
      return;
    }

    sigintExiting = true;
    void runtime.renderer.writeMessage("Bye.");
    reader.close();
  };
  const rl = createInterface({
    input,
    output,
    ...(args.mode === "interactive"
      ? {
          completer: async (line: string) =>
            completeInteractiveInputWithWorkspace(line, {
              checkpointNames: args.useSession
                ? await loadCheckpointCompletionNames(process.cwd())
                : [],
              projectCommands: (await loadProjectCommands(process.cwd())).commands,
              skillNames: (await loadProjectSkills(process.cwd())).skills.map((skill) => skill.name),
              toolNames: runtime?.toolRegistry.list().map((tool) => tool.name) ?? [],
              workspaceRoot: process.cwd(),
            }),
        }
      : {}),
    ...(args.mode === "interactive" && terminalHistory
      ? {
          history: terminalHistory.entries,
          historySize: TERMINAL_HISTORY_LIMIT,
          removeHistoryDuplicates: true,
        }
      : {}),
  });
  const reader = new LineReader(
    rl,
    output,
    input,
    args.mode === "interactive" ? handleSigint : null,
  );

  if (args.mode === "interactive") {
    process.on("SIGINT", handleSigint);
  }

  if (args.mode === "interactive" && terminalHistory) {
    reader.setHistory(terminalHistory.entries);
  }

  let closed = false;

  rl.on("close", () => {
    closed = true;
  });

  try {
    runtime = await createRuntime(
      reader,
      args.useSession,
      args.allowEdits,
      args.sandbox,
      args.stream,
      args.json,
      rich,
      args.verifyCommand,
      debug,
      terminalHistory,
    );

    if (args.mode === "prompt") {
      await runOneShotPrompt(runtime, args.prompt);
      return;
    }

    await runInteractive(runtime, reader);
  } finally {
    await runtime?.mcp.manager.close();

    if (!closed) {
      reader.close();
    }
  }
}

async function createRuntime(
  reader: LineReader,
  useSession: boolean,
  allowEdits: boolean,
  sandbox: boolean | string,
  stream: boolean,
  json: boolean,
  rich: boolean,
  verifyCommand: string | undefined,
  debug: DebugLogger,
  terminalHistory: TerminalHistoryState | null,
): Promise<Runtime> {
  const workspaceRoot = process.cwd();
  debug("runtime.create", {
    workspaceRoot,
    allowEdits,
    json,
    rich,
    sandbox,
    stream,
    useSession,
    verifyCommand: verifyCommand ?? null,
  });
  const loadedConfig = await loadConfig(workspaceRoot);
  const userConfig = await loadUserConfig();
  const apiKeyStatus = await loadApiKeyStatus();
  const storedApiKey = apiKeyStatus.source === "auth-file" ? await loadStoredApiKey() : undefined;
  const mergedConfig = mergeUserDefaults(loadedConfig.config, userConfig.config);
  const sandboxWarnings: string[] = [];
  const shellSandbox = resolveShellSandbox(
    {
      cli: typeof sandbox === "string" ? sandbox : sandbox ? "docker" : undefined,
      env: process.env.CCAGENT_SANDBOX,
      config: {
        mode: mergedConfig.toolPolicy?.shellSandbox,
        image: mergedConfig.toolPolicy?.shellSandboxImage,
        network: mergedConfig.toolPolicy?.shellSandboxNetwork,
        readOnly: mergedConfig.toolPolicy?.shellSandboxReadOnly,
        memoryMb: mergedConfig.toolPolicy?.shellSandboxMemoryMb,
        cpus: mergedConfig.toolPolicy?.shellSandboxCpus,
        pidsLimit: mergedConfig.toolPolicy?.shellSandboxPidsLimit,
      },
    },
    sandboxWarnings,
  );
  const projectInstructions = await loadProjectInstructions(workspaceRoot);
  const renderer = createModeRenderer(json, rich);
  const sessionStore = useSession ? new SessionStore(workspaceRoot) : null;
  const auditLogger = new FileAuditLogger(workspaceRoot);
  const localTools = createDefaultToolRegistry();
  const mcp = await loadMcpTools(
    loadedConfig.config.mcp,
    workspaceRoot,
    localTools.list().map((tool) => tool.name),
  );
  const tools = createDefaultToolRegistry(
    {
      executionGuard: mergedConfig.toolPolicy?.executionGuard,
      shellSandbox,
    },
    mcp.tools,
  );
  const agent = new Agent(
    createModelClient({
      model: mergedConfig.model,
      openAIApiKey: storedApiKey,
      openAIApiMode: mergedConfig.openai?.apiMode,
      openAIBaseURL: mergedConfig.openai?.baseURL,
      providerRetry: mergedConfig.openai?.retry,
      projectInstructions: projectInstructions.content,
    }),
    tools,
    workspaceRoot,
    async (request) =>
      confirmToolExecution(reader, request, loadedConfig, allowEdits, stream, json, rich, debug, renderer),
    debug,
    verifyCommand,
    {
      allowWritePaths: loadedConfig.config.toolPolicy?.allowWritePaths,
      denyWritePaths: loadedConfig.config.toolPolicy?.denyWritePaths,
      denyRiskLevels: loadedConfig.config.toolPolicy?.denyRisk,
      denyTools: loadedConfig.config.toolPolicy?.deny,
      requireApprovalRiskLevels: loadedConfig.config.toolPolicy?.requireApprovalRisk,
      requireApprovalTools: loadedConfig.config.toolPolicy?.requireApproval,
    },
    auditLogger,
    {
      enabled: loadedConfig.config.context?.auto ?? true,
    },
  );
  const loadedSession = sessionStore ? await sessionStore.load(agent.modelName) : null;

  if (loadedSession) {
    agent.loadSession(loadedSession.session);
  }

  for (const warning of loadedConfig.warnings) {
    await renderer.writeMessage(`Config warning: ${warning}`);
  }

  for (const warning of userConfig.warnings) {
    await renderer.writeMessage(`User config warning: ${warning}`);
  }

  for (const warning of sandboxWarnings) {
    await renderer.writeMessage(`Sandbox warning: ${warning}`);
  }

  for (const warning of mcp.warnings) {
    await renderer.writeMessage(`MCP warning: ${warning}`);
  }

  for (const warning of projectInstructions.warnings) {
    await renderer.writeMessage(`Instructions warning: ${warning}`);
  }

  if (loadedSession) {
    for (const warning of loadedSession.warnings) {
      await renderer.writeMessage(`Session warning: ${warning}`);
    }
  }

  if (terminalHistory) {
    for (const warning of terminalHistory.warnings) {
      await renderer.writeMessage(`Terminal history warning: ${warning}`);
    }
  }

  return {
    agent,
    allowEdits,
    apiKeyStatus,
    auditLogger,
    debug,
    json,
    loadedConfig,
    mcp,
    openAIApiKey: storedApiKey,
    projectInstructions,
    reader,
    renderer,
    rich,
    sessionStore,
    sessionCreatedAt: loadedSession?.session.createdAt ?? null,
    terminalHistory,
    toolRegistry: tools,
    turnController: null,
    stream,
    userConfig,
    useSession,
    verifyCommand,
    shellSandbox,
  };
}

async function reloadMcpRuntime(runtime: Runtime, json: boolean): Promise<string> {
  const workspaceRoot = process.cwd();
  const reloadedConfig = await loadConfig(workspaceRoot);
  const localTools = createDefaultToolRegistry({
    executionGuard: reloadedConfig.config.toolPolicy?.executionGuard,
    shellSandbox: runtime.shellSandbox,
  });
  const reservedToolNames = localTools.list().map((tool) => tool.name);

  await runtime.mcp.manager.close();
  runtime.toolRegistry.replace(localTools.list());

  if (reloadedConfig.config.mcp) {
    runtime.loadedConfig.config.mcp = reloadedConfig.config.mcp;
  } else {
    delete runtime.loadedConfig.config.mcp;
  }

  runtime.loadedConfig.exists = reloadedConfig.exists;
  runtime.loadedConfig.warnings = reloadedConfig.warnings;

  try {
    const mcp = await loadMcpTools(
      reloadedConfig.config.mcp,
      workspaceRoot,
      reservedToolNames,
    );

    runtime.toolRegistry.replace([...localTools.list(), ...mcp.tools]);
    runtime.mcp = mcp;

    return formatMcpReloadResult(
      mcp,
      reloadedConfig.config.mcp?.enabled === true,
      reloadedConfig.warnings,
      json,
    );
  } catch (error) {
    runtime.mcp = await loadMcpTools(undefined, workspaceRoot, reservedToolNames);
    const reason = error instanceof Error ? error.message : String(error);

    return json
      ? JSON.stringify({
          error: reason,
          reloaded: false,
          toolCount: runtime.agent.toolCount,
        }, null, 2)
      : [
          `MCP reload failed: ${reason}`,
          "Built-in tools remain available; no MCP tools are registered.",
        ].join("\n");
  }
}

async function runOneShotPrompt(runtime: Runtime, prompt: string): Promise<void> {
  const result = await handleInput(runtime, prompt);

  if (result.shouldResetSessionCreatedAt) {
    runtime.sessionCreatedAt = new Date().toISOString();
    await saveCurrentSession(runtime);
  }
}

const DEFAULT_PROMPT_HINTS = ["/help", "/model", "/config", "/usage-summary", "/session", "/mcp"];

function resolvePromptHints(runtime: Runtime): string[] {
  const merged = mergeUserDefaults(runtime.loadedConfig.config, runtime.userConfig.config);
  return merged.ui?.promptHints ?? DEFAULT_PROMPT_HINTS;
}

async function runInteractive(runtime: Runtime, reader: LineReader): Promise<void> {
  await writeBootSplash(runtime);

  const sandboxTag =
    runtime.shellSandbox.mode !== "off"
      ? `, ${describeShellSandbox(runtime.shellSandbox)}`
      : "";
  const banner =
    `CCAgent started (${runtime.agent.modelName}${sandboxTag}). Type "/help" for commands, "exit" to quit.`;

  if (runtime.renderer.writeBanner) {
    await runtime.renderer.writeBanner(banner);
  } else {
    await runtime.renderer.writeMessage(banner);
  }

  while (true) {
    const hints = resolvePromptHints(runtime);

    if (runtime.renderer.writePromptStatus) {
      await runtime.renderer.writePromptStatus({
        allowEdits: runtime.allowEdits,
        modelName: runtime.agent.modelName,
        local: !runtime.apiKeyStatus.set,
        sandbox:
          runtime.shellSandbox.mode !== "off"
            ? describeShellSandbox(runtime.shellSandbox)
            : undefined,
        useSession: runtime.useSession,
        hints,
      });
    }

    const message = await reader.read("CCAgent > ", {
      promptLine: runtime.renderer.writePromptLine?.bind(runtime.renderer),
      onInput: (line) => {
        const matches = completeSlashCommandHints(line.trimStart());
        runtime.renderer.redrawHints?.(matches.length > 0 ? matches : hints);
      },
    });

    if (message === null) {
      break;
    }

    runtime.turnController = new AbortController();

    let result: HandleResult;

    try {
      result = await handleInput(runtime, message, runtime.turnController.signal);
    } finally {
      runtime.turnController = null;
    }

    await recordTerminalHistoryInput(runtime, message);

    if (result.shouldExit) {
      break;
    }

    if (result.shouldResetSessionCreatedAt) {
      runtime.sessionCreatedAt = new Date().toISOString();
      await saveCurrentSession(runtime);
    }
  }
}

const SPLASH_FRAME_MS = 90;
const SPLASH_REVEAL_STEPS = [0, 0.25, 0.5, 0.75, 1];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeBootSplash(runtime: Runtime): Promise<void> {
  if (!runtime.rich || process.env.CCAGENT_NO_SPLASH === "1") {
    return;
  }

  const columns = Math.min(120, typeof output.columns === "number" ? output.columns : 80);

  if (columns < MIN_SPLASH_COLUMNS) {
    await runtime.renderer.writeMessage(buildBootGreeting({ version: CLI_VERSION }));
    return;
  }

  const theme = getMascotTheme();
  const fullSplash = renderBootSplash({ columns, version: CLI_VERSION, color: true, theme });
  const revealColumns = SPLASH_REVEAL_STEPS.map((step) => Math.round(LOGO_COLS * step));

  for (let frame = 0; frame < revealColumns.length; frame += 1) {
    const lines =
      frame === revealColumns.length - 1
        ? fullSplash
        : renderBootSplash({
            columns,
            version: CLI_VERSION,
            color: true,
            theme,
            revealColumns: revealColumns[frame]!,
          });

    if (frame > 0) {
      output.write(`\x1b[${fullSplash.length}A`);
    }

    for (const line of lines) {
      output.write(`\r\x1b[2K${line}\n`);
    }

    if (frame < revealColumns.length - 1) {
      await delay(SPLASH_FRAME_MS);
    }
  }

  output.write("\n");
}

async function handleInput(
  runtime: Runtime,
  message: string,
  signal?: AbortSignal,
): Promise<HandleResult> {
  const trimmed = message.trim();

  if (trimmed === "exit" || trimmed === "quit") {
    await runtime.renderer.writeMessage("Bye.");
    return {
      shouldExit: true,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed.length === 0) {
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/help" || trimmed.startsWith("/help ")) {
    await runtime.renderer.writeFinalResponse({
      content: formatHelpTopic(trimmed.slice("/help".length).trim()),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/completion" || trimmed === "/keys") {
    await runtime.renderer.writeFinalResponse({
      content: formatCompletionHelp(),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/hello") {
    await runtime.renderer.writeFinalResponse({
      content: "Hello from CCAgent. This command runs locally and does not call the model.",
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  const architectureTopic = parseArchitectureCommand(trimmed);

  if (architectureTopic !== null) {
    await runtime.renderer.writeFinalResponse({
      content: formatArchitectureOverview(architectureTopic),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/config") {
    await runtime.renderer.writeFinalResponse({
      content: formatLoadedConfig(runtime.loadedConfig),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/model" || trimmed === "/models") {
    await runtime.renderer.writeFinalResponse({
      content: formatRuntimeModelInfo(runtime),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/model-smoke" || trimmed.startsWith("/model-smoke ")) {
    await runtime.renderer.writeFinalResponse({
      content: await runModelSmoke(runtime, trimmed.slice("/model-smoke".length).trim()),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/provider-smoke" || trimmed.startsWith("/provider-smoke ")) {
    await runtime.renderer.writeFinalResponse({
      content: await runProviderSmoke(runtime, trimmed.slice("/provider-smoke".length).trim()),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/provider-repair" || trimmed.startsWith("/provider-repair ")) {
    await runtime.renderer.writeFinalResponse({
      content: await runProviderRepairBenchmark(runtime, trimmed.slice("/provider-repair".length).trim()),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/provider-repair-reports" || trimmed.startsWith("/provider-repair-reports ")) {
    const parsed = parseProviderReportsRequest(
      trimmed.slice("/provider-repair-reports".length).trim(),
      "/provider-repair-reports",
    );

    await runtime.renderer.writeFinalResponse({
      content: !parsed.ok
        ? parsed.error
        : parsed.json
          ? formatProviderRepairReportsJson(await listProviderRepairReports(process.cwd(), parsed.limit))
          : formatProviderRepairReports(await listProviderRepairReports(process.cwd(), parsed.limit)),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (
    trimmed === "/provider-repair-compare" ||
    trimmed.startsWith("/provider-repair-compare ") ||
    trimmed === "/provider-repair-gate" ||
    trimmed.startsWith("/provider-repair-gate ")
  ) {
    const gate = trimmed === "/provider-repair-gate" || trimmed.startsWith("/provider-repair-gate ");
    const commandName = gate ? "/provider-repair-gate" : "/provider-repair-compare";
    const parsed = parseProviderCompareRequest(
      trimmed.slice(commandName.length).trim(),
      commandName,
    );
    const comparison = parsed.ok
      ? await compareProviderRepairReports(process.cwd(), parsed.leftName, parsed.rightName)
      : {
          error: parsed.error,
          ok: false as const,
        };

    await runtime.renderer.writeFinalResponse({
      content: parsed.json
        ? formatProviderRepairComparisonJson(comparison)
        : formatProviderRepairComparison(comparison),
    });
    if (gate && ("error" in comparison || comparison.status === "regressed")) {
      process.exitCode = 1;
    }
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/provider-profiles" || trimmed.startsWith("/provider-profiles ")) {
    const parsed = parseProviderProfilesRequest(trimmed.slice("/provider-profiles".length).trim());
    const result = parsed.ok
      ? parsed.action === "add"
        ? await addProviderProfileFromReport(process.cwd(), parsed.reportName)
        : parsed.action === "use"
          ? await useProviderProfile(process.cwd(), parsed.id)
          : await loadProviderProfileRegistry(process.cwd())
      : {
          error: parsed.error,
          ok: false as const,
        };

    await runtime.renderer.writeFinalResponse({
      content: parsed.json
        ? JSON.stringify(result, null, 2)
        : "error" in result
          ? result.error
          : "applied" in result
            ? formatProviderProfileUseResult(result)
          : "added" in result
            ? formatProviderProfileAddResult(result)
            : formatProviderProfiles(result),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/provider-reports" || trimmed.startsWith("/provider-reports ")) {
    const parsed = parseProviderReportsRequest(trimmed.slice("/provider-reports".length).trim());

    await runtime.renderer.writeFinalResponse({
      content: !parsed.ok
        ? parsed.error
        : parsed.json
          ? formatProviderSmokeReportsJson(await listProviderSmokeReports(process.cwd(), parsed.limit))
          : formatProviderSmokeReports(await listProviderSmokeReports(process.cwd(), parsed.limit)),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (
    trimmed === "/provider-compare" ||
    trimmed.startsWith("/provider-compare ") ||
    trimmed === "/provider-gate" ||
    trimmed.startsWith("/provider-gate ")
  ) {
    const gate = trimmed === "/provider-gate" || trimmed.startsWith("/provider-gate ");
    const commandName = gate ? "/provider-gate" : "/provider-compare";
    const parsed = parseProviderCompareRequest(
      trimmed.slice(commandName.length).trim(),
      commandName,
    );
    const comparison = parsed.ok
      ? await compareProviderSmokeReports(process.cwd(), parsed.leftName, parsed.rightName)
      : {
          error: parsed.error,
          ok: false as const,
        };

    await runtime.renderer.writeFinalResponse({
      content: parsed.json
        ? formatProviderSmokeComparisonJson(comparison)
        : formatProviderSmokeComparison(comparison),
    });
    if (gate && ("error" in comparison || comparison.status === "regressed")) {
      process.exitCode = 1;
    }
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/providers" || trimmed === "/provider-matrix") {
    await runtime.renderer.writeFinalResponse({
      content: formatRuntimeProviderCompatibilityMatrix(runtime),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/doctor") {
    await runtime.renderer.writeFinalResponse({
      content: formatDoctorReport(await runDoctor(process.cwd())),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/diagnostics" || trimmed.startsWith("/diagnostics ")) {
    const request = trimmed.slice("/diagnostics".length).trim();

    if (request !== "export") {
      await runtime.renderer.writeFinalResponse({
        content: "Usage: /diagnostics export",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const report = await exportDiagnosticsReport(process.cwd(), {
      activeClient: runtime.agent.modelName,
      apiKeyStatus: runtime.apiKeyStatus,
      loadedConfig: runtime.loadedConfig,
      projectInstructions: runtime.projectInstructions,
      stream: runtime.stream,
      userConfig: runtime.userConfig,
      useSession: runtime.useSession,
      ...(runtime.verifyCommand ? { verifyCommand: runtime.verifyCommand } : {}),
    });

    await runtime.renderer.writeFinalResponse({
      content: formatDiagnosticsReportResult(report),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/evals" || trimmed.startsWith("/evals ")) {
    const parsed = parseEvalsCommand(trimmed.slice("/evals".length).trim());

    if (!parsed.ok) {
      await runtime.renderer.writeFinalResponse({
        content: parsed.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "report") {
      const report = await exportOfflineEvalsReport(process.cwd(), parsed.suite ?? "benchmark", {
        ...(parsed.iterations !== undefined ? { iterations: parsed.iterations } : {}),
        ...(parsed.tag ? { tag: parsed.tag } : {}),
      });

      await runtime.renderer.writeFinalResponse({
        content: parsed.json
          ? formatOfflineEvalsReportJson(report)
          : formatOfflineEvalsReport(report),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "case") {
      const result = await runOfflineEvalCase(parsed.caseName);

      await runtime.renderer.writeFinalResponse({
        content: parsed.json ? formatOfflineEvalCaseJson(result) : formatOfflineEvalCase(result),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "cases") {
      const result = listOfflineEvalCases(parsed.suite, parsed.tag);

      await runtime.renderer.writeFinalResponse({
        content: parsed.json ? formatOfflineEvalCasesJson(result) : formatOfflineEvalCases(result),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "tags") {
      const result = listOfflineEvalTags(parsed.suite);

      await runtime.renderer.writeFinalResponse({
        content: parsed.json ? formatOfflineEvalTagsJson(result) : formatOfflineEvalTags(result),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "reports") {
      const reports = await listOfflineEvalReports(process.cwd(), parsed.limit);

      await runtime.renderer.writeFinalResponse({
        content: parsed.json ? formatOfflineEvalReportsJson(reports) : formatOfflineEvalReports(reports),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "baseline") {
      const result = await saveOfflineEvalBaseline(process.cwd(), parsed.suite ?? "smoke");

      await runtime.renderer.writeFinalResponse({
        content: result.ok
          ? parsed.json
            ? JSON.stringify(result, null, 2)
            : formatOfflineEvalBaseline(result)
          : result.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "compare" || parsed.action === "gate") {
      const comparison =
        parsed.action === "gate"
          ? await compareOfflineEvalReportsForGate(
              process.cwd(),
              parsed.against,
              parsed.maxDurationDeltaMs,
            )
          : await compareOfflineEvalReports(
              process.cwd(),
              parsed.leftName,
              parsed.rightName,
              parsed.maxDurationDeltaMs,
            );

      if (!comparison.ok) {
        await runtime.renderer.writeFinalResponse({
          content: comparison.error,
        });
        if (parsed.action === "gate") {
          process.exitCode = 1;
        }
        return {
          shouldExit: false,
          shouldResetSessionCreatedAt: false,
        };
      }

      await runtime.renderer.writeFinalResponse({
        content: parsed.json
          ? formatOfflineEvalReportComparisonJson(comparison)
          : formatOfflineEvalReportComparison(comparison),
      });

      if (
        parsed.action === "gate" &&
        (comparison.summary.status === "regressed" ||
          (parsed.strict === true &&
            (comparison.summary.status === "informational" ||
              comparison.right.result.failed > 0)))
      ) {
        process.exitCode = 1;
      } else if (
        parsed.action === "compare" &&
        parsed.maxDurationDeltaMs !== undefined &&
        comparison.summary.status === "regressed"
      ) {
        process.exitCode = 1;
      }

      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const result = await runOfflineEvals(parsed.suite ?? "smoke", {
      ...(parsed.iterations !== undefined ? { iterations: parsed.iterations } : {}),
      ...(parsed.tag ? { tag: parsed.tag } : {}),
    });

    await runtime.renderer.writeFinalResponse({
      content: parsed.json ? formatOfflineEvalsJson(result) : formatOfflineEvals(result),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/input-history" || trimmed.startsWith("/input-history ")) {
    const request = trimmed.slice("/input-history".length).trim();

    if (!runtime.terminalHistory) {
      await runtime.renderer.writeFinalResponse({
        content:
          "Terminal input history is disabled for this run. Start without --no-session to load and save .ccagent/history.",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (request === "clear") {
      runtime.terminalHistory = await clearTerminalHistory(process.cwd());
      runtime.reader.setHistory([]);
      await runtime.renderer.writeFinalResponse({
        content: `Terminal input history cleared.\nPath: ${runtime.terminalHistory.path}`,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (request && !isIntegerText(request)) {
      await runtime.renderer.writeFinalResponse({
        content: "Usage: /input-history [count]\n       /input-history clear",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: formatTerminalHistory(runtime.terminalHistory, request ? Number(request) : undefined),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/audit" || trimmed.startsWith("/audit ")) {
    const request = trimmed.slice("/audit".length).trim();
    const parsed = parseAuditRequest(request);

    if (!parsed.ok) {
      await runtime.renderer.writeFinalResponse({
        content: parsed.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatRecentToolAudit(process.cwd(), {
        all: parsed.all,
        jsonl: parsed.jsonl,
        limit: parsed.limit,
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/audit-replay" || trimmed.startsWith("/audit-replay ")) {
    const request = trimmed.slice("/audit-replay".length).trim();
    const parsed = parseAuditReplayRequest(request);

    if (!parsed.ok) {
      await runtime.renderer.writeFinalResponse({
        content: parsed.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatAuditReplay(process.cwd(), {
        all: parsed.all,
        limit: parsed.limit,
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/audit-timeline" || trimmed.startsWith("/audit-timeline ")) {
    const request = trimmed.slice("/audit-timeline".length).trim();
    const parsed = parseAuditTimelineRequest(request);

    if (!parsed.ok) {
      await runtime.renderer.writeFinalResponse({
        content: parsed.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatAuditTimeline(process.cwd(), {
        all: parsed.all,
        limit: parsed.limit,
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/model-trace" || trimmed.startsWith("/model-trace ")) {
    const request = trimmed.slice("/model-trace".length).trim();
    const parsed = parseModelTraceRequest(request);

    if (!parsed.ok) {
      await runtime.renderer.writeFinalResponse({
        content: parsed.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatModelTrace(process.cwd(), {
        all: parsed.all,
        limit: parsed.limit,
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/usage-summary" || trimmed.startsWith("/usage-summary ")) {
    const request = trimmed.slice("/usage-summary".length).trim();

    if (request && request !== "--all") {
      await runtime.renderer.writeFinalResponse({
        content: "Usage: /usage-summary [--all]",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatUsageSummary(process.cwd(), {
        all: request === "--all",
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/usage-models" || trimmed.startsWith("/usage-models ")) {
    const request = trimmed.slice("/usage-models".length).trim();

    if (request && request !== "--all") {
      await runtime.renderer.writeFinalResponse({
        content: "Usage: /usage-models [--all]",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatUsageModels(process.cwd(), {
        all: request === "--all",
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/audit-call" || trimmed.startsWith("/audit-call ")) {
    const request = trimmed.slice("/audit-call".length).trim();
    const parsed = parseAuditCallRequest(request);

    if (!parsed.ok) {
      await runtime.renderer.writeFinalResponse({
        content: parsed.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatAuditCall(process.cwd(), {
        all: parsed.all,
        callId: parsed.callId,
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/audit-summary" || trimmed.startsWith("/audit-summary ")) {
    const request = trimmed.slice("/audit-summary".length).trim();

    if (request && request !== "--all") {
      await runtime.renderer.writeFinalResponse({
        content: "Usage: /audit-summary [--all]",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatAuditSummary(process.cwd(), {
        all: request === "--all",
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/audit-export" || trimmed.startsWith("/audit-export ")) {
    const request = trimmed.slice("/audit-export".length).trim();
    const parsed = parseAuditExportRequest(request);

    if (!parsed.ok) {
      await runtime.renderer.writeFinalResponse({
        content: parsed.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await exportAuditData(process.cwd(), parsed),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/audit-report" || trimmed.startsWith("/audit-report ")) {
    const request = trimmed.slice("/audit-report".length).trim();

    if (request && request !== "--all") {
      await runtime.renderer.writeFinalResponse({
        content: "Usage: /audit-report [--all]",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await exportAuditReport(process.cwd(), {
        all: request === "--all",
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/command-history" || trimmed.startsWith("/command-history ")) {
    const request = trimmed.slice("/command-history".length).trim();
    const parsed = parseCommandHistoryRequest(request);

    if (!parsed.ok) {
      await runtime.renderer.writeFinalResponse({
        content: parsed.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatProjectCommandHistory(process.cwd(), {
        all: parsed.all,
        commandName: parsed.commandName,
        limit: parsed.limit,
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/command-stats" || trimmed.startsWith("/command-stats ")) {
    const request = trimmed.slice("/command-stats".length).trim();

    if (request && request !== "--all") {
      await runtime.renderer.writeFinalResponse({
        content: "Usage: /command-stats [--all]",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: await formatProjectCommandStats(process.cwd(), {
        all: request === "--all",
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/permissions") {
    await runtime.renderer.writeFinalResponse({
      content: formatPermissions(runtime.loadedConfig, {
        allowEdits: runtime.allowEdits,
        sandboxLabel: describeShellSandbox(runtime.shellSandbox),
        verifyCommand: runtime.verifyCommand,
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/instructions") {
    await runtime.renderer.writeFinalResponse({
      content: formatProjectInstructions(runtime.projectInstructions),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/skills") {
    await runtime.renderer.writeFinalResponse({
      content: formatProjectSkills(await loadProjectSkills(process.cwd())),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/skill" || trimmed.startsWith("/skill ")) {
    const name = trimmed.slice("/skill".length).trim();
    const result = name
      ? await readProjectSkill(process.cwd(), name)
      : {
          error: "Usage: /skill <name>",
          loaded: await loadProjectSkills(process.cwd()),
          ok: false as const,
        };
    const content = result.ok
      ? formatProjectSkill(result.skill)
      : [result.error, "", formatProjectSkills(result.loaded)].join("\n");

    await runtime.renderer.writeFinalResponse({ content });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/mcp" || trimmed.startsWith("/mcp ")) {
    const parsed = parseMcpCommand(trimmed.slice("/mcp".length));
    let content: string;

    if ("error" in parsed) {
      content = parsed.error;
    } else if (parsed.action === "reload") {
      content = await reloadMcpRuntime(runtime, parsed.json);
    } else if (parsed.action === "tools") {
      content = formatMcpTools(runtime.mcp, parsed.json);
    } else if (parsed.action === "prompts") {
      content = formatMcpPrompts(runtime.mcp, parsed.json);
    } else if (parsed.action === "resources") {
      content = formatMcpResources(runtime.mcp, parsed.json);
    } else if (parsed.action === "templates") {
      content = formatMcpResourceTemplates(runtime.mcp, parsed.json);
    } else if (parsed.action === "prompt") {
      content = formatMcpPromptResult(
        await runtime.mcp.manager.getPrompt(
          parsed.serverName,
          parsed.name,
          parsed.arguments,
        ),
        parsed.json,
      );
    } else if (parsed.action === "read") {
      content = formatMcpResourceReadResult(
        await runtime.mcp.manager.readResource(parsed.serverName, parsed.uri),
        parsed.json,
      );
    } else {
      content = formatMcpStatus(
        runtime.mcp,
        runtime.loadedConfig.config.mcp?.enabled === true,
        parsed.json,
      );
    }

    await runtime.renderer.writeFinalResponse({ content });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/context") {
    const projectCommands = await loadProjectCommands(process.cwd());
    const projectSkills = await loadProjectSkills(process.cwd());

    await runtime.renderer.writeFinalResponse({
      content: formatRuntimeContext({
        allowEdits: runtime.allowEdits,
        json: runtime.json,
        loadedConfig: runtime.loadedConfig,
        mcp: {
          enabled: runtime.mcp.servers.length > 0 || runtime.loadedConfig.config.mcp?.enabled === true,
          prompts: runtime.mcp.prompts.length,
          resources: runtime.mcp.resources.length,
          servers: runtime.mcp.servers.length,
          templates: runtime.mcp.templates.length,
          tools: runtime.mcp.tools.length,
        },
        modelName: runtime.agent.modelName,
        projectCommands,
        projectInstructions: runtime.projectInstructions,
        projectSkills,
        sessionCreatedAt: runtime.sessionCreatedAt,
        sessionPath: runtime.sessionStore?.path,
        stream: runtime.stream,
        systemPromptLength: buildSystemPrompt(runtime.projectInstructions.content).length,
        toolCount: runtime.agent.toolCount,
        useSession: runtime.useSession,
        verifyCommand: runtime.verifyCommand,
        workspaceRoot: process.cwd(),
      }),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/code-map" || trimmed === "/codemap") {
    await runtime.renderer.writeFinalResponse({
      content: formatCodeMap(await buildCodeMap(process.cwd())),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (
    trimmed === "/code-map export" ||
    trimmed === "/code-map --export" ||
    trimmed === "/codemap export" ||
    trimmed === "/codemap --export"
  ) {
    const report = await exportCodeMapReport(process.cwd());

    await runtime.renderer.writeFinalResponse({
      content: [
        "Exported code map report",
        `Path: ${report.path}`,
        `Bytes: ${Buffer.byteLength(report.content, "utf8")}`,
      ].join("\n"),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed.startsWith("/code-map ") || trimmed.startsWith("/codemap ")) {
    await runtime.renderer.writeFinalResponse({
      content: "Usage: /code-map\n       /code-map export",
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/roadmap") {
    await runtime.renderer.writeFinalResponse({
      content: formatProjectRoadmap(),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/prompt") {
    await runtime.renderer.writeFinalResponse({
      content: formatEffectiveSystemPrompt(runtime.projectInstructions),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/command" || trimmed.startsWith("/command ")) {
    const name = trimmed.slice("/command".length).trim();

    if (!name) {
      await runtime.renderer.writeFinalResponse({
        content: [
          "Usage: /command <name>",
          "",
          formatProjectCommands(await loadProjectCommands(process.cwd())),
        ].join("\n"),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const commandResult = await readProjectCommand(process.cwd(), name);

    if (!commandResult.ok) {
      await recordProjectCommandAudit(runtime, {
        type: "project_command",
        action: "detail",
        commandName: name,
        requestedName: name,
        args: "",
        status: "blocked",
        summary: commandResult.error,
      });
      await runtime.renderer.writeFinalResponse({
        content: formatProjectCommandError(commandResult),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await recordProjectCommandAudit(runtime, {
      type: "project_command",
      action: "detail",
      commandName: commandResult.command.name,
      requestedName: name,
      args: "",
      status: "shown",
      summary: "Project command details shown.",
    });
    await runtime.renderer.writeFinalResponse({
      content: formatProjectCommandDetails(commandResult.command),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/commands" || trimmed.startsWith("/commands ")) {
    const tag = trimmed.slice("/commands".length).trim();
    const loadedCommands = await loadProjectCommands(process.cwd());

    if (tag === "--check") {
      await runtime.renderer.writeFinalResponse({
        content: formatProjectCommandsCheck(loadedCommands),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (tag && !isValidProjectCommandName(tag)) {
      await runtime.renderer.writeFinalResponse({
        content: "Expected tag to contain only letters, numbers, dashes, or underscores.",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: formatProjectCommands(
        loadedCommands,
        tag ? { tag } : undefined,
      ),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/cmd-preview" || trimmed.startsWith("/cmd-preview ")) {
    const request = trimmed.slice("/cmd-preview".length).trim();

    if (request.length === 0) {
      await runtime.renderer.writeFinalResponse({
        content: [
          "Usage: /cmd-preview <name> [args]",
          "",
          formatProjectCommands(await loadProjectCommands(process.cwd())),
        ].join("\n"),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const [name = "", ...rest] = request.split(/\s+/);
    const commandArgs = rest.join(" ");
    const commandResult = await readProjectCommand(process.cwd(), name);

    if (!commandResult.ok) {
      await recordProjectCommandAudit(runtime, {
        type: "project_command",
        action: "preview",
        commandName: name,
        requestedName: name,
        args: commandArgs,
        status: "blocked",
        summary: commandResult.error,
      });
      await runtime.renderer.writeFinalResponse({
        content: formatProjectCommandError(commandResult),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const argsValidation = validateProjectCommandArgs(commandResult.command, commandArgs);

    if (!argsValidation.ok) {
      await recordProjectCommandAudit(runtime, {
        type: "project_command",
        action: "preview",
        commandName: commandResult.command.name,
        requestedName: name,
        args: commandArgs,
        ...formatProjectCommandAuditArgs(argsValidation.parsedArgs),
        status: "blocked",
        summary: firstLine(argsValidation.error),
      });
      await runtime.renderer.writeFinalResponse({
        content: argsValidation.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const expandedPrompt = expandProjectCommand(
      commandResult.command,
      commandArgs,
      argsValidation.parsedArgs,
    );

    await recordProjectCommandAudit(runtime, {
      type: "project_command",
      action: "preview",
      commandName: commandResult.command.name,
      requestedName: name,
      args: commandArgs,
      ...formatProjectCommandAuditArgs(argsValidation.parsedArgs),
      expandedPromptPreview: summarizeProjectCommandPrompt(expandedPrompt),
      status: "shown",
      summary: "Expanded project command preview shown.",
    });
    await runtime.renderer.writeFinalResponse({
      content: formatExpandedProjectCommand(
        commandResult.command,
        commandArgs,
        argsValidation.parsedArgs,
      ),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/cmd" || trimmed.startsWith("/cmd ")) {
    const request = trimmed.slice("/cmd".length).trim();

    if (request.length === 0) {
      await runtime.renderer.writeFinalResponse({
        content: [
          "Usage: /cmd <name> [args]",
          "",
          formatProjectCommands(await loadProjectCommands(process.cwd())),
        ].join("\n"),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const [name = "", ...rest] = request.split(/\s+/);
    const commandResult = await readProjectCommand(process.cwd(), name);

    if (!commandResult.ok) {
      await recordProjectCommandAudit(runtime, {
        type: "project_command",
        action: "run",
        commandName: name,
        requestedName: name,
        args: rest.join(" "),
        status: "blocked",
        summary: commandResult.error,
      });
      await runtime.renderer.writeFinalResponse({
        content: formatProjectCommandError(commandResult),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const commandArgs = rest.join(" ");
    const argsValidation = validateProjectCommandArgs(commandResult.command, commandArgs);

    if (!argsValidation.ok) {
      await recordProjectCommandAudit(runtime, {
        type: "project_command",
        action: "run",
        commandName: commandResult.command.name,
        requestedName: name,
        args: commandArgs,
        ...formatProjectCommandAuditArgs(argsValidation.parsedArgs),
        status: "blocked",
        summary: firstLine(argsValidation.error),
      });
      await runtime.renderer.writeFinalResponse({
        content: argsValidation.error,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    const expandedPrompt = expandProjectCommand(
      commandResult.command,
      commandArgs,
      argsValidation.parsedArgs,
    );

    if (expandedPrompt.trim().length === 0) {
      await recordProjectCommandAudit(runtime, {
        type: "project_command",
        action: "run",
        commandName: commandResult.command.name,
        requestedName: name,
        args: commandArgs,
        ...formatProjectCommandAuditArgs(argsValidation.parsedArgs),
        expandedPromptPreview: summarizeProjectCommandPrompt(expandedPrompt),
        status: "blocked",
        summary: "Project command template expanded to an empty prompt.",
      });
      await runtime.renderer.writeFinalResponse({
        content: `Project command is empty: ${commandResult.command.name}`,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (commandResult.command.confirm) {
      const confirmation = await confirmProjectCommandExecution(
        runtime,
        commandResult.command,
        commandArgs,
        argsValidation.parsedArgs,
      );

      if (!confirmation.approved) {
        await recordProjectCommandAudit(runtime, {
          type: "project_command",
          action: "run",
          commandName: commandResult.command.name,
          requestedName: name,
          args: commandArgs,
          ...formatProjectCommandAuditArgs(argsValidation.parsedArgs),
          expandedPromptPreview: summarizeProjectCommandPrompt(expandedPrompt),
          status: confirmation.status,
          summary: confirmation.summary,
        });
        return {
          shouldExit: false,
          shouldResetSessionCreatedAt: false,
        };
      }
    }

    await recordProjectCommandAudit(runtime, {
      type: "project_command",
      action: "run",
      commandName: commandResult.command.name,
      requestedName: name,
      args: commandArgs,
      ...formatProjectCommandAuditArgs(argsValidation.parsedArgs),
      expandedPromptPreview: summarizeProjectCommandPrompt(expandedPrompt),
      status: "started",
      summary: "Expanded project command sent to agent.",
    });
    return runAgentPrompt(runtime, expandedPrompt, false);
  }

  if (
    trimmed === "/session" ||
    trimmed === "/session show" ||
    trimmed.startsWith("/session show ") ||
    trimmed === "/session stats" ||
    trimmed.startsWith("/session search ")
  ) {
    if (!runtime.useSession || !runtime.sessionStore || !runtime.sessionCreatedAt) {
      await runtime.renderer.writeFinalResponse({
        content:
          "Session disabled for this run. Start without --no-session to load and save .ccagent/sessions/current.json.",
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: formatSessionCommandResult(runtime, trimmed),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed.startsWith("/session ")) {
    await runtime.renderer.writeFinalResponse({
      content: formatSessionUsage(),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (trimmed === "/checkpoint" || trimmed.startsWith("/checkpoint ")) {
    return handleCheckpointCommand(runtime, trimmed.slice("/checkpoint".length).trim());
  }

  return runAgentPrompt(runtime, trimmed, trimmed === "/clear", signal);
}

type CheckpointRequest =
  | {
      action: "backups" | "list";
    }
  | {
      action: "save" | "stats" | "load" | "delete";
      name: string;
    }
  | {
      action: "show";
      limit?: number;
      name: string;
    }
  | {
      action: "search";
      name: string;
      query: string;
    }
  | {
      action: "diff";
      leftName: string;
      rightName: string;
    }
  | {
      action: "diffCurrent";
      name: string;
    }
  | {
      action: "usage";
      error?: string;
    };

type EvalsCommandRequest =
  | {
      action: "cases" | "compare" | "gate" | "report" | "reports" | "run" | "tags";
      against?: string;
      json: boolean;
      maxDurationDeltaMs?: number;
      iterations?: number;
      ok: true;
      limit?: number;
      leftName?: string;
      rightName?: string;
      strict?: boolean;
      tag?: OfflineEvalCaseTag;
      suite?: OfflineEvalSuiteName;
    }
  | {
      action: "baseline";
      json: boolean;
      ok: true;
      suite?: OfflineEvalSuiteName;
    }
  | {
      action: "case";
      caseName: OfflineEvalCaseName;
      json: boolean;
      ok: true;
    }
  | {
      error: string;
      ok: false;
    };

function parseEvalsCommand(request: string): EvalsCommandRequest {
  const parsedParts = parseEvalsCommandParts(request);
  const caseUsage = `Cases: ${OFFLINE_EVAL_CASE_NAMES.join(", ")}`;
  const usage = [
    "Usage: /evals [smoke|regression|benchmark] [--tag <tag>] [--iterations <1-20>] [--json]",
    "       /evals cases [smoke|regression|benchmark] [--tag <tag>] [--json]",
    "       /evals case <name> [--json]",
    "       /evals tags [smoke|regression|benchmark] [--json]",
    "       /evals report [smoke|regression|benchmark] [--tag <tag>] [--iterations <1-20>] [--json]",
    "       /evals reports [count] [--json]",
    "       /evals compare [left] [right] [--max-duration-delta <ms>] [--json]",
    "       /evals baseline [smoke|regression|benchmark] [--json]",
    "       /evals gate [--against <report>] [--strict] [--max-duration-delta <ms>] [--json]",
    "       /evals run [--tag <tag>] [--json]",
    caseUsage,
    `Tags: ${OFFLINE_EVAL_CASE_TAG_NAMES.join(", ")}`,
  ].join("\n");

  if (!parsedParts.ok) {
    return {
      ok: false,
      error: `${usage}\n${parsedParts.error}`,
    };
  }

  const { against, iterations, json, maxDurationDeltaMs, positionalParts, strict, tag } = parsedParts;
  const positional = positionalParts[0];

  if (tag !== undefined && !isOfflineEvalCaseTagName(tag)) {
    return {
      ok: false,
      error: usage,
    };
  }

  if ((against !== undefined || strict) && positional !== "gate") {
    return {
      ok: false,
      error: usage,
    };
  }

  if (positional === "run" && positionalParts.length > 1) {
    return {
      ok: false,
      error: usage,
    };
  }

  if (!positional || positional === "run") {
    if (iterations !== undefined) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "run",
      json,
      ok: true,
      suite: "smoke",
      ...(iterations !== undefined ? { iterations } : {}),
      ...(tag ? { tag } : {}),
    };
  }

  if (positional === "cases") {
    const suite = positionalParts[1];

    if (
      maxDurationDeltaMs !== undefined ||
      iterations !== undefined ||
      positionalParts.length > 2 ||
      (suite !== undefined && !isOfflineEvalSuiteName(suite))
    ) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "cases",
      json,
      ok: true,
      ...(tag ? { tag } : {}),
      ...(suite ? { suite } : {}),
    };
  }

  if (positional === "case") {
    if (maxDurationDeltaMs !== undefined || iterations !== undefined || tag !== undefined) {
      return {
        ok: false,
        error: usage,
      };
    }

    const caseName = positionalParts[1];

    if (!caseName || positionalParts.length !== 2 || !isOfflineEvalCaseName(caseName)) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "case",
      caseName,
      json,
      ok: true,
    };
  }

  if (positional === "tags") {
    const suite = positionalParts[1];

    if (
      maxDurationDeltaMs !== undefined ||
      iterations !== undefined ||
      tag !== undefined ||
      positionalParts.length > 2 ||
      (suite !== undefined && !isOfflineEvalSuiteName(suite))
    ) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "tags",
      json,
      ok: true,
      ...(suite ? { suite } : {}),
    };
  }

  if (positional === "report") {
    const reportSuite = positionalParts[1];

    if (maxDurationDeltaMs !== undefined) {
      return {
        ok: false,
        error: usage,
      };
    }

    if (!reportSuite) {
      return {
        action: "report",
        json,
        ok: true,
        suite: "benchmark",
        ...(iterations !== undefined ? { iterations } : {}),
        ...(tag ? { tag } : {}),
      };
    }

    if (
      !isOfflineEvalSuiteName(reportSuite) ||
      positionalParts.length > 2 ||
      (iterations !== undefined && reportSuite !== "benchmark")
    ) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "report",
      json,
      ok: true,
      suite: reportSuite,
      ...(iterations !== undefined ? { iterations } : {}),
      ...(tag ? { tag } : {}),
    };
  }

  if (positional === "reports") {
    if (tag !== undefined || iterations !== undefined) {
      return {
        ok: false,
        error: usage,
      };
    }

    if (!positionalParts[1]) {
      return {
        action: "reports",
        json,
        ok: true,
        limit: undefined,
      };
    }

    if (!isIntegerText(positionalParts[1] ?? "") || positionalParts.length > 2) {
      return {
        ok: false,
        error: usage,
      };
    }

    const limit = Number(positionalParts[1]);

    if (limit < 1 || limit > 100) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "reports",
      json,
      ok: true,
      limit,
    };
  }

  if (maxDurationDeltaMs !== undefined && positional !== "compare" && positional !== "gate") {
    return {
      ok: false,
      error: usage,
    };
  }

  if ((tag !== undefined || iterations !== undefined) && (positional === "compare" || positional === "gate")) {
    return {
      ok: false,
      error: usage,
    };
  }

  if (positional === "gate") {
    if (positionalParts.length !== 1) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "gate",
      json,
      maxDurationDeltaMs: maxDurationDeltaMs ?? 100,
      ok: true,
      ...(against ? { against } : {}),
      ...(strict ? { strict: true } : {}),
    };
  }

  if (positional === "baseline") {
    const baselineSuite = positionalParts[1];

    if (
      tag !== undefined ||
      iterations !== undefined ||
      maxDurationDeltaMs !== undefined ||
      positionalParts.length > 2 ||
      (baselineSuite !== undefined && !isOfflineEvalSuiteName(baselineSuite))
    ) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "baseline",
      json,
      ok: true,
      ...(baselineSuite ? { suite: baselineSuite } : {}),
    };
  }

  if (positional === "compare") {
    if (positionalParts.length === 1) {
      return {
        action: "compare",
        json,
        maxDurationDeltaMs,
        ok: true,
      };
    }

    if (positionalParts.length !== 3) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      action: "compare",
      json,
      maxDurationDeltaMs,
      ok: true,
      leftName: positionalParts[1],
      rightName: positionalParts[2],
    };
  }

  if (!isOfflineEvalSuiteName(positional)) {
    return {
      ok: false,
      error: usage,
    };
  }

  if (iterations !== undefined && positional !== "benchmark") {
    return {
      ok: false,
      error: usage,
    };
  }

  if (positionalParts.length > 1) {
    return {
      ok: false,
      error: usage,
    };
  }

  return {
    action: "run",
    json,
    ok: true,
    suite: positional,
    ...(iterations !== undefined ? { iterations } : {}),
    ...(tag ? { tag } : {}),
  };
}

type ParsedEvalsCommandParts =
  | {
      against?: string;
      json: boolean;
      iterations?: number;
      maxDurationDeltaMs?: number;
      strict?: boolean;
      tag?: string;
      ok: true;
      positionalParts: string[];
    }
  | {
      error: string;
      ok: false;
    };

function parseEvalsCommandParts(request: string): ParsedEvalsCommandParts {
  const parts = request.split(/\s+/).filter(Boolean);
  const positionalParts: string[] = [];
  let against: string | undefined;
  let json = false;
  let iterations: number | undefined;
  let maxDurationDeltaMs: number | undefined;
  let strict = false;
  let tag: string | undefined;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";

    if (part === "--json") {
      if (json) {
        return {
          ok: false,
          error: "--json can only be provided once.",
        };
      }

      json = true;
      continue;
    }

    if (part === "--iterations") {
      if (iterations !== undefined) {
        return {
          ok: false,
          error: "--iterations can only be provided once.",
        };
      }

      const value = parts[index + 1];

      if (!value || value.startsWith("--")) {
        return {
          ok: false,
          error: "--iterations requires a value.",
        };
      }

      const parsed = parseEvalsIterations(value);

      if (!parsed.ok) {
        return parsed;
      }

      iterations = parsed.value;
      index += 1;
      continue;
    }

    if (part.startsWith("--iterations=")) {
      if (iterations !== undefined) {
        return {
          ok: false,
          error: "--iterations can only be provided once.",
        };
      }

      const parsed = parseEvalsIterations(part.slice("--iterations=".length));

      if (!parsed.ok) {
        return parsed;
      }

      iterations = parsed.value;
      continue;
    }

    if (part === "--max-duration-delta") {
      if (maxDurationDeltaMs !== undefined) {
        return {
          ok: false,
          error: "--max-duration-delta can only be provided once.",
        };
      }

      const value = parts[index + 1];

      if (!value || value.startsWith("--")) {
        return {
          ok: false,
          error: "--max-duration-delta requires a millisecond value.",
        };
      }

      const parsed = parseEvalsDurationThreshold(value);

      if (!parsed.ok) {
        return parsed;
      }

      maxDurationDeltaMs = parsed.value;
      index += 1;
      continue;
    }

    if (part.startsWith("--max-duration-delta=")) {
      if (maxDurationDeltaMs !== undefined) {
        return {
          ok: false,
          error: "--max-duration-delta can only be provided once.",
        };
      }

      const parsed = parseEvalsDurationThreshold(part.slice("--max-duration-delta=".length));

      if (!parsed.ok) {
        return parsed;
      }

      maxDurationDeltaMs = parsed.value;
      continue;
    }

    if (part === "--tag") {
      if (tag !== undefined) {
        return {
          ok: false,
          error: "--tag can only be provided once.",
        };
      }

      const value = parts[index + 1];

      if (!value || value.startsWith("--")) {
        return {
          ok: false,
          error: "--tag requires a tag name.",
        };
      }

      tag = value;
      index += 1;
      continue;
    }

    if (part.startsWith("--tag=")) {
      if (tag !== undefined) {
        return {
          ok: false,
          error: "--tag can only be provided once.",
        };
      }

      const value = part.slice("--tag=".length);

      if (!value) {
        return {
          ok: false,
          error: "--tag requires a tag name.",
        };
      }

      tag = value;
      continue;
    }

    if (part === "--against") {
      if (against !== undefined) {
        return {
          ok: false,
          error: "--against can only be provided once.",
        };
      }

      const value = parts[index + 1];

      if (!value || value.startsWith("--")) {
        return {
          ok: false,
          error: "--against requires a baseline or report name.",
        };
      }

      against = value;
      index += 1;
      continue;
    }

    if (part.startsWith("--against=")) {
      if (against !== undefined) {
        return {
          ok: false,
          error: "--against can only be provided once.",
        };
      }

      const value = part.slice("--against=".length);

      if (!value) {
        return {
          ok: false,
          error: "--against requires a baseline or report name.",
        };
      }

      against = value;
      continue;
    }

    if (part === "--strict") {
      if (strict) {
        return {
          ok: false,
          error: "--strict can only be provided once.",
        };
      }

      strict = true;
      continue;
    }

    if (part.startsWith("--")) {
      return {
        ok: false,
        error: `Unsupported option: ${part}`,
      };
    }

    positionalParts.push(part);
  }

  if (positionalParts.length > 3) {
    return {
      ok: false,
      error: "Too many positional arguments.",
    };
  }

  return {
    iterations,
    json,
    maxDurationDeltaMs,
    ok: true,
    positionalParts,
    ...(against ? { against } : {}),
    ...(strict ? { strict: true } : {}),
    ...(tag ? { tag } : {}),
  };
}

function parseEvalsIterations(value: string): { ok: true; value: number } | { error: string; ok: false } {
  if (!isIntegerText(value)) {
    return {
      ok: false,
      error: "--iterations must be an integer.",
    };
  }

  const iterations = Number(value);

  if (iterations < 1 || iterations > 20) {
    return {
      ok: false,
      error: "--iterations must be between 1 and 20.",
    };
  }

  return {
    ok: true,
    value: iterations,
  };
}

function parseEvalsDurationThreshold(value: string): { ok: true; value: number } | { error: string; ok: false } {
  if (!isIntegerText(value)) {
    return {
      ok: false,
      error: "--max-duration-delta must be an integer number of milliseconds.",
    };
  }

  const threshold = Number(value);

  if (threshold < 0 || threshold > 600_000) {
    return {
      ok: false,
      error: "--max-duration-delta must be between 0 and 600000.",
    };
  }

  return {
    ok: true,
    value: threshold,
  };
}

function isOfflineEvalSuiteName(value: string): value is OfflineEvalSuiteName {
  return (OFFLINE_EVAL_SUITE_NAMES as readonly string[]).includes(value);
}

function isOfflineEvalCaseName(value: string): value is OfflineEvalCaseName {
  return (OFFLINE_EVAL_CASE_NAMES as readonly string[]).includes(value);
}

function isOfflineEvalCaseTagName(value: string): value is OfflineEvalCaseTag {
  return (OFFLINE_EVAL_CASE_TAG_NAMES as readonly string[]).includes(value);
}

async function handleCheckpointCommand(runtime: Runtime, request: string): Promise<HandleResult> {
  if (!runtime.useSession || !runtime.sessionStore) {
    await runtime.renderer.writeFinalResponse({
      content:
        "Session checkpoints are disabled for this run. Start without --no-session to load and save .ccagent/sessions/checkpoints/.",
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  const parsed = parseCheckpointRequest(request);

  if (parsed.action === "usage") {
    await runtime.renderer.writeFinalResponse({
      content: [parsed.error, formatCheckpointUsage()].filter(Boolean).join("\n"),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (parsed.action === "list") {
    await runtime.renderer.writeFinalResponse({
      content: formatSessionCheckpoints(await runtime.sessionStore.listCheckpoints(runtime.agent.modelName)),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (parsed.action === "backups") {
    await runtime.renderer.writeFinalResponse({
      content: formatSessionCheckpointBackups(
        await runtime.sessionStore.listCheckpoints(runtime.agent.modelName),
      ),
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  if (parsed.action === "diff") {
    return handleCheckpointDiffCommand(runtime, parsed.leftName, parsed.rightName);
  }

  if (parsed.action === "diffCurrent") {
    return handleCheckpointDiffCurrentCommand(runtime, parsed.name);
  }

  try {
    if (parsed.action === "save") {
      const session = createCurrentSessionSnapshot(runtime);
      const result = await runtime.sessionStore.saveCheckpoint(parsed.name, session);

      await runtime.renderer.writeFinalResponse({
        content: `Saved session checkpoint: ${result.name}\nPath: ${result.path}`,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "show") {
      const loaded = await runtime.sessionStore.loadCheckpoint(parsed.name, runtime.agent.modelName);

      if (!loaded.exists) {
        await runtime.renderer.writeFinalResponse({
          content: `Session checkpoint not found: ${parsed.name}\nPath: ${loaded.path}`,
        });
        return {
          shouldExit: false,
          shouldResetSessionCreatedAt: false,
        };
      }

      await runtime.renderer.writeFinalResponse({
        content: formatSessionCheckpointDetails(parsed.name, loaded, {
          messageLimit: parsed.limit,
        }),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "stats") {
      const loaded = await runtime.sessionStore.loadCheckpoint(parsed.name, runtime.agent.modelName);

      if (!loaded.exists) {
        await runtime.renderer.writeFinalResponse({
          content: `Session checkpoint not found: ${parsed.name}\nPath: ${loaded.path}`,
        });
        return {
          shouldExit: false,
          shouldResetSessionCreatedAt: false,
        };
      }

      await runtime.renderer.writeFinalResponse({
        content: formatSessionStats(`Session checkpoint stats: ${parsed.name}`, loaded),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "search") {
      const loaded = await runtime.sessionStore.loadCheckpoint(parsed.name, runtime.agent.modelName);

      if (!loaded.exists) {
        await runtime.renderer.writeFinalResponse({
          content: `Session checkpoint not found: ${parsed.name}\nPath: ${loaded.path}`,
        });
        return {
          shouldExit: false,
          shouldResetSessionCreatedAt: false,
        };
      }

      await runtime.renderer.writeFinalResponse({
        content: formatSessionSearch(`Session checkpoint search: ${parsed.name}`, loaded, parsed.query),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "load") {
      const loaded = await runtime.sessionStore.loadCheckpoint(parsed.name, runtime.agent.modelName);

      if (!loaded.exists) {
        await runtime.renderer.writeFinalResponse({
          content: `Session checkpoint not found: ${parsed.name}\nPath: ${loaded.path}`,
        });
        return {
          shouldExit: false,
          shouldResetSessionCreatedAt: false,
        };
      }

      const backup = await runtime.sessionStore.saveCheckpoint(
        createCheckpointLoadBackupName(),
        createCurrentSessionSnapshot(runtime),
      );

      runtime.agent.loadSession(loaded.session);
      runtime.sessionCreatedAt = loaded.session.createdAt;
      await saveCurrentSession(runtime);

      await runtime.renderer.writeFinalResponse({
        content: [
          `Loaded session checkpoint: ${parsed.name}`,
          `Backup checkpoint saved before load: ${backup.name}`,
          `Backup path: ${backup.path}`,
          "",
          formatLoadedSession(loaded),
        ].join("\n"),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    if (parsed.action === "delete") {
      const result = await runtime.sessionStore.deleteCheckpoint(parsed.name);

      await runtime.renderer.writeFinalResponse({
        content: result.deleted
          ? `Deleted session checkpoint: ${result.name}\nPath: ${result.path}`
          : `Session checkpoint not found: ${result.name}\nPath: ${result.path}`,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: formatCheckpointUsage(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    await runtime.renderer.writeFinalResponse({
      content: `Session checkpoint failed: ${reason}`,
    });
  }

  return {
    shouldExit: false,
    shouldResetSessionCreatedAt: false,
  };
}

async function handleCheckpointDiffCurrentCommand(
  runtime: Runtime,
  name: string,
): Promise<HandleResult> {
  if (!runtime.sessionStore) {
    await runtime.renderer.writeFinalResponse({
      content:
        "Session checkpoints are disabled for this run. Start without --no-session to load and save .ccagent/sessions/checkpoints/.",
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  try {
    const left = await runtime.sessionStore.loadCheckpoint(name, runtime.agent.modelName);

    if (!left.exists) {
      await runtime.renderer.writeFinalResponse({
        content: `Session checkpoint not found: ${name}\nPath: ${left.path}`,
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: formatSessionCheckpointDiff(name, left, "current", {
        path: runtime.sessionStore.path,
        exists: true,
        session: createCurrentSessionSnapshot(runtime),
        warnings: [],
      }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    await runtime.renderer.writeFinalResponse({
      content: `Session checkpoint diff failed: ${reason}`,
    });
  }

  return {
    shouldExit: false,
    shouldResetSessionCreatedAt: false,
  };
}

async function handleCheckpointDiffCommand(
  runtime: Runtime,
  leftName: string,
  rightName: string,
): Promise<HandleResult> {
  if (!runtime.sessionStore) {
    await runtime.renderer.writeFinalResponse({
      content:
        "Session checkpoints are disabled for this run. Start without --no-session to load and save .ccagent/sessions/checkpoints/.",
    });
    return {
      shouldExit: false,
      shouldResetSessionCreatedAt: false,
    };
  }

  try {
    const left = await runtime.sessionStore.loadCheckpoint(leftName, runtime.agent.modelName);
    const right = await runtime.sessionStore.loadCheckpoint(rightName, runtime.agent.modelName);

    if (!left.exists || !right.exists) {
      const missing = [
        !left.exists ? `Session checkpoint not found: ${leftName}\nPath: ${left.path}` : undefined,
        !right.exists ? `Session checkpoint not found: ${rightName}\nPath: ${right.path}` : undefined,
      ].filter(Boolean);

      await runtime.renderer.writeFinalResponse({
        content: missing.join("\n"),
      });
      return {
        shouldExit: false,
        shouldResetSessionCreatedAt: false,
      };
    }

    await runtime.renderer.writeFinalResponse({
      content: formatSessionCheckpointDiff(leftName, left, rightName, right),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    await runtime.renderer.writeFinalResponse({
      content: `Session checkpoint diff failed: ${reason}`,
    });
  }

  return {
    shouldExit: false,
    shouldResetSessionCreatedAt: false,
  };
}

function parseCheckpointRequest(request: string): CheckpointRequest {
  if (!request || request === "list") {
    return { action: "list" };
  }

  if (request === "backups") {
    return { action: "backups" };
  }

  const parts = request.split(/\s+/).filter(Boolean);
  const [action = "", name = "", secondName = "", ...rest] = parts;

  if (action === "search" && name.length > 0 && secondName.length > 0) {
    return {
      action,
      name,
      query: [secondName, ...rest].join(" "),
    };
  }

  if (action === "diff-current" && name.length > 0 && secondName.length === 0 && rest.length === 0) {
    return {
      action: "diffCurrent",
      name,
    };
  }

  if (action === "diff" && name.length > 0 && secondName.length > 0 && rest.length === 0) {
    return {
      action,
      leftName: name,
      rightName: secondName,
    };
  }

  if (action === "show" && name.length > 0) {
    const parsedLimit = parseOptionalLimitArgs([secondName, ...rest].filter(Boolean), formatCheckpointShowUsage());

    if (!parsedLimit.ok) {
      return {
        action: "usage",
        error: parsedLimit.error,
      };
    }

    return {
      action,
      limit: parsedLimit.limit,
      name,
    };
  }

  if (
    (action === "save" || action === "stats" || action === "load" || action === "delete") &&
    name.length > 0 &&
    secondName.length === 0 &&
    rest.length === 0
  ) {
    return {
      action,
      name,
    };
  }

  return {
    action: "usage",
    error: action ? `Unknown or incomplete checkpoint command: ${request}` : undefined,
  };
}

function formatCheckpointUsage(): string {
  return [
    "Usage: /checkpoint [list]",
    "       /checkpoint backups",
    "       /checkpoint save <name>",
    "       /checkpoint show <name> [--limit <count>]",
    "       /checkpoint stats <name>",
    "       /checkpoint search <name> <query>",
    "       /checkpoint diff <left> <right>",
    "       /checkpoint diff-current <name>",
    "       /checkpoint load <name>",
    "       /checkpoint delete <name>",
    formatSessionCheckpointNameRules(),
  ].join("\n");
}

function formatCheckpointShowUsage(): string {
  return "Usage: /checkpoint show <name> [--limit <count>]\ncount must be between 1 and 100.";
}

function createCheckpointLoadBackupName(date: Date = new Date()): string {
  return `${CHECKPOINT_LOAD_BACKUP_PREFIX}${date.toISOString().replace(/[-:.]/g, "")}`;
}

async function runAgentPrompt(
  runtime: Runtime,
  prompt: string,
  shouldResetSessionCreatedAt: boolean,
  signal?: AbortSignal,
): Promise<HandleResult> {
  const response = await runtime.agent.handleUserMessage(
    prompt,
    {
      ...(runtime.stream || runtime.json || runtime.rich
        ? { onStreamEvent: runtime.renderer.writeAgentStreamEvent }
        : {}),
      ...(signal ? { signal } : {}),
    },
  );

  if (signal?.aborted === true) {
    await runtime.renderer.writeMessage("Interrupted.");

    return {
      shouldExit: false,
      shouldResetSessionCreatedAt,
    };
  }

  await runtime.renderer.writeFinalResponse(response);

  await saveCurrentSession(runtime);

  return {
    shouldExit: false,
    shouldResetSessionCreatedAt,
  };
}

type ProjectCommandConfirmationResult =
  | {
      approved: true;
    }
  | {
      approved: false;
      status: "blocked" | "denied";
      summary: string;
    };

async function confirmProjectCommandExecution(
  runtime: Runtime,
  command: ProjectCommand,
  args: string,
  parsedArgs: ParsedProjectCommandArgs,
): Promise<ProjectCommandConfirmationResult> {
  if (!input.isTTY) {
    await runtime.renderer.writeFinalResponse({
      content: `Project command requires confirmation, but stdin is not interactive: ${command.name}`,
    });
    return {
      approved: false,
      status: "blocked",
      summary: "Project command requires confirmation, but stdin is not interactive.",
    };
  }

  if (runtime.json) {
    const answer = await runtime.reader.read("");
    const approved = parseApprovalChoice(answer) === "approve";

    if (!approved) {
      await runtime.renderer.writeFinalResponse({
        content: `Project command denied: ${command.name}`,
      });
    }

    return approved
      ? { approved: true }
      : {
          approved: false,
          status: "denied",
          summary: "Project command denied by user.",
        };
  }

  output.write(`\n${formatExpandedProjectCommand(command, args, parsedArgs)}\n\n`);

  while (true) {
    const answer = await runtime.reader.read("Run this project command? [y] yes, [n] no: ");
    const choice = parseApprovalChoice(answer);

    if (choice === "approve") {
      return { approved: true };
    }

    if (choice === "deny") {
      await runtime.renderer.writeFinalResponse({
        content: `Project command denied: ${command.name}`,
      });
      return {
        approved: false,
        status: "denied",
        summary: "Project command denied by user.",
      };
    }

    output.write("\nEnter y or n.\n\n");
  }
}

function formatProjectCommandAuditArgs(
  parsedArgs: ParsedProjectCommandArgs | undefined,
): Pick<ProjectCommandAuditEventInput, "namedArgs" | "positionalArgs"> {
  if (!parsedArgs) {
    return {};
  }

  return {
    ...(Object.keys(parsedArgs.named).length > 0 ? { namedArgs: parsedArgs.named } : {}),
    positionalArgs: parsedArgs.positional,
  };
}

function summarizeProjectCommandPrompt(prompt: string): string {
  return truncateOneLine(prompt.trim(), 240);
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

async function recordProjectCommandAudit(
  runtime: Runtime,
  event: ProjectCommandAuditEventInput,
): Promise<void> {
  try {
    await runtime.auditLogger.record({
      ...event,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    runtime.debug("audit.write_failed", { reason });
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

type AuditRequest =
  | {
      ok: true;
      all?: boolean;
      jsonl?: boolean;
      limit?: number;
    }
  | {
      ok: false;
      error: string;
    };

function parseAuditRequest(request: string): AuditRequest {
  const parts = request.split(/\s+/).filter(Boolean);
  const all = parts.includes("--all");
  const jsonl = parts.includes("--jsonl");
  const supportedOptions = new Set(["--all", "--jsonl"]);
  const optionCount = parts.filter((part) => supportedOptions.has(part)).length;
  const uniqueOptionCount = new Set(parts.filter((part) => supportedOptions.has(part))).size;
  const hasUnsupportedOption = parts.some(
    (part) => part.startsWith("--") && !supportedOptions.has(part),
  );
  const positionalParts = parts.filter((part) => !part.startsWith("--"));

  if (optionCount !== uniqueOptionCount || hasUnsupportedOption || positionalParts.length > 1) {
    return {
      ok: false,
      error: "Usage: /audit [--all] [--jsonl] [count]",
    };
  }

  if (positionalParts.length === 0) {
    return {
      ok: true,
      all,
      jsonl,
    };
  }

  const [countText = ""] = positionalParts;

  if (!isIntegerText(countText)) {
    return {
      ok: false,
      error: "Usage: /audit [--all] [--jsonl] [count]\ncount must be between 1 and 100.",
    };
  }

  return {
    ok: true,
    all,
    jsonl,
    limit: Number(countText),
  };
}

type AuditReplayRequest =
  | {
      ok: true;
      all?: boolean;
      limit?: number;
    }
  | {
      ok: false;
      error: string;
    };

function parseAuditReplayRequest(request: string): AuditReplayRequest {
  const parts = request.split(/\s+/).filter(Boolean);
  const all = parts.includes("--all");
  const optionCount = parts.filter((part) => part === "--all").length;
  const hasUnsupportedOption = parts.some((part) => part.startsWith("--") && part !== "--all");
  const positionalParts = parts.filter((part) => !part.startsWith("--"));

  if (optionCount > 1 || hasUnsupportedOption || positionalParts.length > 1) {
    return {
      ok: false,
      error: "Usage: /audit-replay [--all] [count]",
    };
  }

  if (positionalParts.length === 0) {
    return {
      ok: true,
      all,
    };
  }

  const [countText = ""] = positionalParts;

  if (!isIntegerText(countText)) {
    return {
      ok: false,
      error: "Usage: /audit-replay [--all] [count]\ncount must be between 1 and 100.",
    };
  }

  return {
    ok: true,
    all,
    limit: Number(countText),
  };
}

type AuditTimelineRequest =
  | {
      ok: true;
      all?: boolean;
      limit?: number;
    }
  | {
      ok: false;
      error: string;
    };

function parseAuditTimelineRequest(request: string): AuditTimelineRequest {
  const parts = request.split(/\s+/).filter(Boolean);
  const all = parts.includes("--all");
  const optionCount = parts.filter((part) => part === "--all").length;
  const hasUnsupportedOption = parts.some((part) => part.startsWith("--") && part !== "--all");
  const positionalParts = parts.filter((part) => !part.startsWith("--"));

  if (optionCount > 1 || hasUnsupportedOption || positionalParts.length > 1) {
    return {
      ok: false,
      error: "Usage: /audit-timeline [--all] [count]",
    };
  }

  if (positionalParts.length === 0) {
    return {
      ok: true,
      all,
    };
  }

  const [countText = ""] = positionalParts;

  if (!isIntegerText(countText)) {
    return {
      ok: false,
      error: "Usage: /audit-timeline [--all] [count]\ncount must be between 1 and 100.",
    };
  }

  return {
    ok: true,
    all,
    limit: Number(countText),
  };
}

type ModelTraceRequest =
  | {
      ok: true;
      all?: boolean;
      limit?: number;
    }
  | {
      ok: false;
      error: string;
    };

function parseModelTraceRequest(request: string): ModelTraceRequest {
  const parts = request.split(/\s+/).filter(Boolean);
  const all = parts.includes("--all");
  const optionCount = parts.filter((part) => part === "--all").length;
  const hasUnsupportedOption = parts.some((part) => part.startsWith("--") && part !== "--all");
  const positionalParts = parts.filter((part) => !part.startsWith("--"));

  if (optionCount > 1 || hasUnsupportedOption || positionalParts.length > 1) {
    return {
      ok: false,
      error: "Usage: /model-trace [--all] [count]",
    };
  }

  if (positionalParts.length === 0) {
    return {
      ok: true,
      all,
    };
  }

  const [countText = ""] = positionalParts;

  if (!isIntegerText(countText)) {
    return {
      ok: false,
      error: "Usage: /model-trace [--all] [count]\ncount must be between 1 and 100.",
    };
  }

  return {
    ok: true,
    all,
    limit: Number(countText),
  };
}

type AuditCallRequest =
  | {
      ok: true;
      all?: boolean;
      callId: string;
    }
  | {
      ok: false;
      error: string;
    };

function parseAuditCallRequest(request: string): AuditCallRequest {
  const parts = request.split(/\s+/).filter(Boolean);
  const all = parts.includes("--all");
  const optionCount = parts.filter((part) => part === "--all").length;
  const hasUnsupportedOption = parts.some((part) => part.startsWith("--") && part !== "--all");
  const positionalParts = parts.filter((part) => !part.startsWith("--"));

  if (optionCount > 1 || hasUnsupportedOption || positionalParts.length !== 1) {
    return {
      ok: false,
      error: "Usage: /audit-call [--all] <callId>",
    };
  }

  return {
    ok: true,
    all,
    callId: positionalParts[0] ?? "",
  };
}

type AuditExportRequest =
  | {
      ok: true;
      all?: boolean;
      kind: "summary";
    }
  | {
      ok: true;
      all?: boolean;
      callId: string;
      kind: "call";
    }
  | {
      ok: false;
      error: string;
    };

function parseAuditExportRequest(request: string): AuditExportRequest {
  const usage = "Usage: /audit-export summary [--all]\n       /audit-export call [--all] <callId>";
  const parts = request.split(/\s+/).filter(Boolean);
  const [kind, ...rest] = parts;

  if (kind !== "summary" && kind !== "call") {
    return {
      ok: false,
      error: usage,
    };
  }

  const all = rest.includes("--all");
  const optionCount = rest.filter((part) => part === "--all").length;
  const hasUnsupportedOption = rest.some((part) => part.startsWith("--") && part !== "--all");
  const positionalParts = rest.filter((part) => !part.startsWith("--"));

  if (kind === "summary") {
    if (optionCount > 1 || hasUnsupportedOption || positionalParts.length > 0) {
      return {
        ok: false,
        error: usage,
      };
    }

    return {
      ok: true,
      all,
      kind,
    };
  }

  if (optionCount > 1 || hasUnsupportedOption || positionalParts.length !== 1) {
    return {
      ok: false,
      error: usage,
    };
  }

  return {
    ok: true,
    all,
    callId: positionalParts[0] ?? "",
    kind,
  };
}

type CommandHistoryRequest =
  | {
      ok: true;
      all?: boolean;
      commandName?: string;
      limit?: number;
    }
  | {
      ok: false;
      error: string;
    };

function parseCommandHistoryRequest(request: string): CommandHistoryRequest {
  const parts = request.split(/\s+/).filter(Boolean);
  const all = parts.includes("--all");
  const optionCount = parts.filter((part) => part === "--all").length;
  const positionalParts = parts.filter((part) => part !== "--all");

  if (optionCount > 1) {
    return {
      ok: false,
      error: "Usage: /command-history [--all] [name] [count]",
    };
  }

  if (positionalParts.length === 0) {
    return {
      ok: true,
      all,
    };
  }

  if (positionalParts.length > 2) {
    return {
      ok: false,
      error: "Usage: /command-history [--all] [name] [count]",
    };
  }

  if (positionalParts.length === 1 && isIntegerText(positionalParts[0] ?? "")) {
    return {
      ok: true,
      all,
      limit: Number(positionalParts[0]),
    };
  }

  const [commandName = "", countText] = positionalParts;

  if (!isValidProjectCommandName(commandName)) {
    return {
      ok: false,
      error: "Expected command name to contain only letters, numbers, dashes, or underscores.",
    };
  }

  if (countText && !isIntegerText(countText)) {
    return {
      ok: false,
      error: "Usage: /command-history [--all] [name] [count]\ncount must be between 1 and 100.",
    };
  }

  return {
    ok: true,
    all,
    commandName,
    limit: countText ? Number(countText) : undefined,
  };
}

function parseArchitectureCommand(trimmed: string): string | null {
  for (const command of ["/architecture", "/arch", "/flow"]) {
    if (trimmed === command) {
      return "";
    }

    if (trimmed.startsWith(`${command} `)) {
      return trimmed.slice(command.length).trim();
    }
  }

  return null;
}

function isIntegerText(value: string): boolean {
  return /^\d+$/.test(value);
}

function createModeRenderer(json: boolean, rich = false): OutputRenderer {
  if (json) {
    return createJsonLinesRenderer(output);
  }

  if (rich) {
    return createRichRenderer(output);
  }

  return createTerminalRenderer(output);
}

export function formatRuntimeModelInfo(
  runtime: Pick<
    Runtime,
    "agent" | "apiKeyStatus" | "loadedConfig" | "rich" | "userConfig" | "stream" | "useSession"
  >,
): string {
  const resolvedModel = resolveOpenAIModel(
    runtime.loadedConfig.config.model,
    runtime.userConfig.config.model,
  );
  const resolvedApiMode = resolveOpenAIApiMode(
    runtime.loadedConfig.config.openai?.apiMode,
    runtime.userConfig.config.openai?.apiMode,
  );
  const resolvedBaseURL = resolveOpenAIBaseURL(
    runtime.loadedConfig.config.openai?.baseURL,
    runtime.userConfig.config.openai?.baseURL,
  );
  const embeddingModel = process.env.CCAGENT_EMBEDDING_MODEL?.trim() ||
    runtime.loadedConfig.config.openai?.embeddingModel?.trim() ||
    runtime.userConfig.config.openai?.embeddingModel?.trim();
  const embeddingSource = process.env.CCAGENT_EMBEDDING_MODEL?.trim()
    ? "env"
    : runtime.loadedConfig.config.openai?.embeddingModel?.trim()
      ? "config"
      : runtime.userConfig.config.openai?.embeddingModel?.trim()
        ? "user-config"
        : "none";
  const mergedRetry = {
    ...(runtime.userConfig.config.openai?.retry ?? {}),
    ...(runtime.loadedConfig.config.openai?.retry ?? {}),
  };
  const apiKeyStatus = runtime.apiKeyStatus;
  const clientKind = apiKeyStatus.set
    ? resolvedApiMode.apiMode === "chat"
      ? "openai-chat (/v1/chat/completions)"
      : "openai-responses (/v1/responses)"
    : "mock (OPENAI_API_KEY is not set)";
  const lines = [
    "Model runtime",
    `Active client: ${runtime.agent.modelName}`,
    `Client kind: ${clientKind}`,
    `Configured model: ${resolvedModel.model} (source: ${resolvedModel.source})`,
    `OpenAI API mode: ${resolvedApiMode.apiMode} (source: ${resolvedApiMode.source})`,
    `OpenAI base URL: ${resolvedBaseURL.baseURL} (source: ${resolvedBaseURL.source})`,
    `OpenAI embedding model: ${embeddingModel ? `${embeddingModel} (source: ${embeddingSource})` : "local-hash-v1 (provider embeddings disabled)"}`,
    `OpenAI provider retry: ${formatProviderRetryConfig(Object.keys(mergedRetry).length > 0 ? mergedRetry : undefined)}`,
    apiKeyStatus.source === "env"
      ? "OPENAI_API_KEY: set (real OpenAI model client is active)"
      : apiKeyStatus.source === "auth-file"
        ? "API key: set (source: auth-file; real OpenAI model client is active)"
        : "OPENAI_API_KEY: not set (mock model is active)",
    `Config path: ${runtime.loadedConfig.path}`,
    `Config loaded: ${runtime.loadedConfig.exists ? "yes" : "no"}`,
    `User config path: ${runtime.userConfig.path}`,
    `User config loaded: ${runtime.userConfig.exists ? "yes" : "no"}`,
    `Streaming: ${runtime.stream || runtime.rich ? "on" : "off"}`,
    `Session: ${runtime.useSession ? "on" : "off"}`,
  ];

  if (runtime.loadedConfig.warnings.length > 0) {
    lines.push("");
    lines.push("Config warnings:");
    lines.push(...runtime.loadedConfig.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function formatRuntimeProviderCompatibilityMatrix(
  runtime: Pick<Runtime, "apiKeyStatus" | "loadedConfig" | "userConfig">,
): string {
  const resolvedApiMode = resolveOpenAIApiMode(
    runtime.loadedConfig.config.openai?.apiMode,
    runtime.userConfig.config.openai?.apiMode,
  );
  const resolvedBaseURL = resolveOpenAIBaseURL(
    runtime.loadedConfig.config.openai?.baseURL,
    runtime.userConfig.config.openai?.baseURL,
  );

  return formatProviderCompatibilityMatrix({
    apiMode: resolvedApiMode.apiMode,
    apiModeSource: resolvedApiMode.source,
    baseURL: resolvedBaseURL.baseURL,
    baseURLSource: resolvedBaseURL.source,
    hasApiKey: runtime.apiKeyStatus.set,
  });
}

const MODEL_SMOKE_TOOL: ModelToolDefinition = {
  name: "smoke_ping",
  description: "A no-op smoke test tool. Use it exactly once to confirm tool calling works.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Short confirmation message.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

export async function runModelSmoke(
  runtime: Pick<Runtime, "loadedConfig" | "openAIApiKey" | "projectInstructions" | "userConfig">,
  request = "",
): Promise<string> {
  const client = createSmokeModelClient(runtime);
  const parsed = parseModelSmokeRequest(request);
  const prompt = parsed.prompt || (
    parsed.tool
      ? "Call the smoke_ping tool exactly once with message set to OK. Do not answer in text."
      : "Reply with exactly: OK"
  );
  const probe = await runSmokeProbe(client, {
    allowStreamFallback: true,
    prompt,
    stream: parsed.stream,
    tool: parsed.tool,
  });

  if (probe.ok) {
    return [
      "Model smoke",
      `Client: ${client.name}`,
      `Duration: ${probe.durationMs}ms`,
      `Streaming: ${parsed.stream ? (probe.streamFallback ? "requested but unsupported; used non-streaming" : "on") : "off"}`,
      ...(parsed.stream && !probe.streamFallback ? [`Text delta chunks: ${probe.textDeltaChunks}`] : []),
      `Tool smoke: ${parsed.tool ? formatToolSmokeResult(probe.toolCalls) : "off"}`,
      `Prompt: ${prompt}`,
      `Tool calls: ${probe.toolCalls.length > 0 ? probe.toolCalls.join(", ") : "(none)"}`,
      ...formatSmokeToolArguments(probe.result.toolCalls),
      formatSmokeUsage(probe.result.usage),
      "",
      "Response:",
      probe.result.content.trim() || "(empty)",
    ].join("\n");
  }

  return [
    "Model smoke failed",
    `Client: ${client.name}`,
    `Duration: ${probe.durationMs}ms`,
    `Reason: ${probe.error}`,
  ].join("\n");
}

export async function runProviderSmoke(
  runtime: Pick<Runtime, "apiKeyStatus" | "loadedConfig" | "openAIApiKey" | "projectInstructions" | "userConfig">,
  request = "",
): Promise<string> {
  const parsed = parseProviderSmokeRequest(request);
  const client = createSmokeModelClient(runtime);
  const resolvedModel = resolveOpenAIModel(
    runtime.loadedConfig.config.model,
    runtime.userConfig.config.model,
  );
  const resolvedApiMode = resolveOpenAIApiMode(
    runtime.loadedConfig.config.openai?.apiMode,
    runtime.userConfig.config.openai?.apiMode,
  );
  const resolvedBaseURL = resolveOpenAIBaseURL(
    runtime.loadedConfig.config.openai?.baseURL,
    runtime.userConfig.config.openai?.baseURL,
  );
  const hasApiKey = runtime.apiKeyStatus.set;
  const textPrompt = parsed.prompt || "Reply with exactly: OK";
  const probeDefinitions = createProviderSmokeProbeDefinitions(parsed.profile, textPrompt);
  const results: ProviderSmokeProbeResult[] = [];

  for (const definition of probeDefinitions) {
    client.reset?.();
    const probe = await runSmokeProbe(client, {
      allowStreamFallback: false,
      prompt: definition.prompt,
      stream: definition.stream,
      tool: definition.tool,
    });
    results.push({
      ...definition,
      probe,
      ...evaluateProviderSmokeProbe(definition, probe),
    });
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const diagnosticProbes = results.map((result) => ({
    name: result.name,
    ok: result.ok,
    stream: result.stream,
    summary: result.summary,
    tool: result.tool,
  }));
  const diagnosis = diagnoseProviderSmoke({
    apiMode: resolvedApiMode.apiMode,
    apiModeSource: resolvedApiMode.source,
    baseURL: resolvedBaseURL.baseURL,
    baseURLSource: resolvedBaseURL.source,
    failed,
    hasApiKey,
    model: resolvedModel.model,
    passed,
    profile: parsed.profile,
    probes: diagnosticProbes,
  });
  const compatibility = buildProviderSmokeCompatibilityProfile({
    apiMode: resolvedApiMode.apiMode,
    apiModeSource: resolvedApiMode.source,
    baseURL: resolvedBaseURL.baseURL,
    baseURLSource: resolvedBaseURL.source,
    failed,
    hasApiKey,
    model: resolvedModel.model,
    passed,
    profile: parsed.profile,
    probes: diagnosticProbes,
  });
  const summary: ProviderSmokeSummary = {
    apiMode: resolvedApiMode.apiMode,
    apiModeSource: resolvedApiMode.source,
    apiKeySource: runtime.apiKeyStatus.source,
    baseURL: resolvedBaseURL.baseURL,
    baseURLSource: resolvedBaseURL.source,
    client: client.name,
    clientKind: formatModelClientKind(resolvedApiMode.apiMode, hasApiKey),
    compatibility,
    diagnosis,
    failed,
    hasApiKey,
    model: resolvedModel.model,
    modelSource: resolvedModel.source,
    passed,
    profile: parsed.profile,
    probes: results.map(formatProviderSmokeProbeJson),
  };

  if (parsed.save) {
    summary.report = await exportProviderSmokeReport(process.cwd(), summary);
  }

  if (parsed.json) {
    return JSON.stringify(summary, null, 2);
  }

  const lines = [
    "Provider smoke",
    `Client: ${summary.client}`,
    `Client kind: ${summary.clientKind}`,
    `Configured model: ${summary.model} (source: ${summary.modelSource})`,
    `OpenAI API mode: ${summary.apiMode} (source: ${summary.apiModeSource})`,
    `OpenAI base URL: ${summary.baseURL} (source: ${summary.baseURLSource})`,
    runtime.apiKeyStatus.source === "none"
      ? "OPENAI_API_KEY: not set (mock model is active)"
      : `API key: set (source: ${runtime.apiKeyStatus.source}; real provider will be called)`,
    `Profile: ${summary.profile}`,
    `Summary: ${passed} passed, ${failed} failed`,
    "",
    ...formatProviderSmokeDiagnosis(summary.diagnosis),
    "",
    ...formatProviderSmokeCompatibilityProfile(summary.compatibility),
    "",
    ...results.flatMap(formatProviderSmokeProbeResult),
  ];

  if (summary.report) {
    lines.push(
      "Saved report:",
      `Path: ${summary.report.path}`,
      `JSON: ${summary.report.jsonPath}`,
    );
  }

  return lines.join("\n");
}

export async function runProviderRepairBenchmark(
  runtime: Pick<Runtime, "apiKeyStatus" | "loadedConfig" | "openAIApiKey" | "projectInstructions" | "userConfig">,
  request = "",
): Promise<string> {
  const parsed = parseProviderRepairBenchmarkRequest(request);

  if (!parsed.ok) {
    return parsed.error;
  }

  const result = await runProviderRepairBenchmarkCore(runtime, parsed);

  if (parsed.save) {
    result.report = await exportProviderRepairBenchmarkReport(process.cwd(), result);
  }

  return parsed.json
    ? JSON.stringify(result, null, 2)
    : formatProviderRepairBenchmark(result);
}

type SmokeProbeOptions = {
  allowStreamFallback: boolean;
  prompt: string;
  stream: boolean;
  tool: boolean;
};

type SmokeProbeResult =
  | {
      durationMs: number;
      ok: true;
      result: ModelResult;
      streamFallback: boolean;
      textDeltaChunks: number;
      toolCalls: string[];
    }
  | {
      durationMs: number;
      error: string;
      ok: false;
      streamFallback: boolean;
      textDeltaChunks: number;
      toolCalls: string[];
    };

type ProviderSmokeProbeDefinition = {
  expectedText?: string;
  name: "text" | "unicode" | "streaming" | "tool-call" | "streaming-tool-call";
  prompt: string;
  stream: boolean;
  tool: boolean;
};

type ProviderSmokeProbeResult = ProviderSmokeProbeDefinition & {
  ok: boolean;
  probe: SmokeProbeResult;
  summary: string;
};

type ProviderSmokeRequest = {
  json: boolean;
  profile: ProviderSmokeProfile;
  prompt: string;
  save: boolean;
};

type ProviderSmokeProfile = "quick" | "full";

type ProviderRepairBenchmarkRequest =
  | {
      attempts: number;
      json: boolean;
      ok: true;
      save: boolean;
      task?: string;
    }
  | {
      error: string;
      ok: false;
    };

type ProviderRepairBenchmarkReportResult = {
  exportedAt: string;
  fileName: string;
  jsonFileName: string;
  jsonPath: string;
  path: string;
};

type ProviderRepairBenchmarkResult = {
  apiMode: "chat" | "responses";
  apiModeSource: string;
  apiKeySource: ApiKeySource;
  attempts: number;
  baseURL: string;
  baseURLSource: string;
  client: string;
  clientKind: string;
  durationMs: number;
  fixture: string;
  hasApiKey: boolean;
  initialVerification?: string;
  model: string;
  modelSource: string;
  repairLoop?: string;
  report?: ProviderRepairBenchmarkReportResult;
  status: "fail" | "pass" | "skip";
  summary: string;
  tasks?: Array<{ name: string; status: "pass" | "fail" }>;
};

type ProviderRepairReportSummary = {
  exportedAt: string;
  fileName: string;
  jsonFileName: string;
  jsonPath: string;
  path: string;
  result: ProviderRepairBenchmarkResult;
};

type ProviderRepairComparison = {
  durationDeltaMs: number;
  left: ProviderRepairReportSummary;
  right: ProviderRepairReportSummary;
  status: "changed" | "improved" | "regressed" | "unchanged";
};

type ProviderRepairComparisonResult =
  | ProviderRepairComparison
  | {
      error: string;
      ok: false;
    };

type ProviderSmokeReportResult = {
  exportedAt: string;
  fileName: string;
  jsonFileName: string;
  jsonPath: string;
  path: string;
};

type ProviderSmokeSummary = {
  apiMode: "chat" | "responses";
  apiModeSource: string;
  apiKeySource: ApiKeySource;
  baseURL: string;
  baseURLSource: string;
  client: string;
  clientKind: string;
  compatibility: ProviderSmokeCompatibilityProfile;
  diagnosis: ProviderSmokeDiagnosis;
  failed: number;
  hasApiKey: boolean;
  model: string;
  modelSource: string;
  passed: number;
  profile: ProviderSmokeProfile;
  probes: Array<Record<string, unknown>>;
  report?: ProviderSmokeReportResult;
};

type ProviderSmokeReportSummary = {
  exportedAt: string;
  fileName: string;
  jsonFileName: string;
  jsonPath: string;
  path: string;
  summary: ProviderSmokeSummary;
};

type ProviderSmokeProbeComparison = {
  durationDeltaMs: number;
  left: {
    durationMs: number;
    ok: boolean;
    summary: string;
  } | null;
  name: string;
  right: {
    durationMs: number;
    ok: boolean;
    summary: string;
  } | null;
  status: "changed" | "same";
};

type ProviderSmokeComparison = {
  left: ProviderSmokeReportSummary;
  probes: ProviderSmokeProbeComparison[];
  right: ProviderSmokeReportSummary;
  status: "changed" | "improved" | "regressed" | "unchanged";
};

type ProviderSmokeComparisonResult =
  | ProviderSmokeComparison
  | {
      error: string;
      ok: false;
    };

async function runProviderRepairBenchmarkCore(
  runtime: Pick<Runtime, "apiKeyStatus" | "loadedConfig" | "openAIApiKey" | "projectInstructions" | "userConfig">,
  request: Extract<ProviderRepairBenchmarkRequest, { ok: true }>,
): Promise<ProviderRepairBenchmarkResult> {
  const startedAt = Date.now();
  const resolvedModel = resolveOpenAIModel(
    runtime.loadedConfig.config.model,
    runtime.userConfig.config.model,
  );
  const resolvedApiMode = resolveOpenAIApiMode(
    runtime.loadedConfig.config.openai?.apiMode,
    runtime.userConfig.config.openai?.apiMode,
  );
  const resolvedBaseURL = resolveOpenAIBaseURL(
    runtime.loadedConfig.config.openai?.baseURL,
    runtime.userConfig.config.openai?.baseURL,
  );
  const hasApiKey = runtime.apiKeyStatus.set;
  const clientKind = formatModelClientKind(resolvedApiMode.apiMode, hasApiKey);
  const base = {
    apiMode: resolvedApiMode.apiMode,
    apiModeSource: resolvedApiMode.source,
    apiKeySource: runtime.apiKeyStatus.source,
    attempts: request.attempts,
    baseURL: resolvedBaseURL.baseURL,
    baseURLSource: resolvedBaseURL.source,
    client: hasApiKey ? resolvedModel.model : "mock",
    clientKind,
    fixture: "order-service-project",
    hasApiKey,
    model: resolvedModel.model,
    modelSource: resolvedModel.source,
  };

  if (!hasApiKey) {
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      status: "skip",
      summary: "API key is not set; real provider repair benchmark requires a real model client.",
    };
  }

  const tasks = request.task ? REPAIR_TASKS.filter((task) => task.name === request.task) : REPAIR_TASKS;
  const taskResults: Array<{ name: string; status: "pass" | "fail" }> = [];
  let firstInitial: string | undefined;
  let firstRepair: string | undefined;

  for (const task of tasks) {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "ccagent-provider-repair-"));

    try {
      await createRepairTaskFixture(fixtureRoot, task);

      const agent = new Agent(createSmokeModelClient(runtime), undefined, fixtureRoot, async () => true);
      await agent.handleUserMessage(`/task-state set Provider repair benchmark ${task.name}`);
      const initial = await agent.handleUserMessage("/verify-run package.json");
      const repair = await agent.handleUserMessage(`/repair-loop ${request.attempts}`);
      const passed = repair.content.includes("Repair loop passed") && repair.content.includes("status: passed");

      taskResults.push({ name: task.name, status: passed ? "pass" : "fail" });

      if (firstInitial === undefined) {
        firstInitial = initial.content;
      }

      if (firstRepair === undefined) {
        firstRepair = repair.content;
      }
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  }

  const passedCount = taskResults.filter((task) => task.status === "pass").length;
  const allPassed = passedCount === taskResults.length;

  return {
    ...base,
    fixture: taskResults.length === 1 ? taskResults[0].name : `${taskResults.length} tasks`,
    durationMs: Date.now() - startedAt,
    initialVerification: firstInitial,
    repairLoop: firstRepair,
    status: allPassed ? "pass" : "fail",
    summary: allPassed
      ? `Real provider repaired all ${taskResults.length} task(s) and passed verification.`
      : `Real provider passed ${passedCount}/${taskResults.length} repair task(s).`,
    tasks: taskResults,
  };
}

function formatProviderRepairBenchmark(result: ProviderRepairBenchmarkResult): string {
  const lines = [
    "Provider repair benchmark",
    `Status: ${result.status.toUpperCase()}`,
    `Summary: ${result.summary}`,
    `Client: ${result.client}`,
    `Client kind: ${result.clientKind}`,
    `Configured model: ${result.model} (source: ${result.modelSource})`,
    `OpenAI API mode: ${result.apiMode} (source: ${result.apiModeSource})`,
    `OpenAI base URL: ${result.baseURL} (source: ${result.baseURLSource})`,
    result.hasApiKey
      ? `API key: set (source: ${result.apiKeySource}; real provider was called)`
      : "API key: not set (benchmark skipped)",
    `Fixture: ${result.fixture}`,
    `Attempts: ${result.attempts}`,
    `Duration: ${result.durationMs}ms`,
  ];

  if (result.tasks && result.tasks.length > 0) {
    lines.push("");
    lines.push("Tasks:");
    for (const task of result.tasks) {
      lines.push(`  - ${task.name}: ${task.status.toUpperCase()}`);
    }
  }

  if (result.initialVerification) {
    lines.push("");
    lines.push("Initial verification:");
    lines.push(indentBlock(result.initialVerification, "  "));
  }

  if (result.repairLoop) {
    lines.push("");
    lines.push("Repair loop:");
    lines.push(indentBlock(result.repairLoop, "  "));
  }

  if (result.report) {
    lines.push("");
    lines.push("Saved report:");
    lines.push(`Path: ${result.report.path}`);
    lines.push(`JSON: ${result.report.jsonPath}`);
  }

  if (result.status === "skip") {
    lines.push("");
    lines.push('Next: set OPENAI_API_KEY or run "ccagent login --api-key <key>", confirm /provider-smoke --full passes, then rerun /provider-repair --save.');
  }

  return lines.join("\n");
}

async function exportProviderRepairBenchmarkReport(
  workspaceRoot: string,
  result: ProviderRepairBenchmarkResult,
): Promise<ProviderRepairBenchmarkReportResult> {
  const exportedAt = new Date().toISOString();
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileName = `provider-repair-${formatProviderSmokeTimestamp(exportedAt)}.md`;
  const jsonFileName = `provider-repair-${formatProviderSmokeTimestamp(exportedAt)}.json`;
  const path = `.ccagent/reports/${fileName}`;
  const jsonPath = `.ccagent/reports/${jsonFileName}`;
  const report = {
    exportedAt,
    fileName,
    jsonFileName,
    jsonPath,
    path,
  };
  const payload = {
    ...report,
    result: {
      ...result,
      report: undefined,
    },
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, fileName), buildProviderRepairBenchmarkMarkdown(exportedAt, result), "utf8");
  await writeFile(join(reportsDir, jsonFileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return report;
}

function buildProviderRepairBenchmarkMarkdown(exportedAt: string, result: ProviderRepairBenchmarkResult): string {
  return [
    "# CCAgent Provider Repair Benchmark",
    "",
    `Generated at: ${exportedAt}`,
    "",
    "## Privacy",
    "",
    "- OPENAI_API_KEY value is not included; only set/not set is recorded.",
    "- The benchmark fixture is temporary and is removed after the run.",
    "- Verification and repair summaries are included for debugging provider behavior.",
    "",
    "## Runtime",
    "",
    `- Client: ${result.client}`,
    `- Client kind: ${result.clientKind}`,
    `- Model: ${result.model} (source: ${result.modelSource})`,
    `- API mode: ${result.apiMode} (source: ${result.apiModeSource})`,
    `- Base URL: ${result.baseURL} (source: ${result.baseURLSource})`,
    result.hasApiKey
      ? `- API key: set (source: ${result.apiKeySource})`
      : "- API key: not set",
    "",
    "## Summary",
    "",
    `- Status: ${result.status}`,
    `- Summary: ${result.summary}`,
    `- Fixture: ${result.fixture}`,
    `- Attempts: ${result.attempts}`,
    `- Duration: ${result.durationMs}ms`,
    "",
    ...(result.initialVerification ? [
      "## Initial Verification",
      "",
      "```text",
      result.initialVerification,
      "```",
      "",
    ] : []),
    ...(result.repairLoop ? [
      "## Repair Loop",
      "",
      "```text",
      result.repairLoop,
      "```",
      "",
    ] : []),
  ].join("\n");
}

async function listProviderRepairReports(
  workspaceRoot: string,
  limit = 10,
): Promise<ProviderRepairReportSummary[]> {
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  let fileNames: string[];

  try {
    fileNames = (await readdir(reportsDir))
      .filter((fileName) => /^provider-repair-.+\.json$/.test(fileName))
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }

  const reports = await Promise.all(
    fileNames.map((fileName) => readProviderRepairReport(workspaceRoot, fileName)),
  );

  return reports
    .filter((report): report is ProviderRepairReportSummary => report !== null)
    .sort((left, right) => left.exportedAt.localeCompare(right.exportedAt))
    .slice(-limit)
    .reverse();
}

function formatProviderRepairReports(reports: ProviderRepairReportSummary[]): string {
  const lines = [
    "Provider repair reports",
    `Count: ${reports.length}`,
    "",
  ];

  if (reports.length === 0) {
    lines.push("No provider repair reports found in .ccagent/reports/.");
    return lines.join("\n");
  }

  reports.forEach((report, index) => {
    lines.push(
      `${index + 1}. ${report.exportedAt} status=${report.result.status} model=${report.result.model} mode=${report.result.apiMode} attempts=${report.result.attempts} duration=${report.result.durationMs}ms`,
    );
    lines.push(`   ${report.path}`);
  });

  return lines.join("\n");
}

function formatProviderRepairReportsJson(reports: ProviderRepairReportSummary[]): string {
  return JSON.stringify({ reports }, null, 2);
}

async function readProviderRepairReport(
  workspaceRoot: string,
  fileName: string,
): Promise<ProviderRepairReportSummary | null> {
  try {
    const content = await readFile(join(workspaceRoot, ".ccagent", "reports", fileName), "utf8");
    const parsed = JSON.parse(content) as unknown;

    return parseProviderRepairReportSummary(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function compareProviderRepairReports(
  workspaceRoot: string,
  leftName?: string,
  rightName?: string,
): Promise<ProviderRepairComparisonResult> {
  const reports = leftName || rightName
    ? await Promise.all([
        leftName ? readNamedProviderRepairReport(workspaceRoot, leftName) : Promise.resolve(null),
        rightName ? readNamedProviderRepairReport(workspaceRoot, rightName) : Promise.resolve(null),
      ])
    : await listProviderRepairReports(workspaceRoot, 2);

  if (leftName || rightName) {
    if (!leftName || !rightName) {
      return {
        error: "Usage: /provider-repair-compare [left.json] [right.json] [--json]",
        ok: false,
      };
    }

    const [left, right] = reports as [
      ProviderRepairReportSummary | null,
      ProviderRepairReportSummary | null,
    ];

    if (!left || !right) {
      return {
        error: "Provider repair report not found. Use /provider-repair-reports to list reports.",
        ok: false,
      };
    }

    return buildProviderRepairComparison(left, right);
  }

  if (reports.length < 2) {
    return {
      error: "Need at least two provider repair reports. Run /provider-repair --save twice first.",
      ok: false,
    };
  }

  return buildProviderRepairComparison(reports[1]!, reports[0]!);
}

async function readNamedProviderRepairReport(
  workspaceRoot: string,
  name: string,
): Promise<ProviderRepairReportSummary | null> {
  const fileName = basename(name.replaceAll("\\", "/"));
  const normalizedFileName = fileName.endsWith(".md")
    ? `${fileName.slice(0, -".md".length)}.json`
    : fileName;

  if (!/^provider-repair-.+\.json$/.test(normalizedFileName)) {
    return null;
  }

  return readProviderRepairReport(workspaceRoot, normalizedFileName);
}

function buildProviderRepairComparison(
  left: ProviderRepairReportSummary,
  right: ProviderRepairReportSummary,
): ProviderRepairComparison {
  const durationDeltaMs = right.result.durationMs - left.result.durationMs;
  const leftRank = getProviderRepairStatusRank(left.result.status);
  const rightRank = getProviderRepairStatusRank(right.result.status);
  const status = rightRank < leftRank
    ? "regressed"
    : rightRank > leftRank
      ? "improved"
      : (
          durationDeltaMs !== 0 ||
          left.result.model !== right.result.model ||
          left.result.apiMode !== right.result.apiMode ||
          left.result.baseURL !== right.result.baseURL ||
          left.result.attempts !== right.result.attempts
        )
        ? "changed"
        : "unchanged";

  return {
    durationDeltaMs,
    left,
    right,
    status,
  };
}

function formatProviderRepairComparison(result: ProviderRepairComparisonResult): string {
  if ("error" in result) {
    return result.error;
  }

  return [
    "Provider repair comparison",
    `Status: ${result.status.toUpperCase()}`,
    `Left: ${result.left.fileName} (${result.left.exportedAt})`,
    `Right: ${result.right.fileName} (${result.right.exportedAt})`,
    "",
    "Runtime:",
    `- Model: ${result.left.result.model} -> ${result.right.result.model}`,
    `- API mode: ${result.left.result.apiMode} -> ${result.right.result.apiMode}`,
    `- Base URL: ${result.left.result.baseURL} -> ${result.right.result.baseURL}`,
    `- Attempts: ${result.left.result.attempts} -> ${result.right.result.attempts}`,
    `- Status: ${result.left.result.status} -> ${result.right.result.status}`,
    `- Duration: ${result.left.result.durationMs}ms -> ${result.right.result.durationMs}ms (${formatDurationDelta(result.durationDeltaMs)})`,
    "",
    "Summary:",
    `- Left: ${result.left.result.summary}`,
    `- Right: ${result.right.result.summary}`,
  ].join("\n");
}

function formatProviderRepairComparisonJson(result: ProviderRepairComparisonResult): string {
  return JSON.stringify(result, null, 2);
}

function parseProviderRepairReportSummary(value: unknown): ProviderRepairReportSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const result = record.result;

  if (
    typeof record.exportedAt !== "string" ||
    typeof record.fileName !== "string" ||
    typeof record.jsonFileName !== "string" ||
    typeof record.jsonPath !== "string" ||
    typeof record.path !== "string" ||
    !result ||
    typeof result !== "object"
  ) {
    return null;
  }

  const resultRecord = result as Record<string, unknown>;

  if (
    typeof resultRecord.model !== "string" ||
    typeof resultRecord.apiMode !== "string" ||
    typeof resultRecord.baseURL !== "string" ||
    typeof resultRecord.attempts !== "number" ||
    typeof resultRecord.durationMs !== "number" ||
    typeof resultRecord.status !== "string" ||
    typeof resultRecord.summary !== "string"
  ) {
    return null;
  }

  return {
    exportedAt: record.exportedAt,
    fileName: record.fileName,
    jsonFileName: record.jsonFileName,
    jsonPath: record.jsonPath,
    path: record.path,
    result: result as ProviderRepairBenchmarkResult,
  };
}

function getProviderRepairStatusRank(status: ProviderRepairBenchmarkResult["status"]): number {
  if (status === "pass") {
    return 2;
  }

  if (status === "skip") {
    return 1;
  }

  return 0;
}

async function createRepairTaskFixture(workspaceRoot: string, task: RepairTask): Promise<void> {
  for (const file of task.files) {
    const absolutePath = join(workspaceRoot, file.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
  }
}

function createProviderSmokeProbeDefinitions(
  profile: ProviderSmokeProfile,
  textPrompt: string,
): ProviderSmokeProbeDefinition[] {
  const quickProbes: ProviderSmokeProbeDefinition[] = [
    {
      name: "text",
      prompt: textPrompt,
      stream: false,
      tool: false,
    },
    {
      name: "streaming",
      prompt: textPrompt,
      stream: true,
      tool: false,
    },
    {
      name: "tool-call",
      prompt: "Call the smoke_ping tool exactly once with message set to OK. Do not answer in text.",
      stream: false,
      tool: true,
    },
  ];

  if (profile === "quick") {
    return quickProbes;
  }

  return [
    quickProbes[0],
    {
      expectedText: "\u4f60\u597d",
      name: "unicode",
      prompt: "Reply with exactly: \u4f60\u597d",
      stream: false,
      tool: false,
    },
    quickProbes[1],
    quickProbes[2],
    {
      name: "streaming-tool-call",
      prompt: "Call the smoke_ping tool exactly once with message set to OK. Do not answer in text.",
      stream: true,
      tool: true,
    },
  ];
}

function createSmokeModelClient(
  runtime: Pick<Runtime, "loadedConfig" | "openAIApiKey" | "projectInstructions" | "userConfig">,
): ModelClient {
  const mergedConfig = mergeUserDefaults(runtime.loadedConfig.config, runtime.userConfig.config);

  return createModelClient({
    model: mergedConfig.model,
    openAIApiKey: runtime.openAIApiKey,
    openAIApiMode: mergedConfig.openai?.apiMode,
    openAIBaseURL: mergedConfig.openai?.baseURL,
    providerRetry: mergedConfig.openai?.retry,
    projectInstructions: runtime.projectInstructions.content,
  });
}

async function runSmokeProbe(client: ModelClient, options: SmokeProbeOptions): Promise<SmokeProbeResult> {
  const startedAt = Date.now();
  const streamFallback = options.stream && !client.createTurnStream;

  if (streamFallback && !options.allowStreamFallback) {
    return {
      durationMs: Date.now() - startedAt,
      error: "Streaming is not implemented by this model client.",
      ok: false,
      streamFallback,
      textDeltaChunks: 0,
      toolCalls: [],
    };
  }

  try {
    const input = {
      tools: options.tool ? [MODEL_SMOKE_TOOL] : [],
      userMessage: options.prompt,
    };
    const textDeltas: string[] = [];
    const result =
      options.stream && client.createTurnStream
        ? await client.createTurnStream(input, (event) => {
            if (event.type === "text_delta") {
              textDeltas.push(event.delta);
            }
          })
        : await client.createTurn(input);

    return {
      durationMs: Date.now() - startedAt,
      ok: true,
      result,
      streamFallback,
      textDeltaChunks: textDeltas.length,
      toolCalls: result.toolCalls.map((toolCall) => toolCall.name),
    };
  } catch (error) {
    return {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      streamFallback,
      textDeltaChunks: 0,
      toolCalls: [],
    };
  }
}

function evaluateProviderSmokeProbe(
  definition: ProviderSmokeProbeDefinition,
  probe: SmokeProbeResult,
): { ok: boolean; summary: string } {
  if (!probe.ok) {
    return {
      ok: false,
      summary: probe.error,
    };
  }

  if (definition.tool) {
    if (probe.toolCalls.includes(MODEL_SMOKE_TOOL.name)) {
      return {
        ok: true,
        summary: definition.stream
          ? "streaming smoke_ping tool call returned"
          : "smoke_ping tool call returned",
      };
    }

    return {
      ok: false,
      summary: `missing smoke_ping tool call; got ${formatToolCallNames(probe.toolCalls)}`,
    };
  }

  if (definition.stream) {
    if (probe.streamFallback) {
      return {
        ok: false,
        summary: "streaming was requested but the client fell back to non-streaming",
      };
    }

    if (probe.textDeltaChunks === 0) {
      return {
        ok: false,
        summary: "stream completed without text delta chunks",
      };
    }

    return {
      ok: true,
      summary: `streamed ${probe.textDeltaChunks} text delta chunk(s)`,
    };
  }

  const text = probe.result.content.trim();

  if (text.length === 0) {
    return {
      ok: false,
      summary: "text response was empty",
    };
  }

  if (definition.expectedText && !text.includes(definition.expectedText)) {
    return {
      ok: false,
      summary: `text response did not include ${JSON.stringify(definition.expectedText)}`,
    };
  }

  return {
    ok: true,
    summary: `text response returned (${text.length} chars)`,
  };
}

function formatProviderSmokeProbeResult(result: ProviderSmokeProbeResult): string[] {
  const status = result.ok ? "PASS" : "FAIL";
  const lines = [
    `[${status}] ${result.name} (${result.probe.durationMs}ms): ${result.summary}`,
  ];

  if (result.probe.ok) {
    lines.push(`  Streaming: ${result.stream ? "on" : "off"}`);
    lines.push(`  Tool calls: ${formatToolCallNames(result.probe.toolCalls)}`);
    lines.push(`  ${formatSmokeUsage(result.probe.result.usage)}`);

    if (result.probe.result.toolCalls.length > 0) {
      lines.push(...formatSmokeToolArguments(result.probe.result.toolCalls).map((line) => `  ${line}`));
    }

    if (!result.tool) {
      lines.push(`  Response: ${formatSmokeResponseSnippet(result.probe.result.content)}`);
    }
  }

  return [...lines, ""];
}

function formatProviderSmokeProbeJson(result: ProviderSmokeProbeResult): Record<string, unknown> {
  const base = {
    durationMs: result.probe.durationMs,
    expectedText: result.expectedText,
    name: result.name,
    ok: result.ok,
    prompt: result.prompt,
    stream: result.stream,
    streamFallback: result.probe.streamFallback,
    summary: result.summary,
    textDeltaChunks: result.probe.textDeltaChunks,
    tool: result.tool,
    toolCalls: result.probe.toolCalls,
  };

  if (!result.probe.ok) {
    return {
      ...base,
      error: result.probe.error,
    };
  }

  return {
    ...base,
    responseSnippet: result.tool ? undefined : formatSmokeResponseSnippet(result.probe.result.content),
    toolArguments: result.probe.result.toolCalls.map((toolCall) => ({
      name: toolCall.name,
      rawArguments: toolCall.rawArguments,
    })),
    usage: result.probe.result.usage ?? null,
  };
}

async function exportProviderSmokeReport(
  workspaceRoot: string,
  summary: ProviderSmokeSummary,
): Promise<ProviderSmokeReportResult> {
  const exportedAt = new Date().toISOString();
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileName = `provider-smoke-${formatProviderSmokeTimestamp(exportedAt)}.md`;
  const jsonFileName = `provider-smoke-${formatProviderSmokeTimestamp(exportedAt)}.json`;
  const path = `.ccagent/reports/${fileName}`;
  const jsonPath = `.ccagent/reports/${jsonFileName}`;
  const report: ProviderSmokeReportResult = {
    exportedAt,
    fileName,
    jsonFileName,
    jsonPath,
    path,
  };
  const payload = {
    ...report,
    summary: {
      ...summary,
      report: undefined,
    },
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, fileName), buildProviderSmokeMarkdownReport(exportedAt, summary), "utf8");
  await writeFile(join(reportsDir, jsonFileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return report;
}

function buildProviderSmokeMarkdownReport(exportedAt: string, summary: ProviderSmokeSummary): string {
  return [
    "# CCAgent Provider Smoke Report",
    "",
    `Generated at: ${exportedAt}`,
    "",
    "## Privacy",
    "",
    "- OPENAI_API_KEY value is not included; only set/not set is recorded.",
    "- Prompt text is included because provider compatibility probes are intentionally small.",
    "- Review relay base URLs before sharing this report outside your team.",
    "",
    "## Runtime",
    "",
    `- Client: ${summary.client}`,
    `- Client kind: ${summary.clientKind}`,
    `- Model: ${summary.model} (source: ${summary.modelSource})`,
    `- API mode: ${summary.apiMode} (source: ${summary.apiModeSource})`,
    `- Base URL: ${summary.baseURL} (source: ${summary.baseURLSource})`,
    summary.hasApiKey
      ? `- API key: set (source: ${summary.apiKeySource})`
      : "- API key: not set",
    `- Profile: ${summary.profile}`,
    "",
    "## Summary",
    "",
    `- Passed: ${summary.passed}`,
    `- Failed: ${summary.failed}`,
    "",
    "## Diagnosis",
    "",
    ...formatProviderSmokeDiagnosisMarkdown(summary.diagnosis),
    "",
    "## Compatibility Profile",
    "",
    ...formatProviderSmokeCompatibilityProfileMarkdown(summary.compatibility),
    "",
    "## Probes",
    "",
    "| Probe | Status | Stream | Tool | Duration | Summary |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...summary.probes.map(formatProviderSmokeProbeMarkdownRow),
    "",
  ].join("\n");
}

function formatProviderSmokeDiagnosisMarkdown(diagnosis: ProviderSmokeDiagnosis): string[] {
  const lines = [
    `- Status: ${diagnosis.status}`,
  ];

  if (diagnosis.warnings.length > 0) {
    lines.push("- Warnings:");
    lines.push(...diagnosis.warnings.map((warning) => `  - ${warning}`));
  }

  if (diagnosis.actions.length > 0) {
    lines.push("- Recommended actions:");
    lines.push(...diagnosis.actions.map((action) => `  - ${action}`));
  }

  if (diagnosis.notes.length > 0) {
    lines.push("- Notes:");
    lines.push(...diagnosis.notes.map((note) => `  - ${note}`));
  }

  return lines;
}

function formatProviderSmokeCompatibilityProfileMarkdown(
  profile: ProviderSmokeCompatibilityProfile,
): string[] {
  return [
    `- Status: ${profile.status}`,
    `- Summary: ${profile.summary}`,
    "- Capabilities:",
    ...profile.capabilities.map((capability) => (
      `  - ${capability.name}: ${capability.status} - ${capability.summary}`
    )),
    "- Reuse commands:",
    ...profile.reuseCommands.map((command) => `  - \`${command}\``),
  ];
}

function formatProviderSmokeProbeMarkdownRow(probe: Record<string, unknown>): string {
  return [
    String(probe.name ?? ""),
    probe.ok ? "PASS" : "FAIL",
    probe.stream ? "on" : "off",
    probe.tool ? "on" : "off",
    `${probe.durationMs ?? ""}ms`,
    String(probe.summary ?? ""),
  ].map(escapeMarkdownTableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function formatProviderSmokeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

async function listProviderSmokeReports(
  workspaceRoot: string,
  limit = 10,
): Promise<ProviderSmokeReportSummary[]> {
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  let fileNames: string[];

  try {
    fileNames = (await readdir(reportsDir))
      .filter((fileName) => /^provider-smoke-.+\.json$/.test(fileName))
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }

  const reports = await Promise.all(
    fileNames.map((fileName) => readProviderSmokeReport(workspaceRoot, fileName)),
  );

  return reports
    .filter((report): report is ProviderSmokeReportSummary => report !== null)
    .sort((left, right) => left.exportedAt.localeCompare(right.exportedAt))
    .slice(-limit)
    .reverse();
}

function formatProviderSmokeReports(reports: ProviderSmokeReportSummary[]): string {
  const lines = [
    "Provider smoke reports",
    `Count: ${reports.length}`,
    "",
  ];

  if (reports.length === 0) {
    lines.push("No provider smoke reports found in .ccagent/reports/.");
    return lines.join("\n");
  }

  reports.forEach((report, index) => {
    lines.push(
      `${index + 1}. ${report.summary.profile} ${report.exportedAt} client=${report.summary.client} model=${report.summary.model} mode=${report.summary.apiMode} passed=${report.summary.passed} failed=${report.summary.failed}`,
    );
    lines.push(`   ${report.path}`);
  });

  return lines.join("\n");
}

function formatProviderSmokeReportsJson(reports: ProviderSmokeReportSummary[]): string {
  return JSON.stringify({ reports }, null, 2);
}

type ProviderProfilesRequest =
  | {
      action: "add";
      json: boolean;
      ok: true;
      reportName?: string;
    }
  | {
      action: "list";
      json: boolean;
      ok: true;
    }
  | {
      action: "use";
      id: string;
      json: boolean;
      ok: true;
    }
  | {
      error: string;
      json: boolean;
      ok: false;
    };

type ProviderProfileRegistry = {
  path: string;
  profiles: SavedProviderProfile[];
  version: 1;
};

type SavedProviderProfile = {
  addedAt: string;
  apiMode: "chat" | "responses";
  baseURL: string;
  compatibility: ProviderSmokeCompatibilityProfile;
  exportedAt: string;
  id: string;
  model: string;
  profile: ProviderSmokeProfile;
  sourceReport: string;
};

type ProviderProfileAddResult =
  | {
      added: true;
      path: string;
      profile: SavedProviderProfile;
      registry: ProviderProfileRegistry;
    }
  | {
      added: false;
      path: string;
      reason: string;
      report: string;
      status: ProviderSmokeCompatibilityProfile["status"];
    };

type ProviderProfileUseResult = {
  applied: true;
  changes: Array<{
    action: "set" | "unset";
    key: string;
    value?: string;
  }>;
  configPath: string;
  profile: SavedProviderProfile;
};

async function loadProviderProfileRegistry(workspaceRoot: string): Promise<ProviderProfileRegistry> {
  const path = ".ccagent/provider-profiles.json";

  try {
    const content = await readFile(join(workspaceRoot, path), "utf8");
    const parsed = JSON.parse(content) as unknown;

    return {
      path,
      profiles: parseSavedProviderProfiles(parsed),
      version: 1,
    };
  } catch (error) {
    if (error instanceof SyntaxError || isMissingFileError(error)) {
      return {
        path,
        profiles: [],
        version: 1,
      };
    }

    throw error;
  }
}

async function saveProviderProfileRegistry(
  workspaceRoot: string,
  registry: ProviderProfileRegistry,
): Promise<void> {
  await mkdir(join(workspaceRoot, ".ccagent"), { recursive: true });
  await writeFile(
    join(workspaceRoot, registry.path),
    `${JSON.stringify({ profiles: registry.profiles, version: registry.version }, null, 2)}\n`,
    "utf8",
  );
}

async function addProviderProfileFromReport(
  workspaceRoot: string,
  reportName?: string,
): Promise<ProviderProfileAddResult | { error: string; ok: false }> {
  const report = reportName
    ? await readNamedProviderSmokeReport(workspaceRoot, reportName)
    : (await listProviderSmokeReports(workspaceRoot, 1))[0] ?? null;

  if (!report) {
    return {
      error: "Provider smoke report not found. Run /provider-smoke --full --save first, or pass a provider-smoke-*.json file.",
      ok: false,
    };
  }

  const compatibility = getProviderSmokeCompatibilityProfile(report);

  if (compatibility.status !== "known-good") {
    return {
      added: false,
      path: ".ccagent/provider-profiles.json",
      reason: `report compatibility status is ${compatibility.status}; only known-good reports can be saved as provider profiles.`,
      report: report.jsonFileName,
      status: compatibility.status,
    };
  }

  const profile = buildSavedProviderProfile(report, compatibility);
  const registry = await loadProviderProfileRegistry(workspaceRoot);
  registry.profiles = [
    ...registry.profiles.filter((existing) => (
      existing.baseURL !== profile.baseURL ||
      existing.apiMode !== profile.apiMode ||
      existing.model !== profile.model
    )),
    profile,
  ].sort((left, right) => left.id.localeCompare(right.id));
  await saveProviderProfileRegistry(workspaceRoot, registry);

  return {
    added: true,
    path: registry.path,
    profile,
    registry,
  };
}

async function useProviderProfile(
  workspaceRoot: string,
  id: string,
): Promise<ProviderProfileUseResult | { error: string; ok: false }> {
  const registry = await loadProviderProfileRegistry(workspaceRoot);
  const profile = registry.profiles.find((candidate) => candidate.id === id);

  if (!profile) {
    return {
      error: "Provider profile not found. Use /provider-profiles to list saved profile IDs.",
      ok: false,
    };
  }

  const modelResult = await setConfigValue(workspaceRoot, "model", profile.model);
  await setConfigValue(workspaceRoot, "openai.apiMode", profile.apiMode);
  const changes: ProviderProfileUseResult["changes"] = [
    { action: "set", key: "model", value: profile.model },
    { action: "set", key: "openai.apiMode", value: profile.apiMode },
  ];

  if (isOfficialOpenAIBaseURL(profile.baseURL)) {
    await unsetConfigValue(workspaceRoot, "openai.baseURL");
    changes.push({ action: "unset", key: "openai.baseURL" });
  } else {
    await setConfigValue(workspaceRoot, "openai.baseURL", profile.baseURL);
    changes.push({ action: "set", key: "openai.baseURL", value: profile.baseURL });
  }

  return {
    applied: true,
    changes,
    configPath: modelResult.path,
    profile,
  };
}

function formatProviderProfiles(registry: ProviderProfileRegistry): string {
  const lines = [
    "Provider profiles",
    `Path: ${registry.path}`,
    `Count: ${registry.profiles.length}`,
    "",
  ];

  if (registry.profiles.length === 0) {
    lines.push("No known-good provider profiles saved.");
    lines.push("Run /provider-smoke --full --save with a real API key, then /provider-profiles add.");
    return lines.join("\n");
  }

  registry.profiles.forEach((profile, index) => {
    lines.push(
      `${index + 1}. ${profile.id} model=${profile.model} mode=${profile.apiMode} status=${profile.compatibility.status}`,
    );
    lines.push(`   baseURL=${profile.baseURL}`);
    lines.push(`   source=${profile.sourceReport}`);
  });

  return lines.join("\n");
}

function formatProviderProfileUseResult(result: ProviderProfileUseResult): string {
  return [
    "Provider profile applied",
    `ID: ${result.profile.id}`,
    `Config path: ${result.configPath}`,
    "Changes:",
    ...result.changes.map((change) => (
      change.action === "unset"
        ? `- unset ${change.key}`
        : `- set ${change.key} = ${change.value}`
    )),
  ].join("\n");
}

function formatProviderProfileAddResult(result: ProviderProfileAddResult): string {
  if (!result.added) {
    return [
      "Provider profile not added",
      `Report: ${result.report}`,
      `Status: ${result.status}`,
      `Reason: ${result.reason}`,
      "Next: run /provider-smoke --full --save with a real API key and all probes passing.",
    ].join("\n");
  }

  return [
    "Provider profile saved",
    `Path: ${result.path}`,
    `ID: ${result.profile.id}`,
    `Model: ${result.profile.model}`,
    `API mode: ${result.profile.apiMode}`,
    `Base URL: ${result.profile.baseURL}`,
    `Source report: ${result.profile.sourceReport}`,
  ].join("\n");
}

function getProviderSmokeCompatibilityProfile(
  report: ProviderSmokeReportSummary,
): ProviderSmokeCompatibilityProfile {
  if (report.summary.compatibility) {
    return report.summary.compatibility;
  }

  return buildProviderSmokeCompatibilityProfile({
    apiMode: report.summary.apiMode,
    apiModeSource: report.summary.apiModeSource,
    baseURL: report.summary.baseURL,
    baseURLSource: report.summary.baseURLSource,
    failed: report.summary.failed,
    hasApiKey: report.summary.hasApiKey,
    model: report.summary.model,
    passed: report.summary.passed,
    profile: report.summary.profile,
    probes: report.summary.probes.map((probe) => ({
      name: String(probe.name ?? ""),
      ok: Boolean(probe.ok),
      stream: Boolean(probe.stream),
      summary: String(probe.summary ?? ""),
      tool: Boolean(probe.tool),
    })),
  });
}

function buildSavedProviderProfile(
  report: ProviderSmokeReportSummary,
  compatibility: ProviderSmokeCompatibilityProfile,
): SavedProviderProfile {
  return {
    addedAt: new Date().toISOString(),
    apiMode: report.summary.apiMode,
    baseURL: report.summary.baseURL,
    compatibility,
    exportedAt: report.exportedAt,
    id: createProviderProfileId(report.summary.baseURL, report.summary.apiMode, report.summary.model),
    model: report.summary.model,
    profile: report.summary.profile,
    sourceReport: report.jsonFileName,
  };
}

function createProviderProfileId(baseURL: string, apiMode: string, model: string): string {
  return sanitizeProviderProfilePart(`${providerProfileBaseLabel(baseURL)}-${apiMode}-${model}`);
}

function providerProfileBaseLabel(baseURL: string): string {
  try {
    return new URL(baseURL).host || baseURL;
  } catch {
    return baseURL;
  }
}

function sanitizeProviderProfilePart(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized || "provider-profile";
}

function isOfficialOpenAIBaseURL(baseURL: string): boolean {
  return baseURL.trim().replace(/\/+$/, "").toLowerCase() === "https://api.openai.com/v1";
}

function parseSavedProviderProfiles(value: unknown): SavedProviderProfile[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const profiles = (value as { profiles?: unknown }).profiles;

  if (!Array.isArray(profiles)) {
    return [];
  }

  return profiles.filter((profile): profile is SavedProviderProfile => (
    Boolean(profile) &&
    typeof profile === "object" &&
    typeof (profile as { id?: unknown }).id === "string" &&
    typeof (profile as { model?: unknown }).model === "string" &&
    typeof (profile as { apiMode?: unknown }).apiMode === "string" &&
    typeof (profile as { baseURL?: unknown }).baseURL === "string" &&
    typeof (profile as { sourceReport?: unknown }).sourceReport === "string"
  ));
}

async function readProviderSmokeReport(
  workspaceRoot: string,
  fileName: string,
): Promise<ProviderSmokeReportSummary | null> {
  try {
    const content = await readFile(join(workspaceRoot, ".ccagent", "reports", fileName), "utf8");
    const parsed = JSON.parse(content) as unknown;

    return parseProviderSmokeReportSummary(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function compareProviderSmokeReports(
  workspaceRoot: string,
  leftName?: string,
  rightName?: string,
): Promise<ProviderSmokeComparisonResult> {
  const reports = leftName || rightName
    ? await Promise.all([
        leftName ? readNamedProviderSmokeReport(workspaceRoot, leftName) : Promise.resolve(null),
        rightName ? readNamedProviderSmokeReport(workspaceRoot, rightName) : Promise.resolve(null),
      ])
    : await listProviderSmokeReports(workspaceRoot, 2);

  if (leftName || rightName) {
    if (!leftName || !rightName) {
      return {
        error: "Usage: /provider-compare [left.json] [right.json] [--json]",
        ok: false,
      };
    }

    const [left, right] = reports as [
      ProviderSmokeReportSummary | null,
      ProviderSmokeReportSummary | null,
    ];

    if (!left || !right) {
      return {
        error: "Provider smoke report not found. Use /provider-reports to list reports.",
        ok: false,
      };
    }

    return buildProviderSmokeComparison(left, right);
  }

  if (reports.length < 2) {
    return {
      error: "Need at least two provider smoke reports. Run /provider-smoke --save twice first.",
      ok: false,
    };
  }

  return buildProviderSmokeComparison(reports[1]!, reports[0]!);
}

async function readNamedProviderSmokeReport(
  workspaceRoot: string,
  name: string,
): Promise<ProviderSmokeReportSummary | null> {
  const fileName = basename(name.replaceAll("\\", "/"));
  const normalizedFileName = fileName.endsWith(".md")
    ? `${fileName.slice(0, -".md".length)}.json`
    : fileName;

  if (!/^provider-smoke-.+\.json$/.test(normalizedFileName)) {
    return null;
  }

  return readProviderSmokeReport(workspaceRoot, normalizedFileName);
}

function buildProviderSmokeComparison(
  left: ProviderSmokeReportSummary,
  right: ProviderSmokeReportSummary,
): ProviderSmokeComparison {
  const leftProbes = new Map(left.summary.probes.map((probe) => [
    String(probe.name ?? ""),
    {
      durationMs: Number(probe.durationMs ?? 0),
      ok: Boolean(probe.ok),
      summary: String(probe.summary ?? ""),
    },
  ]));
  const rightProbes = new Map(right.summary.probes.map((probe) => [
    String(probe.name ?? ""),
    {
      durationMs: Number(probe.durationMs ?? 0),
      ok: Boolean(probe.ok),
      summary: String(probe.summary ?? ""),
    },
  ]));
  const names = [...new Set([...leftProbes.keys(), ...rightProbes.keys()])];
  const probes: ProviderSmokeProbeComparison[] = names.map((name) => {
    const leftProbe = leftProbes.get(name) ?? null;
    const rightProbe = rightProbes.get(name) ?? null;

    return {
      durationDeltaMs: (rightProbe?.durationMs ?? 0) - (leftProbe?.durationMs ?? 0),
      left: leftProbe,
      name,
      right: rightProbe,
      status: leftProbe?.ok === rightProbe?.ok && leftProbe?.summary === rightProbe?.summary
        ? "same"
        : "changed",
    };
  });
  const hasRegression =
    right.summary.failed > left.summary.failed ||
    right.summary.passed < left.summary.passed ||
    probes.some((probe) => probe.left?.ok === true && (!probe.right || !probe.right.ok));
  const hasImprovement =
    right.summary.failed < left.summary.failed ||
    right.summary.passed > left.summary.passed ||
    probes.some((probe) => probe.right?.ok === true && (!probe.left || !probe.left.ok));
  const status = hasRegression
    ? "regressed"
    : hasImprovement
      ? "improved"
      : probes.some((probe) => probe.status === "changed")
        ? "changed"
        : "unchanged";

  return {
    left,
    probes,
    right,
    status,
  };
}

function formatProviderSmokeComparison(result: ProviderSmokeComparisonResult): string {
  if ("error" in result) {
    return result.error;
  }

  const lines = [
    "Provider smoke comparison",
    `Status: ${result.status.toUpperCase()}`,
    `Left: ${result.left.fileName} (${result.left.exportedAt})`,
    `Right: ${result.right.fileName} (${result.right.exportedAt})`,
    "",
    "Runtime:",
    `- Model: ${result.left.summary.model} -> ${result.right.summary.model}`,
    `- API mode: ${result.left.summary.apiMode} -> ${result.right.summary.apiMode}`,
    `- Base URL: ${result.left.summary.baseURL} -> ${result.right.summary.baseURL}`,
    `- Profile: ${result.left.summary.profile} -> ${result.right.summary.profile}`,
    `- Passed: ${result.left.summary.passed} -> ${result.right.summary.passed}`,
    `- Failed: ${result.left.summary.failed} -> ${result.right.summary.failed}`,
    "",
    "Probes:",
  ];

  for (const probe of result.probes) {
    lines.push(
      `- ${probe.name}: ${formatProviderProbeStatus(probe.left)} -> ${formatProviderProbeStatus(probe.right)}; duration delta=${formatDurationDelta(probe.durationDeltaMs)}`,
    );
  }

  return lines.join("\n");
}

function formatProviderSmokeComparisonJson(result: ProviderSmokeComparisonResult): string {
  return JSON.stringify(result, null, 2);
}

function formatProviderProbeStatus(
  probe: ProviderSmokeProbeComparison["left"],
): string {
  if (!probe) {
    return "missing";
  }

  return probe.ok ? "PASS" : "FAIL";
}

function formatDurationDelta(deltaMs: number): string {
  return deltaMs > 0 ? `+${deltaMs}ms` : `${deltaMs}ms`;
}

function indentBlock(value: string, prefix: string): string {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function parseProviderSmokeReportSummary(value: unknown): ProviderSmokeReportSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const summary = record.summary;

  if (
    typeof record.exportedAt !== "string" ||
    typeof record.fileName !== "string" ||
    typeof record.jsonFileName !== "string" ||
    typeof record.jsonPath !== "string" ||
    typeof record.path !== "string" ||
    !summary ||
    typeof summary !== "object"
  ) {
    return null;
  }

  const summaryRecord = summary as Record<string, unknown>;

  if (
    typeof summaryRecord.client !== "string" ||
    typeof summaryRecord.model !== "string" ||
    typeof summaryRecord.apiMode !== "string" ||
    typeof summaryRecord.profile !== "string" ||
    typeof summaryRecord.passed !== "number" ||
    typeof summaryRecord.failed !== "number"
  ) {
    return null;
  }

  return {
    exportedAt: record.exportedAt,
    fileName: record.fileName,
    jsonFileName: record.jsonFileName,
    jsonPath: record.jsonPath,
    path: record.path,
    summary: summary as ProviderSmokeSummary,
  };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

function formatToolCallNames(toolCalls: string[]): string {
  return toolCalls.length > 0 ? toolCalls.join(", ") : "(none)";
}

function formatSmokeResponseSnippet(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");

  if (!normalized) {
    return "(empty)";
  }

  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function formatModelClientKind(apiMode: "responses" | "chat", hasApiKey: boolean): string {
  if (!hasApiKey) {
    return "mock (OPENAI_API_KEY is not set)";
  }

  return apiMode === "chat"
    ? "openai-chat (/v1/chat/completions)"
    : "openai-responses (/v1/responses)";
}

function parseModelSmokeRequest(request: string): { prompt: string; stream: boolean; tool: boolean } {
  let rest = request.trim();
  let stream = false;
  let tool = false;

  while (rest.length > 0) {
    if (rest === "--stream" || rest.startsWith("--stream ")) {
      stream = true;
      rest = rest.slice("--stream".length).trimStart();
      continue;
    }

    if (rest === "--tool" || rest.startsWith("--tool ")) {
      tool = true;
      rest = rest.slice("--tool".length).trimStart();
      continue;
    }

    if (rest === "--tools" || rest.startsWith("--tools ")) {
      tool = true;
      rest = rest.slice("--tools".length).trimStart();
      continue;
    }

    break;
  }

  return {
    prompt: rest.trim(),
    stream,
    tool,
  };
}

function parseProviderSmokeRequest(request: string): ProviderSmokeRequest {
  let rest = request.trim();
  let json = false;
  let profile: ProviderSmokeProfile = "quick";
  let save = false;

  while (rest.length > 0) {
    if (rest === "--json" || rest.startsWith("--json ")) {
      json = true;
      rest = rest.slice("--json".length).trimStart();
      continue;
    }

    if (rest === "--save" || rest.startsWith("--save ")) {
      save = true;
      rest = rest.slice("--save".length).trimStart();
      continue;
    }

    if (rest === "--full" || rest.startsWith("--full ")) {
      profile = "full";
      rest = rest.slice("--full".length).trimStart();
      continue;
    }

    if (rest === "--profile full" || rest.startsWith("--profile full ")) {
      profile = "full";
      rest = rest.slice("--profile full".length).trimStart();
      continue;
    }

    if (rest === "--profile=full" || rest.startsWith("--profile=full ")) {
      profile = "full";
      rest = rest.slice("--profile=full".length).trimStart();
      continue;
    }

    if (rest === "--profile quick" || rest.startsWith("--profile quick ")) {
      profile = "quick";
      rest = rest.slice("--profile quick".length).trimStart();
      continue;
    }

    if (rest === "--profile=quick" || rest.startsWith("--profile=quick ")) {
      profile = "quick";
      rest = rest.slice("--profile=quick".length).trimStart();
      continue;
    }

    break;
  }

  return {
    json,
    profile,
    prompt: rest.trim(),
    save,
  };
}

function parseProviderRepairBenchmarkRequest(request: string): ProviderRepairBenchmarkRequest {
  let rest = request.trim();
  let attempts = 1;
  let json = false;
  let save = false;
  let task: string | undefined;

  while (rest.length > 0) {
    if (rest === "--json" || rest.startsWith("--json ")) {
      json = true;
      rest = rest.slice("--json".length).trimStart();
      continue;
    }

    if (rest === "--save" || rest.startsWith("--save ")) {
      save = true;
      rest = rest.slice("--save".length).trimStart();
      continue;
    }

    if (rest === "--task" || rest.startsWith("--task ")) {
      const [value, ...remaining] = rest.slice("--task".length).trimStart().split(/\s+/);

      if (!value || !listRepairTaskNames().includes(value)) {
        return {
          error: `Unknown repair task: ${value ?? "(none)"}. Available: ${listRepairTaskNames().join(", ")}.`,
          ok: false,
        };
      }

      task = value;
      rest = remaining.join(" ").trimStart();
      continue;
    }

    if (rest.startsWith("--task=")) {
      const value = rest.slice("--task=".length).trim();

      if (!value || !listRepairTaskNames().includes(value)) {
        return {
          error: `Unknown repair task: ${value || "(none)"}. Available: ${listRepairTaskNames().join(", ")}.`,
          ok: false,
        };
      }

      task = value;
      rest = "";
      continue;
    }

    if (rest.startsWith("--attempts=")) {
      const [value, ...remaining] = rest.slice("--attempts=".length).split(/\s+/);
      const parsed = Number(value);

      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
        return {
          error: formatProviderRepairBenchmarkUsage(),
          ok: false,
        };
      }

      attempts = parsed;
      rest = remaining.join(" ").trimStart();
      continue;
    }

    if (rest === "--attempts" || rest.startsWith("--attempts ")) {
      const parts = rest.slice("--attempts".length).trimStart().split(/\s+/).filter(Boolean);
      const value = parts[0];
      const parsed = Number(value);

      if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
        return {
          error: formatProviderRepairBenchmarkUsage(),
          ok: false,
        };
      }

      attempts = parsed;
      rest = parts.slice(1).join(" ").trimStart();
      continue;
    }

    return {
      error: formatProviderRepairBenchmarkUsage(),
      ok: false,
    };
  }

  return {
    attempts,
    json,
    ok: true,
    save,
    task,
  };
}

function formatProviderRepairBenchmarkUsage(): string {
  return "Usage: /provider-repair [--attempts <1-5>] [--task <name>] [--save] [--json]";
}

function parseProviderProfilesRequest(request: string): ProviderProfilesRequest {
  let rest = request.trim();
  let json = false;

  while (rest.length > 0) {
    if (rest === "--json" || rest.startsWith("--json ")) {
      json = true;
      rest = rest.slice("--json".length).trimStart();
      continue;
    }

    break;
  }

  if (!rest) {
    return {
      action: "list",
      json,
      ok: true,
    };
  }

  if (rest === "add" || rest.startsWith("add ")) {
    rest = rest.slice("add".length).trimStart();

    while (rest.length > 0) {
      if (rest === "--json" || rest.startsWith("--json ")) {
        json = true;
        rest = rest.slice("--json".length).trimStart();
        continue;
      }

      break;
    }

    const parts = rest.split(/\s+/).filter(Boolean);

    if (parts.length > 1) {
      return {
        error: formatProviderProfilesUsage(),
        json,
        ok: false,
      };
    }

    return {
      action: "add",
      json,
      ok: true,
      ...(parts[0] ? { reportName: parts[0] } : {}),
    };
  }

  if (rest === "use" || rest.startsWith("use ")) {
    rest = rest.slice("use".length).trimStart();

    while (rest.length > 0) {
      if (rest === "--json" || rest.startsWith("--json ")) {
        json = true;
        rest = rest.slice("--json".length).trimStart();
        continue;
      }

      break;
    }

    const parts = rest.split(/\s+/).filter(Boolean);

    if (parts.length !== 1) {
      return {
        error: formatProviderProfilesUsage(),
        json,
        ok: false,
      };
    }

    return {
      action: "use",
      id: parts[0]!,
      json,
      ok: true,
    };
  }

  return {
    error: formatProviderProfilesUsage(),
    json,
    ok: false,
  };
}

function formatProviderProfilesUsage(): string {
  return [
    "Usage: /provider-profiles [--json]",
    "       /provider-profiles add [provider-smoke-*.json] [--json]",
    "       /provider-profiles use <id> [--json]",
  ].join("\n");
}

function parseProviderReportsRequest(
  request: string,
  commandName = "/provider-reports",
): { json: boolean; limit: number; ok: true } | { error: string; ok: false } {
  const usage = `Usage: ${commandName} [count] [--json]`;
  const parts = request.trim().length > 0 ? request.trim().split(/\s+/) : [];
  let json = false;
  let limit = 10;
  let countSet = false;

  for (const part of parts) {
    if (part === "--json") {
      json = true;
      continue;
    }

    if (/^\d+$/.test(part) && !countSet) {
      const parsed = Number(part);

      if (parsed >= 1 && parsed <= 100) {
        limit = parsed;
        countSet = true;
        continue;
      }
    }

    return {
      error: usage,
      ok: false,
    };
  }

  return {
    json,
    limit,
    ok: true,
  };
}

function parseProviderCompareRequest(
  request: string,
  commandName = "/provider-compare",
): { json: boolean; leftName?: string; ok: true; rightName?: string } | { error: string; json: boolean; ok: false } {
  const usage = `Usage: ${commandName} [left.json] [right.json] [--json]`;
  const parts = request.trim().length > 0 ? request.trim().split(/\s+/) : [];
  const names: string[] = [];
  let json = false;

  for (const part of parts) {
    if (part === "--json") {
      json = true;
      continue;
    }

    names.push(part);
  }

  if (names.length !== 0 && names.length !== 2) {
    return {
      error: usage,
      json,
      ok: false,
    };
  }

  return {
    json,
    ok: true,
    ...(names[0] ? { leftName: names[0] } : {}),
    ...(names[1] ? { rightName: names[1] } : {}),
  };
}

function formatToolSmokeResult(toolCalls: string[]): string {
  return toolCalls.includes(MODEL_SMOKE_TOOL.name)
    ? "on (smoke_ping returned)"
    : "on (missing smoke_ping)";
}

function formatSmokeToolArguments(toolCalls: Array<{ name: string; rawArguments: string }>): string[] {
  if (toolCalls.length === 0) {
    return [];
  }

  return [
    "Tool arguments:",
    ...toolCalls.map((toolCall) => `- ${toolCall.name}: ${toolCall.rawArguments}`),
  ];
}

function formatSmokeUsage(usage: ModelUsage | undefined): string {
  if (!usage) {
    return "Usage: (provider did not return usage)";
  }

  const parts = [
    usage.inputTokens !== undefined ? `input=${usage.inputTokens}` : undefined,
    usage.outputTokens !== undefined ? `output=${usage.outputTokens}` : undefined,
    usage.totalTokens !== undefined ? `total=${usage.totalTokens}` : undefined,
    usage.cachedInputTokens !== undefined ? `cached_input=${usage.cachedInputTokens}` : undefined,
  ].filter(Boolean);
  const suffix = usage.estimated ? " estimated=yes" : "";

  return `Usage: ${parts.length > 0 ? parts.join(", ") : "(none)"}${suffix}`;
}

export async function loadCheckpointCompletionNames(workspaceRoot: string): Promise<string[]> {
  try {
    const checkpointDir = new SessionStore(workspaceRoot).checkpointDir;
    const entries = await readdir(checkpointDir, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter(isValidSessionCheckpointName)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function saveCurrentSession(runtime: Runtime): Promise<void> {
  if (!runtime.useSession || !runtime.sessionStore || !runtime.sessionCreatedAt) {
    return;
  }

  await runtime.sessionStore.save(createCurrentSessionSnapshot(runtime));
}

async function recordTerminalHistoryInput(runtime: Runtime, inputText: string): Promise<void> {
  if (!runtime.terminalHistory) {
    return;
  }

  const nextEntries = addTerminalHistoryEntry(runtime.terminalHistory.entries, inputText);

  if (sameStringList(nextEntries, runtime.terminalHistory.entries)) {
    return;
  }

  runtime.terminalHistory = await saveTerminalHistory(process.cwd(), nextEntries);
  runtime.reader.setHistory(nextEntries);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createCurrentSessionSnapshot(runtime: Runtime) {
  const session = runtime.agent.snapshotSession();

  return {
    ...session,
    createdAt: runtime.sessionCreatedAt ?? session.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function formatCurrentSession(
  agent: Agent,
  path: string,
  createdAt: string,
): string {
  const snapshot = agent.snapshotSession();

  return formatLoadedSession({
    path,
    exists: true,
    session: {
      ...snapshot,
      createdAt,
      updatedAt: new Date().toISOString(),
    },
    warnings: [],
  });
}

function formatSessionCommandResult(runtime: Runtime, command: string): string {
  if (command === "/session show" || command.startsWith("/session show ")) {
    const parsed = parseSessionShowRequest(command.slice("/session show".length).trim());

    if (!parsed.ok) {
      return parsed.error;
    }

    return formatCurrentSessionDetails(runtime, parsed.limit);
  }

  if (command === "/session stats") {
    return formatCurrentSessionStats(runtime);
  }

  if (command.startsWith("/session search ")) {
    return formatCurrentSessionSearch(runtime, command.slice("/session search ".length));
  }

  if (!runtime.sessionStore || !runtime.sessionCreatedAt) {
    return "Session disabled for this run. Start without --no-session to load and save .ccagent/sessions/current.json.";
  }

  return formatCurrentSession(runtime.agent, runtime.sessionStore.path, runtime.sessionCreatedAt);
}

function formatCurrentSessionSearch(runtime: Runtime, query: string): string {
  if (!runtime.sessionStore) {
    return "Session disabled for this run. Start without --no-session to load and save .ccagent/sessions/current.json.";
  }

  return formatSessionSearch("Current session search", {
    path: runtime.sessionStore.path,
    exists: Boolean(runtime.sessionCreatedAt),
    session: createCurrentSessionSnapshot(runtime),
    warnings: [],
  }, query);
}

function formatSessionUsage(): string {
  return [
    "Usage: /session",
    "       /session show [--limit <count>]",
    "       /session stats",
    "       /session search <query>",
  ].join("\n");
}

type SessionShowRequest =
  | {
      ok: true;
      limit?: number;
    }
  | {
      ok: false;
      error: string;
    };

function parseSessionShowRequest(request: string): SessionShowRequest {
  const usage = "Usage: /session show [--limit <count>]\ncount must be between 1 and 100.";
  return parseOptionalLimitArgs(request.split(/\s+/).filter(Boolean), usage);
}

function parseOptionalLimitArgs(parts: string[], usage: string): SessionShowRequest {
  if (parts.length === 0) {
    return { ok: true };
  }

  if (parts.length === 1 && parts[0]?.startsWith("--limit=")) {
    return parseLimitValue(parts[0].slice("--limit=".length), usage);
  }

  if (parts.length === 2 && parts[0] === "--limit") {
    return parseLimitValue(parts[1] ?? "", usage);
  }

  return {
    ok: false,
    error: usage,
  };
}

function parseLimitValue(value: string, usage: string): SessionShowRequest {
  if (!isIntegerText(value)) {
    return {
      ok: false,
      error: usage,
    };
  }

  const limit = Number(value);

  if (limit < 1 || limit > 100) {
    return {
      ok: false,
      error: usage,
    };
  }

  return {
    ok: true,
    limit,
  };
}

function formatCurrentSessionStats(runtime: Runtime): string {
  if (!runtime.sessionStore) {
    return "Session disabled for this run. Start without --no-session to load and save .ccagent/sessions/current.json.";
  }

  return formatSessionStats("Current session stats", {
    path: runtime.sessionStore.path,
    exists: Boolean(runtime.sessionCreatedAt),
    session: createCurrentSessionSnapshot(runtime),
    warnings: [],
  });
}

function formatCurrentSessionDetails(runtime: Runtime, messageLimit?: number): string {
  if (!runtime.sessionStore) {
    return "Session disabled for this run. Start without --no-session to load and save .ccagent/sessions/current.json.";
  }

  return formatSessionDetails("Current session", {
    path: runtime.sessionStore.path,
    exists: Boolean(runtime.sessionCreatedAt),
    session: createCurrentSessionSnapshot(runtime),
    warnings: [],
  }, { messageLimit });
}

async function confirmToolExecution(
  reader: LineReader,
  request: ToolApprovalRequest,
  loadedConfig: LoadedConfig,
  allowEdits: boolean,
  stream: boolean,
  json: boolean,
  rich: boolean,
  debug: DebugLogger,
  renderer: OutputRenderer,
): Promise<boolean> {
  if (isPatchApprovalTool(request.toolName) && allowEdits) {
    debug("approval.auto_approved_edit", { toolName: request.toolName });
    if (!json) {
      output.write(`\nAuto-approved ${request.toolName} from --allow-edits.\n`);
    }
    return true;
  }

  if (
    request.toolName === "run_shell" &&
    typeof request.input.command === "string" &&
    isAutoApprovedShellCommand(loadedConfig, request.input.command)
  ) {
    debug("approval.auto_approved", {
      toolName: request.toolName,
      command: request.input.command,
    });
    if (!json) {
      output.write(`\nAuto-approved ${request.toolName} from config:\n${request.input.command}\n`);
    }
    return true;
  }

  if (!input.isTTY) {
    debug("approval.denied_non_interactive", { toolName: request.toolName });
    if (!json) {
      output.write(`\nApproval required for ${request.toolName}, but stdin is not interactive.\n`);
    }
    return false;
  }

  if (json) {
    const answer = await reader.read("");
    const approved = parseApprovalChoice(answer) === "approve";
    debug("approval.user_response", { toolName: request.toolName, approved });
    return approved;
  }

  if (!json && !stream && !rich) {
    output.write(
      `\nApproval required for ${request.toolName}:\n${formatApprovalSummary(request)}\n`,
    );
  }

  while (true) {
    const answer = await reader.read(
      "Approve? [y] yes, [n] no, [s] summary, [d] full diff/details: ",
      { promptLine: renderer.writePromptLine?.bind(renderer) },
    );
    const choice = parseApprovalChoice(answer);

    if (choice === "approve") {
      debug("approval.user_response", { toolName: request.toolName, approved: true });
      return true;
    }

    if (choice === "deny") {
      debug("approval.user_response", { toolName: request.toolName, approved: false });
      return false;
    }

    if (choice === "summary") {
      if (rich) {
        await renderer.writeRichBlock?.(formatApprovalSummary(request), `${request.toolName} summary`);
      } else {
        output.write(`\n${formatApprovalSummary(request)}\n\n`);
      }

      continue;
    }

    if (choice === "diff") {
      if (rich) {
        await renderer.writeRichBlock?.(formatApprovalFullDetails(request), `${request.toolName} details`);
      } else {
        output.write(`\n${formatApprovalFullDetails(request)}\n\n`);
      }

      continue;
    }

    if (rich) {
      await renderer.writeMessage(createDefaultRichTheme().yellow("Enter y, n, s, or d."));
    } else {
      output.write("\nEnter y, n, s, or d.\n\n");
    }
  }
}

export type ApprovalChoice = "approve" | "deny" | "summary" | "diff" | "unknown";

export function parseApprovalChoice(value: string | null): ApprovalChoice {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "y" || normalized === "yes") {
    return "approve";
  }

  if (!normalized || normalized === "n" || normalized === "no") {
    return "deny";
  }

  if (normalized === "s" || normalized === "summary") {
    return "summary";
  }

  if (normalized === "d" || normalized === "diff" || normalized === "full") {
    return "diff";
  }

  return "unknown";
}

export function formatApprovalSummary(request: ToolApprovalRequest): string {
  if (!isPatchApprovalTool(request.toolName)) {
    return request.message;
  }

  return request.message.split("\n\nPreview:\n", 1)[0] ?? request.message;
}

export function formatApprovalFullDetails(request: ToolApprovalRequest): string {
  if (isPatchApprovalTool(request.toolName) && typeof request.input.patch === "string") {
    return request.input.patch;
  }

  return request.message;
}

function isPatchApprovalTool(toolName: string): boolean {
  return toolName === "apply_patch" || toolName === "reverse_patch" || toolName === "edit";
}
