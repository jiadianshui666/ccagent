import type { RichTheme } from "./richRenderer.js";
import { highlightCodeLine } from "./richCode.js";

const STYLE_DECIDE_AT = 20;
const MAX_CODE_LINE_CHARS = 8192;

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

export function looksLikeDiff(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const hasHeader = lines.some((line) =>
    /^(diff --git |index |\*\*\* (Begin Patch|Add File|Delete File|Update File|End Patch)|@@ |--- |\+\+\+ |\-\-\- $|\+\+\+ $)/.test(line),
  );
  const hasChanges = lines.some((line) => /^[+-]/.test(line));
  return hasHeader && hasChanges;
}

export function paintDiffLine(line: string, theme: RichTheme): string {
  if (line.startsWith("\\")) {
    return theme.gray(line);
  }

  if (line.startsWith("+") && !line.startsWith("+++")) {
    return theme.green(line);
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    return theme.red(line);
  }

  if (/^(diff --git |index |\*\*\* |@@ |\+\+\+ |--- )/.test(line)) {
    return theme.cyan(line);
  }

  return line;
}

export function colorizeDiffLines(text: string, theme: RichTheme): string {
  if (!theme.enabled || !looksLikeDiff(text)) {
    return text;
  }

  return text
    .split(/\r?\n/)
    .map((line) => paintDiffLine(line, theme))
    .join("\n");
}

type TextStyle =
  | "plain"
  | "heading"
  | "bullet"
  | "ordered"
  | "quote"
  | "fenceOpen"
  | "fenceClose"
  | "code";

export type StreamingTextPainter = {
  consume(delta: string): void;
  /** Append-only streaming: characters are written once and never repainted in place,
   *  so output stays on a single line even on terminals that do not collapse ANSI
   *  erase-and-redraw sequences. Completed lines (ending in "\n") are still painted
   *  with syntax colors. */
  consumeAppend(delta: string): void;
  finish(): void;
  reset(): void;
  startMarker(prefix: string): void;
};

export function createStreamingTextPainter(options: {
  getColumns: () => number;
  theme: RichTheme;
  write: (text: string) => void;
}): StreamingTextPainter {
  const { getColumns, theme, write } = options;

  let ink = "";
  let linePrefix = "";
  let lineHasInk = false;
  let firstSegment = true;
  let style: TextStyle = "plain";
  let styleDecided = false;
  let inFence = false;
  let fenceIsDiff = false;
  let codeLang = "";
  let codeInBlockComment = false;

  const isCodeStyle = (candidate: TextStyle): boolean =>
    candidate === "code" || candidate === "fenceOpen" || candidate === "fenceClose";

  const paintInline = (text: string): string => {
    const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);

    return parts
      .map((part) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return theme.bold(part.slice(2, -2));
        }

        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return theme.yellow(part.slice(1, -1));
        }

        return part;
      })
      .join("");
  };

  const paintSegment = (raw: string, segmentStyle: TextStyle): string => {
    switch (segmentStyle) {
      case "heading":
        return theme.bold(paintInline(raw));
      case "quote":
        return theme.gray(paintInline(raw));
      case "bullet": {
        const marker = raw.match(/^\s*[-*+]\s+/)?.[0];
        return marker
          ? theme.green(marker) + paintInline(raw.slice(marker.length))
          : paintInline(raw);
      }
      case "ordered": {
        const marker = raw.match(/^\s*\d{1,3}[.)]\s+/)?.[0];
        return marker
          ? theme.green(marker) + paintInline(raw.slice(marker.length))
          : paintInline(raw);
      }
      case "fenceOpen":
      case "fenceClose":
        return theme.gray(raw);
      case "code":
        if (fenceIsDiff) {
          return paintDiffLine(raw, theme);
        }

        if (codeLang) {
          const highlighted = highlightCodeLine(raw, {
            language: codeLang,
            theme,
            inBlockComment: codeInBlockComment,
          });
          codeInBlockComment = highlighted.inBlockComment;
          return highlighted.text;
        }

        return theme.gray(raw);
      default:
        return paintInline(raw);
    }
  };

  const decideStyle = (head: string): TextStyle => {
    const trimmed = head.trimEnd();

    if (inFence) {
      return /^\s*(```|~~~)/.test(trimmed) ? "fenceClose" : "code";
    }

    if (/^\s*(```|~~~)/.test(trimmed)) {
      return "fenceOpen";
    }

    if (/^\s{0,3}#{1,6}($|\s)/.test(head)) {
      return "heading";
    }

    if (/^\s*[-*+]\s+/.test(head)) {
      return "bullet";
    }

    if (/^\s*\d{1,3}[.)]\s+/.test(head)) {
      return "ordered";
    }

    if (/^\s*>(\s|$)/.test(head)) {
      return "quote";
    }

    return "plain";
  };

  const fenceLang = (openLine: string): string =>
    /^\s*(?:```|~~~)([A-Za-z0-9_+#-]*)/.exec(openLine)?.[1] ?? "";

  const isDiffFenceLanguage = (lang: string): boolean => /diff|patch/i.test(lang);

  const hasDiffMarker = (line: string): boolean =>
    /^\s*(@@ |\*\*\* |\+\+\+ |--- |index |diff --git )/.test(line);

  const repaintLine = (): void => {
    const painted = paintSegment(ink, style);
    write(`${lineHasInk ? "\r\x1b[2K" : ""}${linePrefix}${painted}`);
    lineHasInk = true;
  };

  const wrapCurrentLine = (): void => {
    const width = getColumns();

    while (styleDecided && !isCodeStyle(style) && ink.length > width) {
      const head = ink.slice(0, width);
      const lastSpace = head.lastIndexOf(" ");
      const cut = lastSpace > 0 ? lastSpace : width;
      const left = ink.slice(0, cut);
      const right = ink.slice(cut).replace(/^ +/, "");

      write(`${lineHasInk ? "\r\x1b[2K" : ""}${linePrefix}${paintSegment(left, style)}\n`);
      linePrefix = "";
      lineHasInk = false;
      firstSegment = false;
      ink = right;
    }
  };

  const finishLine = (): void => {
    if (!styleDecided) {
      style = decideStyle(ink);
      styleDecided = true;
    }

    if (style === "fenceOpen") {
      inFence = true;
      codeLang = fenceLang(ink);
      codeInBlockComment = false;
      fenceIsDiff = isDiffFenceLanguage(codeLang);
    } else if (style === "fenceClose") {
      inFence = false;
      fenceIsDiff = false;
      codeLang = "";
      codeInBlockComment = false;
    } else if (style === "code" && hasDiffMarker(ink)) {
      fenceIsDiff = true;
    }

    repaintLine();
    write("\n");
    ink = "";
    linePrefix = "";
    lineHasInk = false;
    firstSegment = true;
    style = "plain";
    styleDecided = false;
  };

  return {
    consume(delta: string): void {
      const clean = delta
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      let changed = false;

      for (const char of clean) {
        if (char === "\n") {
          finishLine();
          continue;
        }

        ink += char;
        changed = true;

        if (!styleDecided && (ink.includes(" ") || ink.length >= STYLE_DECIDE_AT)) {
          style = decideStyle(ink);
          styleDecided = true;
        }

        wrapCurrentLine();

        if (styleDecided && isCodeStyle(style) && ink.length > MAX_CODE_LINE_CHARS) {
          write(`${paintSegment(ink, style)}\n`);
          ink = "";
          lineHasInk = false;
          firstSegment = false;
        }
      }

      if (changed && ink.length > 0) {
        repaintLine();
      }
    },

    consumeAppend(delta: string): void {
      const clean = delta
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

      for (const char of clean) {
        if (char === "\n") {
          finishLine();
          continue;
        }

        ink += char;
        lineHasInk = true;
        // Append the character once. Do NOT repaint the current line in place —
        // re-emitting the whole line per chunk is what floods terminals that do
        // not collapse erase-and-redraw sequences. Completed lines are recolored
        // once by finishLine().
        write(char);

        if (!styleDecided && (ink.includes(" ") || ink.length >= STYLE_DECIDE_AT)) {
          style = decideStyle(ink);
          styleDecided = true;
        }
      }
    },

    finish(): void {
      if (ink.length > 0) {
        if (!styleDecided) {
          const decided = decideStyle(ink);
          styleDecided = true;

          if (decided !== "plain") {
            style = decided;
            repaintLine();
          }
        }

        write("\n");
      }

      ink = "";
      linePrefix = "";
      lineHasInk = false;
      firstSegment = true;
      style = "plain";
      styleDecided = false;
    },

    reset(): void {
      ink = "";
      linePrefix = "";
      lineHasInk = false;
      firstSegment = true;
      style = "plain";
      styleDecided = false;
      inFence = false;
      fenceIsDiff = false;
      codeLang = "";
      codeInBlockComment = false;
    },

    startMarker(prefix: string): void {
      linePrefix = prefix;
      write(prefix);
      lineHasInk = true;
    },
  };
}
