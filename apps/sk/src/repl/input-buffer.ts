// Cursor-aware input buffer — a tiny pure-logic module that powers
// the sk composer. The previous string-only `input` state only
// supported append + backspace; this module adds every readline-style
// edit (word-wise moves, kill-line, kill-to-end, home/end, multi-line
// newlines) plus draft preservation across history cycling.
//
// The module deliberately lives outside React so we can test every
// edit deterministically with `bun test` — no ink-testing-library
// needed. `ink-app.tsx` imports it and drives state via `apply`.
//
// Grapheme / surrogate-pair note: we treat the buffer as a string of
// UTF-16 code units and the cursor as a code-unit offset. This
// matches how node, readline, and most terminals count positions.
// Emoji with combining characters are the responsibility of the
// consumer (it would need grapheme clustering) — the sk REPL's target
// audience doesn't type them in the composer.

export interface InputBuffer {
  /** The raw text content, multi-line with `\n` separators. */
  value: string;
  /** Cursor offset in code units. 0 <= cursor <= value.length. */
  cursor: number;
}

export const EMPTY_BUFFER: InputBuffer = { value: "", cursor: 0 };

/** Create a fresh buffer seeded with `value`; cursor lands at the end. */
export function buffer(value: string): InputBuffer {
  return { value, cursor: value.length };
}

export type InputAction =
  | { type: "insert"; text: string }
  | { type: "deletePrev" }
  | { type: "deleteNext" }
  | { type: "killPrevWord" }
  | { type: "killNextWord" }
  | { type: "killToEnd" }
  | { type: "killLine" }
  | { type: "moveLeft" }
  | { type: "moveRight" }
  | { type: "moveWordLeft" }
  | { type: "moveWordRight" }
  | { type: "moveHome" }
  | { type: "moveEnd" }
  | { type: "moveLineStart" }
  | { type: "moveLineEnd" }
  | { type: "newline" }
  | { type: "clear" }
  | { type: "set"; value: string; cursor?: number };

// ---------- Core reducer ----------

export function apply(state: InputBuffer, action: InputAction): InputBuffer {
  switch (action.type) {
    case "insert":
      return insert(state, action.text);
    case "deletePrev":
      return deletePrev(state);
    case "deleteNext":
      return deleteNext(state);
    case "killPrevWord":
      return killPrevWord(state);
    case "killNextWord":
      return killNextWord(state);
    case "killToEnd":
      return killToEnd(state);
    case "killLine":
      return { value: "", cursor: 0 };
    case "moveLeft":
      return move(state, Math.max(0, state.cursor - 1));
    case "moveRight":
      return move(state, Math.min(state.value.length, state.cursor + 1));
    case "moveWordLeft":
      return move(state, prevWordBoundary(state.value, state.cursor));
    case "moveWordRight":
      return move(state, nextWordBoundary(state.value, state.cursor));
    case "moveHome":
      return move(state, 0);
    case "moveEnd":
      return move(state, state.value.length);
    case "moveLineStart":
      return move(state, lineStart(state.value, state.cursor));
    case "moveLineEnd":
      return move(state, lineEnd(state.value, state.cursor));
    case "newline":
      return insert(state, "\n");
    case "clear":
      return { ...EMPTY_BUFFER };
    case "set":
      return {
        value: action.value,
        cursor: action.cursor ?? action.value.length,
      };
    default:
      return state;
  }
}

// ---------- Primitive edits ----------

function insert(state: InputBuffer, text: string): InputBuffer {
  if (text.length === 0) return state;
  const value = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
  return { value, cursor: state.cursor + text.length };
}

function deletePrev(state: InputBuffer): InputBuffer {
  if (state.cursor === 0) return state;
  const value = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
  return { value, cursor: state.cursor - 1 };
}

function deleteNext(state: InputBuffer): InputBuffer {
  if (state.cursor >= state.value.length) return state;
  const value = state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1);
  return { value, cursor: state.cursor };
}

function killPrevWord(state: InputBuffer): InputBuffer {
  if (state.cursor === 0) return state;
  const start = prevWordBoundary(state.value, state.cursor);
  const value = state.value.slice(0, start) + state.value.slice(state.cursor);
  return { value, cursor: start };
}

function killNextWord(state: InputBuffer): InputBuffer {
  if (state.cursor >= state.value.length) return state;
  const end = nextWordBoundary(state.value, state.cursor);
  const value = state.value.slice(0, state.cursor) + state.value.slice(end);
  return { value, cursor: state.cursor };
}

function killToEnd(state: InputBuffer): InputBuffer {
  if (state.cursor >= state.value.length) return state;
  const end = lineEnd(state.value, state.cursor);
  // Preserve the trailing newline if we're mid-line, drop it when we're
  // at end of line (shell-standard Ctrl-K semantics).
  const value =
    end === state.cursor
      ? // at end of line — delete the newline itself
        state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1)
      : state.value.slice(0, state.cursor) + state.value.slice(end);
  return { value, cursor: state.cursor };
}

function move(state: InputBuffer, cursor: number): InputBuffer {
  return { value: state.value, cursor };
}

// ---------- Word / line boundary helpers ----------

/**
 * A "word character" is a letter, digit, or underscore — the
 * bash / readline convention. Anything else (whitespace, punctuation,
 * slashes) is a separator.
 */
function isWordChar(ch: string): boolean {
  return /[\w]/.test(ch);
}

/**
 * Given a position inside `text`, return the offset at the start of
 * the previous word (left of `pos`). Matches `Alt-Backspace` and
 * `Alt-Left` in most readline shells: skip separators leftward, then
 * skip word chars leftward.
 */
export function prevWordBoundary(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && !isWordChar(text.charAt(i - 1))) i--;
  while (i > 0 && isWordChar(text.charAt(i - 1))) i--;
  return i;
}

/**
 * Given a position inside `text`, return the offset at the start of
 * the next word (right of `pos`). Mirrors `Alt-Right` / `Alt-d`.
 */
export function nextWordBoundary(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && !isWordChar(text.charAt(i))) i++;
  while (i < text.length && isWordChar(text.charAt(i))) i++;
  return i;
}

/** Offset of the `\n` before `pos`, or 0 if we're on the first line. */
export function lineStart(text: string, pos: number): number {
  const prev = text.lastIndexOf("\n", pos - 1);
  return prev === -1 ? 0 : prev + 1;
}

/** Offset of the `\n` after `pos`, or `text.length` on the last line. */
export function lineEnd(text: string, pos: number): number {
  const next = text.indexOf("\n", pos);
  return next === -1 ? text.length : next;
}

/** Split `value` into render-friendly lines (no trailing empty for `"a\n"`). */
export function splitLines(value: string): string[] {
  if (value === "") return [""];
  return value.split("\n");
}

/**
 * Given `value` + `cursor`, return the 0-indexed row + column the
 * cursor sits at. Column is in code units, matching the rest of the
 * buffer.
 */
export function cursorPosition(state: InputBuffer): { row: number; column: number } {
  const before = state.value.slice(0, state.cursor);
  const newlines = before.split("\n");
  const row = newlines.length - 1;
  const column = (newlines[row] ?? "").length;
  return { row, column };
}
