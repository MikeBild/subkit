const CSI = "\x1b[";
export const PASTE_START = `${CSI}200~`;
export const PASTE_END = `${CSI}201~`;

const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`;
const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`;

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

interface ApplyState {
  inPaste: boolean;
  pasteBuf: string;
}

interface ApplyResult {
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
