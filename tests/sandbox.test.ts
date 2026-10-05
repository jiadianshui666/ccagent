import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCliArgs } from "../src/args.js";
import { loadConfig, setConfigValue } from "../src/config.js";
import {
  buildSandboxSpawn,
  describeShellSandbox,
  DEFAULT_SHELL_SANDBOX,
  resolveShellSandbox,
  SHELL_SANDBOX_WORKSPACE_TARGET,
  WINDOWS_JOB_ENV_KEYS,
} from "../src/sandbox.js";
import { RunShellTool } from "../src/tools/runShell.js";

test("resolveShellSandbox defaults to off", () => {
  const settings = resolveShellSandbox({});

  assert.deepEqual(settings, DEFAULT_SHELL_SANDBOX);
});

test("resolveShellSandbox prefers the CLI flag over env and config", () => {
  const warnings: string[] = [];
  const settings = resolveShellSandbox(
    {
      cli: "docker",
      env: "off",
      config: { mode: "off" },
    },
    warnings,
  );

  assert.equal(settings.mode, "docker");
  assert.deepEqual(warnings, []);
});

test("resolveShellSandbox falls back to CCAGENT_SANDBOX and then config", () => {
  assert.equal(resolveShellSandbox({ env: "dOcKeR" }).mode, "docker");

  const configSettings = resolveShellSandbox({
    config: {
      mode: "docker",
      image: "node:24-alpine",
      network: "bridge",
    },
  });

  assert.equal(configSettings.mode, "docker");
  assert.equal(configSettings.dockerImage, "node:24-alpine");
  assert.equal(configSettings.network, "bridge");
});

test("resolveShellSandbox warns on invalid values and keeps defaults", () => {
  const warnings: string[] = [];
  const settings = resolveShellSandbox(
    {
      cli: "container",
      env: "incinerate",
      config: { mode: "isolated", image: "  ", network: "host" },
    },
    warnings,
  );

  assert.equal(settings.mode, "off");
  assert.equal(settings.dockerImage, DEFAULT_SHELL_SANDBOX.dockerImage);
  assert.equal(settings.network, "none");
  assert.equal(warnings.length, 5);
});

test("buildSandboxSpawn builds docker args with a named container and mounted workspace", () => {
  const settings = resolveShellSandbox({
    config: { mode: "docker", image: "alpine:3.20", network: "none" },
  });
  const originalGetuid = (process as unknown as { getuid?: () => number }).getuid;
  const originalGetgid = (process as unknown as { getgid?: () => number }).getgid;
  Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
  Object.defineProperty(process, "getgid", { configurable: true, value: undefined });

  try {
    const plan = buildSandboxSpawn(settings, "npm test", "C:\\work\\repo", "linux");

    assert.equal(plan.executable, "docker");
    assert.equal(plan.sandboxMode, "docker");
    assert.match(plan.containerName ?? "", /^ccagent-sandbox-[a-z0-9]+$/);
    assert.deepEqual(plan.args, [
      "run",
      "--rm",
      "--init",
      "--name",
      plan.containerName as string,
      "--network=none",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--tmpfs",
      "/var/tmp:rw,noexec,nosuid,nodev,size=32m",
      "--env",
      "HOME=/tmp",
      "--memory",
      "2048m",
      "--memory-swap",
      "2048m",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
      "--mount",
      `type=bind,source=C:\\work\\repo,target=${SHELL_SANDBOX_WORKSPACE_TARGET}`,
      "--workdir",
      SHELL_SANDBOX_WORKSPACE_TARGET,
      "alpine:3.20",
      "sh",
      "-lc",
      "npm test",
    ]);
  } finally {
    if (originalGetuid) {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    } else {
      delete (process as unknown as { getuid?: () => number }).getuid;
    }

    if (originalGetgid) {
      Object.defineProperty(process, "getgid", { configurable: true, value: originalGetgid });
    } else {
      delete (process as unknown as { getgid?: () => number }).getgid;
    }
  }
});

test("buildSandboxSpawn adds the host user on POSIX when uid/gid are available", () => {
  const originalGetuid = (process as unknown as { getuid?: () => number }).getuid;
  const originalGetgid = (process as unknown as { getgid?: () => number }).getgid;
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  Object.defineProperty(process, "getgid", { configurable: true, value: () => 1000 });

  try {
    const settings = resolveShellSandbox({ config: { mode: "docker" } });
    const plan = buildSandboxSpawn(settings, "id", "/work/repo", "linux");
    const userIndex = plan.args.indexOf("--user");

    assert.notEqual(userIndex, -1);
    assert.equal(plan.args[userIndex + 1], "1000:1000");
  } finally {
    if (originalGetuid) {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    } else {
      delete (process as unknown as { getuid?: () => number }).getuid;
    }

    if (originalGetgid) {
      Object.defineProperty(process, "getgid", { configurable: true, value: originalGetgid });
    } else {
      delete (process as unknown as { getgid?: () => number }).getgid;
    }
  }
});

test("buildSandboxSpawn keeps the direct host shell for platform shells", () => {
  const settings = DEFAULT_SHELL_SANDBOX;

  assert.equal(buildSandboxSpawn(settings, "echo hi", "/work", "win32").executable, "powershell.exe");
  assert.equal(buildSandboxSpawn(settings, "echo hi", "/work", "linux").executable, "/bin/sh");
});

test("describeShellSandbox labels off and docker modes", () => {
  assert.equal(describeShellSandbox(DEFAULT_SHELL_SANDBOX), "off (direct on host)");
  assert.equal(
    describeShellSandbox(
      resolveShellSandbox({ config: { mode: "docker", image: "node:24-alpine" } }),
    ),
    "docker (image=node:24-alpine, network=none)",
  );
});

test("resolveShellSandbox reads hardening limits and defaults them when omitted", () => {
  const defaults = resolveShellSandbox({ config: { mode: "docker" } });

  assert.equal(defaults.readOnly, true);
  assert.equal(defaults.memoryMb, 2048);
  assert.equal(defaults.cpus, 2);
  assert.equal(defaults.pidsLimit, 512);

  const custom = resolveShellSandbox({
    config: {
      mode: "docker",
      readOnly: "false",
      memoryMb: "512",
      cpus: "1.5",
      pidsLimit: "256",
    },
  });

  assert.equal(custom.readOnly, false);
  assert.equal(custom.memoryMb, 512);
  assert.equal(custom.cpus, 1.5);
  assert.equal(custom.pidsLimit, 256);
});

test("resolveShellSandbox warns on invalid hardening values and keeps defaults", () => {
  const warnings: string[] = [];
  const settings = resolveShellSandbox(
    {
      config: {
        mode: "docker",
        readOnly: "maybe",
        memoryMb: "12m",
        cpus: "lots",
        pidsLimit: "0",
      },
    },
    warnings,
  );

  assert.equal(settings.readOnly, true);
  assert.equal(settings.memoryMb, 2048);
  assert.equal(settings.cpus, 2);
  assert.equal(settings.pidsLimit, 512);
  assert.equal(warnings.length, 4);
});

test("buildSandboxSpawn skips read-only flags when root writes are allowed", () => {
  const settings = resolveShellSandbox({
    config: {
      mode: "docker",
      readOnly: "false",
      memoryMb: "512",
      cpus: "1.5",
      pidsLimit: "256",
    },
  });
  const originalGetuid = (process as unknown as { getuid?: () => number }).getuid;
  const originalGetgid = (process as unknown as { getgid?: () => number }).getgid;
  Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
  Object.defineProperty(process, "getgid", { configurable: true, value: undefined });

  try {
    const plan = buildSandboxSpawn(settings, "echo ok", "/repo", "linux");

    assert.equal(plan.args.includes("--read-only"), false);
    assert.equal(plan.args.includes("--tmpfs"), false);
    assert.deepEqual(plan.args.slice(plan.args.indexOf("--memory")), [
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1.5",
      "--pids-limit",
      "256",
      "--mount",
      `type=bind,source=/repo,target=${SHELL_SANDBOX_WORKSPACE_TARGET}`,
      "--workdir",
      SHELL_SANDBOX_WORKSPACE_TARGET,
      "alpine:3.20",
      "sh",
      "-lc",
      "echo ok",
    ]);
  } finally {
    if (originalGetuid) {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    } else {
      delete (process as unknown as { getuid?: () => number }).getuid;
    }

    if (originalGetgid) {
      Object.defineProperty(process, "getgid", { configurable: true, value: originalGetgid });
    } else {
      delete (process as unknown as { getgid?: () => number }).getgid;
    }
  }
});

test("--sandbox enables Docker sandboxing for this run", () => {
  const parsed = parseCliArgs(["--sandbox", "list files"]);

  assert.equal(parsed.allowEdits, false);
  assert.equal(parsed.sandbox, true);
  assert.equal(parsed.mode, "prompt");
});

test("toolPolicy.shellSandbox persists through setConfigValue and loadConfig", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-sandbox-config-"));

  try {
    await setConfigValue(workspaceRoot, "toolPolicy.shellSandbox", "docker");
    await setConfigValue(workspaceRoot, "toolPolicy.shellSandboxImage", "node:24-alpine");
    await setConfigValue(workspaceRoot, "toolPolicy.shellSandboxNetwork", "bridge");
    await setConfigValue(workspaceRoot, "toolPolicy.shellSandboxReadOnly", "false");
    await setConfigValue(workspaceRoot, "toolPolicy.shellSandboxMemoryMb", "512");
    await setConfigValue(workspaceRoot, "toolPolicy.shellSandboxCpus", "1.5");
    await setConfigValue(workspaceRoot, "toolPolicy.shellSandboxPidsLimit", "256");

    const loaded = await loadConfig(workspaceRoot);

    assert.equal(loaded.config.toolPolicy?.shellSandbox, "docker");
    assert.equal(loaded.config.toolPolicy?.shellSandboxImage, "node:24-alpine");
    assert.equal(loaded.config.toolPolicy?.shellSandboxNetwork, "bridge");
    assert.equal(loaded.config.toolPolicy?.shellSandboxReadOnly, "false");
    assert.equal(loaded.config.toolPolicy?.shellSandboxMemoryMb, "512");
    assert.equal(loaded.config.toolPolicy?.shellSandboxCpus, "1.5");
    assert.equal(loaded.config.toolPolicy?.shellSandboxPidsLimit, "256");

    await assert.rejects(
      setConfigValue(workspaceRoot, "toolPolicy.shellSandbox", "incinerate"),
      /one of: off, docker, podman, job, timeout/,
    );

    await assert.rejects(
      setConfigValue(workspaceRoot, "toolPolicy.shellSandboxNetwork", "host"),
      /one of: none, bridge/,
    );

    await assert.rejects(
      setConfigValue(workspaceRoot, "toolPolicy.shellSandboxReadOnly", "maybe"),
      /Expected toolPolicy\.shellSandboxReadOnly to be "true" or "false"\./,
    );

    await assert.rejects(
      setConfigValue(workspaceRoot, "toolPolicy.shellSandboxMemoryMb", "12"),
      /between 64 and 262144/,
    );

    await assert.rejects(
      setConfigValue(workspaceRoot, "toolPolicy.shellSandboxCpus", "fast"),
      /Expected toolPolicy\.shellSandboxCpus to be a number\./,
    );

    await assert.rejects(
      setConfigValue(workspaceRoot, "toolPolicy.shellSandboxPidsLimit", "8"),
      /between 16 and 1048576/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("RunShellTool reports a clear error when Docker is unavailable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-sandbox-missing-docker-"));

  try {
    const missingDocker = join(workspaceRoot, "no-such-docker-binary");
    const tool = new RunShellTool({
      sandbox: {
        mode: "docker",
        dockerExecutable: missingDocker,
        dockerImage: "alpine:3.20",
        network: "none",
      },
    });
    const result = await tool.execute({ command: "echo hi" }, { workspaceRoot });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.match(result.error, /Shell command failed to start/);
      assert.match(result.error, /docker shell sandbox requires the matching executable/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("--sandbox=mode accepts an explicit isolation mode", () => {
  const parsed = parseCliArgs(["--sandbox=job", "list files"]);

  assert.equal(parsed.sandbox, "job");
  assert.equal(parsed.mode, "prompt");
});

test("resolveShellSandbox disables platform-incompatible isolators with warnings", () => {
  const jobWarnings: string[] = [];
  const jobSettings = resolveShellSandbox(
    { config: { mode: "job" } },
    jobWarnings,
    "linux",
  );

  assert.equal(jobSettings.mode, "off");
  assert.equal(jobWarnings.length, 1);
  assert.match(jobWarnings[0] ?? "", /only available on win32/);

  const timeoutWarnings: string[] = [];
  const timeoutSettings = resolveShellSandbox(
    { config: { mode: "timeout" } },
    timeoutWarnings,
    "win32",
  );

  assert.equal(timeoutSettings.mode, "off");
  assert.equal(timeoutWarnings.length, 1);
  assert.match(timeoutWarnings[0] ?? "", /not the Windows timeout command/);
});

test("buildSandboxSpawn builds an encoded Windows Job Object wrapper on win32", () => {
  const settings = resolveShellSandbox(
    {
      config: {
        mode: "job",
        memoryMb: "512",
        cpus: "1.5",
        pidsLimit: "128",
      },
    },
    [],
    "win32",
  );
  const plan = buildSandboxSpawn(settings, "echo hi > out.txt", "C:\\repo", "win32", 45_000);

  assert.equal(plan.executable, "powershell.exe");
  assert.equal(plan.sandboxMode, "job");
  assert.deepEqual(plan.args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);

  const script = Buffer.from(plan.args[4] as string, "base64").toString("utf16le");

  assert.match(script, /CreateJobObject/);
  assert.match(script, /AssignProcessToJobObject/);
  assert.match(script, /CCAGENT_JOB_MEMORY_MB/);
  assert.equal(plan.env?.[WINDOWS_JOB_ENV_KEYS.command], "echo hi > out.txt");
  assert.equal(plan.env?.[WINDOWS_JOB_ENV_KEYS.cwd], "C:\\repo");
  assert.equal(plan.env?.[WINDOWS_JOB_ENV_KEYS.memoryMb], "512");
  assert.equal(plan.env?.[WINDOWS_JOB_ENV_KEYS.cpus], "1.5");
  assert.equal(plan.env?.[WINDOWS_JOB_ENV_KEYS.pids], "128");
});

test("buildSandboxSpawn falls back to the direct shell for job mode off win32", () => {
  const settings = resolveShellSandbox({ config: { mode: "job" } }, [], "linux");
  const plan = buildSandboxSpawn(settings, "echo hi", "/repo", "linux");

  assert.equal(plan.executable, "/bin/sh");
  assert.equal(plan.sandboxMode, "off");
});

test("buildSandboxSpawn builds rootless-friendly podman args", () => {
  const settings = resolveShellSandbox(
    { config: { mode: "podman", image: "node:24-alpine", network: "bridge" } },
    [],
    "linux",
  );
  const originalGetuid = (process as unknown as { getuid?: () => number }).getuid;
  const originalGetgid = (process as unknown as { getgid?: () => number }).getgid;
  Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
  Object.defineProperty(process, "getgid", { configurable: true, value: undefined });

  try {
    const plan = buildSandboxSpawn(settings, "npm test", "/repo", "linux");

    assert.equal(plan.executable, "podman");
    assert.equal(plan.sandboxMode, "podman");
    assert.deepEqual(plan.args.slice(0, 12), [
      "run",
      "--rm",
      "--init",
      "--name",
      plan.containerName as string,
      "--network=bridge",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--read-only",
      "--tmpfs",
    ]);
    assert.equal(plan.args.includes("--userns=keep-id"), true);
    assert.equal(plan.args.includes("--user"), false);
    assert.ok(plan.args.includes("node:24-alpine"));
  } finally {
    if (originalGetuid) {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    } else {
      delete (process as unknown as { getuid?: () => number }).getuid;
    }

    if (originalGetgid) {
      Object.defineProperty(process, "getgid", { configurable: true, value: originalGetgid });
    } else {
      delete (process as unknown as { getgid?: () => number }).getgid;
    }
  }
});

test("buildSandboxSpawn wraps POSIX commands with the timeout executable", () => {
  const settings = resolveShellSandbox({ config: { mode: "timeout" } }, [], "linux");
  const plan = buildSandboxSpawn(settings, "npm test", "/repo", "linux", 45_000);

  assert.equal(plan.executable, "timeout");
  assert.equal(plan.sandboxMode, "timeout");
  assert.deepEqual(plan.args, ["-k", "2s", "45s", "/bin/sh", "-lc", "npm test"]);
});

test("RunShellTool executes commands inside a Windows Job Object", {
  skip: process.platform !== "win32",
}, async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-sandbox-job-run-"));

  try {
    const tool = new RunShellTool({
      sandbox: resolveShellSandbox({ config: { mode: "job" } }, [], "win32"),
    });
    const result = await tool.execute({ command: "echo job-ok-951" }, { workspaceRoot });

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.match(result.content, /job-ok-951/);
      assert.match(result.content, /sandbox: job \(Windows Job Object/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
