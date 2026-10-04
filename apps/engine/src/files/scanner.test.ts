import { describe, expect, test } from "bun:test";
import { getScanner, NoopScanner } from "./scanner.ts";

async function* emptyStream(): AsyncIterable<Uint8Array> {}

async function* textStream(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

async function* binaryStream(buf: Uint8Array): AsyncIterable<Uint8Array> {
  yield buf;
}

async function* multiChunkStream(chunks: string[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield new TextEncoder().encode(c);
}

describe("NoopScanner", () => {
  test("returns clean verdict for plain text input", async () => {
    const result = await NoopScanner.scan(textStream("hello world"), {
      filename: "hello.txt",
      content_type: "text/plain",
    });
    expect(result.verdict).toBe("clean");
    expect(result.engine).toBe("noop");
  });

  test("returns clean verdict for empty stream", async () => {
    const result = await NoopScanner.scan(emptyStream(), {
      filename: "empty.bin",
      content_type: null,
    });
    expect(result.verdict).toBe("clean");
    expect(result.engine).toBe("noop");
  });

  test("returns clean verdict for binary-pattern input", async () => {
    const buf = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x4d, 0x5a]);
    const result = await NoopScanner.scan(binaryStream(buf), {
      filename: "payload.bin",
      content_type: "application/octet-stream",
    });
    expect(result.verdict).toBe("clean");
    expect(result.engine).toBe("noop");
  });

  test("returns clean verdict for large multi-chunk stream", async () => {
    const largeChunk = "x".repeat(1024 * 1024);
    const chunks = Array.from({ length: 10 }, () => largeChunk);
    const result = await NoopScanner.scan(multiChunkStream(chunks), {
      filename: "large.txt",
      content_type: "text/plain",
    });
    expect(result.verdict).toBe("clean");
    expect(result.engine).toBe("noop");
  });

  test("returns clean verdict when content_type is undefined", async () => {
    const result = await NoopScanner.scan(textStream("data"), {
      filename: "no-type.dat",
    });
    expect(result.verdict).toBe("clean");
    expect(result.engine).toBe("noop");
  });

  test("never produces a signature field", async () => {
    const result = await NoopScanner.scan(textStream("test"), {
      filename: "f.txt",
    });
    expect(result.signature).toBeUndefined();
  });
});

describe("getScanner", () => {
  test("returns NoopScanner", () => {
    const scanner = getScanner();
    expect(scanner).toBe(NoopScanner);
  });

  test("NoopScanner returned by getScanner is also clean for any input", async () => {
    const scanner = getScanner();
    const result = await scanner.scan(textStream("anything"), { filename: "x.txt" });
    expect(result.verdict).toBe("clean");
  });
});
