import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ApiKeyStatus } from "./auth.js";
import type { LoadedConfig } from "./config.js";
import type { LoadedUserConfig } from "./config.js";
import {
  formatDoctorReport,
  formatOpenAISmokeCommand,
  resolveOpenAIApiMode,
  resolveOpenAIBaseURL,
  resolveOpenAIModel,
  runDoctor,
  type DoctorReport,
} from "./doctor.js";
import type { LoadedProjectInstructions } from "./instructions.js";
import { formatProviderRetryConfig } from "./model.js";

const execFileAsync = promisify(execFile);

export type DiagnosticsRuntimeSummary = {
  activeClient: string;
  apiKeyStatus: ApiKeyStatus;
  loadedConfig: LoadedConfig;
  projectInstructions: LoadedProjectInstructions;
  stream: boolean;
  userConfig: LoadedUserConfig;
  useSession: boolean;
  verifyCommand?: string;
};

export type DiagnosticsReportResult = {
  absolutePath: string;
  content: string;
  doctorFailures: number;
  doctorWarnings: number;
  path: string;
};

export async function exportDiagnosticsReport(
  workspaceRoot: string,
  runtime: DiagnosticsRuntimeSummary,
): Promise<DiagnosticsReportResult> {
  const exportedAt = new Date().toISOString();
  const reportsDir = join(workspaceRoot, ".ccagent", "reports");
  const fileName = `diagnostics-${formatExportTimestamp(exportedAt)}.md`;
  const absolutePath = join(reportsDir, fileName);
  const relativePath = join(".ccagent", "reports", fileName).replaceAll("\\", "/");
  const doctor = await runDoctor(workspaceRoot);
  const npmVersion = await readCommandVersion("npm", ["--version"]);
  const content = buildDiagnosticsMarkdown({
    doctor,
    exportedAt,
    npmVersion,
    runtime,
    workspaceRoot,
  });
  const doctorFailures = countDoctorStatus(doctor, "fail");
  const doctorWarnings = countDoctorStatus(doctor, "warn");

  await mkdir(reportsDir, { recursive: true });
  await writeFile(absolutePath, content, "utf8");

  return {
    absolutePath,
    content,
    doctorFailures,
    doctorWarnings,
    path: relativePath,
  };
}

export function formatDiagnosticsReportResult(result: DiagnosticsReportResult): string {
  return [
    "Exported diagnostics report",
    `Path: ${result.path}`,
    `Doctor: ${result.doctorFailures} failure(s), ${result.doctorWarnings} warning(s)`,
    "Secrets: OPENAI_API_KEY value was not written.",
  ].join("\n");
}

function buildDiagnosticsMarkdown(input: {
  doctor: DoctorReport;
  exportedAt: string;
  npmVersion: string;
  runtime: DiagnosticsRuntimeSummary;
  workspaceRoot: string;
}): string {
  const resolvedModel = resolveOpenAIModel(
    input.runtime.loadedConfig.config.model,
    input.runtime.userConfig.config.model,
  );
  const resolvedApiMode = resolveOpenAIApiMode(
    input.runtime.loadedConfig.config.openai?.apiMode,
    input.runtime.userConfig.config.openai?.apiMode,
  );
  const resolvedBaseURL = resolveOpenAIBaseURL(
    input.runtime.loadedConfig.config.openai?.baseURL,
    input.runtime.userConfig.config.openai?.baseURL,
  );
  const apiKeyStatus = input.runtime.apiKeyStatus;
  const embeddingModel = process.env.CCAGENT_EMBEDDING_MODEL?.trim() ||
    input.runtime.loadedConfig.config.openai?.embeddingModel?.trim() ||
    input.runtime.userConfig.config.openai?.embeddingModel?.trim();
  const lines = [
    "# CCAgent Diagnostics Report",
    "",
    `Generated at: ${input.exportedAt}`,
    `Workspace: ${input.workspaceRoot}`,
    "",
    "## Privacy",
    "",
    "- API key values are not included; only set/not set is recorded.",
    "- Prompt text, session messages, tool outputs, and audit log contents are not included.",
    "- Review relay base URLs before sharing this report outside your team.",
    "",
    "## Runtime",
    "",
    `- Active client: ${input.runtime.activeClient}`,
    `- Node: ${process.version}`,
    `- npm: ${input.npmVersion}`,
    `- Platform: ${process.platform} ${process.arch}`,
    `- Streaming: ${input.runtime.stream ? "on" : "off"}`,
    `- Session: ${input.runtime.useSession ? "on" : "off"}`,
    `- Verify command: ${input.runtime.verifyCommand ?? "(none)"}`,
    "",
    "## Model And Provider",
    "",
    `- Configured model: ${resolvedModel.model} (source: ${resolvedModel.source})`,
    `- OpenAI API mode: ${resolvedApiMode.apiMode} (source: ${resolvedApiMode.source})`,
    `- OpenAI base URL: ${resolvedBaseURL.baseURL} (source: ${resolvedBaseURL.source})`,
    `- OpenAI embedding model: ${embeddingModel || "(local semantic index)"}`,
    `- OpenAI provider retry: ${formatProviderRetryConfig(input.runtime.loadedConfig.config.openai?.retry)}`,
    `- OPENAI_API_KEY: ${apiKeyStatus.source === "env" ? "set" : "not set"}`,
    apiKeyStatus.set
      ? `- API key: set (source: ${apiKeyStatus.source})`
      : "- API key: not set",
    `- OPENAI_BASE_URL env: ${formatEnvPresence("OPENAI_BASE_URL")}`,
    `- CCAGENT_MODEL env: ${formatEnvPresence("CCAGENT_MODEL")}`,
    `- CCAGENT_API_MODE env: ${formatEnvPresence("CCAGENT_API_MODE")}`,
    "",
    "## Config Files",
    "",
    `- Config path: ${input.runtime.loadedConfig.path}`,
    `- Config loaded: ${input.runtime.loadedConfig.exists ? "yes" : "no"}`,
    `- User config path: ${input.runtime.userConfig.path}`,
    `- User config loaded: ${input.runtime.userConfig.exists ? "yes" : "no"}`,
    `- Auth file: ${apiKeyStatus.authPath} (${apiKeyStatus.source === "auth-file" ? "present" : "absent"})`,
    `- Project instructions path: ${input.runtime.projectInstructions.path}`,
    `- Project instructions loaded: ${input.runtime.projectInstructions.exists ? "yes" : "no"}`,
    `- Project instructions chars: ${input.runtime.projectInstructions.content.length}`,
    "",
    "## Doctor Summary",
    "",
    `- Failures: ${countDoctorStatus(input.doctor, "fail")}`,
    `- Warnings: ${countDoctorStatus(input.doctor, "warn")}`,
    `- OK: ${countDoctorStatus(input.doctor, "ok")}`,
    "",
    "```text",
    formatDoctorReport(input.doctor),
    "```",
    "",
    "## Suggested Commands",
    "",
    "```powershell",
    "ccagent --doctor",
    "ccagent --no-session /provider-smoke",
    formatOpenAISmokeCommand(),
    "```",
    "",
  ];

  if (input.runtime.loadedConfig.warnings.length > 0) {
    lines.push(
      "## Config Warnings",
      "",
      ...input.runtime.loadedConfig.warnings.map((warning) => `- ${warning}`),
      "",
    );
  }

  return `${lines.join("\n")}`;
}

function countDoctorStatus(report: DoctorReport, status: "fail" | "ok" | "warn"): number {
  return report.checks.filter((check) => check.status === status).length;
}

async function readCommandVersion(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execCommandVersion(command, args);

    return stdout.split(/\r?\n/).find(Boolean) ?? `${command} found`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `unavailable (${reason})`;
  }
}

async function execCommandVersion(command: string, args: string[]): Promise<{ stdout: string }> {
  if (process.platform === "win32" && command === "npm" && args.join(" ") === "--version") {
    return execFileAsync("cmd.exe", ["/d", "/s", "/c", "npm --version"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
  }

  return execFileAsync(command, args, {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
}

function formatEnvPresence(name: string): string {
  return process.env[name]?.trim() ? "set" : "not set";
}

function formatExportTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}
