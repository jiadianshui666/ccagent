import { resolve } from "node:path";
import type { McpServerConfig, CCAgentConfig } from "./config.js";
import type { Tool, ToolContext, ToolParameterSchema, ToolResult } from "./tools/types.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_MCP_RESULT_CHARS = 12_000;
const MAX_MCP_TOOL_NAME_LENGTH = 64;

type McpClientHandle = {
  close(): Promise<void>;
};

type McpToolDescriptor = {
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

type McpResourceDescriptor = {
  description?: string;
  mimeType?: string;
  name: string;
  uri: string;
};

type McpResourceTemplateDescriptor = {
  description?: string;
  mimeType?: string;
  name: string;
  uriTemplate: string;
};

type McpPromptArgument = {
  description?: string;
  name: string;
  required?: boolean;
};

type McpPromptDescriptor = {
  arguments?: McpPromptArgument[];
  description?: string;
  name: string;
};

type McpCallResult = {
  content?: unknown;
  isError?: unknown;
  structuredContent?: unknown;
};

type McpReadResourceResult = {
  contents: Array<{
    blob?: string;
    mimeType?: string;
    text?: string;
    uri: string;
  }>;
};

type McpGetPromptResult = {
  description?: string;
  messages: Array<{
    content: unknown;
    role: "assistant" | "user";
  }>;
};

type McpToolClient = McpClientHandle & {
  callTool(input: { arguments: Record<string, unknown>; name: string }): Promise<McpCallResult>;
  connect(transport: unknown): Promise<void>;
  getServerCapabilities(): { prompts?: unknown; resources?: unknown; tools?: unknown } | undefined;
  listResources(input?: { cursor?: string }): Promise<{
    nextCursor?: string;
    resources: McpResourceDescriptor[];
  }>;
  listResourceTemplates(input?: { cursor?: string }): Promise<{
    nextCursor?: string;
    resourceTemplates: McpResourceTemplateDescriptor[];
  }>;
  readResource(input: { uri: string }): Promise<McpReadResourceResult>;
  getPrompt(input: { arguments?: Record<string, string>; name: string }): Promise<McpGetPromptResult>;
  listPrompts(input?: { cursor?: string }): Promise<{
    nextCursor?: string;
    prompts: McpPromptDescriptor[];
  }>;
};

type McpClientSession = {
  client: McpToolClient;
  name: string;
  timeoutMs: number;
};

export type McpServerStatus = {
  name: string;
  toolCount: number;
};

export type McpServerConnectionStatus = {
  command: string;
  error?: string;
  name: string;
  resourceCount: number;
  promptCount: number;
  templateCount: number;
  status: "connected" | "disabled" | "unavailable";
  toolCount: number;
};

export type McpToolStatus = {
  description: string;
  name: string;
  serverName: string;
  toolName: string;
};

export type McpResourceStatus = {
  description?: string;
  mimeType?: string;
  name: string;
  serverName: string;
  uri: string;
};

export type McpResourceTemplateStatus = {
  description?: string;
  mimeType?: string;
  name: string;
  serverName: string;
  uriTemplate: string;
};

export type McpPromptStatus = {
  arguments: McpPromptArgument[];
  description?: string;
  name: string;
  serverName: string;
};

export type McpPromptResult =
  | {
      ok: true;
      description?: string;
      messages: Array<{ content: string; role: "assistant" | "user" }>;
      name: string;
      serverName: string;
    }
  | {
      ok: false;
      error: string;
      name: string;
      serverName: string;
    };

export type McpResourceReadResult =
  | {
      ok: true;
      content: string;
      mimeTypes: string[];
      serverName: string;
      uri: string;
    }
  | {
      ok: false;
      error: string;
      serverName: string;
      uri: string;
    };

export class McpManager {
  constructor(private readonly sessions: McpClientSession[]) {}

  async close(): Promise<void> {
    await Promise.all(this.sessions.map(async ({ client }) => {
      try {
        await client.close();
      } catch {
        // Shutdown is best-effort; the CLI process is already exiting.
      }
    }));
  }

  async readResource(serverName: string, uri: string): Promise<McpResourceReadResult> {
    const session = this.sessions.find((candidate) => candidate.name === serverName);

    if (!session) {
      return {
        ok: false,
        error: `MCP server "${serverName}" is not connected.`,
        serverName,
        uri,
      };
    }

    try {
      const result = await withTimeout(
        `MCP resource ${serverName} ${uri}`,
        session.client.readResource({ uri }),
        session.timeoutMs,
      );
      const mimeTypes = [...new Set(result.contents.flatMap((item) => item.mimeType ? [item.mimeType] : []))];
      const content = truncate(
        result.contents.map(formatMcpResourceContent).filter(Boolean).join("\n"),
        MAX_MCP_RESULT_CHARS,
      );

      return {
        ok: true,
        content: content || "MCP resource returned no readable content.",
        mimeTypes,
        serverName,
        uri,
      };
    } catch (error) {
      return {
        ok: false,
        error: formatError(error),
        serverName,
        uri,
      };
    }
  }

  async getPrompt(
    serverName: string,
    name: string,
    args: Record<string, string>,
  ): Promise<McpPromptResult> {
    const session = this.sessions.find((candidate) => candidate.name === serverName);

    if (!session) {
      return {
        ok: false,
        error: `MCP server "${serverName}" is not connected.`,
        name,
        serverName,
      };
    }

    try {
      const result = await withTimeout(
        `MCP prompt ${serverName}.${name}`,
        session.client.getPrompt({
          ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
          name,
        }),
        session.timeoutMs,
      );
      const messages = result.messages.map((message) => ({
        content: formatMcpPromptContent(message.content),
        role: message.role,
      }));

      return {
        ...(result.description ? { description: result.description } : {}),
        messages,
        name,
        ok: true,
        serverName,
      };
    } catch (error) {
      return {
        error: formatError(error),
        name,
        ok: false,
        serverName,
      };
    }
  }
}

export type McpToolLoadResult = {
  manager: McpManager;
  prompts: McpPromptStatus[];
  resources: McpResourceStatus[];
  templates: McpResourceTemplateStatus[];
  serverStatuses: McpServerConnectionStatus[];
  servers: McpServerStatus[];
  toolStatuses: McpToolStatus[];
  tools: Tool[];
  warnings: string[];
};

export async function loadMcpTools(
  mcp: CCAgentConfig["mcp"] | undefined,
  workspaceRoot: string,
  reservedToolNames: Iterable<string> = [],
): Promise<McpToolLoadResult> {
  const warnings: string[] = [];
  const sessions: McpClientSession[] = [];
  const prompts: McpPromptStatus[] = [];
  const resources: McpResourceStatus[] = [];
  const templates: McpResourceTemplateStatus[] = [];
  const serverStatuses: McpServerConnectionStatus[] = [];
  const servers: McpServerStatus[] = [];
  const toolStatuses: McpToolStatus[] = [];
  const tools: Tool[] = [];
  const usedNames = new Set([...reservedToolNames].map((name) => name.toLowerCase()));
  const configuredServers = Object.entries(mcp?.servers ?? {});

  if (mcp?.enabled !== true) {
    serverStatuses.push(...configuredServers.map(([name, server]) => ({
      command: server.command,
      name,
      promptCount: 0,
      resourceCount: 0,
      templateCount: 0,
      status: "disabled" as const,
      toolCount: 0,
    })));

    return {
      manager: new McpManager(sessions),
      prompts,
      resources,
      serverStatuses,
      servers,
      templates,
      toolStatuses,
      tools,
      warnings,
    };
  }

  if (configuredServers.length === 0) {
    warnings.push("MCP is enabled but no servers are configured.");
    return {
      manager: new McpManager(sessions),
      prompts,
      resources,
      serverStatuses,
      servers,
      templates,
      toolStatuses,
      tools,
      warnings,
    };
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const {
    getDefaultEnvironment,
    StdioClientTransport,
  } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  for (const [serverName, server] of configuredServers) {
    const timeoutMs = server.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    let client: McpToolClient | undefined;

    try {
      const transport = new StdioClientTransport({
        args: server.args,
        command: server.command,
        cwd: resolveMcpWorkingDirectory(workspaceRoot, server),
        env: {
          ...getDefaultEnvironment(),
          ...server.env,
        },
        stderr: "pipe",
      });
      client = new Client({ name: "ccagent", version: "0.1.0" }) as McpToolClient;
      await withTimeout(
        `MCP server "${serverName}" initialization`,
        client.connect(transport),
        timeoutMs,
      );
      const capabilities = client.getServerCapabilities();
      const descriptors = capabilities?.tools
        ? await listMcpTools(client, timeoutMs)
        : [];
      let discoveredTools = 0;
      let discoveredResources = 0;
      let discoveredPrompts = 0;
      let discoveredTemplates = 0;

      for (const descriptor of descriptors) {
        const toolName = createMcpToolName(serverName, descriptor.name, usedNames);

        if (!toolName) {
          warnings.push(`Skipping MCP tool "${serverName}.${descriptor.name}" because its name conflicts or is invalid.`);
          continue;
        }

        tools.push(new McpTool({
          client,
          descriptor,
          serverName,
          timeoutMs,
          toolName,
        }));
        toolStatuses.push({
          description: descriptor.description?.trim() || descriptor.name,
          name: toolName,
          serverName,
          toolName: descriptor.name,
        });
        discoveredTools += 1;
      }

      if (capabilities?.resources) {
        try {
          const resourceDescriptors = await listMcpResources(client, timeoutMs);

          for (const descriptor of resourceDescriptors) {
            resources.push({
              ...(descriptor.description ? { description: descriptor.description } : {}),
              ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
              name: descriptor.name,
              serverName,
              uri: descriptor.uri,
            });
            discoveredResources += 1;
          }
        } catch (error) {
          warnings.push(`MCP server "${serverName}" resource discovery failed: ${formatError(error)}`);
        }

        try {
          const templateDescriptors = await listMcpResourceTemplates(client, timeoutMs);

          for (const descriptor of templateDescriptors) {
            templates.push({
              ...(descriptor.description ? { description: descriptor.description } : {}),
              ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
              name: descriptor.name,
              serverName,
              uriTemplate: descriptor.uriTemplate,
            });
            discoveredTemplates += 1;
          }
        } catch (error) {
          warnings.push(`MCP server "${serverName}" resource template discovery failed: ${formatError(error)}`);
        }
      }

      if (capabilities?.prompts) {
        try {
          const promptDescriptors = await listMcpPrompts(client, timeoutMs);

          for (const descriptor of promptDescriptors) {
            prompts.push({
              arguments: descriptor.arguments ?? [],
              ...(descriptor.description ? { description: descriptor.description } : {}),
              name: descriptor.name,
              serverName,
            });
            discoveredPrompts += 1;
          }
        } catch (error) {
          warnings.push(`MCP server "${serverName}" prompt discovery failed: ${formatError(error)}`);
        }
      }

      sessions.push({ client, name: serverName, timeoutMs });
      servers.push({ name: serverName, toolCount: discoveredTools });
      serverStatuses.push({
        command: server.command,
        name: serverName,
        promptCount: discoveredPrompts,
        resourceCount: discoveredResources,
        status: "connected",
        templateCount: discoveredTemplates,
        toolCount: discoveredTools,
      });
    } catch (error) {
      if (client) {
        try {
          await client.close();
        } catch {
          // Connection setup already failed; ignore cleanup failures.
        }
      }

      const reason = formatError(error);
      serverStatuses.push({
        command: server.command,
        error: reason,
        name: serverName,
        promptCount: 0,
        resourceCount: 0,
        status: "unavailable",
        templateCount: 0,
        toolCount: 0,
      });
      warnings.push(`MCP server "${serverName}" is unavailable: ${reason}`);
    }
  }

  return {
    manager: new McpManager(sessions),
    prompts,
    resources,
    serverStatuses,
    servers,
    templates,
    toolStatuses,
    tools,
    warnings,
  };
}

export type McpCommand =
  | {
      action: "prompts" | "reload" | "resources" | "status" | "templates" | "tools";
      json: boolean;
    }
  | {
      action: "read";
      json: boolean;
      serverName: string;
      uri: string;
    }
  | {
      action: "prompt";
      arguments: Record<string, string>;
      json: boolean;
      name: string;
      serverName: string;
    };

export function parseMcpCommand(input: string): McpCommand | { error: string } {
  const rawInput = input.trim();
  const json = /(?:^|\s)--json(?=\s|$)/.test(rawInput);
  const commandInput = rawInput.replace(/(?:^|\s)--json(?=\s|$)/g, " ").trim();
  const positional = commandInput.split(/\s+/).filter(Boolean);
  const action = positional[0] ?? "status";
  const usage = "Usage: /mcp [status|tools|resources|templates|prompts|reload] [--json] | /mcp read <server> <uri> [--json] | /mcp prompt <server> <name> [arguments-json] [--json]";

  if (action === "read") {
    if (positional.length !== 3) {
      return { error: usage };
    }

    return {
      action: "read",
      json,
      serverName: positional[1] ?? "",
      uri: positional[2] ?? "",
    };
  }

  if (action === "prompt") {
    const match = commandInput.match(/^prompt\s+(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);

    if (!match) {
      return { error: usage };
    }

    const parsedArguments = parseMcpPromptArguments(match[3]);

    if (!parsedArguments.ok) {
      return { error: parsedArguments.error };
    }

    return {
      action: "prompt",
      arguments: parsedArguments.value,
      json,
      name: match[2] ?? "",
      serverName: match[1] ?? "",
    };
  }

  if (
    positional.length > 1 ||
    (
      action !== "reload" &&
      action !== "prompts" &&
      action !== "resources" &&
      action !== "status" &&
      action !== "templates" &&
      action !== "tools"
    )
  ) {
    return { error: usage };
  }

  return {
    action,
    json,
  };
}

function parseMcpPromptArguments(value: string | undefined):
  | { ok: true; value: Record<string, string> }
  | { error: string; ok: false } {
  if (!value) {
    return { ok: true, value: {} };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    const source = asRecord(parsed);

    if (!source || Object.values(source).some((item) => typeof item !== "string")) {
      return {
        error: "MCP prompt arguments must be a JSON object with string values.",
        ok: false,
      };
    }

    return { ok: true, value: source as Record<string, string> };
  } catch {
    return { error: "MCP prompt arguments must be valid JSON.", ok: false };
  }
}

export function formatMcpStatus(
  mcp: McpToolLoadResult,
  enabled: boolean,
  json = false,
): string {
  const summary = createMcpStatusSummary(mcp, enabled);

  if (json) {
    return JSON.stringify(summary, null, 2);
  }

  const lines = [
    "MCP status",
    `Enabled: ${enabled ? "yes" : "no"}`,
    `Configured servers: ${summary.configuredServers}`,
    `Connected servers: ${summary.connectedServers}`,
    `Discovered tools: ${summary.toolCount}`,
    `Discovered resources: ${summary.resourceCount}`,
    `Discovered prompts: ${summary.promptCount}`,
    `Discovered resource templates: ${summary.templateCount}`,
    "",
    "Servers:",
  ];

  if (mcp.serverStatuses.length === 0) {
    lines.push("- (none)");
  } else {
    for (const server of mcp.serverStatuses) {
      const details = [
        `status=${server.status}`,
        `tools=${server.toolCount}`,
        `resources=${server.resourceCount}`,
        `prompts=${server.promptCount}`,
        `templates=${server.templateCount}`,
        `command=${server.command}`,
      ];

      if (server.error) {
        details.push(`error=${server.error}`);
      }

      lines.push(`- ${server.name}: ${details.join(", ")}`);
    }
  }

  if (mcp.warnings.length > 0) {
    lines.push("", "Warnings:", ...mcp.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function formatMcpReloadResult(
  mcp: McpToolLoadResult,
  enabled: boolean,
  configWarnings: string[] = [],
  json = false,
): string {
  const summary = createMcpStatusSummary(mcp, enabled);

  if (json) {
    return JSON.stringify({
      reloaded: true,
      ...summary,
      configWarnings,
    }, null, 2);
  }

  const lines = ["MCP reloaded", "", formatMcpStatus(mcp, enabled)];

  if (configWarnings.length > 0) {
    lines.push("", "Config warnings:", ...configWarnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function formatMcpTools(
  mcp: McpToolLoadResult,
  json = false,
): string {
  const tools = mcp.toolStatuses;

  if (json) {
    return JSON.stringify({ count: tools.length, tools }, null, 2);
  }

  const lines = ["MCP tools", `Count: ${tools.length}`, ""];

  if (tools.length === 0) {
    lines.push("- (none)");
  } else {
    for (const tool of tools) {
      lines.push(`- ${tool.name} (${tool.serverName}.${tool.toolName}): ${tool.description}`);
    }
  }

  return lines.join("\n");
}

export function formatMcpResources(
  mcp: McpToolLoadResult,
  json = false,
): string {
  const resources = mcp.resources;

  if (json) {
    return JSON.stringify({ count: resources.length, resources }, null, 2);
  }

  const lines = ["MCP resources", `Count: ${resources.length}`, ""];

  if (resources.length === 0) {
    lines.push("- (none)");
  } else {
    for (const resource of resources) {
      const metadata = [
        resource.mimeType ? `type=${resource.mimeType}` : null,
        resource.description ? `description=${resource.description}` : null,
      ].filter(Boolean);
      lines.push(
        `- ${resource.serverName}: ${resource.name} (${resource.uri})${metadata.length > 0 ? `, ${metadata.join(", ")}` : ""}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatMcpResourceTemplates(
  mcp: McpToolLoadResult,
  json = false,
): string {
  const templates = mcp.templates;

  if (json) {
    return JSON.stringify({ count: templates.length, templates }, null, 2);
  }

  const lines = ["MCP resource templates", `Count: ${templates.length}`, ""];

  if (templates.length === 0) {
    lines.push("- (none)");
  } else {
    for (const template of templates) {
      const metadata = [
        template.mimeType ? `type=${template.mimeType}` : null,
        template.description ? `description=${template.description}` : null,
      ].filter(Boolean);
      lines.push(
        `- ${template.serverName}: ${template.name} (${template.uriTemplate})${metadata.length > 0 ? `, ${metadata.join(", ")}` : ""}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatMcpResourceReadResult(
  result: McpResourceReadResult,
  json = false,
): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }

  if (!result.ok) {
    return [
      "MCP resource read failed",
      `Server: ${result.serverName}`,
      `URI: ${result.uri}`,
      `Error: ${result.error}`,
    ].join("\n");
  }

  return [
    "MCP resource",
    `Server: ${result.serverName}`,
    `URI: ${result.uri}`,
    `MIME types: ${result.mimeTypes.length > 0 ? result.mimeTypes.join(", ") : "(unknown)"}`,
    "",
    result.content,
  ].join("\n");
}

export function formatMcpPrompts(
  mcp: McpToolLoadResult,
  json = false,
): string {
  const prompts = mcp.prompts;

  if (json) {
    return JSON.stringify({ count: prompts.length, prompts }, null, 2);
  }

  const lines = ["MCP prompts", `Count: ${prompts.length}`, ""];

  if (prompts.length === 0) {
    lines.push("- (none)");
  } else {
    for (const prompt of prompts) {
      const argumentSummary = prompt.arguments.length > 0
        ? prompt.arguments.map((argument) => `${argument.name}${argument.required ? "*" : ""}`).join(", ")
        : "none";
      lines.push(
        `- ${prompt.serverName}.${prompt.name}: ${prompt.description ?? "(no description)"} (arguments: ${argumentSummary})`,
      );
    }
  }

  return lines.join("\n");
}

export function formatMcpPromptResult(
  result: McpPromptResult,
  json = false,
): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }

  if (!result.ok) {
    return [
      "MCP prompt failed",
      `Server: ${result.serverName}`,
      `Prompt: ${result.name}`,
      `Error: ${result.error}`,
    ].join("\n");
  }

  return [
    "MCP prompt",
    `Server: ${result.serverName}`,
    `Prompt: ${result.name}`,
    `Description: ${result.description ?? "(none)"}`,
    "",
    ...result.messages.flatMap((message, index) => [
      `[${index + 1}] ${message.role}`,
      message.content,
      "",
    ]),
  ].join("\n").trimEnd();
}

function createMcpStatusSummary(mcp: McpToolLoadResult, enabled: boolean) {
  return {
    connectedServers: mcp.serverStatuses.filter((server) => server.status === "connected").length,
    configuredServers: mcp.serverStatuses.length,
    enabled,
    promptCount: mcp.prompts.length,
    resourceCount: mcp.resources.length,
    servers: mcp.serverStatuses,
    templateCount: mcp.templates.length,
    toolCount: mcp.toolStatuses.length,
    warnings: mcp.warnings,
  };
}

class McpTool implements Tool {
  readonly description: string;
  readonly name: string;
  readonly parameters: ToolParameterSchema;
  private readonly optionalProperties: Set<string>;

  constructor(private readonly options: {
    client: McpToolClient;
    descriptor: McpToolDescriptor;
    serverName: string;
    timeoutMs: number;
    toolName: string;
  }) {
    const normalized = normalizeMcpInputSchema(options.descriptor.inputSchema);
    this.name = options.toolName;
    this.description = `MCP server ${options.serverName}: ${options.descriptor.description?.trim() || options.descriptor.name}`;
    this.parameters = normalized.parameters;
    this.optionalProperties = normalized.optionalProperties;
  }

  approvalMessage(input: Record<string, unknown>): string {
    return [
      `Run external MCP tool ${this.options.serverName}.${this.options.descriptor.name}?`,
      `Input: ${truncate(JSON.stringify(input), 800)}`,
    ].join("\n");
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const argumentsForServer = Object.fromEntries(
      Object.entries(input).filter(([key, value]) => !(value === null && this.optionalProperties.has(key))),
    );

    try {
      const result = await withTimeout(
        `MCP tool ${this.options.serverName}.${this.options.descriptor.name}`,
        this.options.client.callTool({
          arguments: argumentsForServer,
          name: this.options.descriptor.name,
        }),
        this.options.timeoutMs,
      );
      const content = formatMcpCallResult(result);

      if (result.isError === true) {
        return {
          ok: false,
          error: content || `MCP tool ${this.options.serverName}.${this.options.descriptor.name} returned an error.`,
        };
      }

      return {
        ok: true,
        content: content || "MCP tool completed without content.",
        metadata: {
          mcpServer: this.options.serverName,
          mcpTool: this.options.descriptor.name,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: `MCP tool ${this.options.serverName}.${this.options.descriptor.name} failed: ${formatError(error)}`,
      };
    }
  }
}

async function listMcpTools(client: McpToolClient, timeoutMs: number): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await withTimeout(
      "MCP tool discovery",
      (client as unknown as {
        listTools(input?: { cursor?: string }): Promise<{ nextCursor?: string; tools: McpToolDescriptor[] }>;
      }).listTools(cursor ? { cursor } : undefined),
      timeoutMs,
    );
    tools.push(...result.tools.filter(isMcpToolDescriptor));

    if (!result.nextCursor || result.nextCursor === cursor) {
      break;
    }

    cursor = result.nextCursor;
  }

  return tools;
}

async function listMcpResources(
  client: McpToolClient,
  timeoutMs: number,
): Promise<McpResourceDescriptor[]> {
  const resources: McpResourceDescriptor[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await withTimeout(
      "MCP resource discovery",
      client.listResources(cursor ? { cursor } : undefined),
      timeoutMs,
    );
    resources.push(...result.resources.filter(isMcpResourceDescriptor));

    if (!result.nextCursor || result.nextCursor === cursor) {
      break;
    }

    cursor = result.nextCursor;
  }

  return resources;
}

async function listMcpResourceTemplates(
  client: McpToolClient,
  timeoutMs: number,
): Promise<McpResourceTemplateDescriptor[]> {
  const templates: McpResourceTemplateDescriptor[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await withTimeout(
      "MCP resource template discovery",
      client.listResourceTemplates(cursor ? { cursor } : undefined),
      timeoutMs,
    );
    templates.push(...result.resourceTemplates.filter(isMcpResourceTemplateDescriptor));

    if (!result.nextCursor || result.nextCursor === cursor) {
      break;
    }

    cursor = result.nextCursor;
  }

  return templates;
}

async function listMcpPrompts(
  client: McpToolClient,
  timeoutMs: number,
): Promise<McpPromptDescriptor[]> {
  const prompts: McpPromptDescriptor[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await withTimeout(
      "MCP prompt discovery",
      client.listPrompts(cursor ? { cursor } : undefined),
      timeoutMs,
    );
    prompts.push(...result.prompts.filter(isMcpPromptDescriptor));

    if (!result.nextCursor || result.nextCursor === cursor) {
      break;
    }

    cursor = result.nextCursor;
  }

  return prompts;
}

function isMcpToolDescriptor(value: unknown): value is McpToolDescriptor {
  const source = asRecord(value);
  return Boolean(
    source
    && typeof source.name === "string"
    && source.name.trim()
    && asRecord(source.inputSchema)?.type === "object",
  );
}

function isMcpResourceDescriptor(value: unknown): value is McpResourceDescriptor {
  const source = asRecord(value);
  return Boolean(
    source
    && typeof source.name === "string"
    && source.name.trim()
    && typeof source.uri === "string"
    && source.uri.trim(),
  );
}

function isMcpResourceTemplateDescriptor(value: unknown): value is McpResourceTemplateDescriptor {
  const source = asRecord(value);
  return Boolean(
    source
    && typeof source.name === "string"
    && source.name.trim()
    && typeof source.uriTemplate === "string"
    && source.uriTemplate.trim(),
  );
}

function isMcpPromptDescriptor(value: unknown): value is McpPromptDescriptor {
  const source = asRecord(value);
  return Boolean(source && typeof source.name === "string" && source.name.trim());
}

function normalizeMcpInputSchema(inputSchema: Record<string, unknown>): {
  optionalProperties: Set<string>;
  parameters: ToolParameterSchema;
} {
  const source = asRecord(inputSchema) ?? {};
  const properties = asRecord(source.properties) ?? {};
  const required = new Set(
    Array.isArray(source.required)
      ? source.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const optionalProperties = new Set(Object.keys(properties).filter((name) => !required.has(name)));
  const normalizedProperties = Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [
      name,
      optionalProperties.has(name)
        ? { anyOf: [normalizeMcpSchema(schema), { type: "null" }] }
        : normalizeMcpSchema(schema),
    ]),
  );

  return {
    optionalProperties,
    parameters: {
      additionalProperties: false,
      properties: normalizedProperties,
      required: Object.keys(normalizedProperties),
      type: "object",
    },
  };
}

function normalizeMcpSchema(value: unknown): Record<string, unknown> {
  const source = asRecord(value);

  if (!source) {
    return {};
  }

  const normalized: Record<string, unknown> = { ...source };

  if (source.type === "object" || source.properties !== undefined) {
    const properties = asRecord(source.properties) ?? {};
    normalized.type = "object";
    normalized.properties = Object.fromEntries(
      Object.entries(properties).map(([name, schema]) => [name, normalizeMcpSchema(schema)]),
    );
    normalized.required = Object.keys(properties);
    normalized.additionalProperties = false;
  }

  if (source.type === "array") {
    normalized.items = normalizeMcpSchema(source.items ?? {});
  }

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(source[key])) {
      normalized[key] = source[key].map(normalizeMcpSchema);
    }
  }

  return normalized;
}

function createMcpToolName(serverName: string, toolName: string, usedNames: Set<string>): string | null {
  const server = serverName.replaceAll(/[^A-Za-z0-9_]/g, "_");
  const tool = toolName.trim().replaceAll(/[^A-Za-z0-9_]/g, "_");

  if (!tool) {
    return null;
  }

  const base = `mcp_${server}_${tool}`.slice(0, MAX_MCP_TOOL_NAME_LENGTH);

  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0
      ? base
      : `${base.slice(0, MAX_MCP_TOOL_NAME_LENGTH - String(suffix).length - 1)}_${suffix}`;

    if (!usedNames.has(candidate.toLowerCase())) {
      usedNames.add(candidate.toLowerCase());
      return candidate;
    }
  }

  return null;
}

function resolveMcpWorkingDirectory(workspaceRoot: string, server: McpServerConfig): string {
  return server.cwd ? resolve(workspaceRoot, server.cwd) : workspaceRoot;
}

function formatMcpCallResult(result: McpCallResult): string {
  const content = Array.isArray(result.content)
    ? result.content.flatMap(formatMcpContentItem).filter(Boolean)
    : [];

  if (result.structuredContent !== undefined) {
    content.push(JSON.stringify(result.structuredContent, null, 2));
  }

  return truncate(content.join("\n"), MAX_MCP_RESULT_CHARS);
}

function formatMcpResourceContent(value: McpReadResourceResult["contents"][number]): string {
  if (typeof value.text === "string") {
    return value.text;
  }

  if (typeof value.blob === "string") {
    return `[binary MCP resource omitted: ${value.blob.length} base64 characters]`;
  }

  return "";
}

function formatMcpPromptContent(value: unknown): string {
  const content = asRecord(value);

  if (!content || typeof content.type !== "string") {
    return "[invalid MCP prompt content omitted]";
  }

  if (content.type === "text" && typeof content.text === "string") {
    return truncate(content.text, MAX_MCP_RESULT_CHARS);
  }

  if (content.type === "resource") {
    const resource = asRecord(content.resource);

    if (typeof resource?.text === "string") {
      return truncate(resource.text, MAX_MCP_RESULT_CHARS);
    }

    return "[binary MCP prompt resource omitted]";
  }

  if (content.type === "image" || content.type === "audio") {
    return `[MCP prompt ${content.type} content omitted]`;
  }

  if (content.type === "resource_link") {
    return truncate(JSON.stringify(content), MAX_MCP_RESULT_CHARS);
  }

  return `[unsupported MCP prompt content type: ${content.type}]`;
}

function formatMcpContentItem(value: unknown): string[] {
  const item = asRecord(value);

  if (!item || typeof item.type !== "string") {
    return [];
  }

  if (item.type === "text" && typeof item.text === "string") {
    return [item.text];
  }

  if (item.type === "resource" && asRecord(item.resource)) {
    const resource = asRecord(item.resource) ?? {};
    return [typeof resource.text === "string" ? resource.text : JSON.stringify(resource)];
  }

  if (item.type === "resource_link") {
    return [JSON.stringify(item)];
  }

  if (item.type === "image" || item.type === "audio") {
    return [`[MCP ${item.type} content omitted]`];
  }

  return [JSON.stringify(item)];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...[truncated]`;
}
