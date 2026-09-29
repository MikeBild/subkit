import { describe, expect, test } from "bun:test";
import { triggerOwner } from "./shell-header";

// One sidebar toggle per viewport, and a bar only where it carries something.

describe("triggerOwner", () => {
  const wide = { mobile: false, breadcrumb: false, chatHeader: false, pageFrames: 1 };

  test("a page frame on a wide screen draws the toggle beside its heading", () => {
    expect(triggerOwner(wide)).toBe("page");
  });

  test("a phone keeps the bar: the navigation opens from it", () => {
    expect(triggerOwner({ ...wide, mobile: true })).toBe("bar");
  });

  test("a record's breadcrumb keeps the bar, even over a page frame", () => {
    // The run log is a page frame that becomes a record address in place.
    expect(triggerOwner({ ...wide, breadcrumb: true })).toBe("bar");
  });

  test("the chat header lives in the bar", () => {
    expect(triggerOwner({ ...wide, chatHeader: true })).toBe("bar");
  });

  test("a page without a frame still gets a toggle, in the bar", () => {
    expect(triggerOwner({ ...wide, pageFrames: 0 })).toBe("bar");
  });
});
