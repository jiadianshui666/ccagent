import assert from "node:assert/strict";
import test from "node:test";
import { formatCliUsage, parseCliArgs } from "../src/args.js";

test("parseCliArgs returns interactive mode without args", () => {
  assert.deepEqual(parseCliArgs([]), {
    mode: "interactive",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
});

test("parseCliArgs recognizes standalone help and version flags", () => {
  assert.deepEqual(parseCliArgs(["--help"]), {
    mode: "help",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["-h"]), {
    mode: "help",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--version"]), {
    mode: "version",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["-v"]), {
    mode: "version",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--init"]), {
    mode: "init",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--init-instructions"]), {
    mode: "initInstructions",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--init-command", "review"]), {
    mode: "initCommand",
    name: "review",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--init-skill", "code-review"]), {
    mode: "initSkill",
    name: "code-review",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--doctor"]), {
    mode: "doctor",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--config-set", "openai.apiMode", "chat"]), {
    mode: "configSet",
    key: "openai.apiMode",
    value: "chat",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--config-get", "openai.baseURL"]), {
    mode: "configGet",
    key: "openai.baseURL",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--config-unset", "openai.baseURL"]), {
    mode: "configUnset",
    key: "openai.baseURL",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs([
    "--mcp-add",
    "filesystem",
    "npx",
    "--",
    "-y",
    "@modelcontextprotocol/server-filesystem",
    ".",
  ]), {
    mode: "mcpAdd",
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--mcp-remove", "filesystem"]), {
    mode: "mcpRemove",
    name: "filesystem",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--mcp-enable"]), {
    mode: "mcpEnable",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--mcp-disable"]), {
    mode: "mcpDisable",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
});

test("parseCliArgs treats flags inside prompts as prompt text", () => {
  assert.deepEqual(parseCliArgs(["run", "node", "-v"]), {
    mode: "prompt",
    prompt: "run node -v",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["explain", "--no-session"]), {
    mode: "prompt",
    prompt: "explain --no-session",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
  });
});

test("parseCliArgs supports leading global flags", () => {
  assert.deepEqual(parseCliArgs(["--no-session"]), {
    mode: "interactive",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: false,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--no-session", "list", "files"]), {
    mode: "prompt",
    prompt: "list files",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: false,
    verbose: false,
  });
  assert.deepEqual(parseCliArgs(["--verbose", "--allow-edits", "--no-session", "list", "files"]), {
    mode: "prompt",
    prompt: "list files",
    allowEdits: true,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: false,
    verbose: true,
  });
  assert.deepEqual(parseCliArgs(["--allow-edits", "--verify", "npm test", "patch", "demo.txt", "hello"]), {
    mode: "prompt",
    prompt: "patch demo.txt hello",
    allowEdits: true,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: false,
    verifyCommand: "npm test",
  });
  assert.deepEqual(parseCliArgs(["--debug", "--help"]), {
    mode: "help",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: true,
    verbose: true,
  });
});

test("formatCliUsage includes one-shot mode", () => {
  assert.match(formatCliUsage(), /ccagent <prompt>/);
  assert.match(formatCliUsage(), /--init-instructions/);
  assert.match(formatCliUsage(), /--init-command/);
  assert.match(formatCliUsage(), /--init-skill/);
  assert.match(formatCliUsage(), /--no-session/);
  assert.match(formatCliUsage(), /--allow-edits/);
  assert.match(formatCliUsage(), /--verify/);
  assert.match(formatCliUsage(), /--stream/);
  assert.match(formatCliUsage(), /--json/);
  assert.match(formatCliUsage(), /--plain/);
  assert.match(formatCliUsage(), /--verbose/);
  assert.match(formatCliUsage(), /--config-set/);
  assert.match(formatCliUsage(), /--config-get/);
  assert.match(formatCliUsage(), /--config-unset/);
});

test("parseCliArgs supports stream mode", () => {
  assert.deepEqual(parseCliArgs(["--stream", "--no-session", "hello"]), {
    mode: "prompt",
    prompt: "hello",
    allowEdits: false,
    json: false,
    plain: false,
    sandbox: false,
    stream: true,
    useSession: false,
    verbose: false,
  });
});

test("parseCliArgs supports JSON Lines mode", () => {
  assert.deepEqual(parseCliArgs(["--json", "--no-session", "list", "files"]), {
    mode: "prompt",
    prompt: "list files",
    allowEdits: false,
    json: true,
    plain: false,
    sandbox: false,
    stream: false,
    useSession: false,
    verbose: false,
  });
});

test("parseCliArgs supports plain terminal output mode", () => {
  assert.deepEqual(parseCliArgs(["--plain", "--no-session"]), {
    mode: "interactive",
    allowEdits: false,
    json: false,
    plain: true,
    sandbox: false,
    stream: false,
    useSession: false,
    verbose: false,
  });
});
