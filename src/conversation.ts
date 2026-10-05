export type ConversationRole = "user" | "assistant";

export type ConversationMessage = {
  role: ConversationRole;
  content: string;
};

export type ConversationCompactResult = {
  afterMessages: number;
  beforeMessages: number;
  keptMessages: number;
  reason: "auto" | "manual";
  summarizedMessages: number;
  summaryChars: number;
};

export type ConversationStatus = {
  canCompact: boolean;
  compactTriggerMessages: number;
  hasSummary: boolean;
  keepRecentMessages: number;
  maxMessages: number;
  messageCount: number;
  summaryChars: number;
  totalChars: number;
};

const MAX_MESSAGES = 40;
const MAX_DISPLAY_CHARS = 1200;
export const DEFAULT_CONVERSATION_HISTORY_LIMIT = 12;
const COMPACT_TRIGGER_MESSAGES = 36;
const COMPACT_KEEP_RECENT_MESSAGES = 12;
const MAX_SUMMARY_CHARS = 4000;
const MAX_SUMMARY_ITEM_CHARS = 260;
export const CONTEXT_SUMMARY_PREFIX = "[context summary]";

export class Conversation {
  private readonly messages: ConversationMessage[] = [];

  load(messages: ConversationMessage[]): ConversationCompactResult | null {
    this.messages.length = 0;

    for (const message of messages) {
      this.messages.push({
        role: message.role,
        content: message.content,
      });
    }

    return this.compactIfNeeded("auto");
  }

  add(role: ConversationRole, content: string): ConversationCompactResult | null {
    this.messages.push({
      role,
      content,
    });

    return this.compactIfNeeded("auto");
  }

  compact(): ConversationCompactResult | null {
    return this.compactNow("manual");
  }

  clear(): void {
    this.messages.length = 0;
  }

  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  snapshot(): ConversationMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  status(): ConversationStatus {
    const summary = this.messages.find(isContextSummaryMessage);

    return {
      canCompact: this.canCompact(),
      compactTriggerMessages: COMPACT_TRIGGER_MESSAGES,
      hasSummary: Boolean(summary),
      keepRecentMessages: COMPACT_KEEP_RECENT_MESSAGES,
      maxMessages: MAX_MESSAGES,
      messageCount: this.messages.length,
      summaryChars: summary?.content.length ?? 0,
      totalChars: this.messages.reduce((total, message) => total + message.content.length, 0),
    };
  }

  format(options: { limit?: number } = {}): string {
    if (this.isEmpty()) {
      return "Conversation history is empty.";
    }

    const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;
    const startIndex = limit && limit < this.messages.length ? this.messages.length - limit : 0;
    const body = this.messages
      .slice(startIndex)
      .map((message, offset) => {
        const label = `${startIndex + offset + 1}. ${message.role}`;
        return `${label}:\n${truncate(message.content, MAX_DISPLAY_CHARS)}`;
      })
      .join("\n\n");

    if (startIndex === 0) {
      return body;
    }

    return [
      `Conversation history (showing last ${this.messages.length - startIndex} of ${this.messages.length} messages).`,
      "Use /history --all to show everything or /history <count> to choose a limit.",
      "",
      body,
    ].join("\n");
  }

  private compactIfNeeded(reason: "auto" | "manual"): ConversationCompactResult | null {
    if (this.messages.length <= COMPACT_TRIGGER_MESSAGES && this.messages.length <= MAX_MESSAGES) {
      return null;
    }

    return this.compactNow(reason);
  }

  private compactNow(reason: "auto" | "manual"): ConversationCompactResult | null {
    if (!this.canCompact()) {
      return null;
    }

    const beforeMessages = this.messages.length;
    const splitIndex = Math.max(0, beforeMessages - COMPACT_KEEP_RECENT_MESSAGES);
    const olderMessages = this.messages.slice(0, splitIndex);
    const recentMessages = this.messages.slice(splitIndex);
    const summary = buildContextSummary(olderMessages, recentMessages.length);

    this.messages.length = 0;
    this.messages.push(
      {
        role: "assistant",
        content: summary,
      },
      ...recentMessages,
    );

    return {
      afterMessages: this.messages.length,
      beforeMessages,
      keptMessages: recentMessages.length,
      reason,
      summarizedMessages: olderMessages.length,
      summaryChars: summary.length,
    };
  }

  private canCompact(): boolean {
    return this.messages.length > COMPACT_KEEP_RECENT_MESSAGES + 1;
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function buildContextSummary(messages: ConversationMessage[], keptMessages: number): string {
  const previousSummaries = messages.filter(isContextSummaryMessage);
  const regularMessages = messages.filter((message) => !isContextSummaryMessage(message));
  const lines = [
    CONTEXT_SUMMARY_PREFIX,
    "Older conversation history was compacted locally to keep context smaller.",
    `Summarized messages: ${messages.length}`,
    `Recent messages kept outside this summary: ${keptMessages}`,
  ];

  if (previousSummaries.length > 0) {
    lines.push("", "Previous summaries:");
    previousSummaries.forEach((message, index) => {
      lines.push(`${index + 1}. ${truncateSummaryItem(stripContextSummaryPrefix(message.content))}`);
    });
  }

  if (regularMessages.length > 0) {
    lines.push("", "Older messages:");
    regularMessages.forEach((message, index) => {
      lines.push(`${index + 1}. ${message.role}: ${truncateSummaryItem(oneLine(message.content))}`);
    });
  }

  return truncate(lines.join("\n"), MAX_SUMMARY_CHARS);
}

function isContextSummaryMessage(message: ConversationMessage): boolean {
  return message.role === "assistant" && message.content.startsWith(CONTEXT_SUMMARY_PREFIX);
}

function stripContextSummaryPrefix(content: string): string {
  return content.startsWith(CONTEXT_SUMMARY_PREFIX)
    ? content.slice(CONTEXT_SUMMARY_PREFIX.length).trim()
    : content;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateSummaryItem(value: string): string {
  return truncate(value, MAX_SUMMARY_ITEM_CHARS).replace(/\n/g, " ");
}
