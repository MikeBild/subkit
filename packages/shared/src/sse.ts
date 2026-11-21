export interface SseFrame {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

export type SseParser = (chunk: string) => SseFrame[];

const LINE_END = /\r\n|\n|\r/;

export function createSseParser(): SseParser {
  let buffer = "";
  let id: string | null = null;
  let event = "";
  let data: string[] = [];

  const dispatch = (frames: SseFrame[]) => {
    if (data.length > 0 || event)
      frames.push({ id, event: event || "message", data: data.join("\n") });
    id = null;
    event = "";
    data = [];
  };

  const line = (raw: string, frames: SseFrame[]) => {
    if (raw === "") return dispatch(frames);
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\u0000")) id = value;
  };

  return (chunk) => {
    const frames: SseFrame[] = [];
    buffer += chunk;
    for (;;) {
      const match = LINE_END.exec(buffer);
      if (!match) return frames;
      if (match[0] === "\r" && match.index === buffer.length - 1) return frames;
      line(buffer.slice(0, match.index), frames);
      buffer = buffer.slice(match.index + match[0].length);
    }
  };
}
