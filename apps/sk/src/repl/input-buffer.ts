export interface GhostHint {
  text: string;
  consumed: number;
  kind: "text" | "slash";
}

export interface InputBuffer {
  value: string;
  cursor: number;
  ghost?: GhostHint;
}

export const EMPTY_BUFFER: InputBuffer = { value: "", cursor: 0 };

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
  | { type: "set"; value: string; cursor?: number }
  | { type: "ghostSet"; text: string; kind: "text" | "slash" }
  | { type: "ghostAccept" }
  | { type: "ghostClear" };

export function apply(state: InputBuffer, action: InputAction): InputBuffer {
  const next = applyInner(state, action);
  if (next.ghost && next.value !== next.ghost.text.slice(0, next.ghost.consumed)) {
    return { value: next.value, cursor: next.cursor };
  }
  return next;
}

function applyInner(state: InputBuffer, action: InputAction): InputBuffer {
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
    case "ghostSet":
      if (state.value.length > 0 || action.text.length === 0) return state;
      return {
        ...state,
        ghost: { text: action.text, consumed: 0, kind: action.kind },
      };
    case "ghostAccept":
      if (!state.ghost) return state;
      return {
        value: state.ghost.text,
        cursor: state.ghost.text.length,
      };
    case "ghostClear":
      if (!state.ghost) return state;
      return { value: state.value, cursor: state.cursor };
    default:
      return state;
  }
}

function insert(state: InputBuffer, text: string): InputBuffer {
  if (text.length === 0) return state;
  const value = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
  const cursor = state.cursor + text.length;

  if (state.ghost) {
    const ghost = state.ghost;
    if (text.length === 1) {
      const nextChar = ghost.text.charAt(ghost.consumed);
      if (nextChar.length > 0 && nextChar === text) {
        const consumed = ghost.consumed + 1;
        if (consumed >= ghost.text.length) {
          return { value, cursor };
        }
        return { value, cursor, ghost: { ...ghost, consumed } };
      }
    }
    return { value, cursor };
  }
  return { value, cursor };
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
  const value =
    end === state.cursor
      ? state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1)
      : state.value.slice(0, state.cursor) + state.value.slice(end);
  return { value, cursor: state.cursor };
}

function move(state: InputBuffer, cursor: number): InputBuffer {
  return { value: state.value, cursor };
}

function isWordChar(ch: string): boolean {
  return /[\w]/.test(ch);
}

export function prevWordBoundary(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && !isWordChar(text.charAt(i - 1))) i--;
  while (i > 0 && isWordChar(text.charAt(i - 1))) i--;
  return i;
}

export function nextWordBoundary(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && !isWordChar(text.charAt(i))) i++;
  while (i < text.length && isWordChar(text.charAt(i))) i++;
  return i;
}

export function lineStart(text: string, pos: number): number {
  const prev = text.lastIndexOf("\n", pos - 1);
  return prev === -1 ? 0 : prev + 1;
}

export function lineEnd(text: string, pos: number): number {
  const next = text.indexOf("\n", pos);
  return next === -1 ? text.length : next;
}

export function splitLines(value: string): string[] {
  if (value === "") return [""];
  return value.split("\n");
}

export function cursorPosition(state: InputBuffer): { row: number; column: number } {
  const before = state.value.slice(0, state.cursor);
  const newlines = before.split("\n");
  const row = newlines.length - 1;
  const column = (newlines[row] ?? "").length;
  return { row, column };
}
