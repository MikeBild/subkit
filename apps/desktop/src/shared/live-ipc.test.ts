import { describe, expect, test } from "bun:test";
import { isLiveUrl, LIVE_VIEWS, liveUrl, liveViewOf, screenshotSrc } from "./live-ipc.ts";

describe("live window address", () => {
  test("names the window and the overlay pill", () => {
    for (const view of LIVE_VIEWS) {
      expect(isLiveUrl(liveUrl(view))).toBe(true);
      expect(liveViewOf(liveUrl(view))).toBe(view);
    }
    expect(liveViewOf("subkit-app://shell/live.html#other")).toBeNull();
    expect(liveViewOf("subkit-app://shell/index.html#window")).toBeNull();
    expect(isLiveUrl("https://example.org/live.html")).toBe(false);
  });

  test("a screenshot address changes with every new screenshot", () => {
    expect(screenshotSrc(0)).toBeNull();
    expect(screenshotSrc(3)).toBe("screenshot.png?v=3");
  });
});
