import { spawn, type ChildProcess } from "node:child_process";

export type ShellSandboxMode = "off" | "docker" | "podman" | "job" | "timeout";

export type ShellSandboxNetwork = "none" | "bridge";

export type ShellSandboxSettings = {
  mode: ShellSandboxMode;
  dockerExecutable: string;
  dockerImage: string;
  network: ShellSandboxNetwork;
  readOnly: boolean;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
};

export type ShellSandboxResolutionInput = {
  cli?: string;
  env?: string;
  config?: {
    mode?: string;
    image?: string;
    network?: string;
    readOnly?: string | boolean;
    memoryMb?: string | number;
    cpus?: string | number;
    pidsLimit?: string | number;
  };
};

export type SandboxSpawnPlan = {
  args: string[];
  containerName?: string;
  env?: Record<string, string>;
  executable: string;
  sandboxMode: ShellSandboxMode;
  sandboxLabel: string;
};

export const DEFAULT_SHELL_SANDBOX: ShellSandboxSettings = {
  mode: "off",
  dockerExecutable: "docker",
  dockerImage: "alpine:3.20",
  network: "none",
  readOnly: true,
  memoryMb: 2048,
  cpus: 2,
  pidsLimit: 512,
};

export const SHELL_SANDBOX_MODES: readonly ShellSandboxMode[] = [
  "off",
  "docker",
  "podman",
  "job",
  "timeout",
];

export const SHELL_SANDBOX_NETWORKS: readonly ShellSandboxNetwork[] = ["none", "bridge"];

export const SHELL_SANDBOX_WORKSPACE_TARGET = "/workspace";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export const WINDOWS_JOB_ENV_KEYS = {
  command: "CCAGENT_JOB_CMD",
  cpus: "CCAGENT_JOB_CPUS",
  cwd: "CCAGENT_JOB_CWD",
  memoryMb: "CCAGENT_JOB_MEMORY_MB",
  pids: "CCAGENT_JOB_PIDS",
} as const;

export function resolveShellSandbox(
  input: ShellSandboxResolutionInput,
  warnings: string[] = [],
  platform: NodeJS.Platform = process.platform,
): ShellSandboxSettings {
  const image = resolveDockerImage(input.config?.image, warnings);
  const network = resolveNetwork(input.config?.network, warnings);
  const readOnly = resolveReadOnly(input.config?.readOnly, warnings);
  const memoryMb = resolveIntegerLimit(
    "shellSandboxMemoryMb",
    input.config?.memoryMb,
    DEFAULT_SHELL_SANDBOX.memoryMb,
    64,
    262144,
    warnings,
  );
  const cpus = resolveDecimalLimit(
    "shellSandboxCpus",
    input.config?.cpus,
    DEFAULT_SHELL_SANDBOX.cpus,
    0.1,
    64,
    warnings,
  );
  const pidsLimit = resolveIntegerLimit(
    "shellSandboxPidsLimit",
    input.config?.pidsLimit,
    DEFAULT_SHELL_SANDBOX.pidsLimit,
    16,
    1048576,
    warnings,
  );

  let mode = resolveShellSandboxMode(input, warnings);

  if (mode === "job" && platform !== "win32") {
    warnings.push(
      `Disabling the job sandbox because Windows Job Objects are only available on win32; this platform is ${JSON.stringify(platform)}.`,
    );
    mode = "off";
  }

  if (mode === "timeout" && platform === "win32") {
    warnings.push(
      "Disabling the timeout sandbox because the portable POSIX timeout wrapper is not the Windows timeout command; use job or docker on win32.",
    );
    mode = "off";
  }

  return {
    mode,
    dockerExecutable: DEFAULT_SHELL_SANDBOX.dockerExecutable,
    dockerImage: image,
    network,
    readOnly,
    memoryMb,
    cpus,
    pidsLimit,
  };
}

export function buildSandboxSpawn(
  settings: ShellSandboxSettings,
  command: string,
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
  commandTimeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): SandboxSpawnPlan {
  if (settings.mode === "off") {
    return {
      args: getDirectShellArgs(platform, command),
      executable: getDirectShellExecutable(platform),
      sandboxMode: "off",
      sandboxLabel: "off (direct on host)",
    };
  }

  if (settings.mode === "docker" || settings.mode === "podman") {
    return buildContainerSpawn(settings, command, workspaceRoot, platform);
  }

  if (settings.mode === "job") {
    if (platform !== "win32") {
      return {
        args: getDirectShellArgs(platform, command),
        executable: getDirectShellExecutable(platform),
        sandboxMode: "off",
        sandboxLabel: "job (unsupported on this platform; ran direct on host)",
      };
    }

    const jobSandbox = buildWindowsJobSandboxCommand(settings, command, workspaceRoot);
    const encodedCommand = Buffer.from(jobSandbox.script, "utf16le").toString("base64");

    return {
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedCommand,
      ],
      env: jobSandbox.env,
      executable: "powershell.exe",
      sandboxMode: "job",
      sandboxLabel: describeShellSandbox(settings),
    };
  }

  const timeoutSeconds = Math.max(
    1,
    Math.ceil(normalizeCommandTimeoutMs(commandTimeoutMs) / 1000),
  );

  return {
    args: ["-k", "2s", `${timeoutSeconds}s`, "/bin/sh", "-lc", command],
    executable: "timeout",
    sandboxMode: "timeout",
    sandboxLabel: `timeout (POSIX timeout wrapper, hard cap ${timeoutSeconds}s)`,
  };
}

export function describeShellSandbox(settings: ShellSandboxSettings): string {
  if (settings.mode === "off") {
    return "off (direct on host)";
  }

  if (settings.mode === "job") {
    return "job (Windows Job Object: kill-on-close cleanup, memory/cpu/pids limits)";
  }

  if (settings.mode === "timeout") {
    return "timeout (POSIX timeout wrapper with process-group kill)";
  }

  if (settings.mode === "podman") {
    return `podman (rootless-friendly, image=${settings.dockerImage}, network=${settings.network})`;
  }

  return `docker (image=${settings.dockerImage}, network=${settings.network})`;
}

export function supportsFilesystemReadOnly(mode: ShellSandboxMode): boolean {
  return mode === "docker" || mode === "podman";
}

export function cleanupSandboxContainer(
  dockerExecutable: string,
  containerName: string,
): Promise<boolean> {
  return new Promise((resolveCleanup) => {
    let killer: ChildProcess;

    try {
      killer = spawn(dockerExecutable, ["rm", "-f", containerName], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolveCleanup(false);
      return;
    }

    killer.once("error", () => {
      resolveCleanup(false);
    });

    killer.once("close", (exitCode) => {
      resolveCleanup(exitCode === 0);
    });
  });
}

export function buildWindowsJobSandboxCommand(
  settings: ShellSandboxSettings,
  command: string,
  workspaceRoot: string,
): { env: Record<string, string>; script: string } {
  const env: Record<string, string> = {
    [WINDOWS_JOB_ENV_KEYS.command]: command,
    [WINDOWS_JOB_ENV_KEYS.cwd]: workspaceRoot,
  };

  if (settings.memoryMb !== undefined) {
    env[WINDOWS_JOB_ENV_KEYS.memoryMb] = String(settings.memoryMb);
  }

  if (settings.cpus !== undefined) {
    env[WINDOWS_JOB_ENV_KEYS.cpus] = formatDecimalLimit(settings.cpus);
  }

  if (settings.pidsLimit !== undefined) {
    env[WINDOWS_JOB_ENV_KEYS.pids] = String(settings.pidsLimit);
  }

  return { env, script: WINDOWS_JOB_POWERSHELL_SCRIPT };
}

function buildContainerSpawn(
  settings: ShellSandboxSettings,
  command: string,
  workspaceRoot: string,
  platform: NodeJS.Platform,
): SandboxSpawnPlan {
  const containerName = `ccagent-sandbox-${Date.now().toString(36)}${Math.floor(Math.random() * 1_000_000).toString(36)}`;
  const executable = settings.mode === "podman" ? "podman" : settings.dockerExecutable;
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    containerName,
    `--network=${settings.network}`,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
  ];

  if (settings.readOnly) {
    args.push(
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--tmpfs",
      "/var/tmp:rw,noexec,nosuid,nodev,size=32m",
    );
  }

  args.push("--env", "HOME=/tmp");

  if (settings.memoryMb !== undefined) {
    args.push("--memory", `${settings.memoryMb}m`, "--memory-swap", `${settings.memoryMb}m`);
  }

  if (settings.cpus !== undefined) {
    args.push("--cpus", formatDecimalLimit(settings.cpus));
  }

  if (settings.pidsLimit !== undefined) {
    args.push("--pids-limit", String(settings.pidsLimit));
  }

  args.push(
    "--mount",
    `type=bind,source=${workspaceRoot},target=${SHELL_SANDBOX_WORKSPACE_TARGET}`,
    "--workdir",
    SHELL_SANDBOX_WORKSPACE_TARGET,
  );

  if (settings.mode === "podman" && platform !== "win32") {
    args.push("--userns=keep-id");
  } else {
    addContainerUserArgs(args, platform);
  }

  args.push(settings.dockerImage, "sh", "-lc", command);

  return {
    args,
    containerName,
    executable,
    sandboxMode: settings.mode,
    sandboxLabel: describeShellSandbox(settings),
  };
}

function resolveShellSandboxMode(
  input: ShellSandboxResolutionInput,
  warnings: string[],
): ShellSandboxMode {
  const candidates: Array<{ source: string; value?: string }> = [
    { source: "--sandbox", value: input.cli },
    { source: "CCAGENT_SANDBOX", value: input.env },
    { source: "toolPolicy.shellSandbox", value: input.config?.mode },
  ];

  for (const candidate of candidates) {
    if (candidate.value === undefined) {
      continue;
    }

    const normalized = candidate.value.trim().toLowerCase();

    if (isShellSandboxMode(normalized)) {
      return normalized;
    }

    warnings.push(
      `Ignoring ${candidate.source} value ${JSON.stringify(candidate.value)} because it is not one of ${SHELL_SANDBOX_MODES.join(", ")}.`,
    );
  }

  return DEFAULT_SHELL_SANDBOX.mode;
}

function resolveDockerImage(value: string | undefined, warnings: string[]): string {
  if (value === undefined) {
    return DEFAULT_SHELL_SANDBOX.dockerImage;
  }

  const normalized = value.trim();

  if (normalized.length > 0) {
    return normalized;
  }

  warnings.push("Ignoring an empty docker image name; using the default image.");
  return DEFAULT_SHELL_SANDBOX.dockerImage;
}

function resolveNetwork(value: string | undefined, warnings: string[]): ShellSandboxNetwork {
  if (value === undefined) {
    return DEFAULT_SHELL_SANDBOX.network;
  }

  const normalized = value.trim().toLowerCase();

  if (isShellSandboxNetwork(normalized)) {
    return normalized;
  }

  warnings.push(
    `Ignoring shell sandbox network ${JSON.stringify(value)} because it is not one of ${SHELL_SANDBOX_NETWORKS.join(", ")}.`,
  );

  return DEFAULT_SHELL_SANDBOX.network;
}

function resolveReadOnly(
  value: string | boolean | undefined,
  warnings: string[],
): boolean {
  if (value === undefined) {
    return DEFAULT_SHELL_SANDBOX.readOnly;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true" || normalized === "false") {
    return normalized === "true";
  }

  warnings.push(
    `Ignoring shell sandbox readOnly ${JSON.stringify(value)} because it is not true or false; using ${DEFAULT_SHELL_SANDBOX.readOnly} instead.`,
  );
  return DEFAULT_SHELL_SANDBOX.readOnly;
}

function resolveIntegerLimit(
  field: string,
  value: string | number | undefined,
  fallback: number | undefined,
  min: number,
  max: number,
  warnings: string[],
): number | undefined {
  if (value === undefined) {
    return fallback;
  }

  const parsed = typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : null;

  if (parsed !== null && parsed >= min && parsed <= max) {
    return parsed;
  }

  warnings.push(
    `Ignoring shell sandbox ${field} ${JSON.stringify(value)} because it is not an integer between ${min} and ${max}${fallback !== undefined ? `; using ${fallback} instead` : ""}.`,
  );
  return fallback;
}

function resolveDecimalLimit(
  field: string,
  value: string | number | undefined,
  fallback: number | undefined,
  min: number,
  max: number,
  warnings: string[],
): number | undefined {
  if (value === undefined) {
    return fallback;
  }

  const parsed = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : null;

  if (parsed !== null && parsed >= min && parsed <= max) {
    return parsed;
  }

  warnings.push(
    `Ignoring shell sandbox ${field} ${JSON.stringify(value)} because it is not a number between ${min} and ${max}${fallback !== undefined ? `; using ${fallback} instead` : ""}.`,
  );
  return fallback;
}

function formatDecimalLimit(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function normalizeCommandTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }

  return Math.floor(value);
}

function isShellSandboxMode(value: string): value is ShellSandboxMode {
  return (SHELL_SANDBOX_MODES as readonly string[]).includes(value);
}

function isShellSandboxNetwork(value: string): value is ShellSandboxNetwork {
  return (SHELL_SANDBOX_NETWORKS as readonly string[]).includes(value);
}

function getDirectShellExecutable(platform: NodeJS.Platform): string {
  return platform === "win32" ? "powershell.exe" : "/bin/sh";
}

function getDirectShellArgs(platform: NodeJS.Platform, command: string): string[] {
  if (platform === "win32") {
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  }

  return ["-lc", command];
}

function addContainerUserArgs(args: string[], platform: NodeJS.Platform): void {
  if (platform === "win32") {
    return;
  }

  const getuid = (process as unknown as { getuid?: () => number }).getuid;
  const getgid = (process as unknown as { getgid?: () => number }).getgid;

  if (typeof getuid !== "function" || typeof getgid !== "function") {
    return;
  }

  const uid = getuid();
  const gid = getgid();

  if (Number.isInteger(uid) && Number.isInteger(gid) && uid > 0) {
    args.push("--user", `${uid}:${gid}`);
  }
}

const WINDOWS_JOB_POWERSHELL_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "namespace CCAgentSandbox {",
  "public static class Native {",
  "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);",
  "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);",
  "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);",
  "}",
  "[StructLayout(LayoutKind.Sequential)] public struct IoCounters {",
  "  public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;",
  "  public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;",
  "}",
  "[StructLayout(LayoutKind.Sequential)] public struct JobBasicLimitInformation {",
  "  public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;",
  "  public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;",
  "  public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;",
  "}",
  "[StructLayout(LayoutKind.Sequential)] public struct JobExtendedLimitInformation {",
  "  public JobBasicLimitInformation BasicLimitInformation; public IoCounters IoInfo;",
  "  public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;",
  "  public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;",
  "}",
  "[StructLayout(LayoutKind.Sequential)] public struct JobCpuRateControlInformation {",
  "  public uint ControlFlags; public uint CpuRate;",
  "}",
  "}",
  "'@",
  "try {",
  "  $limits = New-Object CCAgentSandbox.JobExtendedLimitInformation",
  "  $basicInfo = $limits.BasicLimitInformation",
  "  $flagBits = [uint32]8192 -bor [uint32]1024",
  "",
  "  $memoryMbRaw = $env:CCAGENT_JOB_MEMORY_MB",
  "  if ($null -ne $memoryMbRaw -and $memoryMbRaw -match '^\\d+$') {",
  "    $parsedMb = [uint64]$memoryMbRaw",
  "    if ($parsedMb -gt 0) {",
  "      $limits.JobMemoryLimit = [UIntPtr]($parsedMb * [uint64]1048576)",
  "      $flagBits = $flagBits -bor [uint32]512",
  "    }",
  "  }",
  "",
  "  $pidsRaw = $env:CCAGENT_JOB_PIDS",
  "  if ($null -ne $pidsRaw -and $pidsRaw -match '^\\d+$') {",
  "    $parsedPids = [uint32]$pidsRaw",
  "    if ($parsedPids -gt 0) {",
  "      $basicInfo.ActiveProcessLimit = $parsedPids",
  "      $flagBits = $flagBits -bor [uint32]8",
  "    }",
  "  }",
  "",
  "  $basicInfo.LimitFlags = $flagBits",
  "  $limits.BasicLimitInformation = $basicInfo",
  "  $limitsSize = [Runtime.InteropServices.Marshal]::SizeOf($limits)",
  "  $limitsPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($limitsSize)",
  "  [Runtime.InteropServices.Marshal]::StructureToPtr($limits, $limitsPtr, $false) | Out-Null",
  "  $job = [CCAgentSandbox.Native]::CreateJobObject([IntPtr]::Zero, $null)",
  "  if ($job -eq [IntPtr]::Zero) { throw 'ccagent: CreateJobObject failed' }",
  "  if (-not [CCAgentSandbox.Native]::SetInformationJobObject($job, 9, $limitsPtr, [uint32]$limitsSize)) { throw ('ccagent: SetInformationJobObject failed (limit flags): ' + (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error())).Message) }",
  "  [Runtime.InteropServices.Marshal]::FreeHGlobal($limitsPtr)",
  "",
  "  $cpusRaw = $env:CCAGENT_JOB_CPUS",
  "  if ($null -ne $cpusRaw -and $cpusRaw -match '^\\d+(\\.\\d+)?$') {",
  "    $parsedCpus = [double]$cpusRaw",
  "    if ($parsedCpus -gt 0) {",
  "      $cpuInfo = New-Object CCAgentSandbox.JobCpuRateControlInformation",
  "      $cpuInfo.ControlFlags = [uint32]1 -bor [uint32]4",
  "      $rate = [long][Math]::Floor($parsedCpus * 10000.0)",
  "      if ($rate -gt 10000) { $rate = 10000 }",
  "      $cpuInfo.CpuRate = [uint32]$rate",
  "      $cpuSize = [Runtime.InteropServices.Marshal]::SizeOf($cpuInfo)",
  "      $cpuPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($cpuSize)",
  "      [Runtime.InteropServices.Marshal]::StructureToPtr($cpuInfo, $cpuPtr, $false) | Out-Null",
  "      if (-not [CCAgentSandbox.Native]::SetInformationJobObject($job, 15, $cpuPtr, [uint32]$cpuSize)) { throw ('ccagent: SetInformationJobObject failed (cpu rate): ' + (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error())).Message) }",
  "      [Runtime.InteropServices.Marshal]::FreeHGlobal($cpuPtr)",
  "    }",
  "  }",
  "",
  "  $processInfo = New-Object System.Diagnostics.ProcessStartInfo",
  "  $processInfo.FileName = 'cmd.exe'",
  "  $processInfo.Arguments = '/d /s /c \"' + $env:CCAGENT_JOB_CMD + '\"'",
  "  $processInfo.WorkingDirectory = $env:CCAGENT_JOB_CWD",
  "  $processInfo.UseShellExecute = $false",
  "  $process = [System.Diagnostics.Process]::Start($processInfo)",
  "  if ($null -eq $process) { throw 'ccagent: failed to start command' }",
  "  if (-not [CCAgentSandbox.Native]::AssignProcessToJobObject($job, $process.Handle)) { throw 'ccagent: AssignProcessToJobObject failed' }",
  "  $process.WaitForExit()",
  "  exit $process.ExitCode",
  "} catch {",
  "  try { [Console]::Error.WriteLine('ccagent job sandbox: ' + $_.Exception.Message) } catch { }",
  "  exit 1",
  "}",
].join("\n");
