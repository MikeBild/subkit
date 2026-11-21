import { describe, expect, test } from "bun:test";
import { createSseParser, type SseFrame } from "./sse.ts";

function collect(chunks: string[]): SseFrame[] {
  const parse = createSseParser();
  return chunks.flatMap((chunk) => parse(chunk));
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

  test("returns the frames finished by each chunk", () => {
    const parse = createSseParser();
    expect(parse("id: 7\nevent: execution.started\nda")).toEqual([]);
    expect(parse('ta: {"execution_id":"a"}\n\n')).toEqual([
      { id: "7", event: "execution.started", data: '{"execution_id":"a"}' },
    ]);
  });

  test("handles CRLF, CR, comments, multi-line data and the default event name", () => {
    expect(collect([": keep-alive\r\n", "data: a\r\ndata: b\r\n\r\n"])).toEqual([
      { id: null, event: "message", data: "a\nb" },
    ]);
    expect(collect(["data: a\r", "\ndata: b\r\r\n"])).toEqual([
      { id: null, event: "message", data: "a\nb" },
    ]);
    expect(collect(["data:x\rdata\r\r"])).toEqual([]);
    expect(collect(["data:x\rdata\r\r", "\n"])).toEqual([
      { id: null, event: "message", data: "x\n" },
    ]);
  });

  test("a heartbeat or an id alone produces nothing, an event alone is a frame", () => {
    expect(collect([": ping\n\n"])).toEqual([]);
    expect(collect(["id: 9\n\n"])).toEqual([]);
    expect(collect(["event: hello\n\n: keepalive\n\n"])).toEqual([
      { id: null, event: "hello", data: "" },
    ]);
  });

  test("ignores unknown fields and ids with a NUL, and resets per frame", () => {
    expect(collect(["retry: 5\nfoo\nid: a\u0000b\ndata: x\n\ndata: y\n\n"])).toEqual([
      { id: null, event: "message", data: "x" },
      { id: null, event: "message", data: "y" },
    ]);
    expect(collect(["id: 1\nevent: a\ndata: x\n\ndata: y\n\n"])).toEqual([
      { id: "1", event: "a", data: "x" },
      { id: null, event: "message", data: "y" },
    ]);
    expect(collect(["data:  two spaces\n\n"])).toEqual([
      { id: null, event: "message", data: " two spaces" },
    ]);
  });

  test("emits nothing for an unfinished frame", () => {
    expect(collect(["id: 1\nevent: hello\ndata: {}\n"])).toEqual([]);
  });
});
