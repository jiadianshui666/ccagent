import assert from "node:assert/strict";
import test from "node:test";
import { createDebugLogger } from "../src/debug.js";
import { redactSecrets } from "../src/secrets.js";

test("redactSecrets leaves ordinary text untouched", () => {
  assert.equal(
    redactSecrets("npm test -- --test-concurrency=1"),
    "npm test -- --test-concurrency=1",
  );
});

test("redactSecrets hides API keys in key-value pairs and JSON fields", () => {
  assert.match(
    redactSecrets("OPENAI_API_KEY=sk-env-key-abcdef1234567890"),
    /OPENAI_API_KEY=<redacted>/,
  );
  assert.doesNotMatch(
    redactSecrets('{"apiKey":"sk-json-key-abcdef1234567890"}'),
    /sk-json-key/,
  );
  assert.match(
    redactSecrets('{"apiKey":"sk-json-key-abcdef1234567890"}'),
    /redacted/,
  );
  assert.doesNotMatch(
    redactSecrets("api-key=standalone-secret-value"),
    /standalone-secret-value/,
  );
  assert.doesNotMatch(
    redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"),
    /eyJhbGciOiJIUzI1NiJ9/,
  );
  assert.match(
    redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"),
    /Bearer \[redacted\]/,
  );
});

test("redactSecrets hides bare OpenAI-style keys", () => {
  assert.doesNotMatch(
    redactSecrets("the key is sk-ant-api03-secretsecretsecret123"),
    /sk-ant-api03-secret/,
  );
  assert.match(
    redactSecrets("the key is sk-ant-api03-secretsecretsecret123"),
    /sk-\.\.\.\[redacted\]/,
  );
});

test("createDebugLogger redacts secrets in debug payloads", () => {
  const lines: string[] = [];
  const logger = createDebugLogger(true, (line) => {
    lines.push(line);
  });

  logger("cli.start", {
    apiKey: "sk-debug-key-abcdef1234567890",
    note: "visible",
  });

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /sk-debug-key/);
  assert.match(lines[0] ?? "", /redacted/);
  assert.match(lines[0] ?? "", /note/);
});
