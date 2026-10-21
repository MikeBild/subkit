import { describe, expect, test } from "bun:test";
import { ACCOUNT_TRIGGER, CHAT_COLUMN, triggerOwner } from "./shell-header";

describe("triggerOwner", () => {
  const wide = { mobile: false, chatHeader: false, pageFrames: 1 };

  test("a page header on a wide screen draws the toggle beside its heading", () => {
    expect(triggerOwner(wide)).toBe("page");
  });

  test("a phone keeps the bar: the navigation opens from it", () => {
    expect(triggerOwner({ ...wide, mobile: true })).toBe("bar");
  });

  test("the chat header lives in the bar", () => {
    expect(triggerOwner({ ...wide, chatHeader: true })).toBe("bar");
  });

  test("a page without a header still gets a toggle, in the bar", () => {
    expect(triggerOwner({ ...wide, pageFrames: 0 })).toBe("bar");
  });
});

describe("CHAT_COLUMN", () => {
  test("starts at the gutter like every page instead of centering", () => {
    expect(CHAT_COLUMN).not.toContain("mx-auto");
  });
});

describe("ACCOUNT_TRIGGER", () => {
  test("drops the expanded minimum height in icon mode so the trigger stays square", () => {
    expect(ACCOUNT_TRIGGER).toContain("min-h-12");
    expect(ACCOUNT_TRIGGER).toContain("group-data-[collapsible=icon]:min-h-0");
  });
});
