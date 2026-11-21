import { describe, expect, test } from "bun:test";
import { loadingPhase, SKELETON_MIN_MS } from "@ui/lib/loading-phase";

describe("loading phase", () => {
  test("nothing shows before the delay; once shown, it holds the minimum", () => {
    expect(loadingPhase({ loading: true, shownAt: null, now: 0 })).toBe("reserve");
    expect(loadingPhase({ loading: true, shownAt: 0, now: 10 })).toBe("skeleton");
    expect(loadingPhase({ loading: false, shownAt: 0, now: SKELETON_MIN_MS - 1 })).toBe("skeleton");
    expect(loadingPhase({ loading: false, shownAt: 0, now: SKELETON_MIN_MS })).toBe("content");
    expect(loadingPhase({ loading: false, shownAt: null, now: 0 })).toBe("content");
  });
});
