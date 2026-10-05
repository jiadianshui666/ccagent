import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadApiKeyStatus } from "./auth.js";
import { collectProjectCommandChecks, loadProjectCommands } from "./commands.js";
import { loadConfig, loadUserConfig } from "./config.js";
import { loadProjectInstructions } from "./instructions.js";
import { formatProviderRetryConfig, parseOpenAIApiMode, type OpenAIApiMode } from "./model.js";
import { resolveShellSandbox } from "./sandbox.js";
import { SessionStore } from "./session.js";

const execFileAsync = promisify(execFile);
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

type DoctorStatus = "ok" | "warn" | "fail";

type DoctorCheck = {
  name: string;
  status: DoctorStatus;
  detail: string;
};

export type DoctorReport = {
  workspaceRoot: string;
  checks: DoctorCheck[];
};

export async function runDoctor(workspaceRoot: string): Promise<DoctorReport> {
  const loadedConfig = await loadConfig(workspaceRoot);
  const loadedUserConfig = await loadUserConfig();
  const apiKeyStatus = await loadApiKeyStatus();
  const projectInstructions = await loadProjectInstructions(workspaceRoot);
  const projectCommands = await loadProjectCommands(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  const openAIModel = resolveOpenAIModel(loadedConfig.config.model, loadedUserConfig.config.model);
  const openAIBaseURL = resolveOpenAIBaseURL(
    loadedConfig.config.openai?.baseURL,
    loadedUserConfig.config.openai?.baseURL,
  );
  const openAIApiMode = resolveOpenAIApiMode(
    loadedConfig.config.openai?.apiMode,
    loadedUserConfig.config.openai?.apiMode,
  );
  const openAIEmbeddingModel = resolveOpenAIEmbeddingModel(
    loadedConfig.config.openai?.embeddingModel,
    loadedUserConfig.config.openai?.embeddingModel,
  );
  const projectCommandChecks = collectProjectCommandChecks(projectCommands);
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    status: "ok",
    detail: process.version,
  });

  checks.push({
    name: "workspace",
    status: "ok",
    detail: workspaceRoot,
  });

  checks.push({
    name: "config",
    status: loadedConfig.exists ? "ok" : "warn",
    detail: loadedConfig.exists
      ? loadedConfig.path
      : `Missing config. Run "ccagent --init" to create ${loadedConfig.path}.`,
  });

  checks.push({
    name: "user_config",
    status: loadedUserConfig.warnings.length > 0 ? "warn" : "ok",
    detail: loadedUserConfig.exists
      ? loadedUserConfig.path
      : `Not created. Optional user-level defaults live at ${loadedUserConfig.path}; run "ccagent --user-config-set openai.baseURL <url>" to create it.`,
  });

  checks.push({
    name: "project_instructions",
    status: projectInstructions.warnings.length > 0 ? "warn" : "ok",
    detail: projectInstructions.exists
      ? `${projectInstructions.path} (${projectInstructions.bytes ?? 0} bytes, ${projectInstructions.content.length} chars loaded)`
      : `No CCAGENT.md found at ${projectInstructions.path}. Optional project guidance is not loaded. Run "ccagent --init-instructions" to create a starter file.`,
  });

  checks.push({
    name: "project_commands",
    status: projectCommands.warnings.length > 0 ? "warn" : "ok",
    detail: formatProjectCommandsDoctorDetail(projectCommands),
  });

  checks.push({
    name: "project_commands_health",
    status: getProjectCommandsHealthStatus(projectCommandChecks),
    detail: formatProjectCommandsHealthDetail(projectCommandChecks),
  });

  checks.push(await shellSandboxDoctorCheck(loadedConfig.config.toolPolicy?.shellSandbox));

  checks.push({
    name: "model",
    status: "ok",
    detail: `${openAIModel.model} (source: ${openAIModel.source})`,
  });

  checks.push(await checkOpenAISdk(PACKAGE_ROOT));

  checks.push({
    name: "openai_api_mode",
    status: "ok",
    detail:
      openAIApiMode.apiMode === "chat"
        ? `chat (source: ${openAIApiMode.source}; uses /v1/chat/completions; recommended for many relay providers)`
        : `responses (source: ${openAIApiMode.source}; uses /v1/responses)`,
  });

  checks.push({
    name: "openai_base_url",
    status: "ok",
    detail: `${openAIBaseURL.baseURL} (source: ${openAIBaseURL.source})`,
  });

  checks.push({
    name: "openai_embedding_model",
    status: "ok",
    detail: openAIEmbeddingModel.model
      ? `${openAIEmbeddingModel.model} (source: ${openAIEmbeddingModel.source})`
      : "local-hash-v1 (provider embeddings disabled)",
  });

  checks.push({
    name: "openai_provider_retry",
    status: "ok",
    detail: formatProviderRetryConfig(loadedConfig.config.openai?.retry),
  });

  checks.push({
    name: "openai_api_key",
    status: apiKeyStatus.set ? "ok" : "warn",
    detail: apiKeyStatus.source === "env"
      ? "OPENAI_API_KEY is set (env); real OpenAI model client will be used."
      : apiKeyStatus.source === "auth-file"
        ? `API key stored in ${apiKeyStatus.authPath} (ccagent login); real OpenAI model client will be used.`
        : `No API key configured. Set OPENAI_API_KEY or run "ccagent login --api-key <key>"; CCAgent uses the mock model until then.`,
  });

  checks.push({
    name: "openai_smoke_command",
    status: apiKeyStatus.set ? "ok" : "warn",
    detail: apiKeyStatus.set
      ? `Run: ${formatOpenAISmokeCommand()}`
      : `Configure an API key first (set OPENAI_API_KEY or run "ccagent login --api-key <key>"), then run: ${formatOpenAISmokeCommand()}`,
  });

  checks.push(await checkCommand("ripgrep", "rg", ["--version"], "Required by search_files."));
  checks.push(await checkCommand("git", "git", ["--version"], "Required by apply_patch, git_status, and git_diff."));
  checks.push(await checkGlobalCommand());

  checks.push({
    name: "session",
    status: "ok",
    detail: sessionStore.path,
  });

  for (const warning of loadedConfig.warnings) {
    checks.push({
      name: "config_warning",
      status: "warn",
      detail: warning,
    });
  }

  for (const warning of loadedUserConfig.warnings) {
    checks.push({
      name: "user_config_warning",
      status: "warn",
      detail: warning,
    });
  }

  for (const warning of projectInstructions.warnings) {
    checks.push({
      name: "instructions_warning",
      status: "warn",
      detail: warning,
    });
  }

  for (const warning of projectCommands.warnings) {
    checks.push({
      name: "commands_warning",
      status: "warn",
      detail: warning,
    });
  }

  for (const check of projectCommandChecks) {
    if (!check.commandName) {
      continue;
    }

    const scope = check.commandName ? `${check.commandName}: ` : "";

    checks.push({
      name: check.level === "fail" ? "commands_check_failure" : "commands_check_warning",
      status: check.level,
      detail: `${scope}${check.message}`,
    });
  }

  return {
    workspaceRoot,
    checks,
  };
}

export type ResolvedOpenAIModel = {
  model: string;
  source: "env" | "config" | "user-config" | "default";
};

export type ResolvedOpenAIBaseURL = {
  baseURL: string;
  source: "env" | "config" | "user-config" | "official";
};

export type ResolvedOpenAIApiMode = {
  apiMode: OpenAIApiMode;
  source: "env" | "config" | "user-config" | "default";
};

export type ResolvedOpenAIEmbeddingModel = {
  model?: string;
  source: "config" | "env" | "user-config" | "local";
};

export function resolveOpenAIModel(
  configModel: string | undefined,
  userConfigModel: string | undefined = undefined,
): ResolvedOpenAIModel {
  const envModel = process.env.CCAGENT_MODEL?.trim();

  if (envModel) {
    return {
      model: envModel,
      source: "env",
    };
  }

  if (configModel?.trim()) {
    return {
      model: configModel.trim(),
      source: "config",
    };
  }

  if (userConfigModel?.trim()) {
    return {
      model: userConfigModel.trim(),
      source: "user-config",
    };
  }

  return {
    model: DEFAULT_OPENAI_MODEL,
    source: "default",
  };
}

export function formatOpenAISmokeCommand(): string {
  return 'ccagent --json --no-session "list files"';
}

export function resolveOpenAIBaseURL(
  configBaseURL: string | undefined = undefined,
  userConfigBaseURL: string | undefined = undefined,
): ResolvedOpenAIBaseURL {
  const baseURL = process.env.OPENAI_BASE_URL?.trim();

  if (baseURL) {
    return {
      baseURL,
      source: "env",
    };
  }

  if (configBaseURL?.trim()) {
    return {
      baseURL: configBaseURL.trim(),
      source: "config",
    };
  }

  if (userConfigBaseURL?.trim()) {
    return {
      baseURL: userConfigBaseURL.trim(),
      source: "user-config",
    };
  }

  return {
    baseURL: "https://api.openai.com/v1",
    source: "official",
  };
}

export function resolveOpenAIApiMode(
  configApiMode: OpenAIApiMode | undefined = undefined,
  userConfigApiMode: OpenAIApiMode | undefined = undefined,
): ResolvedOpenAIApiMode {
  const envApiMode = process.env.CCAGENT_API_MODE?.trim();

  if (envApiMode) {
    return {
      apiMode: parseOpenAIApiMode(envApiMode),
      source: "env",
    };
  }

  if (configApiMode) {
    return {
      apiMode: configApiMode,
      source: "config",
    };
  }

  if (userConfigApiMode) {
    return {
      apiMode: userConfigApiMode,
      source: "user-config",
    };
  }

  return {
    apiMode: "responses",
    source: "default",
  };
}

export function resolveOpenAIEmbeddingModel(
  configEmbeddingModel: string | undefined = undefined,
  userConfigEmbeddingModel: string | undefined = undefined,
): ResolvedOpenAIEmbeddingModel {
  const envModel = process.env.CCAGENT_EMBEDDING_MODEL?.trim();

  if (envModel) {
    return {
      model: envModel,
      source: "env",
    };
  }

  if (configEmbeddingModel?.trim()) {
    return {
      model: configEmbeddingModel.trim(),
      source: "config",
    };
  }

  if (userConfigEmbeddingModel?.trim()) {
    return {
      model: userConfigEmbeddingModel.trim(),
      source: "user-config",
    };
  }

  return {
    source: "local",
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["CCAgent doctor", `Workspace: ${report.workspaceRoot}`, ""];

  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
  }

  const failures = report.checks.filter((check) => check.status === "fail").length;
  const warnings = report.checks.filter((check) => check.status === "warn").length;

  lines.push("");
  lines.push(`Summary: ${failures} failure(s), ${warnings} warning(s).`);

  return lines.join("\n");
}

async function checkCommand(
  name: string,
  command: string,
  args: string[],
  missingDetail: string,
): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });

    const firstLine = stdout.split(/\r?\n/).find(Boolean) ?? `${command} found.`;

    return {
      name,
      status: "ok",
      detail: firstLine,
    };
  } catch {
    return {
      name,
      status: "fail",
      detail: `${command} was not found. ${missingDetail}`,
    };
  }
}

async function checkOpenAISdk(packageRoot: string): Promise<DoctorCheck> {
  try {
    const installed = await readPackageJson(join(packageRoot, "node_modules", "openai", "package.json"));
    const localPackage = await readPackageJson(join(packageRoot, "package.json"));
    const declared = readDependencyVersion(localPackage, "openai");
    const version = typeof installed.version === "string" ? installed.version : "unknown";
    const declaration = declared ? `declared ${declared}` : "not declared in package.json";

    return {
      name: "openai_sdk",
      status: "ok",
      detail: `openai ${version} installed (${declaration}).`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return {
      name: "openai_sdk",
      status: "fail",
      detail: `OpenAI SDK was not found. Run "npm install" in the CCAgent project. ${reason}`,
    };
  }
}

async function readPackageJson(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid package.json: ${path}`);
  }

  return parsed as Record<string, unknown>;
}

function readDependencyVersion(packageJson: Record<string, unknown>, name: string): string | null {
  for (const field of ["dependencies", "devDependencies"] as const) {
    const dependencies = packageJson[field];

    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }

    const version = (dependencies as Record<string, unknown>)[name];

    if (typeof version === "string" && version.trim().length > 0) {
      return version.trim();
    }
  }

  return null;
}

async function shellSandboxDoctorCheck(
  configuredMode: string | undefined,
): Promise<DoctorCheck> {
  const settings = resolveShellSandbox({
    env: process.env.CCAGENT_SANDBOX,
    config: { mode: configuredMode },
  });

  if (settings.mode === "off") {
    return {
      name: "shell_sandbox",
      status: "ok",
      detail:
        "off (shell commands run directly on the host; job/timeout/podman/docker isolation is available through toolPolicy.shellSandbox)",
    };
  }

  if (settings.mode === "job") {
    if (process.platform !== "win32") {
      return {
        name: "shell_sandbox",
        status: "fail",
        detail: "sandbox is set to job but Windows Job Objects require win32; use docker, podman, timeout, or off",
      };
    }

    try {
      await withTimeout(
        execFileAsync("where.exe", ["powershell.exe"], { windowsHide: true }),
        3_000,
      );

      return {
        name: "shell_sandbox",
        status: "ok",
        detail: describeSandboxDoctorDetail(settings, "job (Windows Job Object: kill-on-close cleanup, memory/cpu/pids limits)"),
      };
    } catch {
      return {
        name: "shell_sandbox",
        status: "fail",
        detail: "sandbox is set to job but powershell.exe is unavailable on this machine",
      };
    }
  }

  if (settings.mode === "timeout") {
    if (process.platform === "win32") {
      return {
        name: "shell_sandbox",
        status: "fail",
        detail: "sandbox is set to timeout but the POSIX timeout wrapper is not the Windows timeout command; use job or docker on win32",
      };
    }

    try {
      await withTimeout(
        execFileAsync("timeout", ["--version"]).catch(() =>
          execFileAsync("timeout", ["--help"]),
        ),
        3_000,
      );

      return {
        name: "shell_sandbox",
        status: "ok",
        detail: describeSandboxDoctorDetail(settings, "timeout (POSIX timeout wrapper with process-group kill)"),
      };
    } catch {
      return {
        name: "shell_sandbox",
        status: "fail",
        detail: "sandbox is set to timeout but the timeout executable is unavailable; install GNU coreutils (or busybox timeout) or use docker/podman/off",
      };
    }
  }

  const modeLabel = settings.mode === "podman"
    ? `podman (rootless-friendly, image=${settings.dockerImage}, network=${settings.network})`
    : `docker (image=${settings.dockerImage}, network=${settings.network})`;
  const executable = settings.mode === "podman" ? "podman" : settings.dockerExecutable;

  try {
    await withTimeout(
      execFileAsync(executable, ["--version"], {
        windowsHide: true,
      }),
      3_000,
    );

    return {
      name: "shell_sandbox",
      status: "ok",
      detail: `${modeLabel}, readonly=${settings.readOnly ? "yes" : "no"}, memory=${settings.memoryMb ?? "-"}m, cpus=${settings.cpus ?? "-"}, pids=${settings.pidsLimit ?? "-"}; the ${executable} CLI is available`,
    };
  } catch {
    return {
      name: "shell_sandbox",
      status: "fail",
      detail: `sandbox is set to ${settings.mode} but "${executable}" is unavailable; install it or run "ccagent --config-set toolPolicy.shellSandbox off"`,
    };
  }
}

function describeSandboxDoctorDetail(
  settings: ReturnType<typeof resolveShellSandbox>,
  prefix: string,
): string {
  return `${prefix}, readonly=n/a, memory=${settings.memoryMb ?? "-"}m, cpus=${settings.cpus ?? "-"}, pids=${settings.pidsLimit ?? "-"} (if supported by the isolator)`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function getProjectCommandsHealthStatus(
  checks: ReturnType<typeof collectProjectCommandChecks>,
): DoctorStatus {
  if (checks.some((check) => check.level === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.level === "warn")) {
    return "warn";
  }

  return "ok";
}

function formatProjectCommandsHealthDetail(
  checks: ReturnType<typeof collectProjectCommandChecks>,
): string {
  const failures = checks.filter((check) => check.level === "fail").length;
  const warnings = checks.filter((check) => check.level === "warn").length;

  if (failures === 0 && warnings === 0) {
    return "No issues found.";
  }

  return `${failures} failure(s), ${warnings} warning(s). Run "/commands --check" for the full report.`;
}

function formatProjectCommandsDoctorDetail(projectCommands: Awaited<ReturnType<typeof loadProjectCommands>>): string {
  const names = projectCommands.commands.map((command) => command.name).join(", ");
  const suffix = names ? `: ${names}` : "";

  return `${projectCommands.path} (${projectCommands.commands.length} command(s)${suffix})`;
}

async function checkGlobalCommand(): Promise<DoctorCheck> {
  const commandPath = await findCommandOnPath("ccagent");

  if (commandPath) {
    return {
      name: "global_command",
      status: "ok",
      detail: commandPath,
    };
  }

  return {
    name: "global_command",
    status: "warn",
    detail: `ccagent was not found on PATH. Run "npm link" from this project to enable it.`,
  };
}

async function findCommandOnPath(command: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  const directories = pathValue.split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".ps1"] : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);

      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue scanning PATH.
      }
    }
  }

  return null;
}
