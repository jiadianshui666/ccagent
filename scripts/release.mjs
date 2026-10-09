#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const explicitBump = args.find((value) => ["major", "minor", "patch"].includes(value));

const usage = [
  "Usage: node scripts/release.mjs [major|minor|patch] [--dry-run]",
  "",
  "Bumps the version, updates CHANGELOG.md, commits, and tags v<version>.",
  "Without an explicit bump, the level is inferred from conventional commits since",
  "the last tag: a breaking change (\"type!:\" or \"BREAKING CHANGE\") is major, any",
  "\"feat:\" is minor, and everything else is patch.",
].join("\n");

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

function run(cmd, argv) {
  const child = spawnSync(cmd, argv, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });

  if (child.error) {
    throw new Error(`${cmd} ${argv.join(" ")}: ${child.error.message}`);
  }

  return child;
}

function git(...argv) {
  const child = run("git", argv);
  return child.status === 0 ? child.stdout.trim() : null;
}

const packageJsonPath = join(repoRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const currentVersion = packageJson.version;

if (dryRun) {
  process.stdout.write(`Release (dry run) from ${currentVersion}\n\n`);
}

const lastTag = git("describe", "--tags", "--abbrev=0");
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const rawLog = git("log", range, "--no-merges", "--format=%H%x00%s%x00%b%x00%x01");
const commits = parseCommits(rawLog ?? "");

function parseCommits(raw) {
  return raw
    .split("\x01")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [hash, subject, ...body] = block.split("\x00");
      return { hash, subject: (subject ?? "").trim(), body: body.join("\n").trim() };
    });
}

function inferBump(changes) {
  const breaking = changes.some(
    (c) => /^.+!:\s/.test(c.subject) || /BREAKING CHANGE/i.test(`${c.subject}\n${c.body}`),
  );
  const feat = changes.some((c) => /^feat(\(.*\))?!?:\s/.test(c.subject));

  if (breaking) return "major";
  if (feat) return "minor";
  return "patch";
}

function nextVersion(version, bump) {
  const [major, minor, patch] = version.split(/[.-]/).map((value) => Number.parseInt(value, 10));

  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const bump = explicitBump ?? inferBump(commits);
const version = nextVersion(currentVersion, bump);

process.stdout.write(
  `Version ${currentVersion} -> ${version} (${bump})${explicitBump ? "" : ", inferred from commits"}\n`,
);

// Bump package.json and package-lock.json without relying on npm's git behavior.
if (!dryRun) {
  writeJson(join(repoRoot, "package.json"), { ...packageJson, version });

  const lockPath = join(repoRoot, "package-lock.json");

  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.version = version;

    if (lock.packages?.[""]) {
      lock.packages[""].version = version;
    }

    writeJson(lockPath, lock);
  }
}

// Build the changelog entry from conventional commits.
const groups = {
  Added: /^feat(\(.*?\))?!?:\s/,
  Fixed: /^fix(\(.*?\))?!?:\s/,
  Changed: /^(perf|refactor)(\(.*?\))?!?:\s/,
  Security: /^security(\(.*?\))?!?:\s/,
};
const changelog = buildChangelog(version, commits, groups);
const changelogPath = join(repoRoot, "CHANGELOG.md");
updateChangelog(changelogPath, changelog, dryRun);

if (dryRun) {
  process.stdout.write(
    `\nWould commit "chore(release): v${version}" and tag v${version}.\n`,
  );
  process.exit(0);
}

const commitResult = run("git", ["commit", "-m", `chore(release): v${version}`]);
const tagResult = run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);

if (commitResult.status !== 0 || tagResult.status !== 0) {
  process.stderr.write("Release commit/tag failed; no changes were pushed.\n");
  process.exit(1);
}

process.stdout.write(
  [
    "",
    `Committed and tagged v${version}.`,
    "Next: git push --follow-tags (the CI release workflow publishes on v* tags),",
    "or run `npm publish` locally (prepublishOnly runs the full release gate).",
  ].join("\n") + "\n",
);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseConventional(subject) {
  const match = subject.match(/^([A-Za-z]+)(\(.*?\))?!?:\s*(.*)$/);
  return match ? { type: match[1], description: match[3].trim() } : null;
}

function buildChangelog(version, changes, groupPatterns) {
  const lines = [`## [${version}] - ${new Date().toISOString().slice(0, 10)}`];
  const buckets = new Map();

  for (const change of changes) {
    const parsed = parseConventional(change.subject);

    if (!parsed) continue;

    const label = Object.keys(groupPatterns).find((name) => groupPatterns[name].test(change.subject));

    if (!label) continue;

    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(parsed.description);
  }

  if (buckets.size === 0) {
    lines.push("", "No user-facing changes.");
    return lines.join("\n");
  }

  for (const [label, items] of buckets) {
    lines.push("", `### ${label}`);
    for (const item of items) lines.push(`- ${item}`);
  }

  return lines.join("\n");
}

function updateChangelog(path, entry, preview) {
  const header = [
    "# Changelog",
    "",
    "All notable changes to this project will be documented in this file.",
    "",
    "The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),",
    "and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).",
    "",
  ].join("\n");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : header;
  const marker = existing.indexOf("\n## [");
  const body = marker === -1 ? "" : existing.slice(marker + 1);
  const content = `${header}\n${entry}\n\n${body}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  if (preview) {
    process.stdout.write(`\n--- CHANGELOG.md preview ---\n${content}`);
    return;
  }

  writeFileSync(path, content, "utf8");
}