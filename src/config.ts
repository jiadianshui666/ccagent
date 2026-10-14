import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserCCAgentDir } from "./auth.js";
import type { ToolRiskLevel } from "./preflight.js";
import { SHELL_SANDBOX_MODES, SHELL_SANDBOX_NETWORKS } from "./sandbox.js";
import {
  EXECUTION_GUARD_LEVELS,
  isExecutionGuardLevel,
  type ExecutionGuardLevel,
} from "./injectionGuard.js";

export type CCAgentConfig = {
  model?: string;
  mcp?: {
    enabled?: boolean;
    servers?: Record<string, McpServerConfig>;
  };
  ui?: {
    promptHints?: string[];
    bell?: boolean;
  };
  context?: {
    auto?: boolean;
  };
  openai?: {
    apiMode?: "responses" | "chat";
    baseURL?: string;
    embeddingModel?: string;
    retry?: {
      baseDelayMs?: number;
      maxAttempts?: number;
      maxDelayMs?: number;
    };
  };
  autoApprove?: {
    shellCommands?: string[];
  };
  toolPolicy?: {
    allowWritePaths?: string[];
    deny?: string[];
    denyRisk?: ToolRiskLevel[];
    denyWritePaths?: string[];
    requireApproval?: string[];
    requireApprovalRisk?: ToolRiskLevel[];
    shellSandbox?: string;
    shellSandboxImage?: string;
    shellSandboxNetwork?: string;
    shellSandboxReadOnly?: string;
    shellSandboxMemoryMb?: string;
    shellSandboxCpus?: string;
    shellSandboxPidsLimit?: string;
    executionGuard?: ExecutionGuardLevel;
  };
};

export type McpServerConfig = {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type LoadedConfig = {
  path: string;
  exists: boolean;
  config: CCAgentConfig;
  warnings: string[];
};

export type InitConfigResult =
  | {
      created: true;
      path: string;
    }
  | {
      created: false;
      path: string;
      reason: string;
    };

export type ConfigKey =
  | "model"
  | "context.auto"
  | "ui.promptHints"
  | "ui.bell"
  | "openai.apiMode"
  | "openai.baseURL"
  | "openai.embeddingModel"
  | "openai.retry.baseDelayMs"
  | "openai.retry.maxAttempts"
  | "openai.retry.maxDelayMs"
  | "toolPolicy.allowWritePaths"
  | "toolPolicy.deny"
  | "toolPolicy.denyRisk"
  | "toolPolicy.denyWritePaths"
  | "toolPolicy.requireApprovalRisk"
  | "toolPolicy.requireApproval"
  | "toolPolicy.shellSandbox"
  | "toolPolicy.shellSandboxImage"
  | "toolPolicy.shellSandboxNetwork"
  | "toolPolicy.shellSandboxReadOnly"
  | "toolPolicy.shellSandboxMemoryMb"
  | "toolPolicy.shellSandboxCpus"
  | "toolPolicy.shellSandboxPidsLimit"
  | "toolPolicy.executionGuard";

export type ConfigSetResult = {
  key: ConfigKey;
  path: string;
  value: string;
};

export type ConfigGetResult = {
  exists: boolean;
  key: ConfigKey;
  path: string;
  value?: string;
};

export type ConfigUnsetResult = {
  existed: boolean;
  key: ConfigKey;
  path: string;
};

export type UserConfigKey =
  | "model"
  | "ui.promptHints"
  | "ui.bell"
  | "openai.apiMode"
  | "openai.baseURL"
  | "openai.embeddingModel"
  | "openai.retry.baseDelayMs"
  | "openai.retry.maxAttempts"
  | "openai.retry.maxDelayMs";

export type LoadedUserConfig = {
  path: string;
  exists: boolean;
  config: CCAgentConfig;
  warnings: string[];
};

export type UserConfigSetResult = {
  key: UserConfigKey;
  path: string;
  value: string;
};

export type UserConfigGetResult = {
  exists: boolean;
  key: UserConfigKey;
  path: string;
  value?: string;
};

export type UserConfigUnsetResult = {
  existed: boolean;
  key: UserConfigKey;
  path: string;
};

export type McpConfigResult = {
  action: "added" | "disabled" | "enabled" | "removed";
  args?: string[];
  command?: string;
  enabled: boolean;
  existed?: boolean;
  name?: string;
  path: string;
};

export type FormatPermissionsOptions = {
  allowEdits?: boolean;
  sandboxLabel?: string;
  verifyCommand?: string;
};

const CONFIG_DIR = ".ccagent";
const CONFIG_FILE = "config.json";
const USER_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "model",
  "ui.promptHints",
  "ui.bell",
  "openai.apiMode",
  "openai.baseURL",
  "openai.embeddingModel",
  "openai.retry.baseDelayMs",
  "openai.retry.maxAttempts",
  "openai.retry.maxDelayMs",
]);
const USER_CONFIG_KEY_LIST =
  "model, ui.promptHints, ui.bell, openai.apiMode, openai.baseURL, openai.embeddingModel, openai.retry.baseDelayMs, openai.retry.maxAttempts, openai.retry.maxDelayMs";
const DEFAULT_CONFIG: CCAgentConfig = {
  model: "gpt-5.5",
  mcp: {
    enabled: false,
    servers: {},
  },
  context: {
    auto: true,
  },
  openai: {
    apiMode: "responses",
    retry: {
      baseDelayMs: 250,
      maxAttempts: 3,
      maxDelayMs: 2000,
    },
  },
  autoApprove: {
    shellCommands: [],
  },
  toolPolicy: {
    allowWritePaths: [],
    deny: [],
    denyRisk: [],
    denyWritePaths: [],
    requireApproval: [],
    requireApprovalRisk: [],
    shellSandbox: "off",
    shellSandboxImage: "alpine:3.20",
    shellSandboxNetwork: "none",
    shellSandboxReadOnly: "true",
    shellSandboxMemoryMb: "2048",
    shellSandboxCpus: "2",
    shellSandboxPidsLimit: "512",
    executionGuard: "deny",
  },
};

export async function initConfig(workspaceRoot: string): Promise<InitConfigResult> {
  const configDir = join(workspaceRoot, CONFIG_DIR);
  const configPath = join(configDir, CONFIG_FILE);
  const existing = await loadConfig(workspaceRoot);

  if (existing.exists) {
    return {
      created: false,
      path: configPath,
      reason: "Config already exists.",
    };
  }

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");

  return {
    created: true,
    path: configPath,
  };
}

export async function loadConfig(workspaceRoot: string): Promise<LoadedConfig> {
  const configPath = join(workspaceRoot, CONFIG_DIR, CONFIG_FILE);

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;
    const warnings: string[] = [];
    const config = parseConfig(parsed, warnings);

    return {
      path: configPath,
      exists: true,
      config,
      warnings,
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        path: configPath,
        exists: false,
        config: {},
        warnings: [],
      };
    }

    const reason = error instanceof Error ? error.message : String(error);

    return {
      path: configPath,
      exists: false,
      config: {},
      warnings: [`Failed to load config: ${reason}`],
    };
  }
}

export async function setConfigValue(
  workspaceRoot: string,
  key: string,
  value: string,
): Promise<ConfigSetResult> {
  const configDir = join(workspaceRoot, CONFIG_DIR);
  const configPath = join(configDir, CONFIG_FILE);
  const normalizedKey = normalizeConfigKey(key);
  const normalizedValue = normalizeConfigSetValue(normalizedKey, value);
  const config = await readConfigObjectForUpdate(configPath);
  let storedValue = normalizedValue;

  if (normalizedKey === "model") {
    config.model = normalizedValue;
  } else if (normalizedKey === "context.auto") {
    const context = ensureObject(config, "context");
    context.auto = normalizedValue === "true";
  } else if (normalizedKey === "ui.promptHints") {
    const ui = ensureObject(config, "ui");
    const hints = parsePromptHintsSetValue(normalizedValue);
    ui.promptHints = hints;
    storedValue = hints.length > 0 ? hints.join(", ") : "(none)";
  } else if (normalizedKey === "ui.bell") {
    const ui = ensureObject(config, "ui");
    const enabled = parseBooleanConfigValue(normalizedValue);
    ui.bell = enabled;
    storedValue = String(enabled);
  } else if (
    normalizedKey === "toolPolicy.deny" ||
    normalizedKey === "toolPolicy.requireApproval" ||
    normalizedKey === "toolPolicy.allowWritePaths" ||
    normalizedKey === "toolPolicy.denyWritePaths"
  ) {
    const toolPolicy = ensureObject(config, "toolPolicy");
    const property = getToolPolicyPropertyName(normalizedKey);
    toolPolicy[property] = parseConfigListValue(normalizedValue);
  } else if (
    normalizedKey === "toolPolicy.denyRisk" ||
    normalizedKey === "toolPolicy.requireApprovalRisk"
  ) {
    const toolPolicy = ensureObject(config, "toolPolicy");
    const property = normalizedKey === "toolPolicy.denyRisk" ? "denyRisk" : "requireApprovalRisk";
    const risks = parseConfigRiskListValue(normalizedValue);
    toolPolicy[property] = risks;
    storedValue = risks.join(", ");
  } else if (isShellSandboxConfigKey(normalizedKey)) {
    const toolPolicy = ensureObject(config, "toolPolicy");
    const property = getToolPolicyPropertyName(normalizedKey);
    toolPolicy[property] = normalizedValue;
  } else if (isOpenAIRetryConfigKey(normalizedKey)) {
    const openai = ensureObject(config, "openai");
    const retry = ensureObject(openai, "retry");
    const property = getOpenAIRetryPropertyName(normalizedKey);
    const numericValue = parseOpenAIRetryConfigSetValue(normalizedKey, normalizedValue);
    retry[property] = numericValue;
    storedValue = String(numericValue);
  } else {
    const openai = ensureObject(config, "openai");

    if (normalizedKey === "openai.apiMode") {
      openai.apiMode = normalizedValue;
    } else if (normalizedKey === "openai.embeddingModel") {
      openai.embeddingModel = normalizedValue;
    } else {
      openai.baseURL = normalizedValue;
    }
  }

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    key: normalizedKey,
    path: configPath,
    value: storedValue,
  };
}

export async function getConfigValue(
  workspaceRoot: string,
  key: string,
): Promise<ConfigGetResult> {
  const normalizedKey = normalizeConfigKey(key);
  const loaded = await loadConfig(workspaceRoot);
  const value = readParsedConfigValue(loaded.config, normalizedKey);

  return {
    exists: value !== undefined,
    key: normalizedKey,
    path: loaded.path,
    value,
  };
}

export async function unsetConfigValue(
  workspaceRoot: string,
  key: string,
): Promise<ConfigUnsetResult> {
  const configDir = join(workspaceRoot, CONFIG_DIR);
  const configPath = join(configDir, CONFIG_FILE);
  const normalizedKey = normalizeConfigKey(key);
  const config = await readConfigObjectForUpdate(configPath);
  const existed = deleteConfigValue(config, normalizedKey);

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    existed,
    key: normalizedKey,
    path: configPath,
  };
}

export function getUserConfigPath(): string {
  return join(getUserCCAgentDir(), CONFIG_FILE);
}

export async function loadUserConfig(): Promise<LoadedUserConfig> {
  const path = getUserConfigPath();

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;
    const warnings: string[] = [];
    const config = parseUserConfigObject(parsed, warnings);

    return {
      path,
      exists: true,
      config,
      warnings,
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        path,
        exists: false,
        config: {},
        warnings: [],
      };
    }

    const reason = error instanceof Error ? error.message : String(error);

    return {
      path,
      exists: false,
      config: {},
      warnings: [`Failed to load user config: ${reason}`],
    };
  }
}

export async function setUserConfigValue(
  key: string,
  value: string,
): Promise<UserConfigSetResult> {
  const path = getUserConfigPath();
  const normalizedKey = normalizeUserConfigKey(key);
  const normalizedValue = normalizeConfigSetValue(normalizedKey, value);
  const config = await readUserConfigObjectForUpdate(path);
  let storedValue = normalizedValue;

  if (normalizedKey === "model") {
    config.model = normalizedValue;
  } else if (normalizedKey === "ui.promptHints") {
    const ui = ensureObject(config, "ui");
    const hints = parsePromptHintsSetValue(normalizedValue);
    ui.promptHints = hints;
    storedValue = hints.length > 0 ? hints.join(", ") : "(none)";
  } else if (normalizedKey === "ui.bell") {
    const ui = ensureObject(config, "ui");
    const enabled = parseBooleanConfigValue(normalizedValue);
    ui.bell = enabled;
    storedValue = String(enabled);
  } else if (isOpenAIRetryConfigKey(normalizedKey)) {
    const openai = ensureObject(config, "openai");
    const retry = ensureObject(openai, "retry");
    const property = getOpenAIRetryPropertyName(normalizedKey);
    const numericValue = parseOpenAIRetryConfigSetValue(normalizedKey, normalizedValue);
    retry[property] = numericValue;
    storedValue = String(numericValue);
  } else {
    const openai = ensureObject(config, "openai");

    if (normalizedKey === "openai.apiMode") {
      openai.apiMode = normalizedValue;
    } else if (normalizedKey === "openai.embeddingModel") {
      openai.embeddingModel = normalizedValue;
    } else {
      openai.baseURL = normalizedValue;
    }
  }

  const cleaned = pickUserConfigFields(config);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");

  return {
    key: normalizedKey,
    path,
    value: storedValue,
  };
}

export async function getUserConfigValue(key: string): Promise<UserConfigGetResult> {
  const normalizedKey = normalizeUserConfigKey(key);
  const loaded = await loadUserConfig();
  const value = readParsedConfigValue(loaded.config, normalizedKey);

  return {
    exists: value !== undefined,
    key: normalizedKey,
    path: loaded.path,
    value,
  };
}

export async function unsetUserConfigValue(key: string): Promise<UserConfigUnsetResult> {
  const path = getUserConfigPath();
  const normalizedKey = normalizeUserConfigKey(key);
  const config = await readUserConfigObjectForUpdate(path);
  const existed = deleteConfigValue(config, normalizedKey);
  const cleaned = pickUserConfigFields(config);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");

  return {
    existed,
    key: normalizedKey,
    path,
  };
}

export function mergeUserDefaults(
  projectConfig: CCAgentConfig,
  userConfig: CCAgentConfig,
): CCAgentConfig {
  const projectOpenAI = projectConfig.openai ?? {};
  const userOpenAI = userConfig.openai ?? {};
  const retry = { ...(userOpenAI.retry ?? {}), ...(projectOpenAI.retry ?? {}) };
  const openai: NonNullable<CCAgentConfig["openai"]> = {
    ...userOpenAI,
    ...projectOpenAI,
  };

  if (Object.keys(retry).length > 0) {
    openai.retry = retry;
  }

  return {
    ...(projectConfig.model ?? userConfig.model
      ? { model: projectConfig.model ?? userConfig.model }
      : {}),
    ...(Object.keys(openai).length > 0 ? { openai } : {}),
    autoApprove: projectConfig.autoApprove,
    context: projectConfig.context,
    mcp: projectConfig.mcp,
    toolPolicy: projectConfig.toolPolicy,
    ...(projectConfig.ui ?? userConfig.ui
      ? { ui: projectConfig.ui ?? userConfig.ui }
      : {}),
  };
}

export function formatUserConfigSetResult(result: UserConfigSetResult): string {
  return `Updated ${result.key} = ${result.value}\nUser config path: ${result.path}`;
}

export function formatUserConfigGetResult(result: UserConfigGetResult): string {
  if (!result.exists) {
    return `${result.key} is not set\nUser config path: ${result.path}`;
  }

  return `${result.key} = ${result.value}\nUser config path: ${result.path}`;
}

export function formatUserConfigUnsetResult(result: UserConfigUnsetResult): string {
  const status = result.existed ? "Removed" : "Not set";
  return `${status} ${result.key}\nUser config path: ${result.path}`;
}

export async function addMcpServer(
  workspaceRoot: string,
  name: string,
  command: string,
  args: string[] = [],
): Promise<McpConfigResult> {
  const configDir = join(workspaceRoot, CONFIG_DIR);
  const configPath = join(configDir, CONFIG_FILE);
  const normalizedName = normalizeMcpServerName(name);
  const normalizedCommand = normalizeMcpCommand(command);
  const normalizedArgs = normalizeMcpArgs(args);
  const config = await readConfigObjectForUpdate(configPath);
  const mcp = ensureObject(config, "mcp");
  const servers = ensureObject(mcp, "servers");

  if (Object.hasOwn(servers, normalizedName)) {
    throw new Error(`MCP server "${normalizedName}" is already configured. Remove it before adding a replacement.`);
  }

  servers[normalizedName] = {
    ...(normalizedArgs.length > 0 ? { args: normalizedArgs } : {}),
    command: normalizedCommand,
  };
  mcp.enabled = true;

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    action: "added",
    args: normalizedArgs,
    command: normalizedCommand,
    enabled: true,
    name: normalizedName,
    path: configPath,
  };
}

export async function removeMcpServer(
  workspaceRoot: string,
  name: string,
): Promise<McpConfigResult> {
  const configDir = join(workspaceRoot, CONFIG_DIR);
  const configPath = join(configDir, CONFIG_FILE);
  const normalizedName = normalizeMcpServerName(name);
  const config = await readConfigObjectForUpdate(configPath);
  const mcp = ensureObject(config, "mcp");
  const servers = ensureObject(mcp, "servers");
  const existed = Object.hasOwn(servers, normalizedName);

  delete servers[normalizedName];

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    action: "removed",
    enabled: mcp.enabled === true,
    existed,
    name: normalizedName,
    path: configPath,
  };
}

export async function setMcpEnabled(
  workspaceRoot: string,
  enabled: boolean,
): Promise<McpConfigResult> {
  const configDir = join(workspaceRoot, CONFIG_DIR);
  const configPath = join(configDir, CONFIG_FILE);
  const config = await readConfigObjectForUpdate(configPath);
  const mcp = ensureObject(config, "mcp");

  mcp.enabled = enabled;

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    action: enabled ? "enabled" : "disabled",
    enabled,
    path: configPath,
  };
}

export function formatConfigSetResult(result: ConfigSetResult): string {
  return `Updated ${result.key} = ${result.value}\nConfig path: ${result.path}`;
}

export function formatConfigGetResult(result: ConfigGetResult): string {
  if (!result.exists) {
    return `${result.key} is not set\nConfig path: ${result.path}`;
  }

  return `${result.key} = ${result.value}\nConfig path: ${result.path}`;
}

export function formatConfigUnsetResult(result: ConfigUnsetResult): string {
  const status = result.existed ? "Removed" : "Not set";
  return `${status} ${result.key}\nConfig path: ${result.path}`;
}

export function formatMcpConfigResult(result: McpConfigResult): string {
  if (result.action === "added") {
    return [
      `Added MCP server ${result.name}: ${result.command}`,
      `Arguments stored: ${result.args?.length ?? 0}`,
      "MCP enabled: yes",
      `Config path: ${result.path}`,
    ].join("\n");
  }

  if (result.action === "removed") {
    return [
      result.existed ? `Removed MCP server ${result.name}` : `MCP server ${result.name} was not configured`,
      `MCP enabled: ${result.enabled ? "yes" : "no"}`,
      `Config path: ${result.path}`,
    ].join("\n");
  }

  return [
    `MCP ${result.enabled ? "enabled" : "disabled"}`,
    `Config path: ${result.path}`,
  ].join("\n");
}

export function formatLoadedConfig(loaded: LoadedConfig): string {
  const lines = [
    `Config path: ${loaded.path}`,
    `Config loaded: ${loaded.exists ? "yes" : "no"}`,
    `Model: ${loaded.config.model ?? "(default)"}`,
    `Automatic context index: ${loaded.config.context?.auto === false ? "off" : "on"}`,
    `OpenAI API mode: ${loaded.config.openai?.apiMode ?? "(default)"}`,
    `OpenAI base URL: ${loaded.config.openai?.baseURL ?? "(default)"}`,
    `OpenAI embedding model: ${loaded.config.openai?.embeddingModel ?? "(local semantic index)"}`,
    `OpenAI retry max attempts: ${loaded.config.openai?.retry?.maxAttempts ?? "(default)"}`,
    `OpenAI retry base delay ms: ${loaded.config.openai?.retry?.baseDelayMs ?? "(default)"}`,
    `OpenAI retry max delay ms: ${loaded.config.openai?.retry?.maxDelayMs ?? "(default)"}`,
    `MCP enabled: ${loaded.config.mcp?.enabled === true ? "yes" : "no"}`,
    `MCP servers: ${Object.keys(loaded.config.mcp?.servers ?? {}).length}`,
    `Prompt hint bar: ${formatPromptHintsDisplay(loaded.config.ui?.promptHints)}`,
    `Turn end bell: ${loaded.config.ui?.bell === true ? "on" : "off"}`,
    `Auto-approved shell commands: ${loaded.config.autoApprove?.shellCommands?.length ?? 0}`,
    `Shell sandbox: ${loaded.config.toolPolicy?.shellSandbox ?? "off"}${formatShellSandboxTail(loaded.config.toolPolicy?.shellSandboxImage, loaded.config.toolPolicy?.shellSandboxNetwork, loaded.config.toolPolicy?.shellSandbox)}`,
    `Shell execution guard: ${loaded.config.toolPolicy?.executionGuard ?? "deny"}`,
    `Allowed write paths: ${loaded.config.toolPolicy?.allowWritePaths?.length ?? 0}`,
    `Denied write paths: ${loaded.config.toolPolicy?.denyWritePaths?.length ?? 0}`,
    `Denied tools: ${loaded.config.toolPolicy?.deny?.length ?? 0}`,
    `Denied risk levels: ${loaded.config.toolPolicy?.denyRisk?.length ?? 0}`,
    `Tools requiring approval: ${loaded.config.toolPolicy?.requireApproval?.length ?? 0}`,
    `Risk levels requiring approval: ${
      loaded.config.toolPolicy?.requireApprovalRisk?.length ?? 0
    }`,
  ];

  const shellCommands = loaded.config.autoApprove?.shellCommands ?? [];

  for (const command of shellCommands) {
    lines.push(`- ${command}`);
  }

  const allowedWritePaths = loaded.config.toolPolicy?.allowWritePaths ?? [];

  for (const path of allowedWritePaths) {
    lines.push(`- allowWritePaths: ${path}`);
  }

  const deniedWritePaths = loaded.config.toolPolicy?.denyWritePaths ?? [];

  for (const path of deniedWritePaths) {
    lines.push(`- denyWritePaths: ${path}`);
  }

  const deniedTools = loaded.config.toolPolicy?.deny ?? [];

  for (const tool of deniedTools) {
    lines.push(`- deny: ${tool}`);
  }

  const deniedRisks = loaded.config.toolPolicy?.denyRisk ?? [];

  for (const risk of deniedRisks) {
    lines.push(`- denyRisk: ${risk}`);
  }

  const approvalTools = loaded.config.toolPolicy?.requireApproval ?? [];

  for (const tool of approvalTools) {
    lines.push(`- requireApproval: ${tool}`);
  }

  const approvalRisks = loaded.config.toolPolicy?.requireApprovalRisk ?? [];

  for (const risk of approvalRisks) {
    lines.push(`- requireApprovalRisk: ${risk}`);
  }

  if (loaded.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...loaded.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatShellSandboxTail(
  image: string | undefined,
  network: string | undefined,
  mode: string | undefined,
): string {
  if (mode !== "docker" && mode !== "podman") {
    return "";
  }

  return ` (image=${image ?? "alpine:3.20"}, network=${network ?? "none"})`;
}

export function formatPermissions(
  loaded: LoadedConfig,
  options: FormatPermissionsOptions = {},
): string {
  const shellCommands = loaded.config.autoApprove?.shellCommands ?? [];
  const allowedWritePaths = loaded.config.toolPolicy?.allowWritePaths ?? [];
  const deniedWritePaths = loaded.config.toolPolicy?.denyWritePaths ?? [];
  const deniedTools = loaded.config.toolPolicy?.deny ?? [];
  const deniedRisks = loaded.config.toolPolicy?.denyRisk ?? [];
  const approvalTools = loaded.config.toolPolicy?.requireApproval ?? [];
  const approvalRisks = loaded.config.toolPolicy?.requireApprovalRisk ?? [];
  const lines = [
    "Tool permissions",
    `Config path: ${loaded.path}`,
    `Config loaded: ${loaded.exists ? "yes" : "no"}`,
    "",
    "Built-in approval rules:",
    "- run_shell asks for approval unless the exact command is auto-approved.",
    "- apply_patch and reverse_patch ask for approval unless --allow-edits is used.",
    "- Other tools run without approval unless toolPolicy.requireApproval includes them.",
    "- toolPolicy.deny blocks a tool before any approval prompt.",
    "- toolPolicy.denyRisk blocks matching preflight risk levels before execution.",
    "- toolPolicy.allowWritePaths limits apply_patch and reverse_patch to listed files or directories.",
    "- toolPolicy.denyWritePaths blocks apply_patch and reverse_patch for listed files or directories.",
    "- toolPolicy.requireApprovalRisk asks for approval based on preflight risk level.",
    "- toolPolicy.shellSandbox=docker runs every run_shell command inside a Docker container with network disabled.",
    "- toolPolicy.executionGuard scans run_shell commands for injection patterns (deny blocks, warn annotates, off disables).",
    "",
    "This run:",
    `- --allow-edits: ${
      options.allowEdits ? "on (apply_patch and reverse_patch auto-approved)" : "off"
    }`,
    `- --verify: ${options.verifyCommand ?? "(none)"}`,
    `- Shell sandbox: ${options.sandboxLabel ?? "off (direct on host)"}`,
    "",
    ...formatPermissionList("Auto-approved shell commands", shellCommands),
    ...formatPermissionList("Allowed write paths", allowedWritePaths),
    ...formatPermissionList("Denied write paths", deniedWritePaths),
    ...formatPermissionList("Denied tools", deniedTools),
    ...formatPermissionList("Denied risk levels", deniedRisks),
    ...formatPermissionList("Tools requiring approval", approvalTools),
    ...formatPermissionList("Risk levels requiring approval", approvalRisks),
  ];

  if (loaded.warnings.length > 0) {
    lines.push("");
    lines.push("Config warnings:");
    lines.push(...loaded.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function isAutoApprovedShellCommand(
  loaded: LoadedConfig,
  command: string,
): boolean {
  const shellCommands = loaded.config.autoApprove?.shellCommands ?? [];
  return shellCommands.includes(command.trim());
}

export function isToolDenied(loaded: LoadedConfig, toolName: string): boolean {
  return (loaded.config.toolPolicy?.deny ?? []).includes(toolName.trim());
}

export function isToolRiskDenied(loaded: LoadedConfig, risk: ToolRiskLevel): boolean {
  return (loaded.config.toolPolicy?.denyRisk ?? []).includes(risk);
}

export function isToolApprovalRequiredByPolicy(
  loaded: LoadedConfig,
  toolName: string,
): boolean {
  return (loaded.config.toolPolicy?.requireApproval ?? []).includes(toolName.trim());
}

export function isToolRiskApprovalRequiredByPolicy(
  loaded: LoadedConfig,
  risk: ToolRiskLevel,
): boolean {
  return (loaded.config.toolPolicy?.requireApprovalRisk ?? []).includes(risk);
}

function parseConfig(value: unknown, warnings: string[]): CCAgentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Config root must be an object. Using defaults.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const config: CCAgentConfig = {};

  if (typeof source.model === "string" && source.model.trim().length > 0) {
    config.model = source.model.trim();
  } else if (source.model !== undefined) {
    warnings.push("Ignoring config.model because it is not a non-empty string.");
  }

  if (source.context !== undefined) {
    config.context = parseContextConfig(source.context, warnings);
  }

  if (source.autoApprove !== undefined) {
    config.autoApprove = parseAutoApprove(source.autoApprove, warnings);
  }

  if (source.openai !== undefined) {
    config.openai = parseOpenAIConfig(source.openai, warnings);
  }

  if (source.mcp !== undefined) {
    config.mcp = parseMcpConfig(source.mcp, warnings);
  }

  if (source.ui !== undefined) {
    config.ui = parseUiConfig(source.ui, warnings);
  }

  if (source.toolPolicy !== undefined) {
    config.toolPolicy = parseToolPolicy(source.toolPolicy, warnings);
  }

  return config;
}

function formatPermissionList(title: string, values: string[]): string[] {
  if (values.length === 0) {
    return [`${title}: (none)`, ""];
  }

  return [`${title}:`, ...values.map((value) => `- ${value}`), ""];
}

async function readConfigObjectForUpdate(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config root must be an object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isFileNotFound(error)) {
      return {};
    }

    throw error;
  }
}

function normalizeConfigKey(key: string): ConfigKey {
  const trimmed = key.trim();

  if (trimmed === "model") {
    return "model";
  }

  if (trimmed === "context.auto") {
    return "context.auto";
  }

  if (trimmed === "ui.promptHints") {
    return "ui.promptHints";
  }

  if (trimmed === "ui.bell") {
    return "ui.bell";
  }

  if (trimmed === "openai.apiMode") {
    return "openai.apiMode";
  }

  if (trimmed === "openai.baseURL" || trimmed === "openai.baseUrl") {
    return "openai.baseURL";
  }

  if (trimmed === "openai.embeddingModel" || trimmed === "openai.embeddings.model") {
    return "openai.embeddingModel";
  }

  if (trimmed === "openai.retry.maxAttempts") {
    return "openai.retry.maxAttempts";
  }

  if (trimmed === "openai.retry.baseDelayMs") {
    return "openai.retry.baseDelayMs";
  }

  if (trimmed === "openai.retry.maxDelayMs") {
    return "openai.retry.maxDelayMs";
  }

  if (trimmed === "toolPolicy.allowWritePaths") {
    return "toolPolicy.allowWritePaths";
  }

  if (trimmed === "toolPolicy.deny") {
    return "toolPolicy.deny";
  }

  if (trimmed === "toolPolicy.denyRisk") {
    return "toolPolicy.denyRisk";
  }

  if (trimmed === "toolPolicy.denyWritePaths") {
    return "toolPolicy.denyWritePaths";
  }

  if (trimmed === "toolPolicy.requireApproval") {
    return "toolPolicy.requireApproval";
  }

  if (trimmed === "toolPolicy.requireApprovalRisk") {
    return "toolPolicy.requireApprovalRisk";
  }

  if (trimmed === "toolPolicy.shellSandbox") {
    return "toolPolicy.shellSandbox";
  }

  if (trimmed === "toolPolicy.shellSandboxImage") {
    return "toolPolicy.shellSandboxImage";
  }

  if (trimmed === "toolPolicy.shellSandboxNetwork") {
    return "toolPolicy.shellSandboxNetwork";
  }

  if (trimmed === "toolPolicy.shellSandboxReadOnly") {
    return "toolPolicy.shellSandboxReadOnly";
  }

  if (trimmed === "toolPolicy.shellSandboxMemoryMb") {
    return "toolPolicy.shellSandboxMemoryMb";
  }

  if (trimmed === "toolPolicy.shellSandboxCpus") {
    return "toolPolicy.shellSandboxCpus";
  }

  if (trimmed === "toolPolicy.shellSandboxPidsLimit") {
    return "toolPolicy.shellSandboxPidsLimit";
  }

  if (trimmed === "toolPolicy.executionGuard") {
    return "toolPolicy.executionGuard";
  }

  throw new Error(
    'Unsupported config key. Supported keys: model, context.auto, ui.promptHints, ui.bell, openai.apiMode, openai.baseURL, openai.embeddingModel, openai.retry.maxAttempts, openai.retry.baseDelayMs, openai.retry.maxDelayMs, toolPolicy.allowWritePaths, toolPolicy.deny, toolPolicy.denyRisk, toolPolicy.denyWritePaths, toolPolicy.requireApproval, toolPolicy.requireApprovalRisk, toolPolicy.shellSandbox, toolPolicy.shellSandboxImage, toolPolicy.shellSandboxNetwork, toolPolicy.shellSandboxReadOnly, toolPolicy.shellSandboxMemoryMb, toolPolicy.shellSandboxCpus, toolPolicy.shellSandboxPidsLimit, toolPolicy.executionGuard.',
  );
}

function normalizeUserConfigKey(key: string): UserConfigKey {
  const normalized = normalizeConfigKey(key);

  if (!USER_CONFIG_KEYS.has(normalized)) {
    throw new Error(`Unsupported user config key. User-level keys: ${USER_CONFIG_KEY_LIST}.`);
  }

  return normalized as UserConfigKey;
}

function parseUserConfigObject(value: unknown, warnings: string[]): CCAgentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring user config because it is not a JSON object.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const config: CCAgentConfig = {};

  for (const topLevelKey of Object.keys(source)) {
    if (topLevelKey !== "model" && topLevelKey !== "ui" && topLevelKey !== "openai") {
      warnings.push(
        `Ignoring user config key "${topLevelKey}" because user-level config only supports ${USER_CONFIG_KEY_LIST}.`,
      );
    }
  }

  if (source.model !== undefined) {
    if (typeof source.model === "string" && source.model.trim().length > 0) {
      config.model = source.model.trim();
    } else {
      warnings.push("Ignoring user config model because it is not a non-empty string.");
    }
  }

  if (source.ui !== undefined) {
    config.ui = parseUiConfig(source.ui, warnings);
  }

  config.openai = parseOpenAIConfig(source.openai, warnings);

  return config;
}

async function readUserConfigObjectForUpdate(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("User config is not a JSON object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isFileNotFound(error)) {
      return {};
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read user config: ${reason}`);
  }
}

function pickUserConfigFields(config: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  if (typeof config.model === "string" && config.model.trim().length > 0) {
    cleaned.model = config.model.trim();
  }

  if (config.ui && typeof config.ui === "object" && !Array.isArray(config.ui)) {
    const source = config.ui as Record<string, unknown>;

    if (Array.isArray(source.promptHints)) {
      const promptHints = source.promptHints.filter(
        (hint): hint is string => typeof hint === "string" && hint.trim().length > 0,
      );

      if (promptHints.length > 0) {
        cleaned.ui = { promptHints };
      }
    }
  }

  if (config.openai && typeof config.openai === "object" && !Array.isArray(config.openai)) {
    const source = config.openai as Record<string, unknown>;
    const openai: Record<string, unknown> = {};

    for (const field of ["apiMode", "baseURL", "embeddingModel"] as const) {
      if (typeof source[field] === "string" && source[field].trim().length > 0) {
        openai[field] = source[field].trim();
      }
    }

    if (source.retry && typeof source.retry === "object" && !Array.isArray(source.retry)) {
      const retry = source.retry as Record<string, unknown>;
      const retryCleaned: Record<string, unknown> = {};

      for (const field of ["maxAttempts", "baseDelayMs", "maxDelayMs"] as const) {
        if (typeof retry[field] === "number") {
          retryCleaned[field] = retry[field];
        }
      }

      if (Object.keys(retryCleaned).length > 0) {
        openai.retry = retryCleaned;
      }
    }

    if (Object.keys(openai).length > 0) {
      cleaned.openai = openai;
    }
  }

  return cleaned;
}

function normalizeMcpServerName(name: string): string {
  const normalized = name.trim();

  if (!/^[A-Za-z0-9_-]{1,32}$/.test(normalized)) {
    throw new Error("MCP server name must contain 1-32 letters, numbers, underscores, or hyphens.");
  }

  return normalized;
}

function normalizeMcpCommand(command: string): string {
  const normalized = command.trim();

  if (!normalized) {
    throw new Error("MCP server command must be a non-empty string.");
  }

  return normalized;
}

function normalizeMcpArgs(args: string[]): string[] {
  const normalized = args.map((argument) => argument.trim());

  if (normalized.some((argument) => !argument)) {
    throw new Error("MCP server arguments must be non-empty strings.");
  }

  return normalized;
}

function normalizeConfigSetValue(key: ConfigKey, value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`Config value for ${key} cannot be empty.`);
  }

  if (key === "openai.apiMode") {
    const normalized = trimmed.toLowerCase();

    if (normalized !== "responses" && normalized !== "chat") {
      throw new Error('Expected openai.apiMode to be "responses" or "chat".');
    }

    return normalized;
  }

  if (key === "context.auto") {
    const normalized = trimmed.toLowerCase();

    if (["true", "on", "1", "yes"].includes(normalized)) {
      return "true";
    }

    if (["false", "off", "0", "no"].includes(normalized)) {
      return "false";
    }

    throw new Error('Expected context.auto to be a boolean (true or false).');
  }

  if (key === "openai.baseURL") {
    validateBaseURL(trimmed);
  }

  if (isOpenAIRetryConfigKey(key)) {
    parseOpenAIRetryConfigSetValue(key, trimmed);
  }

  if (key === "toolPolicy.denyRisk" || key === "toolPolicy.requireApprovalRisk") {
    parseConfigRiskListValue(trimmed);
  }

  if (key === "toolPolicy.shellSandbox") {
    const normalized = trimmed.toLowerCase();

    if (!isShellSandboxModeValue(normalized)) {
      throw new Error(
        `Expected toolPolicy.shellSandbox to be one of: ${SHELL_SANDBOX_MODES.join(", ")}.`,
      );
    }

    return normalized;
  }

  if (key === "toolPolicy.shellSandboxNetwork") {
    const normalized = trimmed.toLowerCase();

    if (!isShellSandboxNetworkValue(normalized)) {
      throw new Error(
        `Expected toolPolicy.shellSandboxNetwork to be one of: ${SHELL_SANDBOX_NETWORKS.join(", ")}.`,
      );
    }

    return normalized;
  }

  if (key === "toolPolicy.shellSandboxReadOnly") {
    const normalized = trimmed.toLowerCase();

    if (normalized !== "true" && normalized !== "false") {
      throw new Error('Expected toolPolicy.shellSandboxReadOnly to be "true" or "false".');
    }

    return normalized;
  }

  if (key === "toolPolicy.shellSandboxMemoryMb") {
    return validateIntegerConfigValue("toolPolicy.shellSandboxMemoryMb", trimmed, 64, 262144);
  }

  if (key === "toolPolicy.shellSandboxPidsLimit") {
    return validateIntegerConfigValue("toolPolicy.shellSandboxPidsLimit", trimmed, 16, 1048576);
  }

  if (key === "toolPolicy.shellSandboxCpus") {
    return validateDecimalConfigValue("toolPolicy.shellSandboxCpus", trimmed, 0.1, 64);
  }

  if (key === "toolPolicy.executionGuard") {
    const normalized = trimmed.toLowerCase();

    if (!(EXECUTION_GUARD_LEVELS as readonly string[]).includes(normalized)) {
      throw new Error(
        `Expected toolPolicy.executionGuard to be one of: ${EXECUTION_GUARD_LEVELS.join(", ")}.`,
      );
    }

    return normalized;
  }

  return trimmed;
}

function readParsedConfigValue(config: CCAgentConfig, key: ConfigKey): string | undefined {
  if (key === "model") {
    return config.model;
  }

  if (key === "context.auto") {
    return config.context?.auto === undefined ? undefined : String(config.context.auto);
  }

  if (key === "ui.promptHints") {
    const hints = config.ui?.promptHints;
    return hints === undefined ? undefined : hints.join(", ");
  }

  if (key === "ui.bell") {
    return config.ui?.bell === undefined ? undefined : String(config.ui.bell);
  }

  if (key === "openai.apiMode") {
    return config.openai?.apiMode;
  }

  if (key === "openai.baseURL") {
    return config.openai?.baseURL;
  }

  if (key === "openai.embeddingModel") {
    return config.openai?.embeddingModel;
  }

  if (key === "openai.retry.maxAttempts") {
    return formatOptionalNumber(config.openai?.retry?.maxAttempts);
  }

  if (key === "openai.retry.baseDelayMs") {
    return formatOptionalNumber(config.openai?.retry?.baseDelayMs);
  }

  if (key === "openai.retry.maxDelayMs") {
    return formatOptionalNumber(config.openai?.retry?.maxDelayMs);
  }

  if (key === "toolPolicy.shellSandbox") {
    return config.toolPolicy?.shellSandbox;
  }

  if (key === "toolPolicy.shellSandboxImage") {
    return config.toolPolicy?.shellSandboxImage;
  }

  if (key === "toolPolicy.shellSandboxNetwork") {
    return config.toolPolicy?.shellSandboxNetwork;
  }

  if (key === "toolPolicy.shellSandboxReadOnly") {
    return config.toolPolicy?.shellSandboxReadOnly;
  }

  if (key === "toolPolicy.shellSandboxMemoryMb") {
    return config.toolPolicy?.shellSandboxMemoryMb;
  }

  if (key === "toolPolicy.shellSandboxCpus") {
    return config.toolPolicy?.shellSandboxCpus;
  }

  if (key === "toolPolicy.shellSandboxPidsLimit") {
    return config.toolPolicy?.shellSandboxPidsLimit;
  }

  if (key === "toolPolicy.executionGuard") {
    return config.toolPolicy?.executionGuard;
  }

  const values = readToolPolicyListValue(config, key);

  return values?.join(", ");
}

function deleteConfigValue(config: Record<string, unknown>, key: ConfigKey): boolean {
  if (key === "model") {
    const existed = "model" in config;
    delete config.model;
    return existed;
  }

  if (key === "ui.promptHints") {
    const ui = config.ui;

    if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
      return false;
    }

    const uiConfig = ui as Record<string, unknown>;
    const existed = "promptHints" in uiConfig;
    delete uiConfig.promptHints;

    if (Object.keys(uiConfig).length === 0) {
      delete config.ui;
    }

    return existed;
  }

  if (key === "ui.bell") {
    const ui = config.ui;

    if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
      return false;
    }

    const uiConfig = ui as Record<string, unknown>;
    const existed = "bell" in uiConfig;
    delete uiConfig.bell;

    if (Object.keys(uiConfig).length === 0) {
      delete config.ui;
    }

    return existed;
  }

  if (key === "context.auto") {
    const context = config.context;

    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return false;
    }

    const contextConfig = context as Record<string, unknown>;
    const existed = "auto" in contextConfig;
    delete contextConfig.auto;

    if (Object.keys(contextConfig).length === 0) {
      delete config.context;
    }

    return existed;
  }

  if (
    key === "toolPolicy.allowWritePaths" ||
    key === "toolPolicy.deny" ||
    key === "toolPolicy.denyRisk" ||
    key === "toolPolicy.denyWritePaths" ||
    key === "toolPolicy.requireApproval" ||
    key === "toolPolicy.requireApprovalRisk" ||
    isShellSandboxConfigKey(key)
  ) {
    const toolPolicy = config.toolPolicy;

    if (!toolPolicy || typeof toolPolicy !== "object" || Array.isArray(toolPolicy)) {
      return false;
    }

    const toolPolicyConfig = toolPolicy as Record<string, unknown>;
    const property = getToolPolicyPropertyName(key);
    const existed = property in toolPolicyConfig;
    delete toolPolicyConfig[property];

    if (Object.keys(toolPolicyConfig).length === 0) {
      delete config.toolPolicy;
    }

    return existed;
  }

  const openai = config.openai;

  if (!openai || typeof openai !== "object" || Array.isArray(openai)) {
    return false;
  }

  const openaiConfig = openai as Record<string, unknown>;
  if (isOpenAIRetryConfigKey(key)) {
    const retry = openaiConfig.retry;

    if (!retry || typeof retry !== "object" || Array.isArray(retry)) {
      return false;
    }

    const retryConfig = retry as Record<string, unknown>;
    const property = getOpenAIRetryPropertyName(key);
    const existed = property in retryConfig;
    delete retryConfig[property];

    if (Object.keys(retryConfig).length === 0) {
      delete openaiConfig.retry;
    }

    if (Object.keys(openaiConfig).length === 0) {
      delete config.openai;
    }

    return existed;
  }

  const property = key === "openai.apiMode"
    ? "apiMode"
    : key === "openai.embeddingModel"
      ? "embeddingModel"
      : "baseURL";
  const existed = property in openaiConfig;
  delete openaiConfig[property];

  if (Object.keys(openaiConfig).length === 0) {
    delete config.openai;
  }

  return existed;
}

function ensureObject(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = source[key];

  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }

  const next: Record<string, unknown> = {};
  source[key] = next;
  return next;
}

function parseContextConfig(value: unknown, warnings: string[]): CCAgentConfig["context"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring context because it is not an object.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const context: NonNullable<CCAgentConfig["context"]> = {};

  if (source.auto !== undefined) {
    if (typeof source.auto === "boolean") {
      context.auto = source.auto;
    } else {
      warnings.push("Ignoring context.auto because it is not a boolean.");
    }
  }

  return context;
}

function parseOpenAIConfig(value: unknown, warnings: string[]): CCAgentConfig["openai"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring openai because it is not an object.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const openai: NonNullable<CCAgentConfig["openai"]> = {};

  if (source.apiMode !== undefined) {
    if (typeof source.apiMode === "string") {
      const apiMode = source.apiMode.trim().toLowerCase();

      if (apiMode === "responses" || apiMode === "chat") {
        openai.apiMode = apiMode;
      } else {
        warnings.push('Ignoring openai.apiMode because it is not "responses" or "chat".');
      }
    } else {
      warnings.push("Ignoring openai.apiMode because it is not a string.");
    }
  }

  if (source.baseURL !== undefined) {
    if (typeof source.baseURL === "string" && source.baseURL.trim().length > 0) {
      try {
        validateBaseURL(source.baseURL.trim());
        openai.baseURL = source.baseURL.trim();
      } catch {
        warnings.push("Ignoring openai.baseURL because it is not a valid http(s) URL.");
      }
    } else {
      warnings.push("Ignoring openai.baseURL because it is not a non-empty string.");
    }
  }

  if (source.embeddingModel !== undefined) {
    if (typeof source.embeddingModel === "string" && source.embeddingModel.trim().length > 0) {
      openai.embeddingModel = source.embeddingModel.trim();
    } else {
      warnings.push("Ignoring openai.embeddingModel because it is not a non-empty string.");
    }
  }

  if (source.retry !== undefined) {
    openai.retry = parseOpenAIRetryConfig(source.retry, warnings);
  }

  return openai;
}

function parseUiConfig(value: unknown, warnings: string[]): CCAgentConfig["ui"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring ui because it is not an object.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const ui: NonNullable<CCAgentConfig["ui"]> = {};

  if (source.promptHints !== undefined) {
    if (Array.isArray(source.promptHints)) {
      ui.promptHints = source.promptHints.filter((hint): hint is string => {
        const isValid = typeof hint === "string" && hint.trim().length > 0;

        if (!isValid) {
          warnings.push("Ignoring a ui.promptHints item because it is not a non-empty string.");
        }

        return isValid;
      });
    } else {
      warnings.push("Ignoring ui.promptHints because it is not an array.");
    }
  }

  if (source.bell !== undefined) {
    if (typeof source.bell === "boolean") {
      ui.bell = source.bell;
    } else {
      warnings.push("Ignoring ui.bell because it is not a boolean.");
    }
  }

  return ui;
}

function parseBooleanConfigValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (["true", "on", "yes", "1"].includes(normalized)) {
    return true;
  }

  if (["false", "off", "no", "0"].includes(normalized)) {
    return false;
  }

  throw new Error("Expected a boolean value (true/false, on/off, yes/no, or 1/0).");
}

function parsePromptHintsSetValue(value: string): string[] {
  if (value.toLowerCase() === "off" || value.toLowerCase() === "none") {
    return [];
  }

  const hints = parseConfigListValue(value);

  if (hints.length > 12) {
    throw new Error("Expected ui.promptHints to contain at most 12 items.");
  }

  return hints;
}

function formatPromptHintsDisplay(hints: string[] | undefined): string {
  if (hints === undefined) {
    return "(default)";
  }

  if (hints.length === 0) {
    return "(hidden)";
  }

  return hints.join(", ");
}

function parseMcpConfig(value: unknown, warnings: string[]): CCAgentConfig["mcp"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring mcp because it is not an object.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const mcp: NonNullable<CCAgentConfig["mcp"]> = {};

  if (source.enabled !== undefined) {
    if (typeof source.enabled === "boolean") {
      mcp.enabled = source.enabled;
    } else {
      warnings.push("Ignoring mcp.enabled because it is not a boolean.");
    }
  }

  if (source.servers !== undefined) {
    if (!source.servers || typeof source.servers !== "object" || Array.isArray(source.servers)) {
      warnings.push("Ignoring mcp.servers because it is not an object.");
    } else {
      const servers: Record<string, McpServerConfig> = {};

      for (const [name, server] of Object.entries(source.servers as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
          warnings.push(`Ignoring mcp server "${name}" because its name is invalid.`);
          continue;
        }

        const parsed = parseMcpServerConfig(server, name, warnings);

        if (parsed) {
          servers[name] = parsed;
        }
      }

      mcp.servers = servers;
    }
  }

  return mcp;
}

function parseMcpServerConfig(
  value: unknown,
  name: string,
  warnings: string[],
): McpServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Ignoring mcp server "${name}" because it is not an object.`);
    return null;
  }

  const source = value as Record<string, unknown>;

  if (typeof source.command !== "string" || source.command.trim().length === 0) {
    warnings.push(`Ignoring mcp server "${name}" because command is not a non-empty string.`);
    return null;
  }

  const server: McpServerConfig = { command: source.command.trim() };

  if (source.args !== undefined) {
    server.args = parseMcpStringArray(source.args, `mcp server "${name}" args`, warnings);
  }

  if (source.cwd !== undefined) {
    if (typeof source.cwd === "string" && source.cwd.trim().length > 0) {
      server.cwd = source.cwd.trim();
    } else {
      warnings.push(`Ignoring mcp server "${name}" cwd because it is not a non-empty string.`);
    }
  }

  if (source.env !== undefined) {
    if (!source.env || typeof source.env !== "object" || Array.isArray(source.env)) {
      warnings.push(`Ignoring mcp server "${name}" env because it is not an object.`);
    } else {
      const env: Record<string, string> = {};

      for (const [key, item] of Object.entries(source.env as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string") {
          warnings.push(`Ignoring an mcp server "${name}" env item because it is invalid.`);
          continue;
        }

        env[key] = item;
      }

      server.env = env;
    }
  }

  if (source.timeoutMs !== undefined) {
    if (typeof source.timeoutMs === "number" && Number.isInteger(source.timeoutMs) && source.timeoutMs >= 1_000 && source.timeoutMs <= 120_000) {
      server.timeoutMs = source.timeoutMs;
    } else {
      warnings.push(`Ignoring mcp server "${name}" timeoutMs because it must be an integer from 1000 to 120000.`);
    }
  }

  return server;
}

function parseMcpStringArray(value: unknown, path: string, warnings: string[]): string[] {
  if (!Array.isArray(value)) {
    warnings.push(`Ignoring ${path} because it is not an array.`);
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item !== "string") {
      warnings.push(`Ignoring a ${path} item because it is not a string.`);
      return [];
    }

    return [item];
  });
}

function parseOpenAIRetryConfig(
  value: unknown,
  warnings: string[],
): NonNullable<NonNullable<CCAgentConfig["openai"]>["retry"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring openai.retry because it is not an object.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const retry: NonNullable<NonNullable<CCAgentConfig["openai"]>["retry"]> = {};
  const maxAttempts = parseOpenAIRetryNumber(
    source.maxAttempts,
    "openai.retry.maxAttempts",
    1,
    5,
    warnings,
  );
  const baseDelayMs = parseOpenAIRetryNumber(
    source.baseDelayMs,
    "openai.retry.baseDelayMs",
    0,
    60_000,
    warnings,
  );
  const maxDelayMs = parseOpenAIRetryNumber(
    source.maxDelayMs,
    "openai.retry.maxDelayMs",
    0,
    60_000,
    warnings,
  );

  if (maxAttempts !== undefined) {
    retry.maxAttempts = maxAttempts;
  }

  if (baseDelayMs !== undefined) {
    retry.baseDelayMs = baseDelayMs;
  }

  if (maxDelayMs !== undefined) {
    retry.maxDelayMs = maxDelayMs;
  }

  return retry;
}

function parseAutoApprove(value: unknown, warnings: string[]): CCAgentConfig["autoApprove"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring autoApprove because it is not an object.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const autoApprove: NonNullable<CCAgentConfig["autoApprove"]> = {};

  if (source.shellCommands !== undefined) {
    if (Array.isArray(source.shellCommands)) {
      autoApprove.shellCommands = source.shellCommands.filter((command): command is string => {
        const isValid = typeof command === "string" && command.trim().length > 0;

        if (!isValid) {
          warnings.push("Ignoring an autoApprove.shellCommands item because it is not a string.");
        }

        return isValid;
      });
    } else {
      warnings.push("Ignoring autoApprove.shellCommands because it is not an array.");
    }
  }

  return autoApprove;
}

function parseToolPolicy(value: unknown, warnings: string[]): CCAgentConfig["toolPolicy"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignoring toolPolicy because it is not an object.");
    return {};
  }

  const source = value as Record<string, unknown>;
  const toolPolicy: NonNullable<CCAgentConfig["toolPolicy"]> = {};

  if (source.allowWritePaths !== undefined) {
    toolPolicy.allowWritePaths = parseToolNameArray(
      source.allowWritePaths,
      "toolPolicy.allowWritePaths",
      warnings,
    );
  }

  if (source.deny !== undefined) {
    toolPolicy.deny = parseToolNameArray(source.deny, "toolPolicy.deny", warnings);
  }

  if (source.denyRisk !== undefined) {
    toolPolicy.denyRisk = parseRiskArray(source.denyRisk, "toolPolicy.denyRisk", warnings);
  }

  if (source.denyWritePaths !== undefined) {
    toolPolicy.denyWritePaths = parseToolNameArray(
      source.denyWritePaths,
      "toolPolicy.denyWritePaths",
      warnings,
    );
  }

  if (source.requireApproval !== undefined) {
    toolPolicy.requireApproval = parseToolNameArray(
      source.requireApproval,
      "toolPolicy.requireApproval",
      warnings,
    );
  }

  if (source.requireApprovalRisk !== undefined) {
    toolPolicy.requireApprovalRisk = parseRiskArray(
      source.requireApprovalRisk,
      "toolPolicy.requireApprovalRisk",
      warnings,
    );
  }

  if (source.shellSandbox !== undefined) {
    toolPolicy.shellSandbox = parseShellSandboxChoice(
      source.shellSandbox,
      "toolPolicy.shellSandbox",
      SHELL_SANDBOX_MODES,
      warnings,
    );
  }

  if (source.shellSandboxImage !== undefined) {
    toolPolicy.shellSandboxImage = parseShellSandboxString(
      source.shellSandboxImage,
      "toolPolicy.shellSandboxImage",
      warnings,
    );
  }

  if (source.shellSandboxNetwork !== undefined) {
    toolPolicy.shellSandboxNetwork = parseShellSandboxChoice(
      source.shellSandboxNetwork,
      "toolPolicy.shellSandboxNetwork",
      SHELL_SANDBOX_NETWORKS,
      warnings,
    );
  }

  if (source.shellSandboxReadOnly !== undefined) {
    toolPolicy.shellSandboxReadOnly = parseShellSandboxChoice(
      source.shellSandboxReadOnly,
      "toolPolicy.shellSandboxReadOnly",
      ["true", "false"],
      warnings,
    );
  }

  if (source.shellSandboxMemoryMb !== undefined) {
    toolPolicy.shellSandboxMemoryMb = parseShellSandboxNumericString(
      source.shellSandboxMemoryMb,
      "toolPolicy.shellSandboxMemoryMb",
      /^\d+$/,
      64,
      262144,
      warnings,
    );
  }

  if (source.shellSandboxCpus !== undefined) {
    toolPolicy.shellSandboxCpus = parseShellSandboxNumericString(
      source.shellSandboxCpus,
      "toolPolicy.shellSandboxCpus",
      /^\d+(?:\.\d+)?$/,
      0.1,
      64,
      warnings,
    );
  }

  if (source.shellSandboxPidsLimit !== undefined) {
    toolPolicy.shellSandboxPidsLimit = parseShellSandboxNumericString(
      source.shellSandboxPidsLimit,
      "toolPolicy.shellSandboxPidsLimit",
      /^\d+$/,
      16,
      1048576,
      warnings,
    );
  }

  if (source.executionGuard !== undefined) {
    toolPolicy.executionGuard = parseExecutionGuardLevel(
      source.executionGuard,
      warnings,
    );
  }

  return toolPolicy;
}

function parseShellSandboxChoice(
  value: unknown,
  field: string,
  allowed: readonly string[],
  warnings: string[],
): string | undefined {
  if (typeof value !== "string") {
    warnings.push(`Ignoring ${field} because it is not a string.`);
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (!allowed.includes(normalized)) {
    warnings.push(`Ignoring ${field} because it is not one of: ${allowed.join(", ")}.`);
    return undefined;
  }

  return normalized;
}

function parseShellSandboxNumericString(
  value: unknown,
  field: string,
  pattern: RegExp,
  min: number,
  max: number,
  warnings: string[],
): string | undefined {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    warnings.push(`Ignoring ${field} because it is not a valid number.`);
    return undefined;
  }

  const numeric = Number(value.trim());

  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    warnings.push(`Ignoring ${field} because it must be between ${min} and ${max}.`);
    return undefined;
  }

  return value.trim();
}

function parseShellSandboxString(
  value: unknown,
  field: string,
  warnings: string[],
): string | undefined {
  if (typeof value !== "string") {
    warnings.push(`Ignoring ${field} because it is not a string.`);
    return undefined;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    warnings.push(`Ignoring ${field} because it is empty.`);
    return undefined;
  }

  return normalized;
}

function parseExecutionGuardLevel(
  value: unknown,
  warnings: string[],
): ExecutionGuardLevel | undefined {
  const parsed = parseShellSandboxChoice(
    value,
    "toolPolicy.executionGuard",
    EXECUTION_GUARD_LEVELS,
    warnings,
  );

  if (parsed === undefined) {
    return undefined;
  }

  return isExecutionGuardLevel(parsed) ? parsed : undefined;
}

function parseToolNameArray(value: unknown, path: string, warnings: string[]): string[] {
  if (!Array.isArray(value)) {
    warnings.push(`Ignoring ${path} because it is not an array.`);
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      warnings.push(`Ignoring a ${path} item because it is not a non-empty string.`);
      return [];
    }

    return [item.trim()];
  });
}

function parseConfigListValue(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseConfigRiskListValue(value: string): ToolRiskLevel[] {
  const risks = parseConfigListValue(value);
  const invalid = risks.find((risk) => !isToolRiskLevel(risk));

  if (invalid) {
    throw new Error('Expected risk levels to be one or more of "low", "medium", or "high".');
  }

  return risks as ToolRiskLevel[];
}

function parseRiskArray(value: unknown, path: string, warnings: string[]): ToolRiskLevel[] {
  if (!Array.isArray(value)) {
    warnings.push(`Ignoring ${path} because it is not an array.`);
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item !== "string" || !isToolRiskLevel(item.trim())) {
      warnings.push(`Ignoring a ${path} item because it is not low, medium, or high.`);
      return [];
    }

    return [item.trim() as ToolRiskLevel];
  });
}

function isToolRiskLevel(value: string): value is ToolRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function readToolPolicyListValue(
  config: CCAgentConfig,
  key: ConfigKey,
): string[] | undefined {
  if (key === "toolPolicy.allowWritePaths") {
    return config.toolPolicy?.allowWritePaths;
  }

  if (key === "toolPolicy.deny") {
    return config.toolPolicy?.deny;
  }

  if (key === "toolPolicy.denyRisk") {
    return config.toolPolicy?.denyRisk;
  }

  if (key === "toolPolicy.denyWritePaths") {
    return config.toolPolicy?.denyWritePaths;
  }

  if (key === "toolPolicy.requireApproval") {
    return config.toolPolicy?.requireApproval;
  }

  if (key === "toolPolicy.requireApprovalRisk") {
    return config.toolPolicy?.requireApprovalRisk;
  }

  return undefined;
}

function getToolPolicyPropertyName(
  key: Extract<
    ConfigKey,
    | "toolPolicy.allowWritePaths"
    | "toolPolicy.deny"
    | "toolPolicy.denyRisk"
    | "toolPolicy.denyWritePaths"
    | "toolPolicy.requireApproval"
    | "toolPolicy.requireApprovalRisk"
    | "toolPolicy.shellSandbox"
    | "toolPolicy.shellSandboxImage"
    | "toolPolicy.shellSandboxNetwork"
    | "toolPolicy.shellSandboxReadOnly"
    | "toolPolicy.shellSandboxMemoryMb"
    | "toolPolicy.shellSandboxCpus"
    | "toolPolicy.shellSandboxPidsLimit"
    | "toolPolicy.executionGuard"
  >,
): string {
  if (key === "toolPolicy.allowWritePaths") {
    return "allowWritePaths";
  }

  if (key === "toolPolicy.deny") {
    return "deny";
  }

  if (key === "toolPolicy.denyRisk") {
    return "denyRisk";
  }

  if (key === "toolPolicy.denyWritePaths") {
    return "denyWritePaths";
  }

  if (key === "toolPolicy.requireApproval") {
    return "requireApproval";
  }

  if (key === "toolPolicy.shellSandbox") {
    return "shellSandbox";
  }

  if (key === "toolPolicy.shellSandboxImage") {
    return "shellSandboxImage";
  }

  if (key === "toolPolicy.shellSandboxNetwork") {
    return "shellSandboxNetwork";
  }

  if (key === "toolPolicy.shellSandboxReadOnly") {
    return "shellSandboxReadOnly";
  }

  if (key === "toolPolicy.shellSandboxMemoryMb") {
    return "shellSandboxMemoryMb";
  }

  if (key === "toolPolicy.shellSandboxCpus") {
    return "shellSandboxCpus";
  }

  if (key === "toolPolicy.shellSandboxPidsLimit") {
    return "shellSandboxPidsLimit";
  }

  if (key === "toolPolicy.executionGuard") {
    return "executionGuard";
  }

  return "requireApprovalRisk";
}

function isOpenAIRetryConfigKey(
  key: ConfigKey,
): key is Extract<
  ConfigKey,
  "openai.retry.baseDelayMs" | "openai.retry.maxAttempts" | "openai.retry.maxDelayMs"
> {
  return (
    key === "openai.retry.baseDelayMs" ||
    key === "openai.retry.maxAttempts" ||
    key === "openai.retry.maxDelayMs"
  );
}

function isShellSandboxConfigKey(
  key: ConfigKey,
): key is
  | "toolPolicy.shellSandbox"
  | "toolPolicy.shellSandboxImage"
  | "toolPolicy.shellSandboxNetwork"
  | "toolPolicy.shellSandboxReadOnly"
  | "toolPolicy.shellSandboxMemoryMb"
  | "toolPolicy.shellSandboxCpus"
  | "toolPolicy.shellSandboxPidsLimit"
  | "toolPolicy.executionGuard" {
  return (
    key === "toolPolicy.shellSandbox" ||
    key === "toolPolicy.shellSandboxImage" ||
    key === "toolPolicy.shellSandboxNetwork" ||
    key === "toolPolicy.shellSandboxReadOnly" ||
    key === "toolPolicy.shellSandboxMemoryMb" ||
    key === "toolPolicy.shellSandboxCpus" ||
    key === "toolPolicy.shellSandboxPidsLimit" ||
    key === "toolPolicy.executionGuard"
  );
}

function isShellSandboxModeValue(value: string): boolean {
  return (SHELL_SANDBOX_MODES as readonly string[]).includes(value);
}

function isShellSandboxNetworkValue(value: string): boolean {
  return (SHELL_SANDBOX_NETWORKS as readonly string[]).includes(value);
}

function getOpenAIRetryPropertyName(
  key: Extract<
    ConfigKey,
    "openai.retry.baseDelayMs" | "openai.retry.maxAttempts" | "openai.retry.maxDelayMs"
  >,
): "baseDelayMs" | "maxAttempts" | "maxDelayMs" {
  if (key === "openai.retry.baseDelayMs") {
    return "baseDelayMs";
  }

  if (key === "openai.retry.maxAttempts") {
    return "maxAttempts";
  }

  return "maxDelayMs";
}

function parseOpenAIRetryConfigSetValue(
  key: Extract<
    ConfigKey,
    "openai.retry.baseDelayMs" | "openai.retry.maxAttempts" | "openai.retry.maxDelayMs"
  >,
  value: string,
): number {
  const bounds = getOpenAIRetryBounds(key);
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected ${key} to be an integer.`);
  }

  if (parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`Expected ${key} to be between ${bounds.min} and ${bounds.max}.`);
  }

  return parsed;
}

function parseOpenAIRetryNumber(
  value: unknown,
  key: Extract<
    ConfigKey,
    "openai.retry.baseDelayMs" | "openai.retry.maxAttempts" | "openai.retry.maxDelayMs"
  >,
  min: number,
  max: number,
  warnings: string[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    warnings.push(`Ignoring ${key} because it is not an integer.`);
    return undefined;
  }

  if (value < min || value > max) {
    warnings.push(`Ignoring ${key} because it is not between ${min} and ${max}.`);
    return undefined;
  }

  return value;
}

function getOpenAIRetryBounds(
  key: Extract<
    ConfigKey,
    "openai.retry.baseDelayMs" | "openai.retry.maxAttempts" | "openai.retry.maxDelayMs"
  >,
): { max: number; min: number } {
  if (key === "openai.retry.maxAttempts") {
    return { max: 5, min: 1 };
  }

  return { max: 60_000, min: 0 };
}

function formatOptionalNumber(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function validateBaseURL(value: string): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected openai.baseURL to be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Expected openai.baseURL to use http or https.");
  }
}

function validateIntegerConfigValue(
  key: string,
  trimmed: string,
  min: number,
  max: number,
): string {
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Expected ${key} to be an integer.`);
  }

  const numeric = Number(trimmed);

  if (numeric < min || numeric > max) {
    throw new Error(`Expected ${key} to be between ${min} and ${max}.`);
  }

  return String(numeric);
}

function validateDecimalConfigValue(
  key: string,
  trimmed: string,
  min: number,
  max: number,
): string {
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`Expected ${key} to be a number.`);
  }

  const numeric = Number(trimmed);

  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    throw new Error(`Expected ${key} to be between ${min} and ${max}.`);
  }

  return trimmed;
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
