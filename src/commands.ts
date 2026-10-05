import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const COMMAND_PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;
const PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export type ProjectCommandArgumentPolicy = "optional" | "required";

export type ProjectCommand = {
  name: string;
  path: string;
  aliases?: string[];
  args?: ProjectCommandArgumentPolicy;
  content: string;
  confirm?: boolean;
  description?: string;
  params?: string[];
  paramDescriptions?: Record<string, string>;
  summary: string;
  tags?: string[];
  usage?: string;
};

export type LoadedProjectCommands = {
  path: string;
  commands: ProjectCommand[];
  warnings: string[];
};

export type InitProjectCommandResult =
  | {
      created: true;
      name: string;
      path: string;
    }
  | {
      created: false;
      name: string;
      path: string;
      reason: string;
    };

export type ReadProjectCommandResult =
  | {
      ok: true;
      command: ProjectCommand;
    }
  | {
      ok: false;
      error: string;
      loaded: LoadedProjectCommands;
    };

export async function initProjectCommand(
  workspaceRoot: string,
  name: string,
): Promise<InitProjectCommandResult> {
  const normalizedName = name.trim();
  const commandsDir = getProjectCommandsDir(workspaceRoot);

  if (!isValidProjectCommandName(normalizedName)) {
    return {
      created: false,
      name: normalizedName,
      path: commandsDir,
      reason: "Expected command name to contain only letters, numbers, dashes, or underscores.",
    };
  }

  const path = join(commandsDir, `${normalizedName}.md`);

  try {
    await stat(path);

    return {
      created: false,
      name: normalizedName,
      path,
      reason: "Project command already exists.",
    };
  } catch (error) {
    if (!isFileNotFound(error)) {
      const reason = error instanceof Error ? error.message : String(error);

      return {
        created: false,
        name: normalizedName,
        path,
        reason: `Could not check project command: ${reason}`,
      };
    }
  }

  await mkdir(commandsDir, { recursive: true });
  await writeFile(path, buildProjectCommandTemplate(normalizedName), "utf8");

  return {
    created: true,
    name: normalizedName,
    path,
  };
}

export async function loadProjectCommands(workspaceRoot: string): Promise<LoadedProjectCommands> {
  const commandsDir = getProjectCommandsDir(workspaceRoot);
  let entries: string[];

  try {
    entries = await readdir(commandsDir);
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        path: commandsDir,
        commands: [],
        warnings: [],
      };
    }

    const reason = error instanceof Error ? error.message : String(error);

    return {
      path: commandsDir,
      commands: [],
      warnings: [`Failed to read project commands: ${reason}`],
    };
  }

  const commands: ProjectCommand[] = [];
  const warnings: string[] = [];

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) {
      continue;
    }

    const name = entry.slice(0, -".md".length);

    if (!isValidProjectCommandName(name)) {
      warnings.push(`Ignoring invalid command file name: ${entry}`);
      continue;
    }

    const path = join(commandsDir, entry);

    try {
      const rawContent = await readFile(path, "utf8");
      const parsed = parseProjectCommandFile(rawContent, entry);
      warnings.push(...parsed.warnings);
      commands.push({
        name,
        path,
        aliases: parsed.aliases,
        args: parsed.args,
        content: parsed.content,
        confirm: parsed.confirm,
        description: parsed.description,
        params: parsed.params,
        paramDescriptions: parsed.paramDescriptions,
        summary: parsed.description ?? summarizeProjectCommand(parsed.content),
        tags: parsed.tags,
        usage: parsed.usage,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to read ${entry}: ${reason}`);
    }
  }

  normalizeProjectCommandAliases(commands, warnings);

  return {
    path: commandsDir,
    commands,
    warnings,
  };
}

export async function readProjectCommand(
  workspaceRoot: string,
  name: string,
): Promise<ReadProjectCommandResult> {
  const normalizedName = name.trim();
  const loaded = await loadProjectCommands(workspaceRoot);

  if (!isValidProjectCommandName(normalizedName)) {
    return {
      ok: false,
      error: "Expected command name to contain only letters, numbers, dashes, or underscores.",
      loaded,
    };
  }

  const command =
    loaded.commands.find((item) => item.name === normalizedName) ??
    loaded.commands.find((item) => item.aliases?.includes(normalizedName));

  if (!command) {
    return {
      ok: false,
      error: `Project command not found: ${normalizedName}`,
      loaded,
    };
  }

  return {
    ok: true,
    command,
  };
}

export type FormatProjectCommandsOptions = {
  tag?: string;
};

export function formatProjectCommands(
  loaded: LoadedProjectCommands,
  options: FormatProjectCommandsOptions = {},
): string {
  const tag = options.tag?.trim();
  const commands = tag
    ? loaded.commands.filter((command) => command.tags?.includes(tag))
    : loaded.commands;
  const lines = [
    "Project commands",
    `Path: ${loaded.path}`,
    ...(tag ? [`Tag: ${tag}`] : []),
    `Count: ${tag ? `${commands.length} of ${loaded.commands.length}` : loaded.commands.length}`,
    "",
  ];

  if (commands.length === 0) {
    lines.push(
      tag
        ? `No project commands found for tag: ${tag}`
        : "No project commands found. Run ccagent --init-command review to add a reusable workflow.",
    );
  } else {
    for (const command of commands) {
      lines.push(`- ${command.name}: ${command.summary}`);

      if (command.aliases && command.aliases.length > 0) {
        lines.push(`  aliases: ${command.aliases.join(", ")}`);
      }

      if (command.tags && command.tags.length > 0) {
        lines.push(`  tags: ${command.tags.join(", ")}`);
      }

      if (command.params && command.params.length > 0) {
        lines.push(`  params: ${command.params.join(", ")}`);
      }

      const paramDescriptionLines = formatParamDescriptionLines(command, "    ");

      if (paramDescriptionLines.length > 0) {
        lines.push("  param descriptions:");
        lines.push(...paramDescriptionLines);
      }

      if (command.usage) {
        lines.push(`  usage: ${command.usage}`);
      }

      if (command.args === "required") {
        lines.push("  args: required");
      }

      if (command.confirm) {
        lines.push("  confirm: required");
      }
    }
  }

  if (loaded.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    lines.push(...loaded.warnings.map((warning) => `- ${warning}`));
  }

  lines.push("");
  lines.push("Usage:");
  lines.push("  /command <name>");
  lines.push("  /cmd <name> [args]");
  lines.push("  /cmd-preview <name> [args]");

  return lines.join("\n");
}

export function formatProjectCommandError(result: Extract<ReadProjectCommandResult, { ok: false }>): string {
  return [result.error, "", formatProjectCommands(result.loaded)].join("\n");
}

export function formatProjectCommandDetails(command: ProjectCommand): string {
  return [
    "Project command",
    `Name: ${command.name}`,
    `Path: ${command.path}`,
    `Aliases: ${command.aliases?.length ? command.aliases.join(", ") : "(none)"}`,
    `Tags: ${command.tags?.length ? command.tags.join(", ") : "(none)"}`,
    `Params: ${command.params?.length ? command.params.join(", ") : "(none)"}`,
    ...formatParamDescriptionBlock(command),
    `Description: ${command.description ?? command.summary}`,
    `Usage: ${command.usage ?? `/cmd ${command.name} [args]`}`,
    `Argument policy: ${command.args ?? "optional"}`,
    `Confirmation: ${command.confirm ? "required" : "not required"}`,
    "",
    "Template:",
    "",
    command.content.trim() || "(empty)",
  ].join("\n");
}

export type ProjectCommandCheck = {
  commandName?: string;
  level: "fail" | "warn";
  message: string;
};

export function formatProjectCommandsCheck(loaded: LoadedProjectCommands): string {
  const checks = collectProjectCommandChecks(loaded);
  const failures = checks.filter((check) => check.level === "fail").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  const lines = [
    "Project command check",
    `Path: ${loaded.path}`,
    `Count: ${loaded.commands.length}`,
    "",
  ];

  if (checks.length === 0) {
    lines.push("No issues found.");
  } else {
    for (const check of checks) {
      const scope = check.commandName ? `${check.commandName}: ` : "";
      lines.push(`[${check.level.toUpperCase()}] ${scope}${check.message}`);
    }
  }

  lines.push("");
  lines.push(`Summary: ${failures} failure(s), ${warnings} warning(s).`);

  return lines.join("\n");
}

export function collectProjectCommandChecks(loaded: LoadedProjectCommands): ProjectCommandCheck[] {
  const checks: ProjectCommandCheck[] = loaded.warnings.map((warning) => ({
    level: "warn",
    message: warning,
  }));

  for (const command of loaded.commands) {
    if (command.content.trim().length === 0) {
      checks.push({
        commandName: command.name,
        level: "fail",
        message: "Template is empty.",
      });
    }

    if (command.args === "required" && !command.usage) {
      checks.push({
        commandName: command.name,
        level: "warn",
        message: "args is required but usage is missing.",
      });
    }

    const namedPlaceholders = collectNamedProjectCommandPlaceholders(command.content);
    const declaredParams = command.params ?? [];
    const describedParams = Object.keys(command.paramDescriptions ?? {});
    const missingDeclaredParams = namedPlaceholders.filter(
      (placeholder) => !declaredParams.includes(placeholder),
    );
    const unusedDeclaredParams = declaredParams.filter(
      (param) => !namedPlaceholders.includes(param),
    );
    const paramsToDocument = uniqueStrings([...namedPlaceholders, ...declaredParams]);
    const unknownDescribedParams = describedParams.filter(
      (param) => !paramsToDocument.includes(param),
    );

    if (missingDeclaredParams.length > 0) {
      checks.push({
        commandName: command.name,
        level: "warn",
        message: `params metadata is missing template placeholder(s): ${missingDeclaredParams.join(", ")}.`,
      });
    }

    if (unusedDeclaredParams.length > 0) {
      checks.push({
        commandName: command.name,
        level: "warn",
        message: `params declares unused parameter(s): ${unusedDeclaredParams.join(", ")}.`,
      });
    }

    if (unknownDescribedParams.length > 0) {
      checks.push({
        commandName: command.name,
        level: "warn",
        message: `param descriptions reference unknown parameter(s): ${unknownDescribedParams.join(", ")}.`,
      });
    }

    if (paramsToDocument.length > 0 && !command.usage) {
      checks.push({
        commandName: command.name,
        level: "warn",
        message: "named params are used but usage is missing.",
      });
    }

    if (command.usage) {
      const missingUsageParams = paramsToDocument.filter(
        (param) => !usageContainsNamedParam(command.usage ?? "", param),
      );

      if (missingUsageParams.length > 0) {
        checks.push({
          commandName: command.name,
          level: "warn",
          message: `usage is missing named parameter(s): ${missingUsageParams
            .map((param) => `--${param}`)
            .join(", ")}.`,
        });
      }
    }
  }

  return checks;
}

export type ProjectCommandArgsValidationResult =
  | {
      ok: true;
      parsedArgs: ParsedProjectCommandArgs;
    }
  | {
      ok: false;
      error: string;
      parsedArgs?: ParsedProjectCommandArgs;
    };

export type ParsedProjectCommandArgs = {
  named: Record<string, string>;
  positional: string;
  positionalTokens: string[];
  raw: string;
};

export type ProjectCommandArgsParseResult =
  | {
      ok: true;
      parsedArgs: ParsedProjectCommandArgs;
    }
  | {
      ok: false;
      error: string;
      parsedArgs?: ParsedProjectCommandArgs;
    };

export function validateProjectCommandArgs(
  command: ProjectCommand,
  args: string,
): ProjectCommandArgsValidationResult {
  const parsed = parseProjectCommandArgs(args);

  if (!parsed.ok) {
    return {
      ok: false,
      error: [
        `Project command arguments are invalid: ${command.name}`,
        parsed.error,
        command.usage ? `Usage: ${command.usage}` : `Usage: /cmd ${command.name} [args]`,
      ].join("\n"),
    };
  }

  if (command.args === "required" && args.trim().length === 0) {
    return {
      ok: false,
      error: [
        `Project command requires arguments: ${command.name}`,
        command.usage ? `Usage: ${command.usage}` : `Usage: /cmd ${command.name} <args>`,
        "Preview with /cmd-preview before running if you are unsure.",
      ].join("\n"),
      parsedArgs: parsed.parsedArgs,
    };
  }

  const missingPlaceholders = getMissingNamedPlaceholders(command, parsed.parsedArgs);

  if (missingPlaceholders.length > 0) {
    return {
      ok: false,
      error: [
        `Project command is missing required named argument(s): ${missingPlaceholders.join(", ")}`,
        `Pass them as ${missingPlaceholders.map((name) => `--${name} <value>`).join(" ")}`,
        command.usage ? `Usage: ${command.usage}` : `Usage: /cmd ${command.name} [args]`,
      ].join("\n"),
      parsedArgs: parsed.parsedArgs,
    };
  }

  return {
    ok: true,
    parsedArgs: parsed.parsedArgs,
  };
}

export function parseProjectCommandArgs(args: string): ProjectCommandArgsParseResult {
  const tokens = tokenizeProjectCommandArgs(args);

  if (!tokens.ok) {
    return tokens;
  }

  const named: Record<string, string> = {};
  const positionalTokens: string[] = [];

  for (let index = 0; index < tokens.tokens.length; index += 1) {
    const token = tokens.tokens[index] ?? "";

    if (token === "--") {
      positionalTokens.push(...tokens.tokens.slice(index + 1));
      break;
    }

    const parsedNamedArg = parseNamedArgToken(token);

    if (!parsedNamedArg) {
      positionalTokens.push(token);
      continue;
    }

    if (parsedNamedArg.value !== undefined) {
      named[parsedNamedArg.name] = parsedNamedArg.value;
      continue;
    }

    const nextToken = tokens.tokens[index + 1];

    if (nextToken !== undefined && !nextToken.startsWith("--")) {
      named[parsedNamedArg.name] = nextToken;
      index += 1;
      continue;
    }

    positionalTokens.push(token);
  }

  return {
    ok: true,
    parsedArgs: {
      named,
      positional: positionalTokens.join(" "),
      positionalTokens,
      raw: args.trim(),
    },
  };
}

export function expandProjectCommand(
  command: ProjectCommand,
  args: string,
  parsedArgs?: ParsedProjectCommandArgs,
): string {
  const resolvedArgs = parsedArgs ?? parseProjectCommandArgsForDisplay(args);
  const content = command.content.trim();
  const trimmedArgs = args.trim();
  const placeholders = collectProjectCommandPlaceholders(content);
  const usesNamedPlaceholders = placeholders.some((placeholder) => placeholder !== "args");
  const argsValue = usesNamedPlaceholders ? (resolvedArgs?.positional ?? "") : trimmedArgs;

  if (placeholders.length > 0) {
    return content.replace(COMMAND_PLACEHOLDER_PATTERN, (match, name: string) => {
      if (name === "args") {
        return argsValue;
      }

      return resolvedArgs?.named[name] ?? match;
    });
  }

  if (!trimmedArgs) {
    return content;
  }

  return [content, "", "Arguments:", trimmedArgs].join("\n");
}

export function formatExpandedProjectCommand(
  command: ProjectCommand,
  args: string,
  parsedArgs?: ParsedProjectCommandArgs,
): string {
  const resolvedArgs = parsedArgs ?? parseProjectCommandArgsForDisplay(args);
  const trimmedArgs = args.trim();
  const expandedPrompt = expandProjectCommand(command, args, resolvedArgs);
  const namedArgLines = resolvedArgs ? formatNamedArgs(resolvedArgs.named) : [];

  return [
    "Project command preview",
    `Name: ${command.name}`,
    `Path: ${command.path}`,
    `Aliases: ${command.aliases?.length ? command.aliases.join(", ") : "(none)"}`,
    `Tags: ${command.tags?.length ? command.tags.join(", ") : "(none)"}`,
    `Description: ${command.description ?? command.summary}`,
    `Usage: ${command.usage ?? `/cmd ${command.name} [args]`}`,
    `Argument policy: ${command.args ?? "optional"}`,
    `Confirmation: ${command.confirm ? "required" : "not required"}`,
    `Declared params: ${command.params?.length ? command.params.join(", ") : "(none)"}`,
    ...formatParamDescriptionBlock(command),
    `Args: ${trimmedArgs || "(none)"}`,
    ...(namedArgLines.length > 0 ? ["Named args:", ...namedArgLines] : []),
    ...(resolvedArgs && resolvedArgs.positional !== trimmedArgs
      ? [`Positional args: ${resolvedArgs.positional || "(none)"}`]
      : []),
    "",
    "Expanded prompt:",
    "",
    expandedPrompt || "(empty)",
  ].join("\n");
}

export function isValidProjectCommandName(name: string): boolean {
  return COMMAND_NAME_PATTERN.test(name);
}

function getProjectCommandsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".ccagent", "commands");
}

function buildProjectCommandTemplate(name: string): string {
  const title = titleCaseCommandName(name);

  return [
    "---",
    `description: ${title} workflow.`,
    `usage: /cmd ${name} [args]`,
    "args: optional",
    "confirm: false",
    "---",
    "",
    `# ${title} {{args}}`,
    "",
    "Use this reusable project workflow:",
    "",
    "- Inspect relevant files before deciding what to change.",
    "- Keep changes focused on the requested task.",
    "- Run the relevant verification command when practical.",
    "",
  ].join("\n");
}

function titleCaseCommandName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function collectProjectCommandPlaceholders(content: string): string[] {
  return [...content.matchAll(COMMAND_PLACEHOLDER_PATTERN)].map((match) => match[1] ?? "");
}

function collectNamedProjectCommandPlaceholders(content: string): string[] {
  return uniqueStrings(
    collectProjectCommandPlaceholders(content).filter((placeholder) => placeholder !== "args"),
  );
}

function getMissingNamedPlaceholders(
  command: ProjectCommand,
  parsedArgs: ParsedProjectCommandArgs,
): string[] {
  return collectNamedProjectCommandPlaceholders(command.content).filter((placeholder) => {
    const value = parsedArgs.named[placeholder];

    return value === undefined || value.trim().length === 0;
  });
}

function parseProjectCommandArgsForDisplay(args: string): ParsedProjectCommandArgs | undefined {
  const parsed = parseProjectCommandArgs(args);

  return parsed.ok ? parsed.parsedArgs : undefined;
}

function formatNamedArgs(named: Record<string, string>): string[] {
  return Object.entries(named)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `  ${name}: ${value}`);
}

function formatParamDescriptionBlock(command: ProjectCommand): string[] {
  const descriptionLines = formatParamDescriptionLines(command, "  ");

  return descriptionLines.length > 0 ? ["Param descriptions:", ...descriptionLines] : [];
}

function formatParamDescriptionLines(command: ProjectCommand, indent: string): string[] {
  const descriptions = command.paramDescriptions ?? {};
  const names = uniqueStrings([...(command.params ?? []), ...Object.keys(descriptions).sort()]);

  return names
    .map((name): [string, string] | null => {
      const description = descriptions[name]?.trim();

      return description ? [name, description] : null;
    })
    .filter((entry): entry is [string, string] => entry !== null)
    .map(([name, description]) => `${indent}${name}: ${description}`);
}

type TokenizeProjectCommandArgsResult =
  | {
      ok: true;
      tokens: string[];
    }
  | {
      ok: false;
      error: string;
      parsedArgs?: ParsedProjectCommandArgs;
    };

function tokenizeProjectCommandArgs(args: string): TokenizeProjectCommandArgsResult {
  const tokens: string[] = [];
  let current = "";
  let currentStarted = false;
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const char = args[index] ?? "";

    if (quote) {
      if (char === "\\" && args[index + 1] === quote) {
        current += quote;
        index += 1;
        continue;
      }

      if (char === quote) {
        quote = null;
        currentStarted = true;
        continue;
      }

      current += char;
      currentStarted = true;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      currentStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (currentStarted) {
        tokens.push(current);
        current = "";
        currentStarted = false;
      }
      continue;
    }

    current += char;
    currentStarted = true;
  }

  if (quote) {
    return {
      ok: false,
      error: "Unterminated quoted argument.",
    };
  }

  if (currentStarted) {
    tokens.push(current);
  }

  return {
    ok: true,
    tokens,
  };
}

function parseNamedArgToken(token: string): { name: string; value?: string } | null {
  if (!token.startsWith("--") || token.length <= 2) {
    return null;
  }

  const body = token.slice(2);
  const separatorIndex = body.indexOf("=");
  const name = separatorIndex === -1 ? body : body.slice(0, separatorIndex);

  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    return null;
  }

  if (separatorIndex === -1) {
    return { name };
  }

  return {
    name,
    value: body.slice(separatorIndex + 1),
  };
}

function summarizeProjectCommand(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "(empty command)";
  }

  return truncate(firstLine.replace(/^#+\s*/, ""), 80);
}

type ParsedProjectCommandFile = {
  aliases?: string[];
  args?: ProjectCommandArgumentPolicy;
  content: string;
  confirm?: boolean;
  description?: string;
  params?: string[];
  paramDescriptions?: Record<string, string>;
  tags?: string[];
  usage?: string;
  warnings: string[];
};

function parseProjectCommandFile(rawContent: string, fileName: string): ParsedProjectCommandFile {
  const content = rawContent.replace(/^\uFEFF/, "");

  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return {
      content: content.trimEnd(),
      warnings: [],
    };
  }

  const lines = content.split(/\r?\n/);
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (closingIndex === -1) {
    return {
      content: content.trimEnd(),
      warnings: [`Ignoring unterminated metadata block in ${fileName}.`],
    };
  }

  const metadataLines = lines.slice(1, closingIndex);
  const body = lines.slice(closingIndex + 1).join("\n").trimEnd();
  const warnings: string[] = [];
  let aliases: string[] | undefined;
  let args: ProjectCommandArgumentPolicy | undefined;
  let description: string | undefined;
  let params: string[] | undefined;
  let paramDescriptions: Record<string, string> | undefined;
  let tags: string[] | undefined;
  let usage: string | undefined;
  let confirm: boolean | undefined;

  for (const line of metadataLines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)?):\s*(.*)$/.exec(trimmed);

    if (!match) {
      warnings.push(`Ignoring invalid metadata line in ${fileName}: ${trimmed}`);
      continue;
    }

    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (!value) {
      continue;
    }

    const metadataValue = stripOptionalQuotes(value);

    if (key === "description") {
      description = metadataValue;
      continue;
    }

    if (key === "usage") {
      usage = metadataValue;
      continue;
    }

    if (key === "alias" || key === "aliases") {
      aliases = parseAliasesMetadata(metadataValue, fileName, warnings);
      continue;
    }

    if (key === "tag" || key === "tags") {
      tags = parseTagsMetadata(metadataValue, fileName, warnings);
      continue;
    }

    if (key.startsWith("param.")) {
      const paramName = key.slice("param.".length);

      if (!PARAM_NAME_PATTERN.test(paramName)) {
        warnings.push(`Ignoring invalid param description metadata in ${fileName}: ${paramName}`);
        continue;
      }

      paramDescriptions ??= {};

      if (Object.hasOwn(paramDescriptions, paramName)) {
        warnings.push(`Ignoring duplicate param description metadata in ${fileName}: ${paramName}`);
        continue;
      }

      paramDescriptions[paramName] = metadataValue;
      continue;
    }

    if (key === "param" || key === "params") {
      params = parseParamsMetadata(metadataValue, fileName, warnings);
      continue;
    }

    if (key === "args") {
      const parsedArgs = parseArgsMetadata(metadataValue);

      if (parsedArgs === null) {
        warnings.push(`Ignoring invalid args metadata in ${fileName}: args`);
      } else {
        args = parsedArgs;
      }
      continue;
    }

    if (key === "confirm") {
      const parsedBoolean = parseBooleanMetadata(metadataValue);

      if (parsedBoolean === null) {
        warnings.push(`Ignoring invalid boolean metadata in ${fileName}: confirm`);
      } else {
        confirm = parsedBoolean;
      }
      continue;
    }

    warnings.push(`Ignoring unsupported metadata key in ${fileName}: ${key}`);
  }

  return {
    aliases,
    args,
    content: body,
    confirm,
    description,
    params,
    paramDescriptions,
    tags,
    usage,
    warnings,
  };
}

function parseAliasesMetadata(value: string, fileName: string, warnings: string[]): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();

  for (const alias of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!isValidProjectCommandName(alias)) {
      warnings.push(`Ignoring invalid alias metadata in ${fileName}: ${alias}`);
      continue;
    }

    if (seen.has(alias)) {
      warnings.push(`Ignoring duplicate alias metadata in ${fileName}: ${alias}`);
      continue;
    }

    seen.add(alias);
    aliases.push(alias);
  }

  return aliases;
}

function normalizeProjectCommandAliases(commands: ProjectCommand[], warnings: string[]): void {
  const commandNames = new Set(commands.map((command) => command.name));
  const aliasOwners = new Map<string, string>();

  for (const command of commands) {
    const aliases = command.aliases ?? [];
    const acceptedAliases: string[] = [];

    for (const alias of aliases) {
      if (alias === command.name) {
        warnings.push(`Ignoring alias matching command name for ${command.name}: ${alias}`);
        continue;
      }

      if (commandNames.has(alias)) {
        warnings.push(`Ignoring alias that conflicts with command name for ${command.name}: ${alias}`);
        continue;
      }

      const existingOwner = aliasOwners.get(alias);

      if (existingOwner) {
        warnings.push(`Ignoring duplicate alias for ${command.name}: ${alias} already points to ${existingOwner}`);
        continue;
      }

      aliasOwners.set(alias, command.name);
      acceptedAliases.push(alias);
    }

    command.aliases = acceptedAliases;
  }
}

function parseTagsMetadata(value: string, fileName: string, warnings: string[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const tag of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!isValidProjectCommandName(tag)) {
      warnings.push(`Ignoring invalid tag metadata in ${fileName}: ${tag}`);
      continue;
    }

    if (seen.has(tag)) {
      warnings.push(`Ignoring duplicate tag metadata in ${fileName}: ${tag}`);
      continue;
    }

    seen.add(tag);
    tags.push(tag);
  }

  return tags;
}

function parseParamsMetadata(value: string, fileName: string, warnings: string[]): string[] {
  const params: string[] = [];
  const seen = new Set<string>();

  for (const param of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!PARAM_NAME_PATTERN.test(param)) {
      warnings.push(`Ignoring invalid params metadata in ${fileName}: ${param}`);
      continue;
    }

    if (seen.has(param)) {
      warnings.push(`Ignoring duplicate params metadata in ${fileName}: ${param}`);
      continue;
    }

    seen.add(param);
    params.push(param);
  }

  return params;
}

function parseArgsMetadata(value: string): ProjectCommandArgumentPolicy | null {
  const normalized = value.trim().toLowerCase();

  if (normalized === "optional" || normalized === "required") {
    return normalized;
  }

  return null;
}

function parseBooleanMetadata(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return null;
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function usageContainsNamedParam(usage: string, param: string): boolean {
  return new RegExp(`(^|\\s)--${escapeRegExp(param)}(?:[=\\s]|$)`).test(usage);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
