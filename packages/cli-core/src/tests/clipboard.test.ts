// OSC 52 clipboard helper — writes the correct escape sequence and
// respects the TTY + size guards.

import { describe, expect, test } from "bun:test";

import { osc52Copy, ringBell } from "../clipboard.ts";

function makeMockStream(isTTY: boolean): {
  stream: NodeJS.WriteStream;
  writes: string[];
} {
  const writes: string[] = [];
  const stream = {
    isTTY,
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

describe("osc52Copy", () => {
  test("writes the OSC 52 sequence with the base64 payload on a TTY", () => {
    const { stream, writes } = makeMockStream(true);
    const ok = osc52Copy("hello", { stream });
    expect(ok).toBe(true);
    expect(writes).toHaveLength(1);
    const expected = Buffer.from("hello", "utf8").toString("base64");
    expect(writes[0]).toBe(`\x1b]52;c;${expected}\x07`);
  });

  test("returns false on a non-TTY stream", () => {
    const { stream, writes } = makeMockStream(false);
    expect(osc52Copy("hello", { stream })).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("returns false when the payload exceeds the byte cap", () => {
    const { stream } = makeMockStream(true);
    // A 1MB payload; default cap is 512KB base64.
    const big = "x".repeat(1_000_000);
    expect(osc52Copy(big, { stream, maxBytes: 1024 })).toBe(false);
  });
});

describe("ringBell", () => {
  test("writes \\x07 on a TTY", () => {
    const { stream, writes } = makeMockStream(true);
    ringBell({ stream });
    expect(writes).toEqual(["\x07"]);
  });

  test("no-ops on a non-TTY stream", () => {
    const { stream, writes } = makeMockStream(false);
    ringBell({ stream });
    expect(writes).toHaveLength(0);
  });
});
