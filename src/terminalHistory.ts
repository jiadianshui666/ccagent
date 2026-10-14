import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSecrets } from "./secrets.js";

export const TERMINAL_HISTORY_LIMIT = 200;
export const TERMINAL_HISTORY_RELATIVE_PATH = ".ccagent/history";

export type TerminalHistoryState = {
  path: string;
  entries: string[];
  warnings: string[];
};

export async function loadTerminalHistory(
  workspaceRoot: string,
  limit = TERMINAL_HISTORY_LIMIT,
): Promise<TerminalHistoryState> {
  const path = getTerminalHistoryPath(workspaceRoot);

  try {
    const content = await readFile(path, "utf8");

    return {
      path,
      entries: normalizeTerminalHistoryEntries(content.split(/\r?\n/), limit),
      warnings: [],
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        path,
        entries: [],
        warnings: [],
      };
    }

    const reason = error instanceof Error ? error.message : String(error);

    return {
      path,
      entries: [],
      warnings: [`Could not read terminal input history: ${reason}`],
    };
  }
}

export async function saveTerminalHistory(
  workspaceRoot: string,
  entries: string[],
  limit = TERMINAL_HISTORY_LIMIT,
): Promise<TerminalHistoryState> {
  const path = getTerminalHistoryPath(workspaceRoot);
  const normalized = normalizeTerminalHistoryEntries(entries, limit);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, normalized.length > 0 ? `${normalized.join("\n")}\n` : "", "utf8");

  return {
    path,
    entries: normalized,
    warnings: [],
  };
}

export async function clearTerminalHistory(workspaceRoot: string): Promise<TerminalHistoryState> {
  const path = getTerminalHistoryPath(workspaceRoot);

  await rm(path, { force: true });

  return {
    path,
    entries: [],
    warnings: [],
  };
}

export function addTerminalHistoryEntry(
  entries: string[],
  entry: string,
  limit = TERMINAL_HISTORY_LIMIT,
): string[] {
  if (!shouldPersistTerminalHistoryEntry(entry)) {
    return normalizeTerminalHistoryEntries(entries, limit);
  }

  return normalizeTerminalHistoryEntries([entry, ...entries], limit);
}

export function normalizeTerminalHistoryEntries(
  entries: string[],
  limit = TERMINAL_HISTORY_LIMIT,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const value = redactSecrets(normalizeTerminalHistoryEntry(entry));

    if (!shouldPersistTerminalHistoryEntry(value) || seen.has(value)) {
      continue;
    }

    normalized.push(value);
    seen.add(value);

    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

export function shouldPersistTerminalHistoryEntry(entry: string): boolean {
  const value = normalizeTerminalHistoryEntry(entry);
  const lower = value.toLowerCase();

  if (!value) {
    return false;
  }

  if (lower === "exit" || lower === "quit" || lower === "/input-history" || lower.startsWith("/input-history ")) {
    return false;
  }

  return !looksSensitive(value);
}

export function formatTerminalHistory(state: TerminalHistoryState, limit = 20): string {
  const displayLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const visibleEntries = state.entries.slice(0, displayLimit);
  const lines = [`Terminal input history: ${state.path}`, `Entries: ${state.entries.length}`];

  for (const warning of state.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  if (visibleEntries.length === 0) {
    lines.push("No terminal input history found.");
    return lines.join("\n");
  }

  lines.push(`Most recent first (${visibleEntries.length} shown):`);

  visibleEntries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${truncateOneLine(entry, 160)}`);
  });

  return lines.join("\n");
}

export function searchTerminalHistoryEntries(
  entries: string[],
  term: string,
  limit = 8,
): string[] {
  const needle = term.trim().toLowerCase();

  if (needle.length === 0) {
    return [];
  }

  const scored: Array<{ entry: string; score: number }> = [];

  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const index = lower.indexOf(needle);

    if (index === -1) {
      continue;
    }

    let score = index;

    if (lower.startsWith(needle)) {
      score -= 100;
    }

    if (lower === needle) {
      score -= 10000;
    }

    scored.push({ entry, score });
  }

  scored.sort((left, right) => left.score - right.score);

  return scored.slice(0, Math.max(1, Math.min(50, Math.floor(limit)))).map((item) => item.entry);
}

export function getTerminalHistoryPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".ccagent", "history");
}

function normalizeTerminalHistoryEntry(entry: string): string {
  return entry.replaceAll("\r", "").replace(/\s+/g, " ").trim();
}

function looksSensitive(value: string): boolean {
  return (
    /\b(api[_-]?key|token|password|secret)\b\s*[:=]/i.test(value) ||
    /\b(openai_api_key|anthropic_api_key)\b/i.test(value) ||
    /\bBearer\s+\S+/i.test(value) ||
    /\bsk-[A-Za-z0-9_-]{12,}\b/.test(value)
  );
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
