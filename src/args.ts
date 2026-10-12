import {
  formatProviderProfileError,
  isProviderProfileId,
  type ProviderProfileId,
} from "./providerProfiles.js";

type GlobalCliOptions = {
  allowEdits: boolean;
  json: boolean;
  plain: boolean;
  sandbox: boolean | string;
  stream: boolean;
  useSession: boolean;
  verbose: boolean;
  verifyCommand?: string;
};

export type CliArgs = (
  | {
      mode: "interactive";
    }
  | {
      mode: "prompt";
      prompt: string;
    }
  | {
      mode: "help";
    }
  | {
      mode: "version";
    }
  | {
      mode: "init";
    }
  | {
      mode: "initInstructions";
    }
  | {
      mode: "initCommand";
      name: string;
    }
  | {
      mode: "initSkill";
      name: string;
    }
  | {
      mode: "doctor";
    }
  | {
      mode: "provider";
      providerId: ProviderProfileId;
    }
  | {
      mode: "providerError";
      message: string;
    }
  | {
      mode: "login";
      apiKey?: string;
    }
  | {
      mode: "logout";
    }
  | {
      mode: "configSet";
      key: string;
      value: string;
    }
  | {
      mode: "configGet";
      key: string;
    }
  | {
      mode: "configUnset";
      key: string;
    }
  | {
      mode: "userConfigSet";
      key: string;
      value: string;
    }
  | {
      mode: "userConfigGet";
      key: string;
    }
  | {
      mode: "userConfigUnset";
      key: string;
    }
  | {
      mode: "mcpAdd";
      args: string[];
      command: string;
      name: string;
    }
  | {
      mode: "mcpRemove";
      name: string;
    }
  | {
      mode: "mcpEnable";
    }
  | {
      mode: "mcpDisable";
    }
) &
  GlobalCliOptions;

export const CLI_VERSION = "0.3.0";

export function parseCliArgs(args: string[]): CliArgs {
  const { remainingArgs, options } = parseLeadingGlobalOptions(args);

  if (remainingArgs.length === 1 && (remainingArgs[0] === "--help" || remainingArgs[0] === "-h")) {
    return { mode: "help", ...options };
  }

  if (
    remainingArgs.length === 1 &&
    (remainingArgs[0] === "--version" || remainingArgs[0] === "-v")
  ) {
    return { mode: "version", ...options };
  }

  if (remainingArgs.length === 1 && remainingArgs[0] === "--init") {
    return { mode: "init", ...options };
  }

  if (remainingArgs.length === 1 && remainingArgs[0] === "--init-instructions") {
    return { mode: "initInstructions", ...options };
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--init-command") {
    const name = remainingArgs[1]?.trim() ?? "";

    if (name) {
      return { mode: "initCommand", name, ...options };
    }
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--init-skill") {
    const name = remainingArgs[1]?.trim() ?? "";

    if (name) {
      return { mode: "initSkill", name, ...options };
    }
  }

  if (remainingArgs.length === 1 && remainingArgs[0] === "--doctor") {
    return { mode: "doctor", ...options };
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--provider") {
    const id = (remainingArgs[1] ?? "").trim().toLowerCase();

    if (isProviderProfileId(id)) {
      return { mode: "provider", providerId: id, ...options };
    }

    return {
      mode: "providerError",
      message: formatProviderProfileError(id),
      ...options,
    };
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "login") {
    const apiKeyFlagIndex = remainingArgs.indexOf("--api-key");

    if (apiKeyFlagIndex > 0) {
      const apiKey = remainingArgs[apiKeyFlagIndex + 1]?.trim() ?? "";

      if (apiKey) {
        return { mode: "login", apiKey, ...options };
      }
    }

    return { mode: "login", ...options };
  }

  if (remainingArgs.length === 1 && remainingArgs[0] === "logout") {
    return { mode: "logout", ...options };
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--config-set") {
    const key = remainingArgs[1]?.trim() ?? "";
    const value = remainingArgs.slice(2).join(" ").trim();

    if (key && value) {
      return {
        mode: "configSet",
        key,
        value,
        ...options,
      };
    }
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--config-get") {
    const key = remainingArgs[1]?.trim() ?? "";

    if (key) {
      return {
        mode: "configGet",
        key,
        ...options,
      };
    }
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--config-unset") {
    const key = remainingArgs[1]?.trim() ?? "";

    if (key) {
      return {
        mode: "configUnset",
        key,
        ...options,
      };
    }
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--user-config-set") {
    const key = remainingArgs[1]?.trim() ?? "";
    const value = remainingArgs.slice(2).join(" ").trim();

    if (key && value) {
      return {
        mode: "userConfigSet",
        key,
        value,
        ...options,
      };
    }
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--user-config-get") {
    const key = remainingArgs[1]?.trim() ?? "";

    if (key) {
      return {
        mode: "userConfigGet",
        key,
        ...options,
      };
    }
  }

  if (remainingArgs.length >= 1 && remainingArgs[0] === "--user-config-unset") {
    const key = remainingArgs[1]?.trim() ?? "";

    if (key) {
      return {
        mode: "userConfigUnset",
        key,
        ...options,
      };
    }
  }

  if (remainingArgs[0] === "--mcp-add") {
    const name = remainingArgs[1]?.trim() ?? "";
    const command = remainingArgs[2]?.trim() ?? "";
    const serverArgs = remainingArgs.slice(3);

    return {
      mode: "mcpAdd",
      args: serverArgs[0] === "--" ? serverArgs.slice(1) : serverArgs,
      command,
      name,
      ...options,
    };
  }

  if (remainingArgs[0] === "--mcp-remove") {
    return {
      mode: "mcpRemove",
      name: remainingArgs[1]?.trim() ?? "",
      ...options,
    };
  }

  if (remainingArgs.length === 1 && remainingArgs[0] === "--mcp-enable") {
    return { mode: "mcpEnable", ...options };
  }

  if (remainingArgs.length === 1 && remainingArgs[0] === "--mcp-disable") {
    return { mode: "mcpDisable", ...options };
  }

  const prompt = remainingArgs.join(" ").trim();

  if (prompt.length > 0) {
    return {
      mode: "prompt",
      prompt,
      ...options,
    };
  }

  return { mode: "interactive", ...options };
}

export function formatCliUsage(): string {
  return [
    "Usage:",
    "  ccagent                  Start interactive mode.",
    "  ccagent <prompt>         Run one prompt, print the result, then exit.",
    "  ccagent --init           Create .ccagent/config.json if missing.",
    "  ccagent --init-instructions",
    "                            Create CCAGENT.md if missing.",
    "  ccagent --init-command <name>",
    "                            Create .ccagent/commands/<name>.md if missing.",
    "  ccagent --init-skill <name>",
    "                            Create .ccagent/skills/<name>/SKILL.md if missing.",
    "  ccagent --doctor         Check local setup and dependencies.",
    "  ccagent login [--api-key <key>]",
    "                            Store an OpenAI API key in <user>/.ccagent/auth.json (like codex login).",
    "                            Without --api-key it reads a piped key or prints the status.",
    "  ccagent logout           Remove the stored API key from <user>/.ccagent/auth.json.",
    "  ccagent --config-set <key> <value>",
    "                            Persist model/openai config in .ccagent/config.json.",
    "  ccagent --config-get <key>",
    "                            Print one persisted config value.",
    "  ccagent --config-unset <key>",
    "                            Remove one persisted config value.",
    "  ccagent --user-config-set <key> <value>",
    "                            Persist user-level defaults in <user>/.ccagent/config.json.",
    "  ccagent --user-config-get <key>",
    "                            Print one user-level config value.",
    "  ccagent --user-config-unset <key>",
    "                            Remove one user-level config value.",
    "  ccagent --mcp-add <name> <command> -- [args...]",
    "                            Add a local MCP stdio server and enable MCP.",
    "  ccagent --mcp-remove <name>",
    "                            Remove one configured MCP server.",
    "  ccagent --mcp-enable | --mcp-disable",
    "                            Enable or disable configured MCP servers.",
    "  ccagent --provider <id>   Apply a provider profile (deepseek, qwen, siliconflow, volcengine, openrouter, ...).",
    "  ccagent --no-session     Run without loading or saving session history.",
    "  ccagent --allow-edits    Auto-approve apply_patch, reverse_patch, and edit for this run.",
    "  ccagent --sandbox        Run shell commands inside a Docker container for this run.",
    "  ccagent --sandbox=mode   Sandbox mode: docker, podman, job (Windows), timeout (POSIX), or off.",
    "  ccagent --verify <cmd>   Run a verification command after a successful patch.",
    "  ccagent --stream         Stream model text deltas to the terminal when supported.",
    "  ccagent --json           Emit JSON Lines events and final response.",
    "  ccagent --plain          Use plain terminal output instead of the rich TTY interface.",
    "  ccagent --verbose        Print debug events for model, tool, and session flow.",
    "  ccagent --help           Show CLI usage and commands.",
    "  ccagent --version        Show version.",
    "",
    "Examples:",
    "  ccagent",
    "  ccagent list files",
    "  ccagent --init-instructions",
    "  ccagent --init-command review",
    "  ccagent --init-skill code-review",
    "  ccagent --no-session list files",
    "  ccagent --allow-edits patch demo.txt hello",
    "  ccagent --sandbox \"ls -la\"",
    "  ccagent --sandbox=job \"dir\"",
    "  ccagent --allow-edits --verify \"npm test\" \"replace demo.txt hello => hi\"",
    "  ccagent --config-set openai.apiMode chat",
    "  ccagent --config-set openai.baseURL https://api.wcgio.com/v1",
    "  ccagent --config-set openai.retry.maxAttempts 4",
    "  ccagent --config-set toolPolicy.allowWritePaths src/,tests/",
    "  ccagent --config-set toolPolicy.deny run_shell",
    "  ccagent --config-set toolPolicy.shellSandbox docker",
    "  ccagent --config-set toolPolicy.shellSandboxImage alpine:3.20",
    "  ccagent --config-set toolPolicy.shellSandboxNetwork none",
    "  ccagent --provider deepseek",
    "  ccagent --config-set toolPolicy.denyWritePaths .ccagent/,package-lock.json",
    "  ccagent --config-set toolPolicy.denyRisk high",
    "  ccagent --config-set toolPolicy.requireApproval read_file,list_files",
    "  ccagent --config-set toolPolicy.requireApprovalRisk medium,high",
    "  ccagent --config-get openai.baseURL",
    "  ccagent --config-unset openai.baseURL",
    "  ccagent login --api-key <key>",
    "  ccagent logout",
    "  ccagent --user-config-set openai.baseURL https://api.wcgio.com/v1",
    "  ccagent --user-config-get model",
    "  ccagent --mcp-add filesystem npx -- -y @modelcontextprotocol/server-filesystem .",
    "  ccagent --mcp-disable",
    "  ccagent --json --no-session list files",
    "  ccagent --verbose read package.json",
    "  ccagent read package.json",
    "  ccagent search ModelClient",
    "  ccagent --plain",
  ].join("\n");
}

function parseLeadingGlobalOptions(args: string[]): {
  remainingArgs: string[];
  options: GlobalCliOptions;
} {
  const options: GlobalCliOptions = {
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  };
  let index = 0;

  while (index < args.length) {
    const arg = args[index];

    if (arg === "--no-session") {
      options.useSession = false;
      index += 1;
      continue;
    }

    if (arg === "--allow-edits") {
      options.allowEdits = true;
      index += 1;
      continue;
    }

    if (arg.startsWith("--sandbox=")) {
      options.sandbox = arg.slice("--sandbox=".length);
      index += 1;
      continue;
    }

    if (arg === "--sandbox") {
      options.sandbox = true;
      index += 1;
      continue;
    }

    if (arg === "--stream") {
      options.stream = true;
      index += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      index += 1;
      continue;
    }

    if (arg === "--plain") {
      options.plain = true;
      index += 1;
      continue;
    }

    if (arg === "--verify" && index + 1 < args.length) {
      const verifyCommand = args[index + 1]?.trim();

      if (verifyCommand) {
        options.verifyCommand = verifyCommand;
      }

      index += 2;
      continue;
    }

    if (arg === "--verbose" || arg === "--debug") {
      options.verbose = true;
      index += 1;
      continue;
    }

    break;
  }

  return {
    remainingArgs: args.slice(index),
    options,
  };
}
