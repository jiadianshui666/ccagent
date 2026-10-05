import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatDoctorReport,
  formatOpenAISmokeCommand,
  resolveOpenAIApiMode,
  resolveOpenAIBaseURL,
  resolveOpenAIEmbeddingModel,
  resolveOpenAIModel,
  runDoctor,
} from "../src/doctor.js";

test("resolveOpenAIModel prefers env, then config, then default", () => {
  const previous = process.env.CCAGENT_MODEL;

  try {
    delete process.env.CCAGENT_MODEL;
    assert.deepEqual(resolveOpenAIModel("config-model"), {
      model: "config-model",
      source: "config",
    });

    assert.deepEqual(resolveOpenAIModel("config-model", "user-model"), {
      model: "config-model",
      source: "config",
    });

    assert.deepEqual(resolveOpenAIModel(undefined, "user-model"), {
      model: "user-model",
      source: "user-config",
    });

    assert.deepEqual(resolveOpenAIModel(undefined), {
      model: "gpt-5.5",
      source: "default",
    });

    process.env.CCAGENT_MODEL = "env-model";
    assert.deepEqual(resolveOpenAIModel("config-model"), {
      model: "env-model",
      source: "env",
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CCAGENT_MODEL;
    } else {
      process.env.CCAGENT_MODEL = previous;
    }
  }
});

test("resolveOpenAIEmbeddingModel prefers env, then config, then local", () => {
  const previous = process.env.CCAGENT_EMBEDDING_MODEL;

  try {
    delete process.env.CCAGENT_EMBEDDING_MODEL;
    assert.deepEqual(resolveOpenAIEmbeddingModel("text-embedding-3-small"), {
      model: "text-embedding-3-small",
      source: "config",
    });
    assert.deepEqual(resolveOpenAIEmbeddingModel(undefined, "user-embedding"), {
      model: "user-embedding",
      source: "user-config",
    });
    assert.deepEqual(resolveOpenAIEmbeddingModel(undefined), {
      source: "local",
    });

    process.env.CCAGENT_EMBEDDING_MODEL = "relay-embedding";
    assert.deepEqual(resolveOpenAIEmbeddingModel("text-embedding-3-small"), {
      model: "relay-embedding",
      source: "env",
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CCAGENT_EMBEDDING_MODEL;
    } else {
      process.env.CCAGENT_EMBEDDING_MODEL = previous;
    }
  }
});

test("resolveOpenAIBaseURL prefers env, then config, then official", () => {
  const previous = process.env.OPENAI_BASE_URL;

  try {
    delete process.env.OPENAI_BASE_URL;
    assert.deepEqual(resolveOpenAIBaseURL(), {
      baseURL: "https://api.openai.com/v1",
      source: "official",
    });

    assert.deepEqual(resolveOpenAIBaseURL(undefined, "https://user-relay.example/v1"), {
      baseURL: "https://user-relay.example/v1",
      source: "user-config",
    });

    assert.deepEqual(resolveOpenAIBaseURL(" https://config-relay.example/v1 "), {
      baseURL: "https://config-relay.example/v1",
      source: "config",
    });

    process.env.OPENAI_BASE_URL = " https://relay.example/v1 ";
    assert.deepEqual(resolveOpenAIBaseURL("https://config-relay.example/v1"), {
      baseURL: "https://relay.example/v1",
      source: "env",
    });
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previous;
    }
  }
});

test("resolveOpenAIApiMode prefers env, then config, then default", () => {
  const previous = process.env.CCAGENT_API_MODE;

  try {
    delete process.env.CCAGENT_API_MODE;
    assert.deepEqual(resolveOpenAIApiMode(), {
      apiMode: "responses",
      source: "default",
    });

    assert.deepEqual(resolveOpenAIApiMode(undefined, "chat"), {
      apiMode: "chat",
      source: "user-config",
    });

    assert.deepEqual(resolveOpenAIApiMode("chat"), {
      apiMode: "chat",
      source: "config",
    });

    process.env.CCAGENT_API_MODE = "responses";
    assert.deepEqual(resolveOpenAIApiMode("chat"), {
      apiMode: "responses",
      source: "env",
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CCAGENT_API_MODE;
    } else {
      process.env.CCAGENT_API_MODE = previous;
    }
  }
});

test("formatOpenAISmokeCommand is copyable and session-safe", () => {
  assert.equal(formatOpenAISmokeCommand(), 'ccagent --json --no-session "list files"');
});

test("runDoctor includes OpenAI SDK, model, key, and smoke command checks", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.CCAGENT_MODEL;
  const previousBaseURL = process.env.OPENAI_BASE_URL;
  const previousApiMode = process.env.CCAGENT_API_MODE;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-doctor-"));

  try {
    delete process.env.OPENAI_API_KEY;
    process.env.CCAGENT_MODEL = "env-model";
    process.env.OPENAI_BASE_URL = "https://relay.example/v1";
    process.env.CCAGENT_API_MODE = "chat";
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        model: "config-model",
        openai: {
          apiMode: "responses",
          baseURL: "https://config-relay.example/v1",
          retry: {
            maxAttempts: 4,
            baseDelayMs: 500,
            maxDelayMs: 5000,
          },
        },
      }),
    );

    const report = await runDoctorIsolated(workspaceRoot);
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.equal(checks.get("model")?.detail, "env-model (source: env)");
    assert.equal(
      checks.get("openai_base_url")?.detail,
      "https://relay.example/v1 (source: env)",
    );
    assert.match(checks.get("openai_api_mode")?.detail ?? "", /chat \(source: env/);
    assert.equal(
      checks.get("openai_provider_retry")?.detail,
      "maxAttempts=4, baseDelayMs=500, maxDelayMs=5000",
    );
    assert.equal(checks.get("openai_sdk")?.status, "ok");
    assert.equal(checks.get("openai_api_key")?.status, "warn");
    assert.equal(checks.get("openai_smoke_command")?.status, "warn");
    assert.match(
      checks.get("openai_smoke_command")?.detail ?? "",
      /ccagent --json --no-session "list files"/,
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }

    if (previousModel === undefined) {
      delete process.env.CCAGENT_MODEL;
    } else {
      process.env.CCAGENT_MODEL = previousModel;
    }

    if (previousBaseURL === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseURL;
    }

    if (previousApiMode === undefined) {
      delete process.env.CCAGENT_API_MODE;
    } else {
      process.env.CCAGENT_API_MODE = previousApiMode;
    }

    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runDoctor reads OpenAI relay settings from config when env is unset", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBaseURL = process.env.OPENAI_BASE_URL;
  const previousApiMode = process.env.CCAGENT_API_MODE;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-doctor-"));

  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.CCAGENT_API_MODE;
    await mkdir(join(workspaceRoot, ".ccagent"));
    await writeFile(
      join(workspaceRoot, ".ccagent", "config.json"),
      JSON.stringify({
        openai: {
          apiMode: "chat",
          baseURL: "https://config-relay.example/v1",
        },
      }),
    );

    const report = await runDoctorIsolated(workspaceRoot);
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.match(checks.get("openai_api_mode")?.detail ?? "", /chat \(source: config/);
    assert.equal(
      checks.get("openai_base_url")?.detail,
      "https://config-relay.example/v1 (source: config)",
    );
    assert.match(checks.get("openai_smoke_command")?.detail ?? "", /Configure an API key first/);
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }

    if (previousBaseURL === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseURL;
    }

    if (previousApiMode === undefined) {
      delete process.env.CCAGENT_API_MODE;
    } else {
      process.env.CCAGENT_API_MODE = previousApiMode;
    }

    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runDoctor reports loaded project instructions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-doctor-"));

  try {
    await writeFile(join(workspaceRoot, "CCAGENT.md"), "- Prefer Chinese responses.\n");

    const report = await runDoctorIsolated(workspaceRoot);
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.equal(checks.get("project_instructions")?.status, "ok");
    assert.match(checks.get("project_instructions")?.detail ?? "", /CCAGENT\.md/);
    assert.match(checks.get("project_instructions")?.detail ?? "", /chars loaded/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runDoctor suggests initializing missing project instructions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-doctor-"));

  try {
    const report = await runDoctorIsolated(workspaceRoot);
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.equal(checks.get("project_instructions")?.status, "ok");
    assert.match(checks.get("project_instructions")?.detail ?? "", /No CCAGENT\.md found/);
    assert.match(checks.get("project_instructions")?.detail ?? "", /ccagent --init-instructions/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runDoctor warns for invalid project instructions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-doctor-"));

  try {
    await mkdir(join(workspaceRoot, "CCAGENT.md"));

    const report = await runDoctorIsolated(workspaceRoot);
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.equal(checks.get("project_instructions")?.status, "warn");
    assert.equal(checks.get("instructions_warning")?.status, "warn");
    assert.match(checks.get("instructions_warning")?.detail ?? "", /not a file/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runDoctor reports project commands", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-doctor-"));

  try {
    const commandsDir = join(workspaceRoot, ".ccagent", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "review.md"), "# Review {{args}}\n");
    await writeFile(join(commandsDir, "test.md"), "# Test workflow\n");

    const report = await runDoctorIsolated(workspaceRoot);
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.equal(checks.get("project_commands")?.status, "ok");
    assert.match(checks.get("project_commands")?.detail ?? "", /\.ccagent/);
    assert.match(checks.get("project_commands")?.detail ?? "", /2 command\(s\): review, test/);
    assert.equal(checks.get("project_commands_health")?.status, "ok");
    assert.match(checks.get("project_commands_health")?.detail ?? "", /No issues found/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runDoctor warns for invalid project command files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-doctor-"));

  try {
    const commandsDir = join(workspaceRoot, ".ccagent", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "bad name.md"), "# Invalid\n");

    const report = await runDoctorIsolated(workspaceRoot);
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.equal(checks.get("project_commands")?.status, "warn");
    assert.equal(checks.get("project_commands_health")?.status, "warn");
    assert.equal(checks.get("commands_warning")?.status, "warn");
    assert.match(checks.get("commands_warning")?.detail ?? "", /invalid command file name/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runDoctor reports project command health issues", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-doctor-"));

  try {
    const commandsDir = join(workspaceRoot, ".ccagent", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "empty.md"), "");
    await writeFile(
      join(commandsDir, "review.md"),
      ["---", "args: required", "---", "Review {{args}}"].join("\n"),
    );

    const report = await runDoctorIsolated(workspaceRoot);
    const checks = new Map(report.checks.map((check) => [check.name, check]));

    assert.equal(checks.get("project_commands")?.status, "ok");
    assert.equal(checks.get("project_commands_health")?.status, "fail");
    assert.match(checks.get("project_commands_health")?.detail ?? "", /1 failure\(s\), 1 warning\(s\)/);
    assert.equal(checks.get("commands_check_failure")?.status, "fail");
    assert.match(checks.get("commands_check_failure")?.detail ?? "", /empty: Template is empty/);
    assert.equal(checks.get("commands_check_warning")?.status, "warn");
    assert.match(checks.get("commands_check_warning")?.detail ?? "", /review: args is required but usage is missing/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatDoctorReport includes OpenAI check details", () => {
  const report = formatDoctorReport({
    workspaceRoot: "workspace",
    checks: [
      {
        name: "openai_sdk",
        status: "ok",
        detail: "openai 1.0.0 installed.",
      },
      {
        name: "openai_api_mode",
        status: "ok",
        detail: "chat (source: config; uses /v1/chat/completions; recommended for many relay providers)",
      },
      {
        name: "openai_base_url",
        status: "ok",
        detail: "https://relay.example/v1 (source: config)",
      },
      {
        name: "openai_smoke_command",
        status: "warn",
        detail: 'Configure an API key first (set OPENAI_API_KEY or run "ccagent login --api-key <key>"), then run: ccagent --json --no-session "list files"',
      },
    ],
  });

  assert.match(report, /\[OK\] openai_sdk/);
  assert.match(report, /openai_api_mode/);
  assert.match(report, /openai_base_url/);
  assert.match(report, /openai_smoke_command/);
  assert.match(report, /Summary: 0 failure\(s\), 1 warning\(s\)\./);
});

async function runDoctorIsolated(workspaceRoot: string): Promise<Awaited<ReturnType<typeof runDoctor>>> {
  const previousUserDir = process.env.CCAGENT_USER_DIR;
  process.env.CCAGENT_USER_DIR = join(workspaceRoot, "user-home");

  try {
    return await runDoctor(workspaceRoot);
  } finally {
    if (previousUserDir === undefined) {
      delete process.env.CCAGENT_USER_DIR;
    } else {
      process.env.CCAGENT_USER_DIR = previousUserDir;
    }
  }
}
