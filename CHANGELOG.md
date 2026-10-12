# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-12

First packaged release of CCAgent, a learning-focused terminal coding agent.

### Added
- Interactive terminal shell: rich TTY interface, one-shot prompts, Tab completion, themes, input history.
- Agent loop with model turns, tool calls, usage accounting, token and cost budgets.
- Workspace tools: list, read, search, shell, apply_patch, reverse_patch, edit, git status/diff, patch snapshots and rollback.
- Safety: approval prompts, risk-grouped patch review, tool/path policies, injection guard, shell allowlist, Docker/podman/Job Object/timeout isolators.
- Sessions: persistence, checkpoints, compaction, task-state resume prompts.
- Subagents: parallel read-only delegation, parallel write delegation with conflict detection, usage rollup, fan-out caps, nested audit spans.
- Web search and fetch tools with SSRF hardening.
- MCP stdio server integration with approvals, timeouts, reload, and runtime catalogs.
- Observability: JSON Lines events, audit logs, usage/cost summaries, diagnostics export, span-tree audit export.
- Learning tooling: architecture guide, code map, offline evals, regression and benchmark suites, baseline and coverage gates, golden scenarios.
- Verification and repair: verify commands, failure classification, /repair-last, /repair-run, /repair-loop, five-task provider repair benchmark.
- Provider compatibility: offline matrix, /provider-smoke quick/full profiles with tool-followup continuity probe, report save/compare/gate, known-good profile registry.
- Built-in provider profiles: DeepSeek, Moonshot, Zhipu, Qwen, SiliconFlow, Volcengine Ark, MiniMax, xAI, Groq, OpenRouter, Mistral.
- Context management: code map, suggest-context, lexical and semantic indexes, TypeScript symbol graph with TypeChecker edges, optional provider-backed embeddings.
- Repo hygiene: three-OS CI matrix, eval baseline/coverage/audit gates, dependabot, CODEOWNERS, PR/issue templates, conventional-commit enforcement, release automation.

### Changed
- apply_patch accepts the unified diff format for model-driven edits.
- Release gate runs build, tests, smoke evals, and pack checks before npm publish.

### Fixed
- Stream responses append text instead of repainting each line.
- Windows process cleanup and MCP timeouts made retry-safe.
- Provider errors classify authentication, quota, context-length, model-not-found, and TLS signatures.
- Chat responses fall back to reasoning_content when content is empty on reasoning-model relays.

### Security
- web_fetch blocks private hosts, validates redirects, and limits hops against SSRF.
- Secrets are redacted across logs, terminal history, debug output, and diagnostics.
