import type { Writable } from "node:stream";
import type { AgentResponse, AgentStreamEvent } from "./agent.js";
import type { RichPromptStatus } from "./richRenderer.js";

export type OutputRenderer = {
  writeAgentStreamEvent(event: AgentStreamEvent): Promise<void>;
  writeFinalResponse(response: AgentResponse): Promise<void>;
  writeMessage(content: string): Promise<void>;
  writeBanner?(content: string): Promise<void>;
  writePromptLine?(prompt: string): Promise<void>;
  writePromptStatus?(status: RichPromptStatus): Promise<void>;
  writeRichBlock?(content: string, title?: string): Promise<void>;
  redrawHints?(hints: string[]): void;
  updateInputEstimate?(tokens: number): void;
  tryExpandFoldedOutput?(): boolean;
};

export type JsonLineOutputEvent =
  | AgentStreamEvent
  | {
      type: "final_response";
      content: string;
      streamed: boolean;
    }
  | {
      type: "message";
      content: string;
    };

export function createTerminalRenderer(output: Writable): OutputRenderer {
  return {
    async writeAgentStreamEvent(event) {
      output.write(renderAgentStreamEvent(event));
    },
    async writeFinalResponse(response) {
      output.write(renderFinalResponse(response));
    },
    async writeMessage(content) {
      output.write(`${content}\n`);
    },
  };
}

export function createJsonLinesRenderer(output: Writable): OutputRenderer {
  return {
    async writeAgentStreamEvent(event) {
      output.write(renderJsonLine(event));
    },
    async writeFinalResponse(response) {
      output.write(
        renderJsonLine({
          type: "final_response",
          content: response.content,
          streamed: Boolean(response.streamed),
        }),
      );
    },
    async writeMessage(content) {
      output.write(
        renderJsonLine({
          type: "message",
          content,
        }),
      );
    },
  };
}

export function renderAgentStreamEvent(event: AgentStreamEvent): string {
  if (event.type === "turn_start") {
    return "";
  }

  if (event.type === "text_delta") {
    return event.delta;
  }

  if (event.type === "tool_preflight") {
    return `\n[tool:preflight] ${event.toolName} risk=${event.risk} impact=${event.workspaceImpact} approval=${formatYesNo(event.requiresApproval)} denied=${formatYesNo(event.deniedByPolicy)}\n`;
  }

  if (event.type === "tool_start") {
    return `\n[tool:start] ${event.toolName} ${event.inputSummary}\n`;
  }

  if (event.type === "tool_approval") {
    if (event.status === "required" && event.message) {
      return `[tool:approval] ${event.toolName} ${event.status}\n${formatApprovalEventSummary(event.message)}\n`;
    }

    return `[tool:approval] ${event.toolName} ${event.status}\n`;
  }

  if (event.type === "tool_finish") {
    return `[tool:finish] ${event.toolName} ${event.summary}\n`;
  }

  if (event.type === "model_turn") {
    return [
      "",
      `[model] ${event.kind} round=${event.round} model=${event.modelName} duration=${event.durationMs}ms ${formatModelTokens(event)} cost=${event.cost} cumulative=turns:${event.cumulativeTurns},total:${event.cumulativeTotalTokens},cost:${event.cumulativeCost} ${event.budget}`,
      "",
    ].join("\n");
  }

  if (event.type === "tool_result") {
    return `\n${event.content}\n\n`;
  }

  return `${event.content}\n`;
}

export function renderFinalResponse(response: AgentResponse): string {
  if (response.streamed) {
    return "\n";
  }

  return `${response.content}\n`;
}

export function renderJsonLine(event: JsonLineOutputEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function formatApprovalEventSummary(message: string): string {
  return message.split("\n\nPreview:\n", 1)[0] ?? message;
}

function formatModelTokens(event: Extract<AgentStreamEvent, { type: "model_turn" }>): string {
  const parts = [
    `in=${formatOptionalNumber(event.inputTokens)}`,
    `out=${formatOptionalNumber(event.outputTokens)}`,
    `total=${formatOptionalNumber(event.totalTokens)}`,
  ];

  if (event.cachedInputTokens !== undefined) {
    parts.push(`cached=${event.cachedInputTokens}`);
  }

  if (event.usageEstimated) {
    parts.push("estimated=yes");
  }

  return `tokens=${parts.join(",")}`;
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "?" : String(value);
}

function formatYesNo(value: boolean): string {
  return value ? "yes" : "no";
}
