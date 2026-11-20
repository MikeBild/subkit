import { describe, expect, test } from "bun:test";
import { backoffDelay, createSseParser, type SseEvent } from "./sse.ts";

function collect(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

describe("createSseParser", () => {
  test("parses id, event and data across arbitrary chunk borders", () => {
    const wire =
      'id: 41\nevent: connector.auth_failed\ndata: {"attention_id":"workflow:42"}\n\nevent: ping\ndata: {}\n\n';
    for (const size of [1, 3, 7, wire.length]) {
      const chunks = wire.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];
      expect(collect(chunks)).toEqual([
        { id: "41", event: "connector.auth_failed", data: '{"attention_id":"workflow:42"}' },
        { id: null, event: "ping", data: "{}" },
      ]);
    }
  });

  test("handles CRLF, comments, multi-line data and the default event name", () => {
    expect(collect([": keep-alive\r\n", "data: a\r\ndata: b\r\n\r\n"])).toEqual([
      { id: null, event: "message", data: "a\nb" },
    ]);
  });

  test("emits nothing for an unfinished event", () => {
    expect(collect(["id: 1\nevent: hello\ndata: {}\n"])).toEqual([]);
  });
});

describe("backoffDelay", () => {
  test("grows exponentially between half and the full ceiling and stops at the maximum", () => {
    expect(backoffDelay(0, 0)).toBe(500);
    expect(backoffDelay(0, 1)).toBe(1000);
    expect(backoffDelay(3, 0.5)).toBe(6000);
    expect(backoffDelay(10, 1)).toBe(60000);
    expect(backoffDelay(99, 1)).toBe(60000);
    expect(backoffDelay(-1, 2)).toBe(1000);
  });
});
