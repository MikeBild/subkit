import { describe, expect, test } from "bun:test";
import { trackTabFocus } from "@ui/molecules/tooltip";

function key(name: string): Event {
  return Object.assign(new Event("keydown"), { key: name });
}

describe("tooltip focus", () => {
  test("a focus that follows a Tab press counts as the reader asking for the tooltip", () => {
    const target = new EventTarget();
    const tabbed = trackTabFocus(target, () => {});
    target.dispatchEvent(key("Tab"));
    expect(tabbed()).toBe(true);
  });

  test("a focus without a Tab press, after a click or after another key does not", () => {
    const target = new EventTarget();
    const tabbed = trackTabFocus(target, () => {});
    expect(tabbed()).toBe(false);
    target.dispatchEvent(key("Tab"));
    target.dispatchEvent(new Event("pointerdown"));
    expect(tabbed()).toBe(false);
    target.dispatchEvent(key("Tab"));
    target.dispatchEvent(key("Enter"));
    expect(tabbed()).toBe(false);
  });

  test("the Tab press only covers the focus it moves, not a later programmatic focus", () => {
    const target = new EventTarget();
    const released: Array<() => void> = [];
    const tabbed = trackTabFocus(target, (release) => released.push(release));
    target.dispatchEvent(key("Tab"));
    expect(tabbed()).toBe(true);
    for (const release of released) release();
    expect(tabbed()).toBe(false);
  });
});
