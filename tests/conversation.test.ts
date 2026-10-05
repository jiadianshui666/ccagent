import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.js";
import {
  CONTEXT_SUMMARY_PREFIX,
  Conversation,
  type ConversationMessage,
} from "../src/conversation.js";
import type { ModelClient, ModelResult, ModelTurnInput } from "../src/model.js";
import { createEmptySession } from "../src/session.js";

test("Conversation auto-compacts older messages into a summary", () => {
  const conversation = new Conversation();
  let compacted = null;

  for (let index = 1; index <= 37; index += 1) {
    compacted = conversation.add("user", `message-${index}`);
  }

  const snapshot = conversation.snapshot();

  assert.ok(compacted);
  assert.equal(snapshot.length, 13);
  assert.equal(snapshot[0]?.role, "assistant");
  assert.match(snapshot[0]?.content ?? "", new RegExp(`^${escapeRegExp(CONTEXT_SUMMARY_PREFIX)}`));
  assert.match(snapshot[0]?.content ?? "", /message-1/);
  assert.equal(snapshot.at(-1)?.content, "message-37");
});

test("Conversation manual compaction keeps recent messages and reports status", () => {
  const conversation = new Conversation();

  for (let index = 1; index <= 15; index += 1) {
    conversation.add(index % 2 === 0 ? "assistant" : "user", `turn-${index}`);
  }

  const compacted = conversation.compact();
  const status = conversation.status();
  const snapshot = conversation.snapshot();

  assert.ok(compacted);
  assert.equal(compacted.beforeMessages, 15);
  assert.equal(compacted.afterMessages, 13);
  assert.equal(compacted.summarizedMessages, 3);
  assert.equal(status.hasSummary, true);
  assert.equal(status.messageCount, 13);
  assert.equal(snapshot[0]?.content.startsWith(CONTEXT_SUMMARY_PREFIX), true);
  assert.equal(snapshot[1]?.content, "turn-4");
  assert.equal(snapshot.at(-1)?.content, "turn-15");
});

test("Conversation format can show only recent messages", () => {
  const conversation = new Conversation();

  for (let index = 1; index <= 5; index += 1) {
    conversation.add(index % 2 === 0 ? "assistant" : "user", `message-${String(index).padStart(2, "0")}`);
  }

  const recent = conversation.format({ limit: 2 });
  const all = conversation.format();

  assert.match(recent, /showing last 2 of 5 messages/);
  assert.doesNotMatch(recent, /message-01/);
  assert.match(recent, /4\. assistant:\nmessage-04/);
  assert.match(recent, /5\. user:\nmessage-05/);
  assert.doesNotMatch(all, /showing last/);
  assert.match(all, /message-01/);
});

test("Agent /compact command restores model history and clears response linkage", async () => {
  const model = new RecordingModelClient();
  const agent = new Agent(model);
  const session = createEmptySession(model.name);
  const messages: ConversationMessage[] = [];

  for (let index = 1; index <= 15; index += 1) {
    messages.push({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `session-turn-${index}`,
    });
  }

  agent.loadSession({
    ...session,
    lastResponseId: "previous-response-id",
    messages,
  });

  const response = await agent.handleUserMessage("/compact");
  const snapshot = agent.snapshotSession();

  assert.match(response.content, /Conversation compacted/);
  assert.equal(snapshot.lastResponseId, undefined);
  assert.equal(snapshot.messages.length, 13);
  assert.equal(snapshot.messages[0]?.content.startsWith(CONTEXT_SUMMARY_PREFIX), true);
  assert.equal(model.restoreCalls.length, 2);
  assert.equal(model.restoreCalls.at(-1)?.length, 13);
});

test("Agent /compact-status reports current compaction state", async () => {
  const agent = new Agent(new RecordingModelClient());
  const response = await agent.handleUserMessage("/compact-status");

  assert.match(response.content, /Conversation compaction status/);
  assert.match(response.content, /Messages: 0/);
  assert.match(response.content, /Has summary: no/);
  assert.match(response.content, /Auto trigger: more than 36 messages/);
});

test("Agent /history supports default limit, explicit count, and --all", async () => {
  const model = new RecordingModelClient();
  const agent = new Agent(model);
  const session = createEmptySession(model.name);
  const messages: ConversationMessage[] = [];

  for (let index = 1; index <= 14; index += 1) {
    messages.push({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `history-${String(index).padStart(2, "0")}`,
    });
  }

  agent.loadSession({
    ...session,
    messages,
  });

  const recentDefault = await agent.handleUserMessage("/history");
  const recentThree = await agent.handleUserMessage("/history 3");
  const all = await agent.handleUserMessage("/history --all");
  const invalid = await agent.handleUserMessage("/history nope");

  assert.match(recentDefault.content, /showing last 12 of 14 messages/);
  assert.doesNotMatch(recentDefault.content, /history-01/);
  assert.match(recentDefault.content, /history-14/);
  assert.match(recentThree.content, /showing last 3 of 14 messages/);
  assert.doesNotMatch(recentThree.content, /history-11/);
  assert.match(recentThree.content, /history-12/);
  assert.match(all.content, /history-01/);
  assert.doesNotMatch(all.content, /showing last/);
  assert.match(invalid.content, /Usage: \/history \[count\]/);
});

class RecordingModelClient implements ModelClient {
  readonly name = "recording";
  readonly restoreCalls: ConversationMessage[][] = [];

  async createTurn(input: ModelTurnInput): Promise<ModelResult> {
    return {
      content: `[recording model] ${input.userMessage ?? ""}`,
      responseId: "recording-response",
      toolCalls: [],
    };
  }

  restoreConversation(messages: ConversationMessage[]): void {
    this.restoreCalls.push(messages.map((message) => ({ ...message })));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
