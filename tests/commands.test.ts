import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expandProjectCommand,
  formatExpandedProjectCommand,
  formatProjectCommandDetails,
  formatProjectCommandError,
  formatProjectCommandsCheck,
  formatProjectCommands,
  initProjectCommand,
  loadProjectCommands,
  parseProjectCommandArgs,
  readProjectCommand,
  validateProjectCommandArgs,
} from "../src/commands.js";

test("loadProjectCommands returns empty list when commands dir is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));

  try {
    const loaded = await loadProjectCommands(workspaceRoot);

    assert.equal(loaded.commands.length, 0);
    assert.deepEqual(loaded.warnings, []);
    assert.match(formatProjectCommands(loaded), /No project commands found/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("initProjectCommand creates a reusable command template", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));

  try {
    const result = await initProjectCommand(workspaceRoot, "review-code");
    const content = await readFile(join(workspaceRoot, ".ccagent", "commands", "review-code.md"), "utf8");
    const loaded = await loadProjectCommands(workspaceRoot);
    const command = loaded.commands[0];

    assert.equal(result.created, true);
    assert.equal(result.name, "review-code");
    assert.equal(result.path, join(workspaceRoot, ".ccagent", "commands", "review-code.md"));
    assert.match(content, /description: Review Code workflow\./);
    assert.match(content, /usage: \/cmd review-code \[args\]/);
    assert.match(content, /# Review Code \{\{args\}\}/);
    assert.equal(command?.name, "review-code");
    assert.equal(command?.description, "Review Code workflow.");
    assert.equal(command?.usage, "/cmd review-code [args]");
    assert.equal(command?.args, "optional");
    assert.equal(command?.confirm, false);
    assert.match(formatProjectCommands(loaded), /review-code: Review Code workflow\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("initProjectCommand does not overwrite an existing command template", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");
  const path = join(commandsDir, "review.md");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(path, "custom command\n", "utf8");

    const result = await initProjectCommand(workspaceRoot, "review");
    const content = await readFile(path, "utf8");

    assert.equal(result.created, false);
    assert.equal(result.name, "review");
    assert.equal(result.path, path);
    assert.equal(result.reason, "Project command already exists.");
    assert.equal(content, "custom command\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("initProjectCommand rejects invalid command names", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));

  try {
    const result = await initProjectCommand(workspaceRoot, "../bad");

    assert.equal(result.created, false);
    assert.equal(result.name, "../bad");
    assert.match(result.reason, /letters, numbers, dashes, or underscores/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadProjectCommands reads markdown command templates", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "review.md"), "# Review {{args}}\n\nRead files first.");
    await writeFile(join(commandsDir, "bad name.md"), "# Bad\n");
    await writeFile(join(commandsDir, "notes.txt"), "ignored");

    const loaded = await loadProjectCommands(workspaceRoot);

    assert.equal(loaded.commands.length, 1);
    assert.equal(loaded.commands[0]?.name, "review");
    assert.equal(loaded.commands[0]?.summary, "Review {{args}}");
    assert.equal(loaded.commands[0]?.description, undefined);
    assert.equal(loaded.commands[0]?.usage, undefined);
    assert.match(loaded.warnings.join("\n"), /bad name\.md/);
    assert.match(formatProjectCommands(loaded), /review: Review/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadProjectCommands parses optional command metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      [
        "---",
        "description: Review code for correctness issues.",
        "aliases: r, rv",
        "tags: review, safety",
        "params: file, topic",
        "param.file: File or directory to inspect.",
        "param.topic: Review focus.",
        "usage: /cmd review <path>",
        "args: required",
        "confirm: true",
        "---",
        "# Review {{args}}",
        "",
        "Read files first.",
      ].join("\n"),
    );

    const loaded = await loadProjectCommands(workspaceRoot);
    const command = loaded.commands[0];

    assert.equal(command?.name, "review");
    assert.deepEqual(command?.aliases, ["r", "rv"]);
    assert.deepEqual(command?.tags, ["review", "safety"]);
    assert.deepEqual(command?.params, ["file", "topic"]);
    assert.deepEqual(command?.paramDescriptions, {
      file: "File or directory to inspect.",
      topic: "Review focus.",
    });
    assert.equal(command?.description, "Review code for correctness issues.");
    assert.equal(command?.usage, "/cmd review <path>");
    assert.equal(command?.args, "required");
    assert.equal(command?.confirm, true);
    assert.equal(command?.summary, "Review code for correctness issues.");
    assert.equal(command?.content, "# Review {{args}}\n\nRead files first.");
    assert.match(formatProjectCommands(loaded), /review: Review code for correctness issues\./);
    assert.match(formatProjectCommands(loaded), /aliases: r, rv/);
    assert.match(formatProjectCommands(loaded), /tags: review, safety/);
    assert.match(formatProjectCommands(loaded), /params: file, topic/);
    assert.match(formatProjectCommands(loaded), /param descriptions:\n    file: File or directory to inspect\.\n    topic: Review focus\./);
    assert.match(formatProjectCommands(loaded), /usage: \/cmd review <path>/);
    assert.match(formatProjectCommands(loaded), /args: required/);
    assert.match(formatProjectCommands(loaded), /confirm: required/);
    assert.match(formatProjectCommands(loaded), /\/command <name>/);

    if (command) {
      const preview = formatExpandedProjectCommand(command, "src/agent.ts");
      const details = formatProjectCommandDetails(command);

      assert.match(preview, /Aliases: r, rv/);
      assert.match(preview, /Tags: review, safety/);
      assert.match(preview, /Description: Review code for correctness issues\./);
      assert.match(preview, /Usage: \/cmd review <path>/);
      assert.match(preview, /Argument policy: required/);
      assert.match(preview, /Confirmation: required/);
      assert.match(preview, /Param descriptions:\n  file: File or directory to inspect\.\n  topic: Review focus\./);
      assert.doesNotMatch(preview, /description:/);

      assert.equal(validateProjectCommandArgs(command, "src/agent.ts").ok, true);
      assert.equal(validateProjectCommandArgs(command, "").ok, false);
      assert.match(details, /Project command/);
      assert.match(details, /Name: review/);
      assert.match(details, /Aliases: r, rv/);
      assert.match(details, /Tags: review, safety/);
      assert.match(details, /Params: file, topic/);
      assert.match(details, /Param descriptions:\n  file: File or directory to inspect\.\n  topic: Review focus\./);
      assert.match(details, /Template:/);
      assert.match(details, /# Review \{\{args\}\}/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadProjectCommands warns for invalid command metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      [
        "---",
        "description Review",
        "owner: cli",
        "aliases: bad path, r, r",
        "tags: bad tag, review, review",
        "params: bad param, file, file",
        "param.file: File to review.",
        "param.file: Duplicate file description.",
        "param.extra: Undeclared parameter.",
        "args: sometimes",
        "confirm: maybe",
        "---",
        "Review {{args}}",
      ].join("\n"),
    );

    const loaded = await loadProjectCommands(workspaceRoot);

    assert.match(loaded.warnings.join("\n"), /invalid metadata line/);
    assert.match(loaded.warnings.join("\n"), /unsupported metadata key/);
    assert.match(loaded.warnings.join("\n"), /invalid alias metadata/);
    assert.match(loaded.warnings.join("\n"), /duplicate alias metadata/);
    assert.match(loaded.warnings.join("\n"), /invalid tag metadata/);
    assert.match(loaded.warnings.join("\n"), /duplicate tag metadata/);
    assert.match(loaded.warnings.join("\n"), /invalid params metadata/);
    assert.match(loaded.warnings.join("\n"), /duplicate params metadata/);
    assert.match(loaded.warnings.join("\n"), /duplicate param description metadata/);
    assert.match(loaded.warnings.join("\n"), /invalid args metadata/);
    assert.match(loaded.warnings.join("\n"), /invalid boolean metadata/);
    assert.match(formatProjectCommands(loaded), /Warnings:/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadProjectCommands warns for alias conflicts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      ["---", "aliases: test, t", "---", "Review {{args}}"].join("\n"),
    );
    await writeFile(
      join(commandsDir, "test.md"),
      ["---", "aliases: t", "---", "Run tests"].join("\n"),
    );

    const loaded = await loadProjectCommands(workspaceRoot);
    const review = loaded.commands.find((command) => command.name === "review");
    const testCommand = loaded.commands.find((command) => command.name === "test");

    assert.deepEqual(review?.aliases, ["t"]);
    assert.deepEqual(testCommand?.aliases, []);
    assert.match(loaded.warnings.join("\n"), /conflicts with command name/);
    assert.match(loaded.warnings.join("\n"), /duplicate alias/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatProjectCommands filters commands by tag", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      ["---", "tags: review, safety", "---", "Review {{args}}"].join("\n"),
    );
    await writeFile(
      join(commandsDir, "test.md"),
      ["---", "tags: test, verification", "---", "Run tests"].join("\n"),
    );

    const loaded = await loadProjectCommands(workspaceRoot);
    const reviewOnly = formatProjectCommands(loaded, { tag: "review" });
    const missing = formatProjectCommands(loaded, { tag: "missing" });

    assert.match(reviewOnly, /Tag: review/);
    assert.match(reviewOnly, /Count: 1 of 2/);
    assert.match(reviewOnly, /review: Review/);
    assert.doesNotMatch(reviewOnly, /test: Run tests/);
    assert.match(missing, /No project commands found for tag: missing/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatProjectCommandsCheck reports command health", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      ["---", "args: required", "---", "Review {{args}}"].join("\n"),
    );
    await writeFile(join(commandsDir, "empty.md"), "");
    await writeFile(join(commandsDir, "bad name.md"), "Bad");

    const loaded = await loadProjectCommands(workspaceRoot);
    const output = formatProjectCommandsCheck(loaded);

    assert.match(output, /Project command check/);
    assert.match(output, /\[WARN\].*bad name\.md/);
    assert.match(output, /\[WARN\] review: args is required but usage is missing\./);
    assert.match(output, /\[FAIL\] empty: Template is empty\./);
    assert.match(output, /Summary: 1 failure\(s\), 2 warning\(s\)\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatProjectCommandsCheck reports clean command sets", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      ["---", "args: required", "usage: /cmd review <path>", "---", "Review {{args}}"].join("\n"),
    );

    const loaded = await loadProjectCommands(workspaceRoot);
    const output = formatProjectCommandsCheck(loaded);

    assert.match(output, /No issues found/);
    assert.match(output, /Summary: 0 failure\(s\), 0 warning\(s\)\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatProjectCommandsCheck reports params metadata issues", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "missing-param.md"),
      [
        "---",
        "usage: /cmd missing-param --file <path>",
        "params: file",
        "---",
        "Review {{file}} for {{topic}}",
      ].join("\n"),
    );
    await writeFile(
      join(commandsDir, "unused-param.md"),
      [
        "---",
        "usage: /cmd unused-param --file <path> --topic <topic>",
        "params: file, topic",
        "---",
        "Review {{file}}",
      ].join("\n"),
    );
    await writeFile(
      join(commandsDir, "usage-missing.md"),
      [
        "---",
        "usage: /cmd usage-missing --file <path>",
        "params: file, topic",
        "---",
        "Review {{file}} for {{topic}}",
      ].join("\n"),
    );
    await writeFile(
      join(commandsDir, "no-usage.md"),
      ["---", "params: file", "---", "Review {{file}}"].join("\n"),
    );

    const loaded = await loadProjectCommands(workspaceRoot);
    const output = formatProjectCommandsCheck(loaded);

    assert.match(output, /missing-param: params metadata is missing template placeholder\(s\): topic\./);
    assert.match(output, /missing-param: usage is missing named parameter\(s\): --topic\./);
    assert.match(output, /unused-param: params declares unused parameter\(s\): topic\./);
    assert.match(output, /usage-missing: usage is missing named parameter\(s\): --topic\./);
    assert.match(output, /no-usage: named params are used but usage is missing\./);
    assert.match(output, /Summary: 0 failure\(s\), 5 warning\(s\)\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatProjectCommandsCheck reports unknown param descriptions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      [
        "---",
        "usage: /cmd review --file <path>",
        "params: file",
        "param.file: File to review.",
        "param.topic: Review focus.",
        "---",
        "Review {{file}}",
      ].join("\n"),
    );

    const loaded = await loadProjectCommands(workspaceRoot);
    const output = formatProjectCommandsCheck(loaded);

    assert.match(output, /review: param descriptions reference unknown parameter\(s\): topic\./);
    assert.match(output, /Summary: 0 failure\(s\), 1 warning\(s\)\./);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("project command args support named placeholders", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      [
        "---",
        "usage: /cmd review --file <path> --topic <topic> [notes]",
        "---",
        "# Review {{file}}",
        "",
        "Focus: {{topic}}",
        "Notes: {{args}}",
      ].join("\n"),
    );

    const commandResult = await readProjectCommand(workspaceRoot, "review");

    assert.equal(commandResult.ok, true);

    if (commandResult.ok) {
      const args = "--file src/agent.ts --topic security extra notes";
      const parsed = parseProjectCommandArgs(args);
      const validation = validateProjectCommandArgs(commandResult.command, args);

      assert.equal(parsed.ok, true);

      if (parsed.ok) {
        assert.deepEqual(parsed.parsedArgs.named, {
          file: "src/agent.ts",
          topic: "security",
        });
        assert.equal(parsed.parsedArgs.positional, "extra notes");
      }

      assert.equal(validation.ok, true);

      if (validation.ok) {
        assert.equal(
          expandProjectCommand(commandResult.command, args, validation.parsedArgs),
          "# Review src/agent.ts\n\nFocus: security\nNotes: extra notes",
        );
        assert.match(
          formatExpandedProjectCommand(commandResult.command, args, validation.parsedArgs),
          /Named args:\n  file: src\/agent\.ts\n  topic: security/,
        );
        assert.match(
          formatExpandedProjectCommand(commandResult.command, args, validation.parsedArgs),
          /Positional args: extra notes/,
        );
      }
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("project command args reject missing named placeholders", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "review.md"), "Review {{file}} for {{topic}}\n");

    const commandResult = await readProjectCommand(workspaceRoot, "review");

    assert.equal(commandResult.ok, true);

    if (commandResult.ok) {
      const validation = validateProjectCommandArgs(commandResult.command, "--file src/agent.ts");

      assert.equal(validation.ok, false);

      if (!validation.ok) {
        assert.match(validation.error, /missing required named argument\(s\): topic/);
        assert.match(validation.error, /--topic <value>/);
      }
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("readProjectCommand validates names and expands templates", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ccagent-commands-"));
  const commandsDir = join(workspaceRoot, ".ccagent", "commands");

  try {
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, "review.md"),
      ["---", "aliases: r", "---", "Review {{args}}"].join("\n"),
    );
    await writeFile(join(commandsDir, "test.md"), "Run tests\n");

    const review = await readProjectCommand(workspaceRoot, "review");
    const reviewAlias = await readProjectCommand(workspaceRoot, "r");
    const testCommand = await readProjectCommand(workspaceRoot, "test");
    const invalid = await readProjectCommand(workspaceRoot, "../bad");
    const missing = await readProjectCommand(workspaceRoot, "missing");

    assert.equal(review.ok, true);
    assert.equal(reviewAlias.ok, true);
    assert.equal(testCommand.ok, true);

    if (review.ok) {
      assert.equal(expandProjectCommand(review.command, "src/agent.ts"), "Review src/agent.ts");
      assert.match(formatExpandedProjectCommand(review.command, "src/agent.ts"), /Project command preview/);
      assert.match(formatExpandedProjectCommand(review.command, "src/agent.ts"), /Name: review/);
      assert.match(formatExpandedProjectCommand(review.command, "src/agent.ts"), /Args: src\/agent\.ts/);
      assert.match(formatExpandedProjectCommand(review.command, "src/agent.ts"), /Review src\/agent\.ts/);
    }

    if (reviewAlias.ok) {
      assert.equal(reviewAlias.command.name, "review");
      assert.equal(expandProjectCommand(reviewAlias.command, "src/agent.ts"), "Review src/agent.ts");
    }

    if (testCommand.ok) {
      assert.equal(expandProjectCommand(testCommand.command, "fast"), "Run tests\n\nArguments:\nfast");
    }

    assert.equal(invalid.ok, false);
    assert.equal(missing.ok, false);

    if (!invalid.ok) {
      assert.match(formatProjectCommandError(invalid), /Expected command name/);
    }

    if (!missing.ok) {
      assert.match(formatProjectCommandError(missing), /Project command not found/);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
