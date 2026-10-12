import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCliArgs } from "../src/args.js";
import { getUserConfigValue } from "../src/config.js";
import {
  applyProviderProfile,
  formatProviderProfileApplication,
  isProviderProfileId,
  PROVIDER_PROFILE_IDS,
  PROVIDER_PROFILES,
} from "../src/providerProfiles.js";

test("provider profile catalog exposes the supported regions", () => {
  assert.deepEqual([...PROVIDER_PROFILE_IDS].sort(), [
    "deepseek",
    "groq",
    "minimax",
    "mistral",
    "moonshot",
    "openrouter",
    "qwen",
    "siliconflow",
    "volcengine",
    "xai",
    "zhipu",
  ]);
  assert.equal(isProviderProfileId("deepseek"), true);
  assert.equal(isProviderProfileId("openai"), false);

  for (const id of PROVIDER_PROFILE_IDS) {
    const profile = PROVIDER_PROFILES[id];

    assert.match(profile.baseURL, /^https:\/\//);
    assert.equal(profile.apiMode, "chat");
    assert.ok(profile.model.length > 0);
  }
});

test("--provider applies parsed profiles and rejects unknown ids", () => {
  const parsed = parseCliArgs(["--provider", "Qwen"]);

  assert.equal(parsed.mode, "provider");

  if (parsed.mode === "provider") {
    assert.equal(parsed.providerId, "qwen");
  }

  const invalid = parseCliArgs(["--provider", "not-a-provider"]);

  assert.equal(invalid.mode, "providerError");

  if (invalid.mode === "providerError") {
    assert.match(invalid.message, /Unknown provider profile/);
    assert.match(invalid.message, /deepseek/);
  }
});

test("applyProviderProfile writes model, apiMode, and baseURL to user config", async () => {
  await withIsolatedUserDir(async (userDir) => {
    const applied = await applyProviderProfile("deepseek");
    const formatted = formatProviderProfileApplication(applied);

    assert.equal(applied.profile.name, "DeepSeek");
    assert.equal((await getUserConfigValue("model")).value, "deepseek-chat");
    assert.equal((await getUserConfigValue("openai.apiMode")).value, "chat");
    assert.equal(
      (await getUserConfigValue("openai.baseURL")).value,
      "https://api.deepseek.com/v1",
    );
    assert.match(formatted, /Provider profile applied: DeepSeek/);
    assert.match(formatted, /deepseek-chat/);
    assert.match(formatted, /ccagent login --api-key/);
  });
});

async function withIsolatedUserDir(run: (userDir: string) => Promise<void>): Promise<void> {
  const previousUserDir = process.env.CCAGENT_USER_DIR;
  const userDir = await mkdtemp(join(tmpdir(), "ccagent-provider-user-"));

  try {
    process.env.CCAGENT_USER_DIR = userDir;
    await run(userDir);
  } finally {
    if (previousUserDir === undefined) {
      delete process.env.CCAGENT_USER_DIR;
    } else {
      process.env.CCAGENT_USER_DIR = previousUserDir;
    }

    await rm(userDir, { recursive: true, force: true });
  }
}