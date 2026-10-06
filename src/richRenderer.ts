import type { Writable } from "node:stream";
import type { AgentResponse, AgentStreamEvent } from "./agent.js";
import type { OutputRenderer } from "./renderer.js";
import {
  createStreamingTextPainter,
  looksLikeDiff,
  paintDiffLine,
  stripAnsi,
  type StreamingTextPainter,
} from "./richText.js";

export {
  colorizeDiffLines,
  looksLikeDiff,
  paintDiffLine,
  stripAnsi,
} from "./richText.js";

const MAX_TOOL_OUTPUT_LINES = 12;
const APPROVAL_MAX_LINES = 30;
const MIN_COLUMNS = 40;
const MAX_COLUMNS = 200;
const DEFAULT_TICK_INTERVAL_MS = 500;
const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2818", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

function spinnerFrame(startedAt: number): string {
  return SPINNER_FRAMES[Math.floor((Date.now() - startedAt) / 500) % SPINNER_FRAMES.length] ?? " ";
}

export type RichTheme = {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
  gray(text: string): string;
};

export function createRichTheme(enabled: boolean): RichTheme {
  const paint =
    enabled
      ? (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`
      : () => (text: string) => text;

  return {
    enabled,
    bold: paint(1),
    dim: paint(2),
    red: paint(31),
    green: paint(32),
    yellow: paint(33),
    blue: paint(34),
    cyan: paint(36),
    magenta: paint(35),
    gray: paint(90),
  };
}

export function createDefaultRichTheme(): RichTheme {
  const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
  return createRichTheme(!noColor);
}

export function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(20, width);
  const wrapped: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length <= safeWidth) {
      wrapped.push(rawLine);
      continue;
    }

    let current = "";

    for (const word of rawLine.split(" ")) {
      if (word.length > safeWidth) {
        if (current) {
          wrapped.push(current);
          current = "";
        }

        let rest = word;

        while (rest.length > safeWidth) {
          wrapped.push(rest.slice(0, safeWidth));
          rest = rest.slice(safeWidth);
        }

        current = rest;
        continue;
      }

      if (current.length === 0) {
        current = word;
        continue;
      }

      if (current.length + 1 + word.length <= safeWidth) {
        current = `${current} ${word}`;
        continue;
      }

      wrapped.push(current);
      current = word;
    }

    if (current) {
      wrapped.push(current);
    }
  }

  return wrapped;
}

const CJK_TEXT_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g;

export function estimateTextTokens(text: string): number {
  const cjk = (text.match(CJK_TEXT_RE) ?? []).length;
  return Math.max(1, Math.ceil(cjk + (text.length - cjk) / 4));
}

export function truncateLines(
  text: string,
  maxLines: number,
  maxWidth: number,
): { text: string; truncated: number } {
  const lines = text.split(/\r?\n/).map((line) =>
    line.length > maxWidth ? `${line.slice(0, Math.max(0, maxWidth - 3))}...` : line,
  );

  if (lines.length <= maxLines) {
    return { text: lines.join("\n"), truncated: 0 };
  }

  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: lines.length - maxLines,
  };
}

export type RichBoxOptions = {
  maxLines?: number;
  maxWidth?: number;
  theme?: RichTheme;
  title?: string;
  titleColor?: "cyan" | "yellow";
};

function resolveColumns(columns: number | undefined): number {
  return Math.max(MIN_COLUMNS, Math.min(columns ?? 80, MAX_COLUMNS));
}

function padDisplayWidth(line: string, width: number): string {
  const visibleLength = stripAnsi(line).length;
  return line + " ".repeat(Math.max(0, width - visibleLength));
}

export function boxText(content: string, options: RichBoxOptions = {}): string {
  const theme = options.theme ?? createDefaultRichTheme();
  const columns = resolveColumns(options.maxWidth);
  const innerWidth = Math.max(20, columns - 4);
  const bodyLength = innerWidth + 4;
  const clean = stripAnsi(content);
  const allLines = wrapText(clean, innerWidth);
  const maxLines = Math.max(3, options.maxLines ?? 24);
  const shownLines = allLines.slice(0, maxLines);
  const suppressed = allLines.length - shownLines.length;
  const isDiff = looksLikeDiff(clean);
  const title = options.title ?? "";
  const titlePaint = options.titleColor === "yellow" ? theme.yellow : theme.cyan;

  let top: string;

  if (title) {
    const shortened = title.length <= innerWidth - 2 ? title : title.slice(0, innerWidth - 2);
    const fill = Math.max(0, bodyLength - 5 - shortened.length);
    top = `${theme.gray("┌─ ")}${theme.bold(titlePaint(shortened))}${theme.gray(` ${"─".repeat(fill)}┐`)}`;
  } else {
    top = theme.gray(`┌─${"─".repeat(bodyLength - 3)}┐`);
  }

  const hasContent = allLines.some((line) => line.length > 0);
  const paintedLines = shownLines.map((line) => (isDiff ? paintDiffLine(line, theme) : line));

  if (!hasContent) {
    paintedLines.length = 0;
    paintedLines.push(theme.dim("(empty)"));
  }

  if (suppressed > 0) {
    paintedLines.push(theme.dim(`… (${suppressed} more lines)`));
  }

  const rows = paintedLines
    .map((line) => `${theme.gray("│")} ${padDisplayWidth(line, innerWidth)} ${theme.gray("│")}`)
    .join("\n");
  const bottom = theme.gray(`└${"─".repeat(bodyLength - 2)}┘`);

  return `${top}\n${rows}\n${bottom}\n`;
}

export type RichPromptStatus = {
  allowEdits: boolean;
  useSession: boolean;
  modelName?: string;
  local?: boolean;
  sandbox?: string;
  hints?: string[];
};

export type RichRenderer = OutputRenderer & {
  writeBanner(content: string): Promise<void>;
  writePromptLine(prompt: string): Promise<void>;
  writePromptStatus(status: RichPromptStatus): Promise<void>;
  writeRichBlock(content: string, title?: string): Promise<void>;
  redrawHints(hints: string[]): void;
};

export type RichRendererOptions = {
  columns?: number;
  theme?: RichTheme;
  tickIntervalMs?: number;
};

export function createRichRenderer(output: Writable, options: RichRendererOptions = {}): RichRenderer {
  const theme = options.theme ?? createDefaultRichTheme();
  const getColumns = (): number =>
    resolveColumns(options.columns ?? (output as Writable & { columns?: number }).columns);
  let textOpen = false;
  let toolOpen = false;
  let preflight: Extract<AgentStreamEvent, { type: "tool_preflight" }> | undefined;
  const deniedCalls = new Set<string>();
  let lastChunkEndsWithNewline = true;
  let writeCount = 0;
  const richStatus: RichPromptStatus = { allowEdits: false, useSession: true };
  let barActive = false;
  let tailMidline = false;
  let barVisible = false;
  let barBelowCursor = false;
  let hintsVisible = false;
  const liveStream = {
    active: false,
    units4: 0,
    tokens: 0,
    startedAt: undefined as number | undefined,
  };
  const lastUsage = {
    modelName: undefined as string | undefined,
    turns: 0,
    tokens: undefined as number | undefined,
    cost: undefined as string | undefined,
  };

  const write = (chunk: string): void => {
    output.write(chunk);
    writeCount += 1;
    lastChunkEndsWithNewline = chunk.endsWith("\n");
  };

  const ensureNewline = (): void => {
    if (!lastChunkEndsWithNewline) {
      write("\n");
    }
  };

  const resetLiveStream = (): void => {
    liveStream.active = false;
    liveStream.units4 = 0;
    liveStream.tokens = 0;
    liveStream.startedAt = undefined;
  };

  const addLiveStreamText = (text: string): void => {
    const cjk = (text.match(CJK_TEXT_RE) ?? []).length;
    liveStream.active = true;
    liveStream.units4 += 4 * cjk + (text.length - cjk);
    liveStream.tokens = Math.max(1, Math.ceil(liveStream.units4 / 4));

    if (liveStream.startedAt === undefined) {
      liveStream.startedAt = Date.now();
      ensureTickTimer();
    }
  };

  const painter: StreamingTextPainter = createStreamingTextPainter({
    getColumns,
    theme,
    write,
  });

  const buildHintsLine = (): string => {
    const hints = richStatus.hints ?? [];

    if (hints.length === 0) {
      return "";
    }

    const raw = ` ${hints.join("  ")} `;
    const columns = getColumns();
    const line = raw.length <= columns ? raw : `${raw.slice(0, Math.max(0, columns - 3))}...`;

    return theme.dim(line);
  };

  const buildBarText = (): string => {
    const modelLabel = lastUsage.modelName ?? richStatus.modelName ?? "-";
    const localBadge = richStatus.local === true ? theme.gray(" (local)") : "";
    const parts = [`model ${modelLabel}${localBadge}`];

    if (lastUsage.turns > 0) {
      parts.push(`${lastUsage.turns} turns`);
    }

    if (lastUsage.tokens !== undefined && lastUsage.tokens > 0) {
      parts.push(`${lastUsage.tokens} tokens`);
    }

    if (lastUsage.cost && lastUsage.cost !== "(not configured)") {
      parts.push(`cost=${lastUsage.cost}`);
    }

    if (liveStream.active && liveStream.tokens > 0) {
      const frame = liveStream.startedAt !== undefined ? spinnerFrame(liveStream.startedAt) : "";
      parts.push(theme.cyan(`${frame} out\u2248${liveStream.tokens} tok`));

      if (liveStream.startedAt !== undefined) {
        parts.push(theme.cyan(`${((Date.now() - liveStream.startedAt) / 1000).toFixed(1)}s`));
      }
    }

    if (richStatus.allowEdits) {
      parts.push(theme.green("edits=auto-approve"));
    }

    if (richStatus.sandbox) {
      parts.push(theme.cyan(`sandbox=${richStatus.sandbox}`));
    }

    if (!richStatus.useSession) {
      parts.push(theme.yellow("session=off"));
    }

    let line = `── ${parts.join(" · ")} `;
    const remaining = getColumns() - stripAnsi(line).length;

    if (remaining > 0) {
      line += "─".repeat(remaining);
    }

    return line;
  };

  const attachBar = (): void => {
    if (!barActive) {
      return;
    }

    if (tailMidline) {
      write("\n");
      tailMidline = false;
    }

    write(theme.dim(buildBarText()));
    barVisible = true;
    barBelowCursor = false;
  };

  const enterContent = (): void => {
    if (!barActive) {
      return;
    }

    write("\r\x1b[2K");
    barVisible = false;
    hintsVisible = false;

    if (tailMidline) {
      write("\x1b[1A");
      tailMidline = false;
    }
  };

  const withBar = (body: () => void): void => {
    if (!barActive) {
      body();
      return;
    }

    enterContent();
    const before = writeCount;
    body();

    if (writeCount > before) {
      tailMidline = !lastChunkEndsWithNewline;
      attachBar();
    }
  };

  const openTextBlock = (): void => {
    if (textOpen) {
      return;
    }

    ensureNewline();
    painter.startMarker(`${theme.cyan("●")} `);
    textOpen = true;
  };

  const closeText = (): void => {
    textOpen = false;
    painter.finish();
    ensureNewline();
  };

  const writeTextDelta = (delta: string): void => {
    let cleaned = delta.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    if (!textOpen) {
      cleaned = cleaned.replace(/^[\r\n]+/, "");

      if (cleaned.length === 0) {
        return;
      }

      openTextBlock();
    }

    // Append-only streaming: characters are written once and never repainted in
    // place. This keeps streamed text on a single line even on terminals that do
    // not collapse ANSI erase-and-redraw (\r\x1b[2K) sequences.
    painter.consumeAppend(cleaned);
  };

  const writeToolStart = (event: Extract<AgentStreamEvent, { type: "tool_start" }>): void => {
    closeText();
    toolOpen = true;

    const badges: string[] = [];

    if (preflight) {
      if (preflight.deniedByPolicy) {
        badges.push("blocked by policy");
      }

      if (preflight.risk) {
        badges.push(`risk=${preflight.risk}`);
      }

      if (preflight.workspaceImpact) {
        badges.push(`impact=${preflight.workspaceImpact}`);
      }
    }

    write(`${theme.magenta("○")} ${theme.bold(event.toolName)}`);

    if (badges.length > 0) {
      write(` ${theme.dim(`(${badges.join(", ")})`)}`);
    }

    write("\n");

    const summaryWidth = getColumns() - 2;

    for (const line of event.inputSummary.split(/\r?\n/)) {
      const shortened = line.length > summaryWidth ? `${line.slice(0, summaryWidth - 3)}...` : line;
      write(`  ${theme.dim(shortened)}\n`);
    }

    preflight = undefined;
  };

  const writeToolApproval = (event: Extract<AgentStreamEvent, { type: "tool_approval" }>): void => {
    if (event.status === "required") {
      closeText();
      write(
        boxText(event.message ?? `Run ${event.toolName}?`, {
          theme,
          title: `Approval required: ${event.toolName}`,
          titleColor: "yellow",
          maxWidth: getColumns(),
          maxLines: APPROVAL_MAX_LINES,
        }),
      );
      return;
    }

    closeText();

    if (event.status === "approved") {
      write(`${theme.green("●")} ${event.toolName} — approved\n`);
      return;
    }

    write(`${theme.red("●")} ${event.toolName} — denied\n`);

    if (event.callId !== undefined) {
      deniedCalls.add(`id:${event.callId}`);
    }

    deniedCalls.add(`name:${event.toolName}`);
    toolOpen = false;
  };

  const writeToolResult = (event: Extract<AgentStreamEvent, { type: "tool_result" }>): void => {
    closeText();

    const prefix = `[tool] ${event.toolName} -> `;
    const body = event.content.startsWith(prefix) ? event.content.slice(prefix.length) : event.content;

    write(
      boxText(body, {
        theme,
        title: `${event.toolName} output`,
        maxWidth: getColumns(),
        maxLines: MAX_TOOL_OUTPUT_LINES,
      }),
    );
  };

  const writeToolFinish = (event: Extract<AgentStreamEvent, { type: "tool_finish" }>): void => {
    const idKey = event.callId !== undefined ? `id:${event.callId}` : undefined;
    const nameKey = `name:${event.toolName}`;
    const reportedDenied = (idKey !== undefined && deniedCalls.has(idKey)) || deniedCalls.has(nameKey);

    if (reportedDenied) {
      if (idKey !== undefined) {
        deniedCalls.delete(idKey);
      }

      deniedCalls.delete(nameKey);
      toolOpen = false;
      return;
    }

    closeText();
    let summary = event.summary;

    if (event.ok) {
      summary = summary.replace(/^ok\s*/i, "");
    }

    const status = event.ok ? theme.green("ok") : theme.red("failed");
    const detail = summary ? ` ${theme.dim(summary)}` : "";

    if (toolOpen) {
      write(`  ${status}${detail}\n`);
    } else {
      write(`${theme.magenta("○")} ${event.toolName} ${status}${detail}\n`);
    }

    toolOpen = false;
  };

  const writeModelTurn = (event: Extract<AgentStreamEvent, { type: "model_turn" }>): void => {
    closeText();
    toolOpen = false;

    lastUsage.modelName = event.modelName;
    lastUsage.turns = event.cumulativeTurns;
    lastUsage.tokens = event.cumulativeTotalTokens;
    lastUsage.cost = event.cumulativeCost;

    const tokenParts: string[] = [];

    if (event.inputTokens !== undefined) {
      tokenParts.push(`in=${event.inputTokens}`);
    }

    if (event.outputTokens !== undefined) {
      tokenParts.push(`out=${event.outputTokens}`);
    }

    if (event.totalTokens !== undefined) {
      tokenParts.push(`total=${event.totalTokens}`);
    }

    const parts = [`model ${event.modelName}`];

    if (tokenParts.length > 0) {
      parts.push(tokenParts.join(", "));
    }

    parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);

    if (event.cost) {
      parts.push(`cost=${event.cost}`);
    }

    if (event.cumulativeTurns > 1) {
      const cumulative: string[] = [`${event.cumulativeTurns} turns`];

      if (event.cumulativeTotalTokens !== undefined) {
        cumulative.push(`${event.cumulativeTotalTokens} tokens`);
      }

      if (event.cumulativeCost) {
        cumulative.push(`cost=${event.cumulativeCost}`);
      }

      parts.push(`cum: ${cumulative.join(", ")}`);
    }

    if (event.budget) {
      parts.push(event.budget);
    }

    let line = `─ ${parts.join(" · ")}`;
    const remaining = getColumns() - stripAnsi(line).length - 1;

    if (remaining > 0) {
      line += "─".repeat(remaining);
    }

  write(`\n${theme.dim(line)}\n`);
  };

  const repaintBar = (): void => {
    if (!barActive || !barVisible) {
      return;
    }

    const bar = theme.dim(buildBarText());

    if (!barBelowCursor) {
      write(`\r\x1b[2K${bar}`);
      return;
    }

    write(`\x1b7`);

    if (hintsVisible) {
      write(`\x1b[1A\r\x1b[2K${buildHintsLine()}`);
      write(`\x1b[2B`);
    } else {
      write(`\x1b[1B`);
    }

    write(`\r\x1b[2K${bar}`);
    write(`\x1b8`);
  };

  let tickTimer: ReturnType<typeof setInterval> | undefined;

  const ensureTickTimer = (): void => {
    if (tickTimer !== undefined) {
      return;
    }

    tickTimer = setInterval(() => {
      if (!liveStream.active || !barActive || !barVisible) {
        return;
      }

      repaintBar();
    }, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);

    tickTimer.unref?.();
  };

  const resizableOutput = output as Writable & {
    columns?: number;
    isTTY?: boolean;
    on?: (event: "resize", listener: () => void) => unknown;
  };

  if (typeof resizableOutput.on === "function" && resizableOutput.isTTY === true) {
    resizableOutput.on("resize", repaintBar);
  }

  return {
    async writeAgentStreamEvent(event) {
      if (event.type === "turn_start") {
        richStatus.modelName = event.modelName;

        if (barActive && barVisible) {
          repaintBar();
        }

        return;
      }

      withBar(() => {
        switch (event.type) {
          case "text_delta":
            writeTextDelta(event.delta);
            addLiveStreamText(event.delta);
            break;
          case "tool_preflight":
            preflight = event;
            break;
          case "tool_start":
            writeToolStart(event);
            break;
          case "tool_approval":
            writeToolApproval(event);
            break;
          case "tool_result":
            writeToolResult(event);
            break;
          case "tool_finish":
            writeToolFinish(event);
            break;
          case "model_turn":
            writeModelTurn(event);
            resetLiveStream();
            break;
          case "message":
            closeText();
            write(`${event.content}\n`);
            break;
        }
      });
    },

    async writeFinalResponse(response: AgentResponse) {
      resetLiveStream();
      withBar(() => {
        if (response.streamed) {
          closeText();
          write("\n");
        } else {
          closeText();
          const content = response.content.replace(/^[\r\n]+/, "");

          if (content) {
            openTextBlock();
            painter.consume(content);
            painter.finish();
          } else {
            write("\n");
          }
        }
      });

      textOpen = false;
      toolOpen = false;
    },

    async writeMessage(content: string) {
      withBar(() => {
        closeText();
        write(`${content}\n`);
      });
    },

    async writeBanner(content: string) {
      withBar(() => {
        closeText();
        write(
          boxText(content, {
            theme,
            title: "CCAgent",
            maxWidth: getColumns(),
          }),
        );
      });
    },

    async writePromptStatus(status: RichPromptStatus) {
      richStatus.allowEdits = status.allowEdits;
      richStatus.useSession = status.useSession;
      richStatus.modelName = status.modelName;
      richStatus.local = status.local;
      richStatus.sandbox = status.sandbox;
      richStatus.hints = status.hints;

      if (!barActive) {
        barActive = true;
        attachBar();
      } else {
        write(`\r\x1b[2K${theme.dim(buildBarText())}`);
        barVisible = true;
        barBelowCursor = false;
      }
    },

    async writePromptLine(prompt: string) {
      resetLiveStream();
      withBar(() => {
        if (barActive && (richStatus.hints?.length ?? 0) > 0) {
          write(buildHintsLine());
          write("\n");
        }

        write(prompt);
      });

      if (barActive) {
        write(`\x1b[1A\x1b[${stripAnsi(prompt).length}C`);
        barBelowCursor = true;
        hintsVisible = (richStatus.hints?.length ?? 0) > 0;
      }
    },

    redrawHints(hints: string[]) {
      if (!barActive || !barBelowCursor || !hintsVisible) {
        return;
      }

      richStatus.hints = hints;
      const line = buildHintsLine();

      if (!line) {
        write("\x1b7\x1b[1A\r\x1b[2K\x1b8");
        return;
      }

      write(`\x1b7\x1b[1A\r\x1b[2K${line}\x1b8`);
    },

    async writeRichBlock(content: string, title?: string) {
      withBar(() => {
        closeText();
        write(
          boxText(content, {
            theme,
            title,
            maxWidth: getColumns(),
          }),
        );
      });
    },
  };
}
