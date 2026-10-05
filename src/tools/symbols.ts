import { readFile, readdir, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { shouldExcludeWorkspaceEntry } from "./listFiles.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_FILES_SCANNED = 800;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILE_READ_BYTES = 128 * 1024;
const MAX_SYMBOLS = 5_000;
const MAX_LIMIT = 100;
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".mts", ".py", ".ts", ".tsx", ".md"]);

export type SymbolKind =
  | "class"
  | "const"
  | "describe"
  | "enum"
  | "function"
  | "heading"
  | "interface"
  | "test"
  | "type";

export type WorkspaceSymbol = {
  exported: boolean;
  kind: SymbolKind;
  line: number;
  name: string;
  path: string;
  signature: string;
};

export class ListSymbolsTool implements Tool {
  readonly name = "list_symbols";
  readonly description = "List top workspace symbols such as classes, functions, exports, tests, and headings.";
  readonly parameters = {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of symbols to list, from 1 to 100.",
      },
    },
    required: ["limit"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) {
      return {
        ok: false,
        error: "Expected input.limit to be a number.",
      };
    }

    const limit = clampLimit(input.limit);
    const index = await buildSymbolIndex(resolve(context.workspaceRoot));
    const symbols = index.symbols.slice(0, limit);

    return {
      ok: true,
      content: formatSymbolIndex(symbols, {
        scanned: index.scanned,
        total: index.symbols.length,
        truncated: index.truncated,
      }),
      metadata: {
        count: symbols.length,
        scanned: index.scanned,
        total: index.symbols.length,
        truncated: index.truncated,
      },
    };
  }
}

export class SearchSymbolsTool implements Tool {
  readonly name = "search_symbols";
  readonly description = "Search workspace symbols by name, kind, path, or signature.";
  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Symbol name, path, kind, or signature text to search for.",
      },
      limit: {
        type: "number",
        description: "Maximum number of symbol matches to show, from 1 to 100.",
      },
    },
    required: ["query", "limit"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.query !== "string") {
      return {
        ok: false,
        error: "Expected input.query to be a string.",
      };
    }

    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) {
      return {
        ok: false,
        error: "Expected input.limit to be a number.",
      };
    }

    const query = input.query.trim();

    if (query.length === 0) {
      return {
        ok: false,
        error: "Missing symbol search query.",
      };
    }

    const limit = clampLimit(input.limit);
    const index = await buildSymbolIndex(resolve(context.workspaceRoot));
    const matches = searchSymbols(index.symbols, query).slice(0, limit);

    return {
      ok: true,
      content: formatSymbolSearch(query, matches, {
        scanned: index.scanned,
        total: index.symbols.length,
        truncated: index.truncated,
      }),
      metadata: {
        count: matches.length,
        query,
        scanned: index.scanned,
        total: index.symbols.length,
        truncated: index.truncated,
      },
    };
  }
}

async function buildSymbolIndex(
  workspaceRoot: string,
): Promise<{ scanned: number; symbols: WorkspaceSymbol[]; truncated: boolean }> {
  const files: string[] = [];
  const fileTruncated = await collectSourceFiles(workspaceRoot, workspaceRoot, files);
  const symbols: WorkspaceSymbol[] = [];
  let symbolTruncated = false;

  for (const filePath of files) {
    if (symbols.length >= MAX_SYMBOLS) {
      symbolTruncated = true;
      break;
    }

    const relativePath = normalizeRelativePath(relative(workspaceRoot, filePath));

    try {
      const raw = await readFile(filePath, "utf8");
      symbols.push(...extractSymbols(relativePath, raw.slice(0, MAX_FILE_READ_BYTES)));
    } catch {
      continue;
    }
  }

  const sortedSymbols = symbols
    .slice(0, MAX_SYMBOLS)
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);

  return {
    scanned: files.length,
    symbols: sortedSymbols,
    truncated: fileTruncated || symbolTruncated || symbols.length > MAX_SYMBOLS,
  };
}

async function collectSourceFiles(workspaceRoot: string, directoryPath: string, files: string[]): Promise<boolean> {
  if (files.length >= MAX_FILES_SCANNED) {
    return true;
  }

  const children = (await readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => entry.name !== ".ccagent")
    .filter((entry) => !shouldExcludeWorkspaceEntry(workspaceRoot, directoryPath, entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  let truncated = false;

  for (const child of children) {
    if (files.length >= MAX_FILES_SCANNED) {
      truncated = true;
      break;
    }

    const childPath = resolve(directoryPath, child.name);

    if (child.isDirectory()) {
      truncated = (await collectSourceFiles(workspaceRoot, childPath, files)) || truncated;
      continue;
    }

    if (!child.isFile() || !SOURCE_EXTENSIONS.has(extname(child.name).toLowerCase())) {
      continue;
    }

    const childStat = await stat(childPath);

    if (childStat.size > MAX_FILE_BYTES) {
      continue;
    }

    files.push(childPath);
  }

  return truncated;
}

export function extractSymbols(path: string, content: string): WorkspaceSymbol[] {
  const extension = extname(path).toLowerCase();
  const symbols: WorkspaceSymbol[] = [];
  const lines = content.split(/\r?\n/);
  let inImportBlock = false;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    if (inImportBlock) {
      if (trimmed.endsWith(";")) {
        inImportBlock = false;
      }
      continue;
    }

    if (isImportLine(trimmed)) {
      if (!trimmed.endsWith(";")) {
        inImportBlock = true;
      }
      continue;
    }

    if (extension === ".md") {
      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);

      if (heading?.[2]) {
        symbols.push(createSymbol(path, lineNumber, "heading", heading[2], trimmed, false));
      }

      continue;
    }

    if (extension === ".py") {
      pushMatch(symbols, path, lineNumber, trimmed, /^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, "function", 2, false);
      pushMatch(symbols, path, lineNumber, trimmed, /^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "class", 1, false);
      continue;
    }

    const exported = /^export\s+/.test(trimmed);
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^(?:module\s*\.\s*)?exports\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=/,
      "const",
      1,
      true,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^module\s*\.\s*exports\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/,
      "const",
      1,
      true,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^(export\s+)?(default\s+)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
      "function",
      4,
      exported,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^(export\s+)?(default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
      "class",
      3,
      exported,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
      "interface",
      2,
      exported,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
      "type",
      2,
      exported,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^(export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
      "enum",
      2,
      exported,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^(export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/,
      "const",
      2,
      exported,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^(?:test|it)\s*\(\s*["'`]([^"'`]+)["'`]/,
      "test",
      1,
      false,
    );
    pushMatch(
      symbols,
      path,
      lineNumber,
      trimmed,
      /^describe\s*\(\s*["'`]([^"'`]+)["'`]/,
      "describe",
      1,
      false,
    );
  }

  return symbols;
}

function isImportLine(trimmed: string): boolean {
  return trimmed.startsWith("import ") || trimmed.startsWith("from ");
}

function pushMatch(
  symbols: WorkspaceSymbol[],
  path: string,
  line: number,
  signature: string,
  pattern: RegExp,
  kind: SymbolKind,
  nameIndex: number,
  exported: boolean,
): void {
  const match = signature.match(pattern);
  const name = match?.[nameIndex];

  if (!name) {
    return;
  }

  symbols.push(createSymbol(path, line, kind, name, signature, exported));
}

function createSymbol(
  path: string,
  line: number,
  kind: SymbolKind,
  name: string,
  signature: string,
  exported: boolean,
): WorkspaceSymbol {
  return {
    exported,
    kind,
    line,
    name: truncateOneLine(name, 120),
    path,
    signature: truncateOneLine(signature, 180),
  };
}

function searchSymbols(symbols: WorkspaceSymbol[], query: string): WorkspaceSymbol[] {
  const terms = tokenizeQuery(query);

  return symbols
    .map((symbol) => ({
      score: scoreSymbol(symbol, query, terms),
      symbol,
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.symbol.path.localeCompare(right.symbol.path) ||
        left.symbol.line - right.symbol.line,
    )
    .map((item) => item.symbol);
}

function scoreSymbol(symbol: WorkspaceSymbol, query: string, terms: string[]): number {
  const lowerQuery = query.toLowerCase();
  const lowerName = symbol.name.toLowerCase();
  const lowerPath = symbol.path.toLowerCase();
  const lowerKind = symbol.kind.toLowerCase();
  const lowerSignature = symbol.signature.toLowerCase();
  let score = 0;

  if (lowerName === lowerQuery) {
    score += 100;
  } else if (lowerName.includes(lowerQuery)) {
    score += 60;
  }

  if (lowerPath.includes(lowerQuery)) {
    score += 25;
  }

  if (lowerKind === lowerQuery) {
    score += 20;
  }

  if (lowerSignature.includes(lowerQuery)) {
    score += 15;
  }

  for (const term of terms) {
    if (lowerName.includes(term)) {
      score += 14;
    }
    if (lowerPath.includes(term)) {
      score += 6;
    }
    if (lowerSignature.includes(term)) {
      score += 4;
    }
  }

  return score;
}

function formatSymbolIndex(
  symbols: WorkspaceSymbol[],
  stats: { scanned: number; total: number; truncated: boolean },
): string {
  const lines = [
    "Symbol index",
    `Scanned files: ${stats.scanned}${stats.truncated ? " (truncated)" : ""}`,
    `Symbols: ${stats.total}`,
    "",
  ];

  if (symbols.length === 0) {
    lines.push("No symbols found.");
    return lines.join("\n");
  }

  symbols.forEach((symbol, index) => {
    lines.push(`${index + 1}. ${formatSymbol(symbol)}`);
  });

  if (stats.total > symbols.length) {
    lines.push(`...${stats.total - symbols.length} more symbol(s) not shown`);
  }

  return lines.join("\n");
}

function formatSymbolSearch(
  query: string,
  symbols: WorkspaceSymbol[],
  stats: { scanned: number; total: number; truncated: boolean },
): string {
  const lines = [
    `Symbol search: ${query}`,
    `Scanned files: ${stats.scanned}${stats.truncated ? " (truncated)" : ""}`,
    `Symbols: ${stats.total}`,
    "",
  ];

  if (symbols.length === 0) {
    lines.push("No matching symbols found.");
    return lines.join("\n");
  }

  symbols.forEach((symbol, index) => {
    lines.push(`${index + 1}. ${formatSymbol(symbol)}`);
  });

  return lines.join("\n");
}

function formatSymbol(symbol: WorkspaceSymbol): string {
  const exported = symbol.exported ? " exported" : "";
  return `${symbol.kind}${exported} ${symbol.name} ${symbol.path}:${symbol.line} - ${symbol.signature}`;
}

function tokenizeQuery(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_$.-]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  ];
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...[truncated]`;
}
