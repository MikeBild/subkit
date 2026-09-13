// Unit tests for the welcome banner tip picker. The Ink component
// itself is exercised indirectly via the InkApp integration tests;
// here we just lock the tip rotation logic.

import { describe, expect, test } from "bun:test";

import { BANNER_TIPS, pickTip } from "../repl/welcome-banner.tsx";

describe("sk welcome banner", () => {
  test("pickTip always returns a non-empty string from BANNER_TIPS", () => {
    for (let i = 0; i < 50; i++) {
      const tip = pickTip(i);
      expect(tip.length).toBeGreaterThan(0);
      expect(BANNER_TIPS).toContain(tip);
    }
  });

  test("pickTip is deterministic for a given seed", () => {
    expect(pickTip(7)).toBe(pickTip(7));
    expect(pickTip(7)).toBe(pickTip(7 + BANNER_TIPS.length));
  });
});
