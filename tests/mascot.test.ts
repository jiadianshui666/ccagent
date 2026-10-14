import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBootGreeting,
  buildCCAgentLogoCanvas,
  centerLines,
  getMascotTheme,
  LOGO_COLS,
  MASCOT_THEMES,
  MIN_SPLASH_COLUMNS,
  renderBootSplash,
  renderLogoLines,
} from "../src/mascot.js";

const BLOCK_CHARS = /^[\u2580\u2584\u2588 ]*$/;
const NO_ANSI = /[^\x20-\x7e\u2580\u2584\u2588]/;

test("mascot canvas builds a 47x6 pixel grid for CCAgent", () => {
  const canvas = buildCCAgentLogoCanvas("CCAgent");
  assert.equal(canvas.cols, 47);
  assert.equal(canvas.rows, 6);
  assert.equal(LOGO_COLS, 47);
  assert.equal(MIN_SPLASH_COLUMNS, 49);
  assert.equal(canvas.pixels.length, 6);
  assert.equal(canvas.pixels[0]!.length, 47);
  assert.equal(canvas.pixels.some((row) => row.some(Boolean)), true);

  const missing = buildCCAgentLogoCanvas("?!");
  assert.equal(missing.pixels.every((row) => row.every((pixel) => !pixel)), true);
});

test("mascot renders three plain block lines without ANSI when colors are off", () => {
  const lines = renderLogoLines("CCAgent", { color: false });
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^[\u2580\u2584\u2588]/);
  assert.equal(lines.join("").includes("\u2588"), true);

  for (const line of lines) {
    assert.match(line, BLOCK_CHARS);
    assert.doesNotMatch(line, NO_ANSI);
    assert.ok(line.length <= LOGO_COLS);
  }
});

test("mascot renders ANSI colored lines with a dim ghost before the reveal sweep", () => {
  const ghost = renderLogoLines("CCAgent", { color: true, revealColumns: 0 });
  assert.match(ghost.join("\n"), /\x1b\[[0-9;]*m/);
  assert.match(ghost.join("\n"), /38;2;51;65;85/);
  assert.doesNotMatch(ghost.join("\n"), /38;2;125;249;255/);

  const lit = renderLogoLines("CCAgent", { color: true });
  assert.match(lit.join("\n"), /38;2;125;249;255/);
  assert.match(lit.join("\n"), /38;2;56;189;248/);
  assert.match(lit.join("\n"), /38;2;37;99;235/);

  const sweep = renderLogoLines("CCAgent", { color: true, revealColumns: 24 });
  assert.match(sweep.join("\n"), /38;2;125;249;255/);
  assert.match(sweep.join("\n"), /38;2;51;65;85/);
});

test("mascot centers and assembles the boot splash with a version line", () => {
  const splash = renderBootSplash({
    columns: 59,
    version: "0.3.0",
    color: false,
  });

  assert.equal(splash.length, 5);
  assert.equal(splash[3], "");
  assert.equal(splash[4], `${" ".repeat(10)}CCAgent v0.3.0 \u2014 terminal coding agent`);
  assert.equal(splash[0]!.startsWith(" ".repeat(6)), true);
  assert.match(splash[0]!.slice(6), BLOCK_CHARS);
  assert.equal(splash[1]!.startsWith(" ".repeat(6)), true);
  assert.equal(splash[2]!.startsWith(" ".repeat(6)), true);

  const narrow = renderBootSplash({ columns: 47, version: "0.3.0", color: false });
  assert.ok(narrow[0]!.length <= 47);
  assert.ok(narrow[4]!.length <= 47);
});

test("mascot centers arbitrary lines without counting ANSI escapes", () => {
  const lines = centerLines(["\x1b[31mok\x1b[0m"], 8);
  assert.equal(lines[0], "   \x1b[31mok\x1b[0m");
});

test("mascot greeting carries the running version", () => {
  assert.equal(buildBootGreeting({ version: "0.3.0" }).includes("CCAgent v0.3.0"), true);
});

test("mascot themes switch via CCAGENT_THEME and default to ocean", () => {
  const previous = process.env.CCAGENT_THEME;

  try {
    delete process.env.CCAGENT_THEME;
    assert.equal(getMascotTheme(), "ocean");

    for (const theme of ["dawn", "dusk", "forest", "sunset"] as const) {
      process.env.CCAGENT_THEME = theme;
      assert.equal(getMascotTheme(), theme);
    }

    process.env.CCAGENT_THEME = "neon";
    assert.equal(getMascotTheme(), "ocean");

    const topPaints = Object.values(MASCOT_THEMES).map((palette) => palette.top);
    assert.equal(new Set(topPaints).size, topPaints.length);
  } finally {
    if (previous === undefined) {
      delete process.env.CCAGENT_THEME;
    } else {
      process.env.CCAGENT_THEME = previous;
    }
  }
});
