import { Transform } from "node:stream";
import type { Readable } from "node:stream";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const MIN_HEURISTIC_PASTE_LENGTH = 24;

export type PasteGuardState = {
  mode: "outside" | "inside";
  buffered: string;
  pending: string;
};

export function createPasteGuardState(): PasteGuardState {
  return { mode: "outside", buffered: "", pending: "" };
}

// Joins the interior lines of a pasted block into one line while keeping a
// single trailing newline/return, which still submits the merged input.
export function normalizePastedText(text: string): string {
  const trailing = /[\r\n]$/.exec(text)?.[0] ?? "";
  const body = trailing ? text.slice(0, -trailing.length) : text;
  const joined = body
    .replace(/\r\n?|\n/g, " ")
    .replace(/[ \t]+/g, " ")
    .trimStart();

  return `${joined}${trailing}`;
}

export function transformPasteChunk(raw: string, state: PasteGuardState): string {
  const combined = state.pending.length > 0 ? state.pending + raw : raw;
  state.pending = "";

  if (
    state.mode === "outside" &&
    !combined.includes(BRACKETED_PASTE_START) &&
    combined.length >= MIN_HEURISTIC_PASTE_LENGTH &&
    /[\r\n]/.test(combined)
  ) {
    return normalizePastedText(combined);
  }

  let output = "";
  let index = 0;

  while (index < combined.length) {
    if (state.mode === "outside") {
      const startAt = combined.indexOf(BRACKETED_PASTE_START, index);

      if (startAt === -1) {
        const tail = partialMarkerPrefix(combined.slice(index), BRACKETED_PASTE_START);

        if (tail.length > 0) {
          output += combined.slice(index, combined.length - tail.length);
          state.pending = tail;
        } else {
          output += combined.slice(index);
        }

        break;
      }

      output += combined.slice(index, startAt);
      state.buffered = "";
      state.mode = "inside";
      index = startAt + BRACKETED_PASTE_START.length;
      continue;
    }

    const endAt = combined.indexOf(BRACKETED_PASTE_END, index);

    if (endAt === -1) {
      const tail = partialMarkerPrefix(combined.slice(index), BRACKETED_PASTE_END);

      if (tail.length > 0) {
        state.buffered += combined.slice(index, combined.length - tail.length);
        state.pending = tail;
      } else {
        state.buffered += combined.slice(index);
      }

      break;
    }

    state.buffered += combined.slice(index, endAt);
    output += normalizePastedText(state.buffered);
    state.buffered = "";
    state.mode = "outside";
    index = endAt + BRACKETED_PASTE_END.length;
  }

  return output;
}

function partialMarkerPrefix(text: string, marker: string): string {
  const maxLength = Math.min(marker.length - 1, text.length);

  for (let length = maxLength; length > 0; length -= 1) {
    const tail = text.slice(text.length - length);

    if (marker.startsWith(tail)) {
      return tail;
    }
  }

  return "";
}

type RawStream = Readable & {
  setRawMode?: (mode: boolean) => unknown;
};

export function createPasteGuardStream(source: RawStream): Transform {
  const state = createPasteGuardState();
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const merged = transformPasteChunk(chunk.toString("utf8"), state);

        if (merged.length > 0) {
          this.push(merged);
        }

        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  const bridge = guard as Transform & {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };

  Object.defineProperty(bridge, "isTTY", { value: true, enumerable: false });
  bridge.isRaw = false;
  bridge.setRawMode = (mode: boolean) => {
    source.setRawMode?.(mode);

    if (typeof (source as RawStream & { isRaw?: boolean }).isRaw === "boolean") {
      bridge.isRaw = mode;
    }
  };

  source.pipe(guard);

  return guard;
}
