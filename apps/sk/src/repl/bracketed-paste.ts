import { Readable } from "node:stream";

const CSI = "\x1b[";
export const PASTE_START = `${CSI}200~`;
export const PASTE_END = `${CSI}201~`;

export const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`;
export const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`;

export function enableBracketedPaste(stream: NodeJS.WriteStream = process.stdout): () => void {
  try {
    stream.write(ENABLE_BRACKETED_PASTE);
  } catch {}
  return () => {
    try {
      stream.write(DISABLE_BRACKETED_PASTE);
    } catch {}
  };
}

export interface PasteEvent {
  text: string;
  id: number;
}

let pasteSeq = 0;
let lastPaste: PasteEvent | null = null;

function emit(text: string): void {
  pasteSeq = (pasteSeq + 1) % Number.MAX_SAFE_INTEGER;
  lastPaste = { text, id: pasteSeq };
}

export function readLastPaste(): PasteEvent | null {
  const p = lastPaste;
  lastPaste = null;
  return p;
}

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
    forward: string;
    pending: string;
  };
  events: ApplyState & {
    emit: string[];
  };
}

export function applyBracketedPaste(input: string, state: ApplyState): ApplyResult {
  let { inPaste, pasteBuf } = state;
  let forward = "";
  const emitted: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (inPaste) {
      const end = input.indexOf(PASTE_END, i);
      if (end === -1) {
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
