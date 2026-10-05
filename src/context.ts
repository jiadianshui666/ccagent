import type { LoadedConfig } from "./config.js";
import type { LoadedProjectCommands } from "./commands.js";
import type { LoadedProjectInstructions } from "./instructions.js";
import type { LoadedProjectSkills } from "./skills.js";

export type RuntimeContextSummary = {
  allowEdits: boolean;
  json: boolean;
  loadedConfig: LoadedConfig;
  mcp: {
    enabled: boolean;
    prompts: number;
    resources: number;
    servers: number;
    templates: number;
    tools: number;
  };
  modelName: string;
  projectCommands: LoadedProjectCommands;
  projectInstructions: LoadedProjectInstructions;
  projectSkills: LoadedProjectSkills;
  sessionCreatedAt: string | null;
  sessionPath?: string;
  stream: boolean;
  systemPromptLength: number;
  toolCount: number;
  useSession: boolean;
  verifyCommand?: string;
  workspaceRoot: string;
};

export function formatRuntimeContext(summary: RuntimeContextSummary): string {
  const lines = [
    "Runtime context",
    `Workspace: ${summary.workspaceRoot}`,
    `Model: ${summary.modelName}`,
    "",
    "Run flags:",
    `- --allow-edits: ${summary.allowEdits ? "on" : "off"}`,
    `- --verify: ${summary.verifyCommand ?? "(none)"}`,
    `- --stream: ${summary.stream ? "on" : "off"}`,
    `- --json: ${summary.json ? "on" : "off"}`,
    `- session: ${summary.useSession ? "on" : "off"}`,
    "",
    "Config:",
    `- path: ${summary.loadedConfig.path}`,
    `- loaded: ${summary.loadedConfig.exists ? "yes" : "no"}`,
    `- model: ${summary.loadedConfig.config.model ?? "(default)"}`,
    `- context.auto: ${summary.loadedConfig.config.context?.auto === false ? "off" : "on"}`,
    `- openai.apiMode: ${summary.loadedConfig.config.openai?.apiMode ?? "(default)"}`,
    `- openai.baseURL: ${summary.loadedConfig.config.openai?.baseURL ?? "(default)"}`,
    `- openai.embeddingModel: ${summary.loadedConfig.config.openai?.embeddingModel ?? "(local semantic index)"}`,
    `- openai.retry.maxAttempts: ${summary.loadedConfig.config.openai?.retry?.maxAttempts ?? "(default)"}`,
    `- openai.retry.baseDelayMs: ${summary.loadedConfig.config.openai?.retry?.baseDelayMs ?? "(default)"}`,
    `- openai.retry.maxDelayMs: ${summary.loadedConfig.config.openai?.retry?.maxDelayMs ?? "(default)"}`,
    `- mcp.enabled: ${summary.mcp.enabled ? "on" : "off"}`,
    `- mcp.servers: ${summary.mcp.servers}`,
    `- mcp.tools: ${summary.mcp.tools}`,
    `- mcp.resources: ${summary.mcp.resources}`,
    `- mcp.prompts: ${summary.mcp.prompts}`,
    `- mcp.templates: ${summary.mcp.templates}`,
    "",
    "Project instructions:",
    `- path: ${summary.projectInstructions.path}`,
    `- loaded: ${summary.projectInstructions.exists ? "yes" : "no"}`,
    `- bytes: ${summary.projectInstructions.bytes ?? 0}`,
    `- content chars: ${summary.projectInstructions.content.length}`,
    "",
    "Project commands:",
    `- path: ${summary.projectCommands.path}`,
    `- count: ${summary.projectCommands.commands.length}`,
    `- names: ${formatProjectCommandNames(summary.projectCommands)}`,
    "",
    "Project skills:",
    `- path: ${summary.projectSkills.path}`,
    `- count: ${summary.projectSkills.skills.length}`,
    `- names: ${formatProjectSkillNames(summary.projectSkills)}`,
    "",
    "Model prompt:",
    `- system prompt chars: ${summary.systemPromptLength}`,
    "",
    "Tools:",
    `- registered: ${summary.toolCount}`,
    "",
    "Session:",
    `- path: ${summary.sessionPath ?? "(disabled)"}`,
    `- loaded: ${summary.sessionCreatedAt ? "yes" : "no"}`,
  ];

  const warnings = [
    ...summary.loadedConfig.warnings.map((warning) => `config: ${warning}`),
    ...summary.projectInstructions.warnings.map((warning) => `instructions: ${warning}`),
    ...summary.projectCommands.warnings.map((warning) => `commands: ${warning}`),
    ...summary.projectSkills.warnings.map((warning) => `skills: ${warning}`),
  ];

  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    lines.push(...warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatProjectSkillNames(projectSkills: LoadedProjectSkills): string {
  if (projectSkills.skills.length === 0) {
    return "(none)";
  }

  return projectSkills.skills.map((skill) => skill.name).join(", ");
}

function formatProjectCommandNames(projectCommands: LoadedProjectCommands): string {
  if (projectCommands.commands.length === 0) {
    return "(none)";
  }

  return projectCommands.commands.map((command) => command.name).join(", ");
}
