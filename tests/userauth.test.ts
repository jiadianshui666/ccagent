import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCliArgs } from "../src/args.js";
import {
  clearStoredApiKey,
  getAuthFilePath,
  loadApiKeyStatus,
  loadStoredApiKey,
  storeApiKey,
} from "../src/auth.js";
import {
  getUserConfigPath,
  getUserConfigValue,
  loadUserConfig,
  mergeUserDefaults,
  setUserConfigValue,
  unsetUserConfigValue,
} from "../src/config.js";
import { createModelClient } from "../src/model.js";

test("auth store, load, and clear roundtrip keeps the stored key private", async () => {
  await withIsolatedUserDir(async (userDir) => {
    assert.equal(await loadStoredApiKey(), undefined);

    const stored = await storeApiKey("  sk-auth-test-key  ");

    assert.equal(stored.action, "stored");
    assert.equal(stored.authPath, getAuthFilePath());
    assert.equal(await loadStoredApiKey(), "sk-auth-test-key");

    const updated = await storeApiKey("sk-auth-test-key-2");

    assert.equal(updated.action, "updated");
    assert.equal(await loadStoredApiKey(), "sk-auth-test-key-2");

    const payload = JSON.parse(await readFile(getAuthFilePath(), "utf8")) as Record<string, unknown>;

    assert.equal(payload.apiKey, "sk-auth-test-key-2");
    assert.equal(typeof payload.updatedAt, "string");
    assert.ok(userDir.length > 0);

    const cleared = await clearStoredApiKey();

    assert.equal(cleared.removed, true);
    assert.equal(await loadStoredApiKey(), undefined);
    assert.equal((await clearStoredApiKey()).removed, false);
  });
});

test("loadApiKeyStatus prefers env, then auth file, then none", async () => {
  const previousKey = process.env.OPENAI_API_KEY;

  await withIsolatedUserDir(async () => {
    try {
      process.env.OPENAI_API_KEY = "sk-env-key";
      const envStatus = await loadApiKeyStatus();

      assert.equal(envStatus.set, true);
      assert.equal(envStatus.source, "env");

      delete process.env.OPENAI_API_KEY;
      const noneStatus = await loadApiKeyStatus();

      assert.equal(noneStatus.set, false);
      assert.equal(noneStatus.source, "none");

      await storeApiKey("sk-stored-key");
      const storedStatus = await loadApiKeyStatus();

      assert.equal(storedStatus.set, true);
      assert.equal(storedStatus.source, "auth-file");
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });
});

test("user config set, get, unset, load, and warn for foreign keys", async () => {
  await withIsolatedUserDir(async () => {
    const missing = await loadUserConfig();

    assert.equal(missing.exists, false);
    assert.equal(missing.path, getUserConfigPath());

    await setUserConfigValue("model", "user-model");
    await setUserConfigValue("openai.baseURL", "https://user-relay.example/v1");
    await setUserConfigValue("openai.retry.maxAttempts", "5");

    const loaded = await loadUserConfig();

    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.model, "user-model");
    assert.equal(loaded.config.openai?.baseURL, "https://user-relay.example/v1");
    assert.equal(loaded.config.openai?.retry?.maxAttempts, 5);

    const get = await getUserConfigValue("openai.retry.maxAttempts");

    assert.equal(get.exists, true);
    assert.equal(get.value, "5");

    await assert.rejects(setUserConfigValue("context.auto", "false"), /Unsupported user config key/);
    await assert.rejects(setUserConfigValue("toolPolicy.deny", "run_shell"), /Unsupported user config key/);

    const unset = await unsetUserConfigValue("model");

    assert.equal(unset.existed, true);
    assert.equal((await loadUserConfig()).config.model, undefined);

    const raw = await readFile(getUserConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    assert.ok(parsed.openai);
    assert.equal("context" in parsed, false);
  });
});

test("user config supports ui prompt hints and they merge into project defaults", async () => {
  await withIsolatedUserDir(async () => {
    await setUserConfigValue("ui.promptHints", "/help, /doctor");

    const loaded = await loadUserConfig();

    assert.deepEqual(loaded.config.ui?.promptHints, ["/help", "/doctor"]);
    assert.equal((await getUserConfigValue("ui.promptHints")).value, "/help, /doctor");

    const merged = mergeUserDefaults({}, loaded.config);
    assert.deepEqual(merged.ui?.promptHints, ["/help", "/doctor"]);

    const projectWins = mergeUserDefaults({ ui: { promptHints: [] } }, loaded.config);
    assert.deepEqual(projectWins.ui?.promptHints, []);

    const unset = await unsetUserConfigValue("ui.promptHints");

    assert.equal(unset.existed, true);
    assert.equal((await getUserConfigValue("ui.promptHints")).exists, false);
  });
});

test("mergeUserDefaults gives project config priority with per-key retry merging", () => {
  const merged = mergeUserDefaults(
    {
      model: "project-model",
      openai: {
        apiMode: "chat",
        retry: { maxAttempts: 4 },
      },
      context: { auto: true },
    },
    {
      model: "user-model",
      openai: {
        apiMode: "responses",
        baseURL: "https://user-relay.example/v1",
        retry: { baseDelayMs: 500, maxAttempts: 2 },
      },
    },
  );

  assert.equal(merged.model, "project-model");
  assert.equal(merged.openai?.apiMode, "chat");
  assert.equal(merged.openai?.baseURL, "https://user-relay.example/v1");
  assert.equal(merged.openai?.retry?.maxAttempts, 4);
  assert.equal(merged.openai?.retry?.baseDelayMs, 500);
  assert.equal(merged.context?.auto, true);

  const userOnly = mergeUserDefaults({}, { model: "user-model" });

  assert.equal(userOnly.model, "user-model");
});

test("parseCliArgs recognizes login, logout, and user config commands", () => {
  assert.deepEqual(parseCliArgs(["login"]), {
    mode: "login",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["login", "--api-key", "sk-arg-key"]), {
    mode: "login",
    apiKey: "sk-arg-key",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.equal(parseCliArgs(["logout"]).mode, "logout");
  assert.deepEqual(parseCliArgs(["--user-config-set", "model", "gpt-5.5"]), {
    mode: "userConfigSet",
    key: "model",
    value: "gpt-5.5",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.equal(parseCliArgs(["--user-config-get", "openai.baseURL"]).mode, "userConfigGet");
  assert.equal(parseCliArgs(["--user-config-unset", "openai.baseURL"]).mode, "userConfigUnset");
});

test("createModelClient accepts a stored api key and still falls back to mock", async () => {
  const previousKey = process.env.OPENAI_API_KEY;

  try {
    delete process.env.OPENAI_API_KEY;
    assert.equal(createModelClient().name, "mock");
    assert.equal(createModelClient({ openAIApiKey: "  " }).name, "mock");

    const realClient = createModelClient({ openAIApiKey: "sk-option-key" });

    assert.notEqual(realClient.name, "mock");
    assert.match(realClient.name, /^openai:/);
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
});

async function withIsolatedUserDir(
  run: (userDir: string) => Promise<void>,
): Promise<void> {
  const previousUserDir = process.env.CCAGENT_USER_DIR;
  const userDir = await mkdtemp(join(tmpdir(), "ccagent-user-"));

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
