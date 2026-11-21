import { describe, expect, test } from "bun:test";
import { SWIPE_DISMISS_DISTANCE, swipeDismisses } from "@ui/lib/sheet-swipe";

describe("swipeDismisses", () => {
  const start = { x: 200, y: 400 };

  test("a swipe toward the edge the sheet came from closes it", () => {
    expect(swipeDismisses("left", start, { x: 200 - SWIPE_DISMISS_DISTANCE, y: 410 })).toBe(true);
    expect(swipeDismisses("right", start, { x: 200 + SWIPE_DISMISS_DISTANCE, y: 390 })).toBe(true);
  });

  test("a short or opposite swipe keeps it open", () => {
    expect(swipeDismisses("left", start, { x: 170, y: 400 })).toBe(false);
    expect(swipeDismisses("left", start, { x: 300, y: 400 })).toBe(false);
    expect(swipeDismisses("right", start, { x: 100, y: 400 })).toBe(false);
  });

  test("scrolling the navigation vertically never closes it", () => {
    expect(swipeDismisses("left", start, { x: 120, y: 200 })).toBe(false);
    expect(swipeDismisses("left", start, { x: 200, y: 100 })).toBe(false);
  });
});
