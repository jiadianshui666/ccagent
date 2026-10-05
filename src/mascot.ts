import { stripAnsi } from "./richText.js";

export type MascotPalette = {
  bg: string;
  top: string;
  mid: string;
  bottom: string;
  dim: string;
  accent: string;
  hint: string;
};

export type MascotTheme = "dawn" | "ocean";

export const MASCOT_THEMES: Record<MascotTheme, MascotPalette> = {
  ocean: {
    bg: "\u001b[48;2;8;15;34m",
    top: "\u001b[38;2;125;249;255m",
    mid: "\u001b[38;2;56;189;248m",
    bottom: "\u001b[38;2;37;99;235m",
    dim: "\u001b[38;2;51;65;85m",
    accent: "\u001b[38;2;34;211;238m",
    hint: "\u001b[38;2;100;116;139m",
  },
  dawn: {
    bg: "\u001b[48;2;15;15;23m",
    top: "\u001b[38;2;255;190;90m",
    mid: "\u001b[38;2;255;130;60m",
    bottom: "\u001b[38;2;200;80;40m",
    dim: "\u001b[38;2;60;50;45m",
    accent: "\u001b[38;2;255;170;70m",
    hint: "\u001b[38;2;120;100;90m",
  },
};

const RESET = "\u001b[0m";
const TOP_HALF = "\u2580";
const BOTTOM_HALF = "\u2584";
const FULL_BLOCK = "\u2588";

type Glyph = string[];

const FONT: Record<string, Glyph> = {
  C: [
    "01111",
    "10000",
    "10000",
    "10000",
    "10000",
    "01111",
  ],
  A: [
    "01110",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
  ],
  g: [
    "01110",
    "10001",
    "10001",
    "01111",
    "00001",
    "01110",
  ],
  e: [
    "01110",
    "10001",
    "11111",
    "10000",
    "10000",
    "01110",
  ],
  n: [
    "00000",
    "11110",
    "10001",
    "10001",
    "10001",
    "10001",
  ],
  t: [
    "01000",
    "01000",
    "11110",
    "01000",
    "01000",
    "00110",
  ],
};

const GLYPH_ROWS = 6;
const GLYPH_COLS = 5;
const GLYPH_GAP = 2;

export type LogoCanvas = {
  cols: number;
  rows: number;
  pixels: boolean[][];
};

export function buildCCAgentLogoCanvas(text = "CCAgent"): LogoCanvas {
  const glyphs = [...text].map((character) => FONT[character] ?? []);
  const width = glyphs.reduce(
    (total, glyph, index) => total + (index > 0 && glyph.length > 0 ? GLYPH_GAP : 0) + GLYPH_COLS,
    0,
  );

  const pixels: boolean[][] = Array.from({ length: GLYPH_ROWS }, () =>
    Array.from({ length: width }, () => false),
  );

  let offset = 0;

  for (const glyph of glyphs) {
    for (let row = 0; row < GLYPH_ROWS; row += 1) {
      for (let col = 0; col < GLYPH_COLS; col += 1) {
        pixels[row]![offset + col] = glyph[row]?.[col] === "1";
      }
    }

    offset += GLYPH_COLS + GLYPH_GAP;
  }

  return {
    cols: width,
    rows: GLYPH_ROWS,
    pixels,
  };
}

export function renderLogoLines(
  text: string,
  options: {
    color: boolean;
    revealColumns?: number;
    theme?: MascotTheme;
  } = { color: false },
): string[] {
  const theme = MASCOT_THEMES[options.theme ?? "ocean"];
  const canvas = buildCCAgentLogoCanvas(text);
  const reveal = options.revealColumns ?? canvas.cols;
  const lines: string[] = [];

  for (let row = 0; row < canvas.rows; row += 2) {
    let line = "";

    for (let col = 0; col < canvas.cols; col += 1) {
      const visible = col < reveal;
      const top = canvas.pixels[row]![col] === true;
      const bottom = canvas.pixels[row + 1]?.[col] === true;
      let segment = " ";

      if (top && bottom) {
        segment = FULL_BLOCK;
      } else if (top) {
        segment = TOP_HALF;
      } else if (bottom) {
        segment = BOTTOM_HALF;
      }

      const color = !options.color
        ? ""
        : visible
          ? row >= 4
            ? theme.bottom
            : row >= 2
              ? theme.mid
              : theme.top
          : theme.dim;

      line += `${color}${segment}${options.color ? RESET : ""}`;
    }

    lines.push(line.trimEnd());
  }

  return lines;
}

export function buildBootGreeting(options: { version: string }): string {
  return `CCAgent v${options.version} \u2014 terminal coding agent`;
}

export function getMascotTheme(): MascotTheme {
  return process.env.CCAGENT_THEME === "dawn" ? "dawn" : "ocean";
}

export const LOGO_COLS = buildCCAgentLogoCanvas("CCAgent").cols;
export const MIN_SPLASH_COLUMNS = LOGO_COLS + 2;

export function centerLines(lines: string[], width: number): string[] {
  return lines.map((line) => {
    const padding = Math.max(0, Math.floor((width - stripAnsi(line).length) / 2));
    return `${" ".repeat(padding)}${line}`;
  });
}

export function renderBootSplash(options: {
  columns: number;
  version: string;
  color: boolean;
  theme?: MascotTheme;
  revealColumns?: number;
}): string[] {
  const logoLines = renderLogoLines("CCAgent", {
    color: options.color,
    revealColumns: options.revealColumns,
    theme: options.theme,
  });
  const lines = centerLines(logoLines, options.columns);
  lines.push("");
  lines.push(centerLines([buildBootGreeting({ version: options.version })], options.columns)[0]!);
  return lines;
}
