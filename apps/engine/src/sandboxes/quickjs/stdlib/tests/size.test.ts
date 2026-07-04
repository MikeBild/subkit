// Size tripwire for the stdlib preamble.
//
// `stdlib.js` is evaluated AFRESH on every `runJs` call — QuickJS does not
// share bytecode across contexts — so its byte size is paid by every
// before-request hook and every JS transform. This test fails the build
// if the source crosses the ceiling so that growth is a conscious
// decision, not a silent regression. The ceiling was raised 25→30 KB for
// the MIME surface: `sk` is frozen at install, so an on-demand sub-module
// cannot attach to it — see README "Size budget" for the trade-off the
// next bump must revisit.

import { describe, expect, test } from "bun:test";
import { STDLIB_SOURCE } from "../index.ts";

const SIZE_CEILING_BYTES = 30_000;

describe("stdlib.js size budget", () => {
  test(`source length stays under ${SIZE_CEILING_BYTES} bytes`, () => {
    // `STDLIB_SOURCE` is the exact text bundled into the binary and
    // evaluated in the VM, so its `.length` is the byte budget that
    // matters at runtime.
    expect(STDLIB_SOURCE.length).toBeLessThan(SIZE_CEILING_BYTES);
  });
});
