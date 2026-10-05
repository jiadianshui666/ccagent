import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const resourcesOnly = process.env.MCP_FIXTURE_RESOURCES_ONLY === "1";

const server = new Server(
  { name: "ccagent-test-mcp-server", version: "1.0.0" },
  {
    capabilities: {
      resources: {},
      ...(resourcesOnly ? {} : { prompts: {}, tools: {} }),
    },
  },
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{
    uri: "fixture://guide",
    name: "Fixture guide",
    description: "A text resource used by CCAgent MCP tests.",
    mimeType: "text/plain",
  }],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{
    uriTemplate: "fixture://docs/{topic}",
    name: "Fixture topic",
    description: "Reads one fixture documentation topic.",
    mimeType: "text/plain",
  }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{
    uri: request.params.uri,
    mimeType: "text/plain",
    text: request.params.uri === "fixture://guide"
      ? "Fixture resource content."
      : request.params.uri.startsWith("fixture://docs/")
        ? `Fixture topic resource: ${request.params.uri.slice("fixture://docs/".length)}`
        : "Unknown fixture resource.",
  }],
}));

if (!resourcesOnly) {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{
      name: "echo_prompt",
      description: "Builds a fixture prompt from one message.",
      arguments: [{
        name: "message",
        description: "Message to include in the prompt.",
        required: true,
      }],
    }],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    description: "Fixture prompt result.",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Fixture prompt: ${request.params.arguments?.message ?? "(missing)"}`,
      },
    }],
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "echo_text",
      description: "Echoes text with an optional suffix.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          suffix: { type: "string" },
        },
        required: ["message"],
      },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "echo_text") {
      return {
        content: [{ type: "text", text: "unknown tool" }],
        isError: true,
      };
    }

    const message = typeof request.params.arguments?.message === "string"
      ? request.params.arguments.message
      : "";
    const suffix = typeof request.params.arguments?.suffix === "string"
      ? request.params.arguments.suffix
      : "";

    return {
      content: [{ type: "text", text: `${message}${suffix}` }],
    };
  });
}

await server.connect(new StdioServerTransport());
