import { describe, expect, test } from "bun:test";
import type { PushPreference } from "../identity/setup-preferences.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { deliveryOf } from "./personal-schedule.ts";
import { buildPushSummary, newestItem, pushSummaryMode, summarizesPush } from "./push-summary.ts";

const at = new Date(getTestNow());
const HOUR = 3_600_000;

function clock(offsetMinutes: number): string {
  const moved = new Date(at.getTime() + offsetMinutes * 60_000);
  return `${String(moved.getUTCHours()).padStart(2, "0")}:${String(moved.getUTCMinutes()).padStart(2, "0")}`;
}

function preference(
  schedule: PushPreference["schedule"],
  last_digest_at: Date | null = null,
): PushPreference {
  return {
    schedule,
    timezone: "UTC",
    critical_breakthrough: false,
    last_digest_at,
    approver_user_id: null,
  };
}

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

describe("the summary counts what waits by class", () => {
  test("classes are counted in a fixed order and empty classes are left out", () => {
    expect(
      buildPushSummary([
        { class: "decide" },
        { class: "failing" },
        { class: "decide" },
        { class: "decide" },
        { class: "failing" },
      ]),
    ).toEqual({ total: 5, by_class: { failing: 2, decide: 3 } });
    expect(
      Object.keys(buildPushSummary([{ class: "decide" }, { class: "stopped" }]).by_class),
    ).toEqual(["stopped", "decide"]);
    expect(buildPushSummary([])).toEqual({ total: 0, by_class: {} });
  });

  test("the newest item is the deep-link target, items without a time come last", () => {
    const early = { id: "a", since: new Date(at.getTime() - 2 * HOUR).toISOString() };
    const late = { id: "b", since: new Date(at.getTime() - HOUR).toISOString() };
    const timeless = { id: "c", since: null };
    expect(newestItem([early, late, timeless])?.id).toBe("b");
    expect(newestItem([timeless, early])?.id).toBe("a");
    expect(newestItem([timeless, { id: "d", since: "not a date" }])?.id).toBe("c");
    expect(newestItem([])).toBeNull();
  });
});

describe("a summary replaces single pushes only where items were held", () => {
  test("the daily summary time summarizes as soon as two items are new", () => {
    const due = deliveryOf(
      preference({ mode: "daily_digest", at: clock(-1) }, new Date(at.getTime() - 24 * HOUR)),
      at,
    );
    const mode = pushSummaryMode(due, at);
    expect(mode).toEqual({ kind: "digest" });
    expect(summarizesPush(mode, at, 2)).toBe(true);
    expect(summarizesPush(mode, at, 1)).toBe(false);
    const held = deliveryOf(preference({ mode: "daily_digest", at: clock(60) }, at), at);
    expect(pushSummaryMode(held, at)).toBeNull();
  });

  test("working hours summarize the first push of the window, not later ones", () => {
    const open = deliveryOf(
      preference({ mode: "working_hours", from: clock(-60), to: clock(60), days: EVERY_DAY }),
      at,
    );
    const mode = pushSummaryMode(open, at);
    expect(mode?.kind).toBe("release");
    const start = mode?.kind === "release" ? mode.window_start : null;
    expect(start?.toISOString().slice(0, 16)).toBe(
      new Date(at.getTime() - HOUR).toISOString().slice(0, 16),
    );
    expect(summarizesPush(mode, null, 2)).toBe(true);
    expect(summarizesPush(mode, new Date(at.getTime() - 2 * HOUR), 3)).toBe(true);
    expect(summarizesPush(mode, new Date(at.getTime() - 30 * 60_000), 3)).toBe(false);
    expect(summarizesPush(mode, null, 1)).toBe(false);
  });

  test("pushing right away never summarizes", () => {
    const now = deliveryOf(preference({ mode: "immediately" }), at);
    expect(pushSummaryMode(now, at)).toBeNull();
    expect(summarizesPush(null, null, 9)).toBe(false);
  });
});
