import { describe, expect, test } from "bun:test";
import { attentionBadge } from "@/features/overview/model/attention-projection";
import { BADGE_MAX, badgeCount, showAppBadge } from "./app-badge";

function target() {
  const calls: (number | "clear")[] = [];
  return {
    calls,
    setAppBadge: async (count?: number) => {
      calls.push(count ?? -1);
    },
    clearAppBadge: async () => {
      calls.push("clear");
    },
  };
}

describe("app badge count", () => {
  test("is the number of open attention entries", () => {
    expect(badgeCount({ count: 3 })).toBe(3);
    expect(badgeCount(null)).toBe(0);
    expect(badgeCount(undefined)).toBe(0);
    expect(badgeCount(attentionBadge(undefined))).toBe(0);
  });

  test("never goes negative, fractional or past the cap", () => {
    expect(badgeCount({ count: -2 })).toBe(0);
    expect(badgeCount({ count: 2.9 })).toBe(2);
    expect(badgeCount({ count: Number.NaN })).toBe(0);
    expect(badgeCount({ count: 5000 })).toBe(BADGE_MAX);
  });
});

describe("showing the badge", () => {
  test("sets the count and clears at zero", async () => {
    const app = target();
    expect(await showAppBadge(4, app)).toBe("set");
    expect(await showAppBadge(0, app)).toBe("cleared");
    expect(app.calls).toEqual([4, "clear"]);
  });

  test("a browser without badges is left alone", async () => {
    expect(await showAppBadge(4, {})).toBe("unsupported");
    expect(await showAppBadge(0, undefined)).toBe("unsupported");
  });

  test("a refusing browser does not break the page", async () => {
    const refusing = {
      setAppBadge: async () => {
        throw new Error("NotAllowedError");
      },
    };
    expect(await showAppBadge(1, refusing)).toBe("unsupported");
  });
});
