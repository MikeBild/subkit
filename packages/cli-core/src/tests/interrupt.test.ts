// Two-phase Ctrl+C interrupt ceremony — first press cancels the
// current turn, second press within the window exits. Outside a
// turn, a single press exits directly.

import { describe, expect, test } from "bun:test";
import { makeInterruptController } from "../interrupt.ts";

describe("interrupt controller", () => {
  test("outside a turn, a single press returns exit", () => {
    const ic = makeInterruptController();
    expect(ic.press(false)).toBe("exit");
  });

  test("during a turn, first press cancels the turn", () => {
    const ic = makeInterruptController();
    expect(ic.press(true)).toBe("cancel-turn");
  });

  test("second press within the window returns exit", () => {
    const ic = makeInterruptController(2000);
    expect(ic.press(true)).toBe("cancel-turn");
    expect(ic.press(true)).toBe("exit");
  });

  test("reset() clears the timer", () => {
    const ic = makeInterruptController(2000);
    expect(ic.press(true)).toBe("cancel-turn");
    ic.reset();
    expect(ic.press(true)).toBe("cancel-turn");
  });
});
