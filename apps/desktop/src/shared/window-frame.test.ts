import { describe, expect, test } from "bun:test";
import {
  CAPTURE_WINDOW,
  COCKPIT_WINDOW,
  captureBounds,
  initialWindowSize,
  overlayBounds,
  PILL_WINDOW,
  pillBounds,
  windowBackground,
} from "./window-frame.ts";

describe("app window frame", () => {
  test("opens at the click-dummy's 1280 × 800 where it fits", () => {
    expect(initialWindowSize({ width: 2560, height: 1440 })).toEqual({ width: 1280, height: 800 });
  });

  test("shrinks to the work area, never below the minimum", () => {
    expect(initialWindowSize({ width: 1024, height: 700 })).toEqual({ width: 1024, height: 700 });
    expect(initialWindowSize({ width: 600, height: 400 })).toEqual({
      width: COCKPIT_WINDOW.minWidth,
      height: COCKPIT_WINDOW.minHeight,
    });
  });

  test("quick capture sits centred at the top of the display", () => {
    expect(captureBounds({ x: 0, y: 25, width: 1512, height: 957 })).toEqual({
      x: 460,
      y: 25,
      width: CAPTURE_WINDOW.width,
      height: CAPTURE_WINDOW.height,
    });
  });

  test("sheets lie on the app window, or in the middle of the display without one", () => {
    const app = { x: 100, y: 80, width: 1280, height: 772 };
    expect(overlayBounds(app, { x: 0, y: 25, width: 1512, height: 957 })).toEqual(app);
    expect(overlayBounds(null, { x: 0, y: 25, width: 1512, height: 957 })).toEqual({
      x: 116,
      y: 104,
      width: 1280,
      height: 800,
    });
  });

  test("the stop pill sits centred just below the top of the display", () => {
    expect(pillBounds({ x: 0, y: 25, width: 1512, height: 957 })).toEqual({
      x: 546,
      y: 33,
      width: PILL_WINDOW.width,
      height: PILL_WINDOW.height,
    });
  });

  test("paints the theme background before the page", () => {
    expect(windowBackground(false)).toBe("#ffffff");
    expect(windowBackground(true)).toBe("#020618");
  });
});
