// Size tripwire for the stdlib preamble.
//
// `stdlib.js` is evaluated AFRESH on every `runJs` call — QuickJS does not
// share bytecode across contexts — so its byte size is paid by every
// before-request hook and every JS transform. Past the soft ceiling the
// next additive surface must be split into an on-demand sub-module rather
// than inflating the default preamble. This test fails the build if the
// source crosses 25 KB so that growth is a conscious decision, not a
// silent regression. Current size is ~20.7 KB (see README "Size budget").

import { describe, expect, test } from "bun:test";
import { STDLIB_SOURCE } from "../index.ts";

const SIZE_CEILING_BYTES = 25_000;

describe("stdlib.js size budget", () => {
  test(`source length stays under ${SIZE_CEILING_BYTES} bytes`, () => {
    // `STDLIB_SOURCE` is the exact text bundled into the binary and
    // evaluated in the VM, so its `.length` is the byte budget that
    // matters at runtime.
    expect(STDLIB_SOURCE.length).toBeLessThan(SIZE_CEILING_BYTES);
  });
});
