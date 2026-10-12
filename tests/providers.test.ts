import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderSmokeCompatibilityProfile,
  diagnoseProviderSmoke,
  formatProviderSmokeCompatibilityProfile,
  formatProviderSmokeDiagnosis,
  formatProviderCompatibilityMatrix,
  PROVIDER_COMPATIBILITY_ENTRIES,
} from "../src/providers.js";

test("provider compatibility matrix includes active relay guidance", () => {
  const output = formatProviderCompatibilityMatrix({
    apiMode: "responses",
    apiModeSource: "config",
    baseURL: "https://relay.example/v1",
    baseURLSource: "config",
    hasApiKey: false,
  });

  assert.ok(PROVIDER_COMPATIBILITY_ENTRIES.some((entry) => entry.id === "generic-chat-relay"));
  assert.match(output, /Provider compatibility matrix/);
  assert.match(output, /API mode: responses \(source: config\)/);
  assert.match(output, /Base URL: https:\/\/relay\.example\/v1 \(source: config\)/);
  assert.match(output, /API key: not set/);
  assert.match(output, /Detected profile: Custom Responses-compatible relay/);
  assert.match(output, /switch to chat if relay errors mention Responses or previous_response_id/);
  assert.match(output, /generic-chat-relay: Generic OpenAI-compatible relay/);
  assert.match(output, /responses-compatible-relay: Responses-compatible relay/);
  assert.match(output, /Built-in provider profiles/);
  assert.match(output, /- volcengine: Volcengine Ark/);
  assert.match(output, /- openrouter: OpenRouter/);
});

test("provider smoke diagnosis explains relay and probe failures", () => {
  const diagnosis = diagnoseProviderSmoke({
    apiMode: "responses",
    apiModeSource: "config",
    baseURL: "https://relay.example/v1",
    baseURLSource: "config",
    failed: 2,
    hasApiKey: true,
    passed: 1,
    profile: "full",
    probes: [
      {
        name: "text",
        ok: true,
        stream: false,
        summary: "text response returned",
        tool: false,
      },
      {
        name: "streaming",
        ok: false,
        stream: true,
        summary: "stream completed without text delta chunks",
        tool: false,
      },
      {
        name: "tool-call",
        ok: false,
        stream: false,
        summary: "missing smoke_ping tool call",
        tool: true,
      },
      {
        name: "tool-followup",
        ok: false,
        stream: false,
        summary: "text response did not include CONTINUED",
        tool: false,
      },
    ],
  });
  const output = formatProviderSmokeDiagnosis(diagnosis).join("\n");

  assert.equal(diagnosis.status, "failing");
  assert.match(output, /Provider diagnosis/);
  assert.match(output, /Responses mode on custom relays requires \/v1\/responses/);
  assert.match(output, /Failed probes: streaming, tool-call, tool-followup/);
  assert.match(output, /forwards SSE streaming/);
  assert.match(output, /support function\/tool calls/);
  assert.match(output, /multi-turn tool continuity/);
});

test("provider smoke compatibility profile summarizes known-good capability status", () => {
  const profile = buildProviderSmokeCompatibilityProfile({
    apiMode: "chat",
    apiModeSource: "config",
    baseURL: "https://relay.example/v1",
    baseURLSource: "config",
    failed: 0,
    hasApiKey: true,
    model: "relay-model",
    passed: 5,
    profile: "full",
    probes: [
      { name: "text", ok: true, stream: false, summary: "text ok", tool: false },
      { name: "unicode", ok: true, stream: false, summary: "unicode ok", tool: false },
      { name: "streaming", ok: true, stream: true, summary: "stream ok", tool: false },
      { name: "tool-call", ok: true, stream: false, summary: "tool ok", tool: true },
      { name: "streaming-tool-call", ok: true, stream: true, summary: "streaming tool ok", tool: true },
      { name: "tool-followup", ok: true, stream: false, summary: "follow-up turn returned text (9 chars)", tool: false },
    ],
  });
  const output = formatProviderSmokeCompatibilityProfile(profile).join("\n");

  assert.equal(profile.status, "known-good");
  assert.equal(profile.capabilities.every((capability) => capability.status === "pass"), true);
  assert.equal(profile.capabilities.find((capability) => capability.name === "tool-followup")?.status, "pass");
  assert.match(output, /Compatibility profile/);
  assert.match(output, /Status: known-good/);
  assert.match(output, /text: pass - text ok/);
  assert.match(output, /ccagent --config-set openai.baseURL https:\/\/relay\.example\/v1/);
  assert.match(output, /ccagent --config-set openai.apiMode chat/);
  assert.match(output, /ccagent --config-set model relay-model/);
});
