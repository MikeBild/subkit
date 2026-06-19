// Bracketed paste support for the Ink TUI.
//
// A terminal with bracketed paste mode enabled frames pasted text with
// the CSI sequences ESC [ 200 ~ (start) and ESC [ 201 ~ (end). Ink's
// `useInput` is not aware of this protocol — it sees the sequences
// inline with the pasted characters, which makes newlines and
// fragmented pastes unreliable.
//
// This module owns two responsibilities:
//   1. Enable bracketed paste on stdout when the Ink app starts and
//      disable it on exit. When the host terminal does not honour the
//      sequence, the enable byte is harmlessly ignored.
//   2. Wrap `process.stdin` so the bytes Ink eventually reads are
//      already normalised:
//        - ESC [ 200 ~ … ESC [ 201 ~   →   a single opaque chunk with
//          the markers stripped.
//        - partial frames across `data` events are buffered.
//
// The wrapper returns the cleaned text exactly as typed plus a trailing
// newline from the closing marker if the user pasted one. Callers that
// want to distinguish a bracketed paste from a regular keystroke burst
// can inspect `readLastPaste()` immediately after the key event lands —
// see `apps/sk/src/ink-app.tsx` for the consumer pattern.

import { Readable } from "node:stream";

const CSI = "\x1b[";
export const PASTE_START = `${CSI}200~`;
export const PASTE_END = `${CSI}201~`;

export const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`;
export const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`;

/**
 * Enable bracketed paste on the active terminal, returning a disposer
 * that restores the prior mode (practically a best-effort disable —
 * terminals without bracketed paste ignore both writes).
 */
export function enableBracketedPaste(stream: NodeJS.WriteStream = process.stdout): () => void {
  // Some terminals (e.g. non-TTY pipes) raise on write — guard so sk
  // still boots when stdout is redirected.
  try {
    stream.write(ENABLE_BRACKETED_PASTE);
  } catch {
    /* non-TTY — paste handling will fall back to the heuristic */
  }
  return () => {
    try {
      stream.write(DISABLE_BRACKETED_PASTE);
    } catch {
      /* already closed */
    }
  };
}

export interface PasteEvent {
  /** The pasted characters with the PASTE_START / PASTE_END markers
   *  already stripped. Newlines are preserved verbatim. */
  text: string;
  /** Monotonic id so downstream consumers can diff against a cached
   *  last-seen value. Incremented on every emitted paste, wrapping at
   *  Number.MAX_SAFE_INTEGER. */
  id: number;
}

/**
 * Buffers paste frames so a subscriber can read the most recent paste
 * exactly once. Not a general pub/sub — the Ink composer consumes
 * synchronously right after a key event.
 */
let pasteSeq = 0;
let lastPaste: PasteEvent | null = null;

function emit(text: string): void {
  pasteSeq = (pasteSeq + 1) % Number.MAX_SAFE_INTEGER;
  lastPaste = { text, id: pasteSeq };
}

/** Returns and clears the last paste event, if any. */
export function readLastPaste(): PasteEvent | null {
  const p = lastPaste;
  lastPaste = null;
  return p;
}

/**
 * Wrap `process.stdin` with a transform that detects bracketed paste
 * markers, emits a single `PasteEvent` per completed paste, and passes
 * everything else through unchanged. Returns the wrapped stream plus a
 * disposer. Safe to call only once per process; subsequent calls throw.
 *
 * Exported internals (`applyBracketedPaste`) drive the same state
 * machine without touching `process.stdin` — used by tests and by
 * terminals that already strip the markers upstream.
 */
let wrapped = false;

export function wrapStdinForBracketedPaste(): {
  stream: NodeJS.ReadableStream;
  dispose: () => void;
} {
  if (wrapped) {
    throw new Error("wrapStdinForBracketedPaste called twice in the same process");
  }
  wrapped = true;
  const src = process.stdin;
  const out = new Readable({ read() {} });
  let buf = Buffer.alloc(0);
  let inPaste = false;
  let pasteBuf = "";

  const onData = (chunk: Buffer | string): void => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const { keep, events } = applyBracketedPaste(buf.toString("utf8"), { inPaste, pasteBuf });
    inPaste = events.inPaste;
    pasteBuf = events.pasteBuf;
    for (const e of events.emit) emit(e);
    // Forward the non-paste remainder unchanged. When a trailing
    // partial marker is in the buffer we keep the raw bytes so the
    // next `data` event can complete them.
    if (keep.forward.length > 0) out.push(Buffer.from(keep.forward, "utf8"));
    buf = Buffer.from(keep.pending, "utf8");
  };
  const onEnd = (): void => {
    if (pasteBuf.length > 0) emit(pasteBuf);
    out.push(null);
  };

  src.on("data", onData);
  src.once("end", onEnd);

  const dispose = () => {
    src.off("data", onData);
    src.off("end", onEnd);
    wrapped = false;
  };

  return { stream: out, dispose };
}

interface ApplyState {
  inPaste: boolean;
  pasteBuf: string;
}

export interface ApplyResult {
  keep: {
    /** Bytes to forward to the consumer now (paste markers stripped). */
    forward: string;
    /** Bytes to hold onto because they may be the prefix of an
     *  unfinished paste marker. */
    pending: string;
  };
  events: ApplyState & {
    /** Emitted paste texts (markers already stripped). */
    emit: string[];
  };
}

/**
 * Pure state machine for bracketed-paste framing. Exported for unit
 * tests + alternate stdin wrappers; the production call site uses
 * `wrapStdinForBracketedPaste`.
 *
 * The trick: we must not forward half of an ESC[200~ prefix because a
 * subsequent chunk might complete it. We look for the earliest marker
 * that could start here and retain the suspicious tail in `pending`.
 */
export function applyBracketedPaste(input: string, state: ApplyState): ApplyResult {
  let { inPaste, pasteBuf } = state;
  let forward = "";
  const emitted: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (inPaste) {
      const end = input.indexOf(PASTE_END, i);
      if (end === -1) {
        // Marker not yet in buffer — accumulate.
        pasteBuf += input.slice(i);
        i = input.length;
      } else {
        pasteBuf += input.slice(i, end);
        emitted.push(pasteBuf);
        pasteBuf = "";
        inPaste = false;
        i = end + PASTE_END.length;
      }
      continue;
    }
    const start = input.indexOf(PASTE_START, i);
    if (start === -1) {
      // No start marker ahead — keep the trailing slice unless it could
      // be the prefix of one.
      const tail = input.slice(i);
      const suspicious = suspiciousPrefix(tail);
      if (suspicious > 0) {
        forward += tail.slice(0, tail.length - suspicious);
        return {
          keep: { forward, pending: tail.slice(tail.length - suspicious) },
          events: { inPaste, pasteBuf, emit: emitted },
        };
      }
      forward += tail;
      i = input.length;
      continue;
    }
    forward += input.slice(i, start);
    inPaste = true;
    i = start + PASTE_START.length;
  }
  return {
    keep: { forward, pending: "" },
    events: { inPaste, pasteBuf, emit: emitted },
  };
}

/** If `tail` could be the beginning of either PASTE_START or PASTE_END,
 *  return the length of that suspicious prefix so the caller can
 *  retain it until the next chunk arrives. */
function suspiciousPrefix(tail: string): number {
  for (
    let len = Math.min(tail.length, Math.max(PASTE_START.length, PASTE_END.length));
    len > 0;
    len -= 1
  ) {
    const slice = tail.slice(tail.length - len);
    if (PASTE_START.startsWith(slice) || PASTE_END.startsWith(slice)) return len;
  }
  return 0;
}
