import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  buildSandboxSpawn,
  cleanupSandboxContainer,
  DEFAULT_SHELL_SANDBOX,
  type ShellSandboxSettings,
} from "../sandbox.js";
import {
  DEFAULT_EXECUTION_GUARD_LEVEL,
  formatExecutionGuardDenial,
  scanShellCommand,
  type ExecutionGuardLevel,
} from "../injectionGuard.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_COMMAND_LENGTH = 2000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const PROCESS_TREE_KILL_GRACE_MS = 500;

export type RunShellToolOptions = {
  executionGuard?: ExecutionGuardLevel;
  sandbox?: ShellSandboxSettings;
  timeoutMs?: number;
};

export class RunShellTool implements Tool {
  readonly name = "run_shell";
  readonly description = "Run a shell command in the current workspace after user approval.";
  readonly parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to run in the workspace root.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  } as const;
  private readonly executionGuard: ExecutionGuardLevel;
  private readonly sandbox: ShellSandboxSettings;
  private readonly timeoutMs: number;

  constructor(options: RunShellToolOptions = {}) {
    this.executionGuard = options.executionGuard ?? DEFAULT_EXECUTION_GUARD_LEVEL;
    this.sandbox = options.sandbox ?? DEFAULT_SHELL_SANDBOX;
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  }

  approvalMessage(input: Record<string, unknown>): string | null {
    if (typeof input.command !== "string") {
      return "Run an invalid shell command request.";
    }

    const sandboxNote =
      this.sandbox.mode === "docker"
        ? ` (sandboxed: Docker container, network=${this.sandbox.network})`
        : "";
    const guardNote = formatGuardApprovalNote(this.executionGuard, input.command);

    return `Run shell command in workspace${sandboxNote}${guardNote}:\n${input.command}`;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.command !== "string") {
      return {
        ok: false,
        error: "Expected input.command to be a string.",
      };
    }

    const command = input.command.trim();

    if (command.length === 0) {
      return {
        ok: false,
        error: "Missing shell command.",
      };
    }

    if (command.length > MAX_COMMAND_LENGTH) {
      return {
        ok: false,
        error: `Shell command is too long (${command.length} characters).`,
      };
    }

    const guardScan = scanShellCommand(command);

    if (this.executionGuard === "deny" && guardScan.flagged) {
      return {
        ok: false,
        error: formatExecutionGuardDenial(guardScan.rules),
      };
    }

    const workspaceRoot = resolve(context.workspaceRoot);
    const plan = buildSandboxSpawn(
      this.sandbox,
      command,
      workspaceRoot,
      process.platform,
      this.timeoutMs,
    );

    const result = await runShellProcess(
      plan.executable,
      plan.args,
      workspaceRoot,
      this.timeoutMs,
      plan.env,
      plan.containerName === undefined
        ? undefined
        : () => cleanupSandboxContainer(plan.executable, plan.containerName as string),
    );

    if (result.spawnError) {
      const sandboxHint =
        this.sandbox.mode !== "off"
          ? ` The ${this.sandbox.mode} shell sandbox requires the matching executable on this machine; install it or run "ccagent --config-set toolPolicy.shellSandbox off" to disable it.`
          : "";

      return {
        ok: false,
        error: `Shell command failed to start: ${result.spawnError}${sandboxHint}`,
      };
    }

    return {
      ok: true,
      content: formatShellOutput(result.exitCode, result.stdout, result.stderr, {
        outputTruncated: result.outputTruncated,
        processTreeTerminated: result.processTreeTerminated,
        sandbox: plan.sandboxLabel,
        timedOut: result.timedOut,
        timeoutMs: this.timeoutMs,
        guardWarnings:
          this.executionGuard === "warn" && guardScan.flagged
            ? guardScan.rules.map((rule) => `${rule.id} — ${rule.reason}`)
            : [],
      }),
      metadata: {
        command,
        exitCode: result.exitCode,
        outputTruncated: result.outputTruncated,
        processTreeTerminated: result.processTreeTerminated,
        executionGuardLevel: this.executionGuard,
        sandboxMode: plan.sandboxMode,
        signal: result.signal,
        timedOut: result.timedOut,
        timeoutMs: this.timeoutMs,
      },
    };
  }
}

type ShellProcessResult = {
  exitCode: number | null;
  outputTruncated: boolean;
  processTreeTerminated: boolean;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

function runShellProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
  onTimeoutCleanup?: () => Promise<boolean>,
): Promise<ShellProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = createOutputCollector();
    const stderr = createOutputCollector();
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    let terminationPromise: Promise<boolean> | undefined;

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.once("error", (error) => {
      spawnError = error.message;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminationPromise = terminateProcessTree(child);

      if (onTimeoutCleanup) {
        void onTimeoutCleanup();
      }
    }, timeoutMs);

    child.once("close", async (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      const processTreeTerminated = terminationPromise ? await terminationPromise : false;
      resolveProcess({
        exitCode,
        outputTruncated: stdout.truncated || stderr.truncated,
        processTreeTerminated,
        signal,
        ...(spawnError ? { spawnError } : {}),
        stderr: stderr.value(),
        stdout: stdout.value(),
        timedOut,
      });
    });
  });
}

function createOutputCollector(): {
  append(chunk: Buffer | string): void;
  readonly truncated: boolean;
  value(): string;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const remaining = MAX_OUTPUT_BYTES - bytes;

      if (remaining <= 0) {
        truncated = true;
        return;
      }

      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        return;
      }

      chunks.push(buffer);
      bytes += buffer.length;
    },
    get truncated(): boolean {
      return truncated;
    },
    value(): string {
      return Buffer.concat(chunks, bytes).toString("utf8");
    },
  };
}

async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;

  if (!pid || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  if (process.platform === "win32") {
    const killed = await runTaskkill(pid);

    if (!killed) {
      child.kill("SIGKILL");
    }

    return killed;
  }

  let signalSent = false;

  try {
    process.kill(-pid, "SIGTERM");
    signalSent = true;
  } catch {
    signalSent = child.kill("SIGTERM") || signalSent;
  }

  await delay(PROCESS_TREE_KILL_GRACE_MS);

  try {
    process.kill(-pid, "SIGKILL");
    signalSent = true;
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      signalSent = child.kill("SIGKILL") || signalSent;
    }
  }

  return signalSent;
}

function runTaskkill(pid: number): Promise<boolean> {
  return new Promise((resolveKill) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });

    killer.once("error", () => {
      resolveKill(false);
    });
    killer.once("close", (exitCode) => {
      resolveKill(exitCode === 0);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return COMMAND_TIMEOUT_MS;
  }

  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("run_shell timeoutMs must be a positive finite number");
  }

  return Math.floor(value);
}

function formatShellOutput(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  diagnostics: {
    outputTruncated: boolean;
    processTreeTerminated: boolean;
    guardWarnings: string[];
    sandbox: string;
    timedOut: boolean;
    timeoutMs: number;
  },
): string {
  const diagnosticLines = [
    ...(diagnostics.timedOut
      ? [
          diagnostics.processTreeTerminated
            ? `[ccagent] command timed out after ${diagnostics.timeoutMs}ms; the process tree was terminated.`
            : `[ccagent] command timed out after ${diagnostics.timeoutMs}ms; process-tree termination could not be confirmed.`,
        ]
      : []),
    ...diagnostics.guardWarnings.map(
      (warning) => `[ccagent] execution guard warning: ${warning}`,
    ),
    ...(diagnostics.outputTruncated
      ? [`[ccagent] command output was truncated after ${MAX_OUTPUT_BYTES} bytes per stream.`]
      : []),
  ];

  return [
    `sandbox: ${diagnostics.sandbox}`,
    `exitCode: ${exitCode ?? "unknown"}`,
    "stdout:",
    stdout.trimEnd() || "(empty)",
    "stderr:",
    stderr.trimEnd() || "(empty)",
    ...diagnosticLines,
  ].join("\n");
}

function formatGuardApprovalNote(level: ExecutionGuardLevel, command: string): string {
  if (level === "off") {
    return "";
  }

  const scan = scanShellCommand(command);

  if (!scan.flagged) {
    return "";
  }

  return level === "deny"
    ? " (execution guard: command matches blocked patterns)"
    : " (execution guard: command matches suspicious patterns and will log warnings)";
}
