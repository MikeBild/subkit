export interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

export interface SseParser {
  push(chunk: string): void;
}

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = "";
  let id: string | null = null;
  let event = "";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0 || event) {
      onEvent({ id, event: event || "message", data: data.join("\n") });
    }
    id = null;
    event = "";
    data = [];
  };

  const line = (raw: string) => {
    if (raw === "") return dispatch();
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\u0000")) id = value;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) return;
        if (match[0] === "\r" && match.index === buffer.length - 1) return;
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
  };
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

export function backoffDelay(
  attempt: number,
  jitter: number,
  options: BackoffOptions = {},
): number {
  const base = options.baseMs ?? 1_000;
  const max = options.maxMs ?? 60_000;
  const exponent = Math.min(Math.max(attempt, 0), 16);
  const ceiling = Math.min(max, base * 2 ** exponent);
  const share = Math.min(Math.max(jitter, 0), 1);
  return Math.round(ceiling / 2 + (ceiling / 2) * share);
}
