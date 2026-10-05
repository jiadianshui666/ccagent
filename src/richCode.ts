import type { RichTheme } from "./richRenderer.js";

type CommentSpec = {
  line?: string;
  block?: { start: string; end: string };
};

const COMMENT_SPECS: Record<string, CommentSpec> = {
  c: { line: "//", block: { start: "/*", end: "*/" } },
  css: { block: { start: "/*", end: "*/" } },
  html: { block: { start: "<!--", end: "-->" } },
  json: {},
  md: {},
  plain: {},
  py: { line: "#" },
  rust: { line: "//", block: { start: "/*", end: "*/" } },
  sh: { line: "#" },
  ts: { line: "//", block: { start: "/*", end: "*/" } },
};

const KEYWORDS: Record<string, Set<string>> = {
  c: new Set([
    "auto", "break", "case", "char", "const", "continue", "default", "do",
    "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline",
    "int", "long", "register", "restrict", "return", "short", "signed", "sizeof",
    "static", "struct", "switch", "typedef", "union", "unsigned", "void",
    "volatile", "while",
  ]),
  css: new Set(),
  html: new Set(),
  json: new Set(["null", "true", "false"]),
  md: new Set(),
  plain: new Set(),
  py: new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break",
    "class", "continue", "def", "del", "elif", "else", "except", "finally",
    "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  ]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn",
    "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let",
    "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self",
    "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
    "use", "where", "while",
  ]),
  sh: new Set([
    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for",
    "function", "if", "in", "local", "readonly", "return", "select", "then",
    "time", "until", "while",
  ]),
  ts: new Set([
    "abstract", "any", "as", "async", "await", "boolean", "break", "case",
    "catch", "class", "const", "constructor", "continue", "declare", "default",
    "delete", "do", "else", "enum", "export", "extends", "false", "finally",
    "for", "from", "function", "get", "if", "implements", "import", "in",
    "instanceof", "interface", "keyof", "let", "namespace", "new", "null",
    "number", "of", "private", "protected", "public", "readonly", "return",
    "satisfies", "set", "static", "string", "super", "switch", "symbol",
    "this", "throw", "true", "try", "type", "typeof", "undefined", "unique",
    "unknown", "using", "var", "void", "while", "yield",
  ]),
};

export function normalizeCodeLanguage(fenceLang: string): string {
  const tag = fenceLang.trim().toLowerCase();

  if (/^(ts|tsx|typescript|js|jsx|javascript|mjs|cjs)$/.test(tag)) {
    return "ts";
  }

  if (/^(py|py3|python)$/.test(tag)) {
    return "py";
  }

  if (/^(sh|bash|shell|zsh|console)$/.test(tag)) {
    return "sh";
  }

  if (tag === "json" || tag === "jsonc") {
    return "json";
  }

  if (/^(c|cc|cpp|cxx|h|hpp|java|go)$/.test(tag)) {
    return "c";
  }

  if (tag === "rust" || tag === "rs") {
    return "rust";
  }

  if (/^(html|xml|svg)$/.test(tag)) {
    return "html";
  }

  if (tag === "css") {
    return "css";
  }

  if (/^(md|markdown)$/.test(tag)) {
    return "md";
  }

  return "plain";
}

export function highlightCodeLine(
  raw: string,
  options: {
    inBlockComment: boolean;
    language: string;
    theme: RichTheme;
  },
): { text: string; inBlockComment: boolean } {
  const { language, theme } = options;
  const lang = normalizeCodeLanguage(language);
  const spec = COMMENT_SPECS[lang] ?? COMMENT_SPECS.plain;
  const keywords = KEYWORDS[lang] ?? KEYWORDS.plain;
  let inBlockComment = options.inBlockComment;
  const out: string[] = [];
  let start = 0;
  let i = 0;

  const paint = (style: "plain" | "comment" | "string" | "number" | "keyword") => (text: string) => {
    switch (style) {
      case "comment":
        return theme.gray(text);
      case "string":
        return theme.green(text);
      case "number":
        return theme.yellow(text);
      case "keyword":
        return theme.magenta(text);
      default:
        return text;
    }
  };

  const flush = (end: number, style: "plain" | "comment" | "string" | "number" | "keyword"): void => {
    if (end <= start) {
      return;
    }

    out.push(paint(style)(raw.slice(start, end)));
    start = end;
  };

  while (i < raw.length) {
    if (inBlockComment && spec.block) {
      const endAt = raw.indexOf(spec.block.end, i);

      if (endAt === -1) {
        flush(raw.length, "comment");
        return { text: out.join(""), inBlockComment: true };
      }

      i = endAt + spec.block.end.length;
      flush(i, "comment");
      inBlockComment = false;
      continue;
    }

    if (spec.line && raw.startsWith(spec.line, i)) {
      flush(i, "plain");
      flush(raw.length, "comment");
      return { text: out.join(""), inBlockComment: false };
    }

    if (spec.block && !inBlockComment && raw.startsWith(spec.block.start, i)) {
      const endAt = raw.indexOf(spec.block.end, i + spec.block.start.length);

      if (endAt === -1) {
        flush(i, "plain");
        flush(raw.length, "comment");
        return { text: out.join(""), inBlockComment: true };
      }

      i = endAt + spec.block.end.length;
      flush(i, "comment");
      continue;
    }

    const char = raw[i];

    if (char === `"` || char === `'` || char === "`") {
      flush(i, "plain");
      let j = i + 1;

      while (j < raw.length) {
        if (raw[j] === "\\") {
          j += 2;
          continue;
        }

        if (raw[j] === char) {
          break;
        }

        j += 1;
      }

      i = Math.min(j + 1, raw.length);
      flush(i, "string");
      continue;
    }

    if (/[0-9]/.test(char)) {
      flush(i, "plain");
      const match = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(
        raw.slice(i),
      );
      const width = match?.[0].length ?? 1;
      i += width;
      flush(i, "number");
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      flush(i, "plain");
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(raw.slice(i));
      const width = match?.[0].length ?? 1;
      const word = raw.slice(i, i + width);
      i += width;
      flush(i, keywords.has(word) ? "keyword" : "plain");
      continue;
    }

    i += 1;
  }

  flush(raw.length, "plain");
  return { text: out.join(""), inBlockComment: false };
}
