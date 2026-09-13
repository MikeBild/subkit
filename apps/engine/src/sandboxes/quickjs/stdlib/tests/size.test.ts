// Size tripwire for the stdlib preamble.
//
// `stdlib.js` is evaluated AFRESH on every `runJs` call — QuickJS does not
// share bytecode across contexts — so its byte size is paid by every
// before-request hook and every JS transform. This test fails the build
// if the EVALUATED source crosses the ceiling so that growth is a
// conscious decision, not a silent regression. The trade-off history the
// README "Size budget" section records: the ceiling went 25→30 KB for the
// MIME surface; the vendor-shaping surface then revisited the trade-off
// (as that bump demanded) by stripping full-line comments at load time in
// index.ts — comments are for the humans reading stdlib.js, not for the
// VM re-parsing them on every invocation. The ceiling below governs the
// stripped text; the on-disk file may be larger.

import { describe, expect, test } from "bun:test";

import { STDLIB_SOURCE } from "../index.ts";

const SIZE_CEILING_BYTES = 30_000;

describe("stdlib.js size budget", () => {
  test(`evaluated source length stays under ${SIZE_CEILING_BYTES} bytes`, () => {
    // `STDLIB_SOURCE` is the exact text evaluated in the VM (comment-
    // stripped at load), so its `.length` is the byte budget that
    // matters at runtime.
    expect(STDLIB_SOURCE.length).toBeLessThan(SIZE_CEILING_BYTES);
  });

  test("the comment strip left a parseable program (no template-literal casualties)", () => {
    // `new Function` parses without executing — a mis-stripped line
    // (e.g. inside a multiline template literal) fails here rather than
    // at first runJs in production.
    expect(() => new Function(STDLIB_SOURCE)).not.toThrow();
  });
});
