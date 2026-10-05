# CCAgent

A learning-focused terminal coding agent inspired by tools like Claude Code.

CCAgent requires Node.js 20 or newer and runs on Windows, macOS, and Linux.
The rich interface needs a VT-aware terminal (see
[Terminal compatibility](#terminal-compatibility)).

## Run

Interactive mode:

```bash
ccagent
```

Interactive mode saves terminal input history in `.ccagent/history` so the next
run can recall recent prompts with the arrow keys. This is separate from
conversation history. Use `/input-history` to inspect it and `/input-history
clear` to clear it.

Press Tab in interactive mode to complete slash commands, tool names, project
command names or aliases, and project skill names. For example, `/chec<Tab>` can complete
checkpoint commands, and `/cmd r<Tab>` can complete a reusable project command
named `review`. `/skill c<Tab>` can complete a project skill named
`code-review`. Checkpoint commands also complete saved checkpoint names, so
`/checkpoint show be<Tab>` can complete `before-edit`.

Use `/completion` or `/keys` to inspect Tab completion behavior and terminal
input shortcuts from inside CCAgent.

Tab also completes workspace paths for path-oriented commands. For example,
`/read src/<Tab>` can complete files under `src/`, while `/ls s<Tab>` and
`/tree s<Tab>` complete directories. The same noisy paths hidden by `list_files`,
such as `node_modules`, `dist`, and `.ccagent/history`, are hidden from path
completion too.

### Rich terminal interface

When `ccagent` runs interactively in a real terminal, it uses a rich colored
interface instead of plain text:

- assistant messages stream into marked blocks (`●`), and tool calls render as
  structured blocks (`○`) with the input summary and a preview box for tool
  output,
- assistant text streams live with word wrap and simple markdown styling
  (headings, bullets, quotes, inline bold / code), and diff lines inside code
  fences are highlighted green / red,
- fenced code blocks get syntax highlighting for TypeScript, Python, Rust, C,
  JSON, and shell files,
- approval requests render as a bordered panel, and `+` / `-` lines in diffs
  are highlighted green / red,
- each model round ends with a dim usage line showing the model name, tokens,
  duration, and cost, plus cumulative session totals after the first round,
- consecutive read-only tool calls requested in one model turn run in
  parallel while tool events keep their deterministic order,
- a bottom status bar shows the configured model (tagged `(local)` when the
  mock model is active), session totals, and policy flags (such as
  `--allow-edits`) and stays pinned while prompts and responses stream, with a
  live outgoing-token estimate (`out≈N tok`) and a ticking elapsed-time counter
- the startup banner box and message layout stay readable across terminal
  widths, and the status bar rewraps automatically when the window is resized.

Disable it with:

```bash
ccagent --plain
```

The rich interface only activates when stdout is an interactive terminal
(TTY). Pipes, one-shot prompts, `--json`, and `--plain` all keep the stable
plain-text output formats. Set `NO_COLOR=1` to keep the layout but drop ANSI
colors.

One-shot mode:

```bash
ccagent list files
ccagent read package.json
ccagent search ModelClient
```

Run one command without loading or saving session history:

```bash
ccagent --no-session list files
```

Print debug events while the agent runs:

```bash
ccagent --verbose list files
CCAGENT_DEBUG=1 ccagent list files
```

Stream model text deltas and per-turn usage to the terminal when supported:

```bash
ccagent --stream --no-session "list files"
```

Both OpenAI API modes support streaming. In `responses` mode, CCAgent listens to
Responses stream events. In `chat` mode, CCAgent streams
`/v1/chat/completions` text deltas and accumulates streamed tool-call argument
chunks before executing tools.

In stream mode, tool calls also show lifecycle lines:

```text
[model] user round=0 model=mock duration=2ms tokens=in=3,out=8,total=11,estimated=yes cost=(not configured) cumulative=turns:1,total:11,cost:(not configured) Budget: (not configured)
[tool:preflight] list_files risk=low impact=read-only approval=no denied=no
[tool:start] list_files {"path":".","maxDepth":1}
[tool:finish] list_files ok (12 chars, count=1)
[tool] list_files -> ...
```

Each completed model call emits one `[model]` line. The line includes that turn's token usage, current-run cumulative usage, optional cost, and budget status from `CCAGENT_MAX_TOTAL_TOKENS` / `CCAGENT_MAX_COST_USD`.

Emit machine-readable JSON Lines:

```bash
ccagent --json --no-session "list files"
```

Each line is one event:

```jsonl
{"type":"model_turn","kind":"user","round":0,"modelName":"mock","totalTokens":11,"cumulativeTotalTokens":11,"budget":"Budget: (not configured)"}
{"type":"tool_preflight","toolName":"list_files","risk":"low","workspaceImpact":"read-only","requiresApproval":false,"deniedByPolicy":false}
{"type":"tool_start","toolName":"list_files","inputSummary":"{\"path\":\".\",\"maxDepth\":1}"}
{"type":"tool_finish","toolName":"list_files","ok":true,"summary":"ok (12 chars, count=1)"}
{"type":"final_response","content":"...","streamed":true}
```

Run a file-editing demo that auto-approves patch application:

```bash
ccagent --allow-edits "patch demo.txt hello"
```

Read an existing file and replace text through the patch flow:

```bash
ccagent --allow-edits "replace demo.txt hello => hi"
```

Run a verification command after a successful patch:

```bash
ccagent --allow-edits --verify "npm test" "replace demo.txt hello => hi"
```

Every successful patch also writes a pre-edit snapshot under
`.ccagent/patch-snapshots/` so you can inspect the original file contents later.

Run the full task workflow with planning:

```bash
ccagent --allow-edits --verify "npm test" "task replace demo.txt hello => hi"
```

Initialize project config in another workspace:

```bash
ccagent --init
```

Initialize project instructions in another workspace:

```bash
ccagent --init-instructions
```

Initialize a reusable project command template:

```bash
ccagent --init-command review
```

Initialize reusable project workflow guidance:

```bash
ccagent --init-skill code-review
```

Diagnose the local setup:

```bash
ccagent --doctor
```

`--doctor` checks Node, project config, `CCAGENT.md`, project commands, project command health, the installed OpenAI SDK, selected model, API mode, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `rg`, `git`, the global `ccagent` command, and the session path. It also prints a copyable real-model smoke command:

```bash
ccagent --json --no-session "list files"
```

Development mode:

```bash
npm run dev
npm run typecheck
npm run build
npm run ci
npm test
npm run check
npm run check:full
npm run release:check
npm run release:full
npm start
```

### Boot splash and themes

Interactive starts in a real terminal show a short pixel-art boot splash:
the word `CCAgent` drawn in block glyphs with a cyan-blue gradient sweeping
across the letters, followed by the version line. Set `CCAGENT_THEME` to
pick the palette:

- `CCAGENT_THEME=ocean` (default): cyan-blue tech gradient.
- `CCAGENT_THEME=dawn`: warm orange gradient.

Set `CCAGENT_NO_SPLASH=1` to skip the splash entirely. On terminals narrower
than 49 columns CCAgent falls back to a single plain version line, and
`--plain`, one-shot, `--json`, and piped output never print the splash, so
scripting stays unaffected.

### Terminal compatibility

The rich interface uses ANSI/VT escape sequences and Unicode box-drawing
characters. Use a VT-aware terminal for the full experience:

- Windows 10/11: Windows Terminal (recommended), WezTerm, Alacritty, ConEmu
  (with VT sequences enabled in the terminal), or VS Code's terminal. Recent
  Windows 10/11 builds ship VT processing by default in `conhost.exe` too.
- macOS: Terminal.app and iTerm2.
- Linux: terminal emulators with a UTF-8 locale.

On terminals where the layout looks mangled, `ccagent --plain` keeps stable
plain-text output and `NO_COLOR=1` keeps the layout but drops ANSI colors.
CCAgent also falls back to plain output automatically whenever stdout is not
an interactive TTY (pipes, `--json`, one-shot prompts).

### Interrupting a turn

- While a model turn is running, press Ctrl+C to cancel it. The in-flight
  request is aborted immediately, automatic retries are skipped, and the
  turn is reported as canceled instead of crashing or emitting a bogus model
  error.
- When no turn is running, Ctrl+C exits CCAgent.

## Global Command

This project is linked locally with:

```bash
npm link
```

That makes the `ccagent` command available on this machine.

To remove the global link:

```bash
npm unlink -g ccagent
```

Before linking or sharing a local package, run:

```bash
npm run release:check
```

`release:check` builds `dist/`, verifies the CLI package metadata, checks that
`dist/index.js` has the Node shebang, and runs `npm pack --dry-run` to confirm
the package contains the CLI entry plus README without including `src/`,
`tests/`, `node_modules/`, or `.ccagent/`. For a slower release gate that also
runs the full test suite and smoke eval, use:

```bash
npm run release:full
```

For a full local CI gate that also creates fresh provider smoke reports and
gates them without relying on report history, use:

```bash
npm run ci
```

## Commands

In interactive mode, `/help` shows a concise overview. Use `/help <topic>` for a focused section or `/help all` for the full command reference. `ccagent --help` also prints the full reference.

```text
/help [topic]
/help all
/hello
/completion
/keys
/architecture
/architecture loop
/architecture tools
/architecture sources
/architecture exercises
/config
/mcp [status|tools|resources|templates|prompts|reload] [--json]
/mcp read <server> <uri> [--json]
/mcp prompt <server> <name> [arguments-json] [--json]
/model
/models
/model-smoke
/code-map
/code-map export
/roadmap
/context
/diagnostics export
/audit [--all] [--jsonl] [count]
/audit-replay [--all] [count]
/audit-timeline [--all] [count]
/model-trace [--all] [count]
/usage-summary [--all]
/usage-models [--all]
/audit-call [--all] <callId>
/audit-summary [--all]
/audit-export summary [--all]
/audit-export call [--all] <callId>
/audit-report [--all]
/permissions
/instructions
/prompt
/session
/session show [--limit <count>]
/session stats
/session search <query>
/checkpoint [list]
/checkpoint backups
/checkpoint save <name>
/checkpoint show <name> [--limit <count>]
/checkpoint stats <name>
/checkpoint search <name> <query>
/checkpoint diff <left> <right>
/checkpoint diff-current <name>
/checkpoint load <name>
/checkpoint delete <name>
/plan
/plan add <step>
/plan start <id>
/plan done <id>
/plan pending <id>
/plan drop <id>
/plan clear
/task-state
/task-state resume
/task-state prompt
/task-state set <objective>
/task-state status <active|blocked|complete>
/task-state step <step>
/task-state note <summary>
/task-state files [--mode=replace|merge|clear] <paths...>
/task-state clear
/history [count]
/history --all
/input-history [count]
/input-history clear
/compact
/compact-status
/clear
/tools
/tools --verbose
/tool <name>
/commands
/cmd-preview <name> [args]
/cmd <name> [args]
/undo
/snapshots [list] [limit]
/snapshots history [limit]
/snapshots show <snapshot-file>
/snapshots restore <snapshot-file> <path>
/ls [path] [depth]
/tree [path] [depth]
/read <path>
/search <query>
/suggest-context <query>
/index [status]
/index build
/index search <query> [limit]
/index eval [status]
/index eval init
/index eval run [--json]
/index semantic [status]
/index semantic build
/index semantic search <query> [limit]
/symbols [limit]
/symbols search <query> [limit]
/verify-suggest [paths...]
/verify-run [paths...]
/verify-last
/verify-failure
/verify-rerun
/verify-stability [runs]
/verify-clear
/repair-last
/repair-preview
/repair-run
/repair-loop [attempts]
/status
/diff
/run <command>
/apply_patch_file <path>
```

## Tools

```text
list_files
read_file
search_files
suggest_context
run_subagent
run_subagents
build_context_index
context_index_status
search_context_index
build_semantic_index
semantic_index_status
search_semantic_index
list_symbols
search_symbols
suggest_verification
workspace_info
list_patch_snapshots
patch_snapshot_history
show_patch_snapshot
restore_patch_snapshot
run_shell
edit
apply_patch
reverse_patch
git_status
git_diff
update_plan
update_task_state
```

`run_shell`, `edit`, `apply_patch`, and `reverse_patch` require approval. In one-shot mode they are denied unless explicitly allowlisted.
Use `--allow-edits` to auto-approve `edit`, `apply_patch`, and `reverse_patch`; shell commands still require approval or a config allowlist.
Use `--verify "<command>"` to run one explicit verification command after `apply_patch` or `edit` succeeds.
Use `/verify-suggest [paths...]` to suggest likely build, focused test, eval, and release-check commands from changed paths and package scripts.
Use `/verify-run [paths...]` to run those suggested commands through the normal `run_shell` approval flow.
Use `/verify-last` to run suggested verification for the most recent patch's recorded paths.
Use `/verify-failure` to inspect the most recent failed verification command and its recorded summary/remediation.
Use `/verify-rerun` to rerun the most recent failed verification command through the normal `run_shell` approval flow.
Use `/verify-stability [runs]` to repeat the stored command and classify it as a stable pass, stable failure, or flaky result before editing source code.
Use `/verify-clear` to clear the stored verification failure and rerun target when they are stale.
Use `/repair-last` after a failed `/verify-run` or `/verify-last` to start an agent repair loop with the failed command, file locations, remediation hints, failure-specific repair strategy, captured output, and current contents for likely repair files.
Use `/repair-preview` to inspect the exact repair prompt and repair strategy without calling the model or changing files. When a recent patch exists, the prompt includes recent patch paths and reminds the model to reread current file contents before writing another patch.
Use `/repair-run` to run the repair loop and then immediately rerun the stored verification target.
Use `/repair-loop [attempts]` to repeat repair plus rerun until verification passes or attempts are exhausted. Attempts defaults to 2 and is capped at 5.
Failed `/verify-run` and `/verify-last` commands show a short failure summary with likely cause, next step, file location, remediation suggestions, and key error lines before the full captured output.
When `apply_patch` succeeds without `--verify`, CCAgent appends suggested verification commands to the patch result.
Patch approval prompts show a risk-grouped file review before the raw diff. At the approval prompt, enter `d` for the full diff, `s` for the summary, `y` to approve, or `n` to deny.

Inspect registered tools and one tool's model-facing schema/current policy state:

```bash
ccagent --no-session /tools
ccagent --no-session /tools --verbose
```

`/tools` shows a grouped summary with risk and effective behavior. `/tools --verbose` adds descriptions, workspace impact, and behavior. `/tool <name>` shows the full parameter schema and policy details:

```bash
ccagent --no-session /tool read_file
ccagent --no-session /tool run_shell
```

Inspect the active approval and policy rules:

```bash
ccagent --no-session /permissions
ccagent --allow-edits --verify "npm test" --no-session /permissions
```

## Config

Project config lives at:

```text
.ccagent/config.json
```

Example:

```json
{
  "model": "gpt-5.5",
  "mcp": {
    "enabled": false,
    "servers": {
      "example": {
        "command": "node",
        "args": ["C:/absolute/path/to/mcp-server.mjs"],
        "cwd": ".",
        "timeoutMs": 30000
      }
    }
  },
  "context": {
    "auto": true
  },
  "openai": {
    "apiMode": "chat",
    "baseURL": "https://api.wcgio.com/v1",
    "embeddingModel": "text-embedding-3-small",
    "retry": {
      "maxAttempts": 3,
      "baseDelayMs": 250,
      "maxDelayMs": 2000
    }
  },
  "autoApprove": {
    "shellCommands": []
  },
  "toolPolicy": {
    "allowWritePaths": [],
    "denyWritePaths": [],
    "deny": [],
    "denyRisk": [],
    "requireApproval": [],
    "requireApprovalRisk": []
  }
}
```

Update, read, or remove config values from the CLI:

```powershell
ccagent --config-set model gpt-5.5
ccagent --config-set context.auto false
ccagent --config-set openai.apiMode chat
ccagent --config-set openai.baseURL https://api.wcgio.com/v1
ccagent --config-set openai.embeddingModel text-embedding-3-small
ccagent --config-set openai.retry.maxAttempts 4
ccagent --config-set openai.retry.baseDelayMs 500
ccagent --config-set openai.retry.maxDelayMs 5000
ccagent --config-set ui.promptHints /help,/model,/config,/mcp
ccagent --config-set ui.promptHints off
ccagent --config-set toolPolicy.allowWritePaths src/,tests/
ccagent --config-set toolPolicy.denyWritePaths .ccagent/,package-lock.json
ccagent --config-set toolPolicy.deny run_shell
ccagent --config-set toolPolicy.denyRisk high
ccagent --config-set toolPolicy.requireApproval read_file,list_files
ccagent --config-set toolPolicy.requireApprovalRisk medium,high
ccagent --config-get openai.baseURL
ccagent --config-get openai.embeddingModel
ccagent --config-unset openai.baseURL
ccagent --config-unset openai.embeddingModel
```

Supported config keys are:

```text
model
context.auto     true | false; attach bounded task context from an existing persistent index
openai.apiMode    responses | chat
openai.baseURL    OpenAI-compatible API base URL
openai.embeddingModel  Optional embedding model for provider-backed semantic index
openai.retry.maxAttempts  Provider retry attempts, integer 1-5
openai.retry.baseDelayMs  Provider retry initial backoff, integer 0-60000
openai.retry.maxDelayMs   Provider retry maximum backoff, integer 0-60000
ui.promptHints    Comma-separated shortcut labels for the interactive prompt hint bar, or "off" to hide
toolPolicy.allowWritePaths    Comma-separated writable files or directories for patch tools
toolPolicy.denyWritePaths     Comma-separated files or directories blocked for patch tools
toolPolicy.deny              Comma-separated tool names to disable
toolPolicy.denyRisk          Comma-separated risk levels to disable: low, medium, high
toolPolicy.requireApproval   Comma-separated tool names that always require approval
toolPolicy.requireApprovalRisk
                             Comma-separated risk levels that always require approval
```

`OPENAI_API_KEY` is intentionally not stored in `.ccagent/config.json`. Use an
environment variable, or persist it per machine with `ccagent login --api-key
<key>` (see "Login" below).

### User-level config (Codex-style)

User-level defaults live at `~/.ccagent/config.json` (on Windows:
`C:\Users\<you>\.ccagent\config.json`) and apply to every workspace, so relay
settings do not have to be repeated per project. Precedence for `model`,
`ui.promptHints`, `openai.apiMode`, `openai.baseURL`, `openai.embeddingModel`, and
`openai.retry.*` is:

```text
environment variable > project .ccagent/config.json > user ~/.ccagent/config.json > built-in default
```

Manage user-level values with:

```powershell
ccagent --user-config-set model gpt-5.5
ccagent --user-config-set openai.apiMode chat
ccagent --user-config-set openai.baseURL https://api.wcgio.com/v1
ccagent --user-config-set openai.embeddingModel text-embedding-3-small
ccagent --user-config-set openai.retry.maxAttempts 4
ccagent --user-config-set ui.promptHints /help,/model,/config,/mcp
ccagent --user-config-get openai.baseURL
ccagent --user-config-unset openai.baseURL
```

User-level config only supports `model`, `ui.promptHints`, and `openai` keys;
project-scoped settings such as `mcp`, `context`, `autoApprove`, and `toolPolicy` stay in the workspace
`.ccagent/config.json`. The user directory can be overridden with the
`CCAGENT_USER_DIR` environment variable, which is also how tests isolate it.

### Login (`ccagent login`)

Like `codex login --api-key`, CCAgent can persist one API key per machine in
`~/.ccagent/auth.json` instead of relying on environment variables:

```powershell
ccagent login --api-key <your_api_key>
ccagent login                # print status, or read a piped key
ccagent login < key.txt      # store the key from stdin
ccagent logout               # remove the stored key
```

Key priority is `OPENAI_API_KEY` env > stored `auth.json` key > mock model.
The auth file is written with owner-only permissions on POSIX systems, CCAgent
never prints the stored key value, and `/doctor` and `/diagnostics export`
record only whether a key is configured and which source it came from.

### MCP stdio tools

CCAgent can discover and call tools from local MCP servers that use the stdio
transport. MCP is disabled by default. To enable it, edit `.ccagent/config.json`
and set `mcp.enabled` to `true`, then add one or more entries under
`mcp.servers`:

```json
{
  "mcp": {
    "enabled": true,
    "servers": {
      "example": {
        "command": "node",
        "args": ["C:/absolute/path/to/mcp-server.mjs"],
        "cwd": ".",
        "env": {
          "EXAMPLE_MODE": "local"
        },
        "timeoutMs": 30000
      }
    }
  }
}
```

`command` is required. `args`, `cwd`, `env`, and `timeoutMs` are optional.
Relative `cwd` values are resolved from the current workspace. The server name
and MCP tool name become a model-visible tool such as
`mcp_example_echo_text`. Server startup or discovery failures produce warnings
without disabling CCAgent's built-in tools. Use `/context` to inspect the
number of connected MCP servers and discovered tools.

Inspect MCP runtime state and the discovered tool catalog without calling the
model:

```powershell
ccagent --no-session /mcp
ccagent --no-session "/mcp tools"
ccagent --no-session "/mcp resources"
ccagent --no-session "/mcp templates"
ccagent --no-session "/mcp read example fixture://guide"
ccagent --no-session "/mcp prompts"
ccagent --no-session '/mcp prompt example review {"path":"src/agent.ts"}'
ccagent --no-session "/mcp reload"
ccagent --no-session "/mcp --json"
ccagent --no-session "/mcp tools --json"
```

`/mcp` reports configured, connected, unavailable, and disabled servers. The
tool catalog shows model-facing names such as `mcp_example_echo_text`. JSON
output omits server environment variables and argument lists.

In interactive mode, run `/mcp reload` after editing MCP configuration. CCAgent
closes the previous MCP child processes, rereads the config, rediscovers tools,
and replaces only the MCP portion of the live tool registry. The current
conversation, plan, model, and built-in tools remain active.

`/mcp resources` lists resources advertised by connected servers. Use
`/mcp read <server> <uri>` to fetch one explicitly. Text content is capped to
the same bounded MCP output size as tools; binary data is not printed and is
reported as omitted. Resources are never injected into model context
automatically.

`/mcp templates` lists parameterized resource URI templates such as
`docs://project/{topic}`. CCAgent does not guess or automatically expand
variables; replace them explicitly and pass the resolved URI to `/mcp read`.

`/mcp prompts` lists prompt templates. Use `/mcp prompt <server> <name>` to
retrieve one, optionally followed by a JSON object whose values must all be
strings. Prompt messages are bounded and non-text content is omitted or safely
summarized. Retrieved prompts are displayed for review and are never executed
or injected into the current model automatically.

MCP server maps are not supported by `--config-set`; edit the JSON file
directly for advanced fields. For basic local stdio servers, use:

```powershell
ccagent --mcp-add filesystem npx -- -y @modelcontextprotocol/server-filesystem .
ccagent --mcp-disable
ccagent --mcp-enable
ccagent --mcp-remove filesystem
```

`--mcp-add` saves the name, command, and arguments, then enables MCP for the
next CCAgent run. It refuses to overwrite an existing name. `--mcp-disable`
keeps saved servers but prevents their startup. Edit JSON directly when you
need `cwd`, `env`, or `timeoutMs`; keep API keys in environment variables rather
than command arguments or the config file.

Enabling a server starts its configured command as a local child process, so
only enable commands and packages you trust. MCP tools always ask for approval
before execution. Child processes inherit the current environment.

The current MCP integration supports stdio tools plus explicit resource,
resource-template, and prompt operations. Subscriptions, prompt completion,
HTTP transports, and OAuth are not implemented yet.

Inspect the active runtime model settings without calling the model:

```powershell
ccagent --no-session /model
ccagent --no-session /models
```

`/model` shows the active client, configured model source, API mode source,
base URL source, and whether `OPENAI_API_KEY` is set. It never prints the key.

Test the current model client with one tiny prompt:

```powershell
ccagent --no-session /model-smoke
ccagent --no-session /model-smoke "Reply in Chinese with OK"
ccagent --no-session /model-smoke --stream "Reply in Chinese with OK"
ccagent --no-session /model-smoke --tool
ccagent --no-session /model-smoke --stream --tool
ccagent --no-session /providers
ccagent --no-session /provider-smoke
ccagent --no-session /provider-smoke --json
ccagent --no-session /provider-smoke --full
ccagent --no-session /provider-smoke --full --save
ccagent --no-session /provider-smoke --profile full --json
ccagent --no-session /provider-repair
ccagent --no-session /provider-repair --task date-pad
ccagent --no-session /provider-repair --attempts 2 --save
ccagent --no-session /provider-repair --json
ccagent --no-session /provider-repair-reports
ccagent --no-session /provider-repair-compare
ccagent --no-session /provider-repair-gate
ccagent --no-session /provider-reports
ccagent --no-session /provider-reports --json
ccagent --no-session /provider-profiles
ccagent --no-session /provider-profiles add
ccagent --no-session /provider-profiles add provider-smoke-2026-07-15T10-02-55-005Z.json
ccagent --no-session /provider-profiles use relay-example-chat-gpt-5-5
ccagent --no-session /provider-compare
ccagent --no-session /provider-compare --json
ccagent --no-session /provider-gate
ccagent --no-session /provider-gate --json
```

`/model-smoke` calls the current model client and prints the response, duration,
streaming status, tool-call count, and usage when the provider returns it.
Without a prompt, it uses `Reply with exactly: OK`. Add `--stream` to test
streamed text deltas. Add `--tool` to ask the model for a `smoke_ping` tool
call without executing any real tool. It does not update the conversation or
session history.

`/providers` prints an offline provider compatibility matrix with the active
API mode, active base URL, detected profile, recommended setup commands, and
when to prefer `chat` versus `responses` mode. It does not call the model.

`/provider-smoke` runs three quick provider compatibility probes through the
same model client: plain text, streaming text deltas, and a `smoke_ping`
tool-call request. Add `--full` or `--profile full` to also test Unicode text
and streaming tool calls. It prints per-probe pass/fail status, client kind,
API mode, base URL, profile, usage when available, and short response snippets.
It also prints a provider diagnosis with warnings and recommended actions, such
as setting `OPENAI_API_KEY`, switching relay providers from `responses` to
`chat`, checking SSE streaming, or confirming tool/function-call support. Use it
after changing relay settings or model IDs. Add `--json` for machine-readable
probe results and diagnosis. Add `--save` to write Markdown and JSON reports
under `.ccagent/reports/`; saved Markdown reports include the same diagnosis
and a compatibility profile. The profile marks the run as `mock-only`,
`failed`, `partial`, or `known-good`, lists text/unicode/streaming/tool-call
capabilities, and includes reuse commands for the model, API mode, and base URL.
Only a real-key full profile with all probes passing should be treated as
`known-good`.
Use `/provider-profiles add` to save the latest `known-good` report into
`.ccagent/provider-profiles.json`, or pass a specific `provider-smoke-*.json`
file name. Mock-only, partial, or failing reports are rejected so the profile
registry stays trustworthy. Use `/provider-profiles` to list saved profiles.
Use `/provider-profiles use <id>` to apply a saved profile back into
`.ccagent/config.json`; it writes `model`, `openai.apiMode`, and
`openai.baseURL` or unsets the base URL for the official OpenAI endpoint.
Use `/provider-repair` after a real full provider smoke pass to run a controlled
repair benchmark through the current model. It builds a temporary broken project
for each repair task, runs verification, asks the model to repair it through the
same agent tool loop, and removes the fixtures afterward. By default it runs
every repair task (`order-service`, `truncate-boundary`, `date-pad`,
`cross-module-contract`, `rounding-boundary`) and reports
a per-task summary; pass `--task <name>` to run a single task. Add `--save` to
write a Markdown and JSON benchmark report under `.ccagent/reports/`. Without
`OPENAI_API_KEY`, it reports `SKIP` and does not call the model.
Use `/provider-repair-reports` to list saved repair benchmark reports. Use
`/provider-repair-compare` to compare the latest two reports, and
`/provider-repair-gate` in CI or local release checks; it exits non-zero when
the latest repair status regresses, for example from `pass` to `skip` or `fail`.
Use `/provider-reports` to list saved provider smoke reports later. Use
`/provider-compare` to compare the latest two saved reports. Use
`/provider-gate` in CI; it returns a non-zero exit code when failed probes
increase, passed probes decrease, or a previously passing probe disappears.

Real provider calls classify failures before reporting them. Transient errors
such as 429 rate limits, timeouts, network resets, and 5xx server failures are
retried with bounded exponential backoff. Final failures include the error kind,
retryability, attempt count, HTTP status, and provider code when available.

`/code-map` shows the repo's learning map, key files, and study order.
`/code-map export` writes a Markdown report under `.ccagent/reports/`.
`/roadmap` shows the current completion estimate and next recommended work.

Tool policy is enforced before tool execution. `deny` blocks a tool even if the model asks for it; `denyRisk` blocks tools by their preflight risk level. `allowWritePaths` and `denyWritePaths` constrain `apply_patch` and `reverse_patch` by file path. `requireApproval` makes named tools ask before running; `requireApprovalRisk` does the same by risk level.
Use `/permissions` when you want a readable summary of built-in approval rules, this run's `--allow-edits` / `--verify` flags, auto-approved shell commands, and project tool policy.

## Offline Evals

Run the built-in mock-agent eval suite:

```powershell
ccagent --no-session /evals
ccagent --no-session /evals smoke
ccagent --no-session /evals regression
ccagent --no-session /evals regression --tag repair
ccagent --no-session /evals regression --tag retrieval
ccagent --no-session /evals benchmark
ccagent --no-session /evals benchmark --tag tool --iterations 1
ccagent --no-session /evals cases
ccagent --no-session /evals cases regression
ccagent --no-session /evals cases regression --tag repair
ccagent --no-session /evals tags regression
ccagent --no-session /evals case repair_loop_bad_patch_recovery
ccagent --no-session /evals case repair_loop_wrong_file_recovery
ccagent --no-session /evals case repair_loop_partial_multifile_recovery
ccagent --no-session /evals case repair_loop_multifile
ccagent --no-session /evals case repair_loop_service_contract
ccagent --no-session /evals case repair_loop_renamed_api_contract
ccagent --no-session /evals case repair_loop_stale_import_contract
ccagent --no-session /evals case repair_loop_contract_drift
ccagent --no-session /evals case repair_loop_multi_caller_contract_drift
ccagent --no-session /evals case repair_loop_cascading_dependency_chain
ccagent --no-session /evals case repair_loop_ambiguous_test_signal
ccagent --no-session /evals case repair_loop_large_repo_retrieval
ccagent --no-session /evals case context_graph_retrieval
ccagent --no-session /evals case repair_loop_process_cleanup
ccagent --no-session /evals case repair_loop_service_readiness
ccagent --no-session /evals case repair_loop_project_fixture
ccagent --no-session /evals case verification_environment_failures
ccagent --no-session /evals case verification_flaky_guard
ccagent --no-session /evals report
ccagent --no-session /evals report smoke
ccagent --no-session /evals reports
ccagent --no-session /evals compare
ccagent --no-session /evals compare --max-duration-delta 100
ccagent --no-session /evals baseline
ccagent --no-session /evals baseline smoke
ccagent --no-session /evals gate
ccagent --no-session /evals gate --max-duration-delta 50 --json
ccagent --no-session /evals gate --against baseline-smoke --strict
ccagent --no-session /evals --json
```

Development scripts wrap the same commands through `tsx src/index.ts`, so they
work before building `dist/`:

```powershell
npm run evals:smoke
npm run evals:regression
npm run evals:regression -- --tag repair
npm run evals:regression -- --tag retrieval
npm run evals:benchmark
npm run evals:benchmark -- --tag tool --iterations 1
npm run evals:cases
npm run evals:cases -- regression
npm run evals:cases -- regression --tag repair
npm run evals:tags -- regression
npm run evals:baseline
npm run evals:case -- repair_loop_bad_patch_recovery
npm run evals:case -- repair_loop_wrong_file_recovery
npm run evals:case -- repair_loop_partial_multifile_recovery
npm run evals:case -- repair_loop_multifile
npm run evals:case -- repair_loop_service_contract
npm run evals:case -- repair_loop_renamed_api_contract
npm run evals:case -- repair_loop_stale_import_contract
npm run evals:case -- repair_loop_contract_drift
npm run evals:case -- repair_loop_multi_caller_contract_drift
npm run evals:case -- repair_loop_cascading_dependency_chain
npm run evals:case -- repair_loop_ambiguous_test_signal
npm run evals:case -- repair_loop_large_repo_retrieval
npm run evals:case -- context_graph_retrieval
npm run evals:case -- repair_loop_process_cleanup
npm run evals:case -- repair_loop_service_readiness
npm run evals:case -- repair_loop_project_fixture
npm run evals:case -- verification_environment_failures
npm run evals:case -- verification_flaky_guard
npm run evals:report
npm run evals:reports
npm run evals:gate
npm run baseline:update
npm run baseline:gate
npm run provider:smoke
npm run provider:smoke:full
npm run provider:report
npm run provider:reports
npm run provider:compare
npm run provider:gate
npm run provider:repair
npm run provider:repair:report
npm run provider:repair:reports
npm run provider:repair:compare
npm run provider:repair:gate
npm run provider:ci
```

After `npm run build`, run the same large-repository case through the generated
CLI to confirm that `dist/` matches the TypeScript source:

```powershell
node dist/index.js --no-session /evals case repair_loop_large_repo_retrieval
```

The offline evals use temporary workspaces and the mock model, so they do not
call a real provider. `context_graph_retrieval` directly measures exact-definition MRR, depth-two graph recall, hybrid recall, and distractor leakage; run it alone or with `--tag retrieval`. `smoke` checks listing and reading files, `regression`
covers plan updates, patch flows, task workflows, missing-text recovery, repair
loops, bad-patch repair recovery, wrong-file repair recovery, partial multi-file repair recovery, multi-file repair loops, service/API contract repair, renamed API repair, stale import repair, cross-file contract drift repair, multi-caller contract drift repair, cascading dependency-chain repair, ambiguous test-signal repair, large-repository cross-module retrieval and repair behind more than 500 distractor files, process-cleanup repair with timed-out process-tree termination, local service startup/readiness repair with bounded health polling, generated-artifact protection, flaky-test repair blocking, environment-prerequisite diagnosis, and verification failure repair strategies. Readiness repair requires a deadline, preserves the final connection error, keeps the real health assertion, and cleans up the started service instead of using fixed sleeps or unbounded retries.
Benchmark runs default to three iterations. Use `--iterations 1` for a quick local timing check or increase it up to 20 for a steadier measurement; combine it with `--tag` to benchmark one capability group without running the full matrix.
`baseline` pins the latest report of a suite into `.ccagent/reports/eval-baseline-<suite>.json` (re-running replaces the pin), so `gate --against baseline-<suite>` compares fresh runs against a stable, reviewed baseline instead of only the previous run. `gate` also checks case coverage: an untagged run that omits expected cases from its suite manifest is reported as a regression. `--strict` makes `gate` fail whenever the latest report contains failed cases or the comparison is informational, so a green gate can never hide failing eval cases.
`benchmark` repeats all cases and reports average durations. `report` writes a
Markdown file under `.ccagent/reports/`.
`reports` lists saved report history, `compare` compares the latest two, and
`gate` compares the latest two with a default 100ms duration threshold.
Add `--max-duration-delta <ms>` to flag duration regressions for same-suite
reports and return exit code 1 when the threshold is exceeded. `npm run
evals:gate` uses a 100ms threshold by default. Override it with
`CCAGENT_EVAL_MAX_DURATION_DELTA=50` or `npm run evals:gate -- --max-duration-delta
50`; add `--against baseline-smoke` to gate against a pinned baseline and
`--strict` to fail on any failing case. The normal workflow is: pin a baseline
with `npm run evals:baseline`, make changes, save another report, then run
`npm run evals:gate -- --against baseline-smoke --strict`. Add `--json` when
you want machine-readable output.

For committed gating, the repository version-controls a smoke baseline at
`tests/fixtures/eval-baseline-smoke.json`. `npm run baseline:gate` copies that
fixture in, exports a fresh smoke report, and gates the report against the
committed baseline in `--strict` mode; CI runs it on every commit. When a
behavior change is reviewed and accepted, refresh the committed baseline with
`npm run baseline:update` and commit the updated fixture. Both scripts accept
`CCAGENT_BASELINE_FIXTURE` to point at an alternative fixture path.

## Real-repository retrieval manifests

`tests/fixtures/retrieval-manifests/` hosts retrieval eval manifests for
several real published repositories (`debug@4.4.1`, `kleur@4.1.5`,
`picomatch@4.0.2`) whose cases point at exact definitions in the shipped
files. Thresholds are pinned to measured lexical/automatic recall and MRR,
so an index regression trips the gate.

Run every suite against freshly downloaded pinned tarballs (needs network):

```bash
npm run retrieval:manifests -- --fetch
```

Or against an existing extraction (this writes
`.ccagent/retrieval-eval.json` inside the target repository):

```bash
npm run retrieval:manifests -- debug --target <path-to-extracted-repo>
```

Each suite runs `/index build` and `/index eval run --json`, prints the
lexical and automatic scores per repository, and exits non-zero when a
suite drops below its measured thresholds. The picomatch `posix-entry`
case documents the remaining re-export discovery gap. CommonJS
`exports.name =` symbols are extracted so cross-file identifier queries
rank their definition files first (see `tests/symbols.test.ts`).

## Project Instructions

Create `CCAGENT.md` in the workspace root to add project-specific guidance to the model's system prompt:

```bash
ccagent --init-instructions
```

The command creates a starter file only when `CCAGENT.md` is missing; it does not overwrite existing instructions.

```md
# CCAgent Instructions

- Prefer Chinese responses for this project.
- Inspect relevant files before editing.
- Use apply_patch for file edits; do not edit files with shell commands.
- Run npm test before summarizing code changes when practical.
- Never store OPENAI_API_KEY or other secrets in project files.
```

Inspect what was loaded:

```bash
ccagent --no-session /instructions
ccagent --no-session /context
ccagent --no-session /suggest-context "provider smoke"
ccagent --no-session /index build
ccagent --no-session /index search "provider smoke"
ccagent --no-session /index eval init
ccagent --no-session /index eval status
ccagent --no-session /index eval run
ccagent --no-session /index semantic build
ccagent --no-session /index semantic search "relay compatibility"
ccagent --no-session /symbols search provider
ccagent --no-session /verify-suggest src/model.ts
ccagent --no-session /verify-run src/model.ts
ccagent --no-session /verify-last
ccagent --no-session /verify-failure
ccagent --no-session /verify-rerun
ccagent --no-session /verify-stability 3
ccagent --no-session /verify-clear
ccagent --no-session /repair-last
ccagent --no-session /repair-preview
ccagent --no-session /repair-run
ccagent --no-session /repair-loop 2
ccagent --no-session /prompt
ccagent --no-session /code-map
ccagent --no-session /code-map export
ccagent --no-session /roadmap
```

`CCAGENT.md` is read at startup. If you edit it while interactive mode is already running, restart `ccagent` to load the new content.

`/context` summarizes the runtime state that shapes the agent loop: workspace, model, run flags, config, project instructions, project commands, project skills, system prompt size, registered tools, and session state.
`/suggest-context <query>` scans workspace file names and small text snippets, then ranks likely files to read next. It is a lightweight local relevance pass. The scan keeps a 500-file budget and rotates across directories, taking at most 20 files from one directory per pass, so a large early-sorted module cannot hide relevant files in sibling modules.
`/index build` writes a persistent local context index to `.ccagent/index/context-index.json`. Later builds reuse unchanged file tokens, previews, symbols, and module edges based on file metadata, rebuild only changed files, and report cache status as `miss`, `partial`, or `reused`; adding or deleting files also refreshes graph resolution. The module graph understands relative imports plus root `tsconfig.json`/`jsconfig.json` `baseUrl` and `paths` aliases, including relative and package-based multi-level `extends`, JSONC comments, trailing commas, wildcard targets, and target fallback order. Package-based configs can be resolved from workspace `node_modules` through explicit config paths, omitted `.json` extensions, and `package.json#tsconfig`; inherited configs are read for workspace alias resolution but dependency directories are never added to the local index. Changing any inherited alias config forces a full edge refresh. It also discovers npm/Yarn `package.json#workspaces` and pnpm workspace manifests, resolves workspace package names and subpaths through `exports`, `source`, `types`, `module`, `main`, and source-index fallbacks, and refreshes edges when package manifests change. TypeScript project references become `project reference` edges, while `/// <reference path="...">` and `/// <reference types="...">` become `type reference` edges. When that index already exists, ordinary CLI tasks automatically refresh it at a bounded interval, retrieve up to five relevant files within a fixed character budget, and attach the evidence to the current model request without changing the saved user message. If a local `local-hash-v1` semantic index also exists, automatic context fuses normalized lexical and semantic rankings, gives agreement between both channels a boost, and can include conceptually related files that contain none of the exact query terms. Remote embedding indexes are not called automatically, so this path cannot silently spend provider credits. Successful patch and shell tools invalidate the automatic context for the next task. A missing lexical index is not created implicitly; run `/index build` once to opt in, optionally run `/index semantic build` for hybrid retrieval, or set `context.auto` to `false` to disable automatic retrieval. `/index search <query> [limit]` searches the lexical index directly, reads only top matching files for snippets, and marks results as stale when a file changed after the last build. The lexical index also stores local import/re-export/require edges plus file-level symbols. Search performs a bounded two-level graph walk around its strongest lexical matches, prioritizes query-matching imported symbols and tests, and attenuates deeper graph scores so it can surface nearby dependencies and callers without displacing exact symbol definitions.
JavaScript and TypeScript module references are parsed with the TypeScript AST, including multiline imports, original and local alias names, re-exports, CommonJS `require`, dynamic imports, and `import("...")` type references. This avoids comment/string false positives and gives graph ranking both sides of aliased symbols.

A bounded TypeChecker pass follows aliases through barrel re-exports and stores separate `symbolEdges` from a consumer to the final workspace declaration. Search traverses these together with syntax-level module edges, so an exact definition can reach indirect callers in one hop. The pass is limited to 500 source files, 16 MB of source text, 2,000 edges, and 30 symbols per edge; it is loaded only while building the context graph, so ordinary CLI commands do not pay the TypeScript startup cost. Dependency declarations are ignored unless their final declaration maps back to an indexed workspace file.

`/index eval init` creates `.ccagent/retrieval-eval.json`. Add repository-specific queries and expected files, build the lexical index, optionally build the local semantic index, then run `/index eval run`. The command reports macro Recall@K and MRR for direct lexical search and the same automatic retrieval path used for model context. Missing expected files or metrics below the configured thresholds produce `Status: FAIL`; `--json` emits a machine-readable result for CI.

```json
{
  "version": 1,
  "k": 5,
  "thresholds": {
    "lexicalRecallAtK": 0.8,
    "lexicalMrr": 0.5,
    "automaticRecallAtK": 0.8,
    "automaticMrr": 0.5
  },
  "cases": [
    {
      "name": "context-index-definition",
      "query": "ContextIndexSearchResult",
      "expected": ["src/contextIndex.ts"]
    }
  ]
}
```

`/index semantic build` writes a chunk-level semantic vector index to `.ccagent/index/semantic-index.json`. By default it uses the deterministic offline `local-hash-v1` vectorizer, so it works without an API key. Rebuilds reuse unchanged file chunks by content hash and invalidate the cache when the provider or embedding model changes. Set `OPENAI_API_KEY` plus `openai.embeddingModel` or `CCAGENT_EMBEDDING_MODEL` to build and search the same index through an OpenAI-compatible `/v1/embeddings` provider. Search results include `path:start-end` line ranges so the agent can read the most relevant part of a large file first.
`/symbols [limit]` builds a lightweight local symbol index from source files and Markdown headings.
`/symbols search <query> [limit]` searches classes, functions, exports, tests, and headings without reading whole files into the model context.
`/verify-suggest [paths...]` reads `package.json` scripts and suggests verification commands for explicit paths, or changed files from `git status` when no paths are passed.
`/verify-run [paths...]` runs the suggested commands sequentially through `run_shell`; each command still follows approval and auto-approve rules.
`/verify-last` runs the same approval-gated verification flow for the most recent patch's recorded paths.
`/verify-failure` prints the last stored verification failure, including command, paths, locations, summary, remediation, and a short output excerpt. After a repair patch, failure details may be cleared while the rerun target remains available.
`/verify-rerun` reruns the exact failed command stored by `/verify-run` or `/verify-last`, including after a repair patch clears failure details. If it passes, the stored rerun target is cleared; if it fails again, the failure summary, remediation, and repair prompt context are refreshed.
`/verify-stability [runs]` repeats the stored command 3 times by default, with a maximum of 10. A mix of passes and failures is recorded as `flaky` and blocks `/repair-preview` plus `/repair-last`; repeated failures are recorded as stable repair evidence; repeated passes clear the verification state.
`/verify-clear` clears the stored failure and rerun target without clearing chat history, plan, patch snapshots, or the last patch record.
`/repair-last` starts a normal tool-using agent loop from the most recent verification failure stored in the current session. It includes failure-specific repair strategy for common TypeScript, test-runner, npm-script, and generic command failures, and it automatically reads likely repair files before the first patch attempt. When a failure has no source location, it also extracts test files referenced by the executed command while excluding generated and dependency directories such as `dist`, `build`, `coverage`, and `node_modules`. It is most useful in interactive/session mode; `--no-session` will not preserve a failure from a previous process.
`/repair-preview` prints the repair prompt that `/repair-last` would send to the model, which is useful while learning or debugging repair behavior. When a recent patch exists, the prompt includes recent patch paths and a stale-context guard to reread current file contents before another patch.
`/repair-run` combines `/repair-last` and `/verify-rerun`: it lets the agent attempt the repair, then reruns the stored verification target through the same approval-gated shell path.
`/repair-loop [attempts]` repeats `/repair-run` behavior while verification keeps failing. It defaults to 2 attempts and refuses values above 5 to avoid runaway edit/test loops. Each attempt reports whether a patch was applied, which paths changed, and the patch snapshot. If a patch fails because hunks no longer match current files, `apply_patch` reports a stale-context diagnosis plus suggested `read_file` calls; the repair loop automatically rereads those files and includes their current contents in the next repair prompt. If the model applies a patch but verification still fails, the loop reports that it is continuing to the next attempt. If the model attempts a patch but it fails to apply, the loop also continues to the next attempt; if the model does not attempt a patch and verification is still failing, the loop stops early.
Failed verification runs include a short summary with exit code, likely cause for common runners, next step, file location, remediation suggestions, and key stderr/stdout lines before the full output.
Environment-related failures are classified before outer npm wrapper errors. Missing environment variables, occupied ports, network/DNS failures, and missing system commands produce environment-specific remediation and block automatic source repair until the prerequisite is resolved or repository configuration is explicitly proven wrong. On PowerShell, inspect variables with `Get-Item Env:<NAME>`, commands with `Get-Command <name>`, and listening ports with `Get-NetTCPConnection -LocalPort <port>`.
`/prompt` prints the effective system prompt after `CCAGENT.md` is merged in.
`/code-map` summarizes the key files and learning order for the repository.
`/code-map export` writes a Markdown code map report under `.ccagent/reports/`.
`/roadmap` prints the current completion estimate and next recommended work.

## Project Skills

Project skills are reusable workflow guidance that the Agent can discover and
read only when relevant to the current task. They differ from Project Commands:
commands are prompt templates that you explicitly run, while skills teach the
Agent how to handle a type of work.

Each skill lives in its own directory:

```text
.ccagent/skills/<name>/SKILL.md
```

Create a starter skill without overwriting an existing file:

```bash
ccagent --init-skill code-review
```

List or inspect skills without calling the model:

```bash
ccagent --no-session /skills
ccagent --no-session /skill code-review
```

`SKILL.md` can start with optional metadata:

```md
---
description: Review code for correctness, regressions, and missing tests.
tags: review, safety
---

# Code Review

Read the changed files and relevant tests before reporting findings.
Run focused verification for every proposed fix.
```

The model-facing `list_skills` tool discovers names and summaries. The Agent
then calls `read_skill` only for guidance relevant to the task, so every skill
is not injected into every prompt. Interactive Tab completion supports
`/skill <name>`. Names may contain 1-64 letters, numbers, dashes, or underscores.
Skill files larger than 64 KiB are ignored and reported as warnings.

## Project Commands

Reusable command templates live in:

```text
.ccagent/commands/
```

Create a starter command template:

```bash
ccagent --init-command review
```

The command creates `.ccagent/commands/review.md` only when it is missing; it does not overwrite existing command files.

Each `*.md` file becomes a command. For example:

```text
.ccagent/commands/review.md
.ccagent/commands/test.md
```

List available commands:

```bash
ccagent --no-session /commands
ccagent --no-session /commands review
ccagent --no-session /commands --check
```

`/commands --check` reports command loading warnings, empty templates, and required-argument commands that do not declare `usage`.

Inspect one command:

```bash
ccagent --no-session /command review
ccagent --no-session /command r
```

Preview a command without calling the model:

```bash
ccagent --no-session /cmd-preview review src/agent.ts
```

Run a command:

```bash
ccagent --no-session /cmd review src/agent.ts
ccagent --no-session /cmd test
```

Optionally start a command template with metadata:

```md
---
description: Review code or workspace areas for bugs, regressions, and missing tests.
aliases: r
tags: review, safety
usage: /cmd review <path-or-topic>
args: required
confirm: true
---

# Review {{args}}

Review the requested code or workspace area.
```

Supported metadata keys are `description`, `aliases`, `tags`, `params`, `param.<name>`, `usage`, `args`, and `confirm`. `description`, `aliases`, `tags`, `params`, `param.<name>`, and `usage` are shown by `/commands` and `/cmd-preview`, but they are not sent as part of the expanded prompt. Set `aliases: r, rv` to add shorthand names for `/cmd` and `/cmd-preview`. Set `tags: review, safety` to group commands and filter them with `/commands review`. Set `args: required` to reject `/cmd <name>` when no arguments were provided. Set `confirm: true` to require approval before `/cmd` runs the expanded prompt.

Use `{{args}}` inside a template to receive command arguments.

If a template does not contain `{{args}}`, CCAgent appends the arguments under an `Arguments:` section.

Templates can also declare named placeholders such as `{{file}}` and `{{topic}}`:

```md
---
params: file, topic
param.file: File or path to review.
param.topic: Review focus.
usage: /cmd review --file <path> --topic <topic> [notes]
---

# Review {{file}}

Focus: {{topic}}
Notes: {{args}}
```

Pass named values with `--name value` or `--name=value`:

```bash
ccagent --no-session /cmd-preview review --file src/agent.ts --topic security extra notes
```

When a template uses named placeholders, those values are required. `{{args}}` receives the remaining positional arguments after named values are removed.

Declare named placeholders with `params: file, topic` so `/commands --check` can warn when the template, `params`, and `usage` drift apart. Add optional `param.file: File or path to review.` lines to document named parameters in `/commands`, `/command`, and `/cmd-preview`; `/commands --check` warns when a parameter description references a parameter that is not declared or used.

## Session

Session state is saved at:

```text
.ccagent/sessions/current.json
```

This folder is ignored by git.

Use `--no-session` before the prompt to start with an empty context and skip all session writes:

```bash
ccagent --no-session read package.json
```

The session also stores the current `/plan` task list, `/task-state` checkpoint, and the most recent applied patch, so `/undo` and task continuity can work after restarting the CLI.

Use `/session` for a compact summary, `/session show` to inspect the current session metadata, saved plan, and recent message previews, `/session stats` to inspect session size and rough token estimates, or `/session search <query>` to find whether a detail still exists in the current conversation context:

```bash
ccagent /session show
ccagent /session show --limit 3
ccagent /session stats
ccagent /session search ModelClient
```

`/session show` displays the 8 most recent messages by default. Use `--limit <count>` when you want a smaller or larger preview without printing the full conversation history.

`/history` shows recent conversation messages by default. Use `/history 5` to choose a smaller window or `/history --all` when you need the full local conversation history.

Named checkpoints let you save and restore the agent's conversation, plan, task state, response linkage, and last patch metadata without changing project files:

```bash
ccagent /checkpoint save before-edit
ccagent /checkpoint
ccagent /checkpoint backups
ccagent /checkpoint show before-edit
ccagent /checkpoint show before-edit --limit 3
ccagent /checkpoint stats before-edit
ccagent /checkpoint search before-edit ModelClient
ccagent /checkpoint diff before-edit after-edit
ccagent /checkpoint diff-current before-edit
ccagent /checkpoint load before-edit
ccagent /checkpoint delete before-edit
```

`/checkpoint show <name>` prints checkpoint metadata, the saved plan, and recent message previews without loading it. Use `--limit <count>` to choose how many recent messages to preview. `/checkpoint stats <name>` summarizes checkpoint size, rough token estimates, plan counts, and largest messages. `/checkpoint search <name> <query>` searches messages inside a saved checkpoint without loading it. `/checkpoint diff <left> <right>` compares message counts, common message prefix, plan changes, last patch metadata, and messages added on the right side. `/checkpoint diff-current <name>` compares a saved checkpoint with the current in-memory session. Checkpoint files live under `.ccagent/sessions/checkpoints/`, which is also ignored by git. Checkpoint names may contain only letters, numbers, dashes, and underscores.

In interactive mode, Tab completes saved checkpoint names for `/checkpoint show`, `/checkpoint stats`, `/checkpoint search`, `/checkpoint diff`, `/checkpoint diff-current`, `/checkpoint load`, and `/checkpoint delete`.

Before `/checkpoint load <name>` replaces the current session, CCAgent automatically saves the current session as a `before-load-...` checkpoint so you can inspect or restore the previous context later.
Use `/checkpoint backups` to list only those automatic before-load backups.

## Context Compaction

CCAgent automatically compacts long local conversation history into one assistant summary message. This keeps persisted sessions and Chat Completions history smaller while preserving recent messages.

Use these commands to inspect or trigger it manually:

```bash
ccagent --no-session /compact-status
ccagent /compact
```

Compaction keeps the most recent messages, summarizes older messages with a `[context summary]` prefix, restores the model client's local history from the compacted conversation, and clears stale Responses API linkage.

## Plan Mode

Use plan commands when a task has multiple steps:

```text
/plan
/plan add inspect project structure
/plan add implement the change
/plan start 1
/plan done 1
/plan pending 1
/plan drop 1
/plan clear
```

The model can also call the `update_plan` tool during natural-language tasks. With the mock model, this is easy to see:

```bash
ccagent --verbose "plan inspect files; write tests"
```

Use task state commands when a task spans multiple edits or verification passes and you want a compact checkpoint separate from the full chat history:

```text
/task-state
/task-state set improve provider relay compatibility
/task-state step add provider smoke regression test
/task-state note implemented retry checks; still need real relay run
/task-state files --mode=merge src/model.ts tests/model.test.ts
/task-state status active
/task-state resume
/task-state clear
```

The model can also call `update_task_state` during natural-language tasks. When a task state exists, successful patches merge changed files into it, failed verification marks it `blocked`, and passing verification records the latest verification command. Use `/task-state resume` after a restart or context compaction to generate a compact continuation prompt from the task state, plan, recent patch, and verification target.

## File Editing Flow

The mock model includes a small patch demo for learning the editing loop:

```bash
ccagent --allow-edits --verbose "patch demo.txt hello"
```

It also includes an existing-file edit demo:

```bash
ccagent --allow-edits --verbose "replace demo.txt hello => hi"
```

Add `--verify` to run a test command immediately after the patch:

```bash
ccagent --allow-edits --verify "npm test" --verbose "replace demo.txt hello => hi"
```

Patch approval now groups changed files by risk before showing the raw diff.
Each successful patch writes a pre-edit snapshot under `.ccagent/patch-snapshots/`.
That snapshot captures the files referenced by the patch before the edit lands.
Use `/snapshots` to list saved pre-edit snapshots, `/snapshots history` to review rollback points with restore commands, `/snapshots show <file>` to inspect captured files, and `/snapshots restore <file> <path>` to restore one captured file after approval. Restores honor `toolPolicy.allowWritePaths` and `toolPolicy.denyWritePaths`.

Use `task replace` when you want the mock model to exercise the full workflow:

```bash
ccagent --allow-edits --verify "npm test" --verbose "task replace demo.txt hello => hi"
```

Add `--stream` when you want to see model text as it arrives:

```bash
ccagent --stream --allow-edits --verify "npm test" "task replace demo.txt hello => hi"
```

Undo the most recently applied patch:

```bash
ccagent --allow-edits /undo
ccagent --allow-edits /snapshots
ccagent --allow-edits /snapshots history
```

That path goes through the same pieces as a real edit:

```text
User prompt
  -> ModelClient optionally streams text_delta events
  -> ModelClient returns update_plan tool call for task mode
  -> Agent streams tool_preflight / tool_start / tool_approval / tool_finish events
  -> ModelClient returns read_file tool call
  -> Agent sends file content back to the model
  -> ModelClient returns apply_patch tool call
  -> Agent asks for approval
  -> --allow-edits approves apply_patch
  -> ApplyPatchTool validates paths and runs git apply
  -> Agent records the patch so /undo can reverse it later
  -> Agent runs the --verify command
  -> ModelClient returns update_plan tool call marking the task complete
  -> Session records the turn
```

## Debug Mode

Use `--verbose` or `CCAGENT_DEBUG=1` when you want to study the agent loop. Debug output includes runtime creation, model turn requests, model results, tool calls, tool results, and approval decisions.

## Audit Logs

Audit logs are written as JSON Lines under:

```text
.ccagent/logs/
```

Each tool call records `tool_preflight`, `tool_start`, and `tool_finish`; approval-gated tools also record `tool_approval` events. `tool_preflight` is a transparency layer: it classifies risk, workspace impact, policy denial, and approval need before execution, but the existing approval rules still decide whether the tool can run. Model turns record `model_turn` metadata such as model name, round, duration, response id, content length, requested tool names, and token usage when the provider returns usage data; they do not store prompts, API keys, or full model responses. Tool audit events include a `callId` so the preflight, start, approval, and finish records for the same tool call can be correlated. Project command detail, preview, and run paths record `project_command` events with command name, requested alias/name, arguments, status, and summary. These logs are for replaying the agent's execution path after a run and are ignored by git. Use `/audit-timeline` to group raw events into tool-call steps with status and duration. Use `/model-trace` to inspect model turn metadata, tokens, and optional cost estimates. Use `/usage-summary` to summarize token usage and optional cost across the latest log or all logs. Use `/usage-models` to compare token usage by model. Use `/audit-export` to write summary or call-level JSON files under `.ccagent/exports/`. Use `/audit-report` to write a readable Markdown report under `.ccagent/reports/`.

Cost estimates are off by default because relay providers may use different prices. Set these environment variables when you want `/model-trace`, `/usage-summary`, and `/usage-models` to estimate cost from recorded token counts:

```powershell
$env:CCAGENT_INPUT_USD_PER_1M_TOKENS="2"
$env:CCAGENT_OUTPUT_USD_PER_1M_TOKENS="10"
```

Set optional budget limits when you want `/usage-summary` and `/usage-models` to show an `ok`, `exceeded`, or `incomplete` budget line:

```powershell
$env:CCAGENT_MAX_TOTAL_TOKENS="200000"
$env:CCAGENT_MAX_COST_USD="1.00"
```

Inspect the latest audit log from the CLI:

```bash
ccagent --no-session /audit
ccagent --no-session /audit 10
ccagent --no-session /audit --all 20
ccagent --no-session /audit --jsonl --all 20
ccagent --no-session /audit-replay --all 20
ccagent --no-session /audit-timeline --all 20
ccagent --no-session /model-trace --all 20
ccagent --no-session /usage-summary --all
ccagent --no-session /usage-models --all
ccagent --no-session /audit-call --all local-example-1
ccagent --no-session /audit-summary --all
ccagent --no-session /audit-export summary --all
ccagent --no-session /audit-export call --all local-example-1
ccagent --no-session /audit-report --all
ccagent --no-session /command-history
ccagent --no-session /command-history review 10
ccagent --no-session /command-history --all review 10
ccagent --no-session /command-stats
ccagent --no-session /command-stats --all
```

## Architecture

```text
CLI
  -> Renderer
  -> Agent
  -> ModelClient
  -> ToolRegistry
  -> Tools
  -> Plan
  -> SessionStore
```

`Renderer` is deliberately separate from `Agent`: the agent emits structured events such as `text_delta`, `model_turn`, `tool_preflight`, `tool_start`, and `tool_finish`; the renderer decides how those events look in the terminal.
The same events can also be rendered as JSON Lines with `--json`.

The project currently uses a mock model when `OPENAI_API_KEY` is not set. Set `OPENAI_API_KEY` to use the OpenAI model client.

## Real OpenAI Model

Without an API key (no `OPENAI_API_KEY` env and no `ccagent login` key), CCAgent intentionally runs with the mock model so the agent loop can be learned and tested offline.

PowerShell example for a real model run with temporary environment variables:

```powershell
$env:OPENAI_API_KEY="your_api_key"
# Optional: use an OpenAI-compatible relay/proxy endpoint.
$env:OPENAI_BASE_URL="https://your-relay.example/v1"
# Optional: override the configured/default model.
$env:CCAGENT_MODEL="your_model_id"
# Optional: use Chat Completions for relay providers.
$env:CCAGENT_API_MODE="chat"
# Optional: use provider-backed embeddings for /index semantic build/search.
$env:CCAGENT_EMBEDDING_MODEL="text-embedding-3-small"
ccagent --doctor
ccagent --stream --no-session --verbose "list files"
```

The same machine can use the Codex-style persisted key instead of the
environment variable:

```powershell
ccagent login --api-key your_api_key
ccagent logout
```

`CCAGENT_API_MODE` supports two values:

```text
responses  default; uses /v1/responses and previous_response_id
chat       uses /v1/chat/completions and stores messages locally
```

For relay providers, use `chat` mode if `/v1/responses` is unsupported or you see an error like `previous_response_id is only supported on Responses WebSocket v2`.

Persistent relay example:

```powershell
$env:OPENAI_API_KEY="your_relay_key"
ccagent --config-set model gpt-5.5
ccagent --config-set openai.apiMode chat
ccagent --config-set openai.baseURL https://api.wcgio.com/v1
ccagent --config-set openai.embeddingModel text-embedding-3-small
ccagent --config-set openai.retry.maxAttempts 4
ccagent --doctor
ccagent --no-session /provider-smoke
ccagent --no-session /index semantic build
ccagent --no-session /index semantic search "provider compatibility"
ccagent --no-session /diagnostics export
ccagent --json --no-session "list files"
```

Environment variables take priority over both the project `.ccagent/config.json` and the user-level `~/.ccagent/config.json`, so you can temporarily override the persisted values for one PowerShell session.

Use `/diagnostics export` when provider setup is confusing. It writes a redacted
Markdown report under `.ccagent/reports/` with doctor results, model/provider
configuration, Node/npm details, and suggested smoke commands. It records only
whether `OPENAI_API_KEY` is set, never the key value.

If you want a machine-readable smoke test, run the command printed by `ccagent --doctor`:

```powershell
ccagent --json --no-session "list files"
```

The default OpenAI client uses the Responses API shape:

```text
user prompt
  -> streamed response.output_text.delta events when --stream is enabled
  -> response.completed with final output and function_call items
  -> local tool execution
  -> function_call_output items sent back with previous_response_id
```

The Chat Completions mode uses this shape:

```text
user prompt
  -> messages: system + user
  -> assistant message with tool_calls
  -> local tool execution
  -> tool role messages sent back with tool_call_id
  -> assistant final message
```

## Tests

Run the test suite:

```bash
npm test
```

The tests cover CLI argument parsing, project config loading, context
compaction, context suggestions, plan state, task state, session persistence,
tool safety boundaries, secret redaction, interrupt handling, the shell
sandbox and injection guard, provider profiles, and parallel tool execution.
`tests/fixtures/golden-scenarios.json` drives scripted multi-turn replays
through the real agent loop so prompt and tool-schema drift fails CI.

## Provider Profiles

One command configures CCAgent for a regional provider:

```bash
ccagent --provider deepseek
ccagent --provider moonshot     # Moonshot AI (Kimi)
ccagent --provider zhipu        # Zhipu AI (GLM)
ccagent --provider qwen         # Alibaba Cloud Model Studio
```

A profile writes three user-level values: the default model, `openai.apiMode`
(always `chat` for these OpenAI-compatible endpoints), and `openai.baseURL`.
List them with `ccagent --config-get <key>` or remove them with
`ccagent --config-unset <key>`. API keys always flow through the normal key
flow (`ccagent login --api-key <key>` or `OPENAI_API_KEY`), regardless of
provider. Run `ccagent --doctor` and `ccagent --no-session /provider-smoke`
after switching profiles.

Model IDs move fast on these platforms; update the default with
`ccagent --config-set model <new-model>` when a provider ships a newer model.

## Security and Secret Redaction

Everything CCAgent writes to disk or to debug output is filtered before it is
written, at every write path:

- `.ccagent/logs/tool-audit-<date>.jsonl` audit records
- `CCAGENT_DEBUG=1` / `--verbose` debug payloads
- `.ccagent/history` terminal input history: entries that are pure secrets
  are dropped, and commands that contain a secret are stored with the secret
  replaced (for example `ccagent login --api-key sk-...[redacted]`), so the
  command stays searchable without the credential
- `/diagnostics export` reports, which record only whether a key is set,
  never the key value

Redaction covers `api_key` / `api-key` / `token` / `authorization` key-value
pairs, JSON credential fields, bearer tokens, bare `sk-...` and `sk-ant-...`
keys, and well-known variables such as `OPENAI_API_KEY`.

### Shell command isolation

Every `run_shell` command already requires explicit approval, but you can
also isolate execution:

- Default (`toolPolicy.shellSandbox: "off"`): commands run directly on the
  host shell, with approval prompts, tool policies, timeouts, and
  process-tree termination as the guardrails.
- Docker (`ccagent --sandbox` for one run, or
  `ccagent --config-set toolPolicy.shellSandbox docker` to persist): every
  command runs inside a fresh `docker run --rm` container:
  - the workspace is bind-mounted at `/workspace` and is the working
    directory, so per-file patches still work,
  - the container gets a random `ccagent-sandbox-*` name and is force-removed
    on timeout,
  - the network is disabled by default (`toolPolicy.shellSandboxNetwork`
    can switch it to `bridge`),
  - the default image is `alpine:3.20`; override it with
    `toolPolicy.shellSandboxImage` (any image that provides `sh`),
  - the container root filesystem is read-only by default with writable
    noexec `tmpfs` mounts for `/tmp` and `/var/tmp`
    (`toolPolicy.shellSandboxReadOnly`, `"true"` or `"false"`), and `HOME`
    is pointed at the container `/tmp`,
  - `--security-opt no-new-privileges` and `--cap-drop ALL` are always
    applied, so a compromised command cannot gain privileges or capabilities
    inside the container,
  - resource limits protect the host: `toolPolicy.shellSandboxMemoryMb`
    (default `2048`, also disables swap), `toolPolicy.shellSandboxCpus`
    (default `2`), and `toolPolicy.shellSandboxPidsLimit` (default `512`,
    which also contains fork bombs),
  - on POSIX hosts the container runs as your current uid/gid so edited
    files keep the same ownership.

Beyond `off` and `docker`, three alternate isolators are supported. Set them
with `ccagent --config-set toolPolicy.shellSandbox <mode>` or per-run with
`ccagent --sandbox=mode`:

- `job` (Windows only): every command runs inside a fresh Windows Job
  Object injected through an encoded PowerShell wrapper. The job enables
  kill-on-close cleanup and die-on-unhandled-exception, a hard job memory
  cap (`toolPolicy.shellSandboxMemoryMb`), a hard CPU-rate cap
  (`toolPolicy.shellSandboxCpus`, treated as a 1-100% cap), and an
  active-process cap (`toolPolicy.shellSandboxPidsLimit`, contains fork
  bombs). If the agent process dies, the OS kills the entire job tree.
  `job` isolates cleanup and resources but not the filesystem or network;
  prefer docker/podman for untrusted commands. `ccagent --doctor` checks
  `powershell.exe` availability.
- `podman`: the same hardening profile as docker (`--cap-drop ALL`,
  `no-new-privileges`, read-only root with noexec tmpfs, memory/cpu/pids
  limits) driven through `podman run`, with `--userns=keep-id` on POSIX so
  container edits keep your ownership without a root daemon.
- `timeout` (POSIX only): wraps every command in GNU/BusyBox `timeout` with
  a `-k 2s` kill-after grace, adding a hard wall-clock cap in the same
  spawn as the `run_shell` timeout. It provides process cleanup only.

`CCAGENT_SANDBOX=off|docker|podman|job|timeout` works as an
environment-level switch between `--sandbox[=mode]` and the project config.
Platform-incompatible choices (for example `job` on Linux) fall back to
`off` with a warning. `ccagent --doctor` reports whether the active
isolator's executable is available, and the interactive status bar shows
the active sandbox next to the model name.

Isolation is not substitution: with a malicious model, prefer
`toolPolicy.deny run_shell` and `toolPolicy.allowWritePaths` to keep changes
auditable, and Docker sandboxing to keep host/network damage contained.
`ccagent --doctor` prints the active hardening profile (read-only root, memory,
cpus, pids) along with the Docker CLI check.

### Shell execution guard

Every `run_shell` command additionally passes through an execution guard
(`toolPolicy.executionGuard`, default `deny`) that blocks classic
injection/exfiltration patterns even when the command is on the auto-approve
list:

- remote downloads piped into a shell (`curl ... | sh`)
- recursive removal targeting `/`, `/etc`, `/usr`, `/boot`, or `$HOME`
- writes to `authorized_keys` / `known_hosts`
- shell fork bombs and shell-history wipes

Modes: `deny` blocks the command before execution, `warn` executes it and
annotates the output with guard warnings, `off` disables the scan. Blocked or
warned commands surface the rule IDs in the approval message and the tool
result.

## Real-provider validation runbook

Provider smoke and repair benchmarks run fully offline in CI (no API key
needed), but the real-relay measurements that feed known-good provider
profiles require live credentials. With `OPENAI_API_KEY` exported or a key
stored through `ccagent login`:

```bash
npm run provider:smoke:full      # quick + full relay smoke
npm run provider:report          # full smoke, saved benchmark report
npm run provider:repair:report   # /provider-repair --save real-relay run
npm run provider:reports         # list saved benchmark reports
npm run provider:compare         # compare saved smoke reports
npm run provider:repair:compare  # compare saved repair runs
npm run provider:gate            # gate the latest saved smoke report
npm run provider:repair:gate     # gate the latest saved repair report
```

After a provider passes, `ccagent --provider <id>` applies its known-good
profile. To add a new regional provider, extend `PROVIDER_PROFILES` in
`src/providerProfiles.ts` with the measured `baseURL`/`apiMode`/`model` and
rerun `npm test`.

## Continuous Integration

`.github/workflows/ci.yml` runs on every push and pull request across
Node.js 20, 22, and 24 on Ubuntu, Windows, and macOS. Each job runs
`npm ci`, type-checking, the build, the full offline test suite (the mock
model, no API keys needed), an offline eval regression gate
(`npm run evals:gate-ci`: two fresh smoke runs compared against the
configured duration delta in `--strict` mode, with suite coverage checks),
the committed baseline gate (`npm run baseline:gate`: a fresh smoke report
gated against `tests/fixtures/eval-baseline-smoke.json` in `--strict` mode),
and `npm run release:check`.

Live provider smoke tests need real API credentials, so they are excluded
from the default matrix. Trigger them from the Actions tab with "Run
workflow" and tick `run_provider_smoke`; supply `OPENAI_API_KEY` as a secret
in the `provider` environment.

### Adopting the gates downstream

To reuse the committed-baseline gate in another repository that uses
ccagent, vendor `scripts/evals-gate.mjs`, `scripts/baseline-gate.mjs`, and
`scripts/baseline-update.mjs` (they resolve the project root from the
`scripts/` folder and invoke the installed ccagent CLI):

1. Run `npm run baseline:update` once to commit a baseline fixture.
2. Wire `npm run baseline:gate` into the CI or commit hook right after the
   test job; it runs a fresh smoke report and compares it in `--strict`
   mode with case-coverage checks.
3. Refresh the baseline only after a reviewed behavior change, because the
   gate detects every drift from the committed fixture.

## Release and Install

CCAgent declares `"engines": { "node": ">=20" }`. From source:

```bash
npm ci
npm run build
npm link
```

Verify a release build with `npm run release:check` (name, semver version,
MIT license, bin entry, shebang, and the packed file list via
`npm pack --dry-run`) or the fuller `npm run release:full`, which also runs
the test suite and the eval smoke suite.

Publishing runs `prepublishOnly`, which executes `npm run release:full` as a
gate before anything reaches the registry:

```bash
npm publish --dry-run
npm publish
```

The package is MIT-licensed (see `LICENSE`). `npm publish` requires an npm
account (`npm login`) and an available package name.
