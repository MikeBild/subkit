import { describe, expect, test } from "bun:test";
import { PAUSE_MAX_MINUTES, pauseActive, pauseView, planPause } from "./notification-pause.ts";

const at = new Date("2026-11-21T10:00:00.000Z");
const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000);

describe("a personal notification pause", () => {
  test("no pause stored means notifications flow", () => {
    expect(pauseActive({ paused_at: null, paused_until: null }, at)).toBe(false);
    expect(pauseView({ paused_at: null, paused_until: null }, at)).toEqual({
      paused: false,
      mode: null,
      paused_at: null,
      until: null,
    });
  });

  test("a pause until a time holds until that moment and ends by itself", () => {
    const pause = { paused_at: at, paused_until: later(60) };
    expect(pauseView(pause, later(59))).toEqual({
      paused: true,
      mode: "until",
      paused_at: at,
      until: later(60),
    });
    expect(pauseActive(pause, later(60))).toBe(false);
    expect(pauseView(pause, later(61)).paused).toBe(false);
  });

  test("a pause until resumed lasts", () => {
    expect(pauseView({ paused_at: at, paused_until: null }, later(60 * 24 * 365))).toMatchObject({
      paused: true,
      mode: "until_resumed",
      until: null,
    });
  });

  test("the tray's one hour is planned from the server clock", () => {
    expect(planPause({ mode: "for", minutes: 60 }, at)).toEqual({
      ok: true,
      paused_at: at,
      paused_until: later(60),
    });
    expect(planPause({ mode: "until_resumed" }, at)).toEqual({
      ok: true,
      paused_at: at,
      paused_until: null,
    });
  });

  test("an end in the past or beyond thirty days is refused", () => {
    expect(planPause({ mode: "until", until: at }, at)).toEqual({
      ok: false,
      reason: "pause_in_past",
    });
    expect(planPause({ mode: "until", until: later(PAUSE_MAX_MINUTES + 1) }, at)).toEqual({
      ok: false,
      reason: "pause_too_long",
    });
    expect(planPause({ mode: "until", until: later(PAUSE_MAX_MINUTES) }, at).ok).toBe(true);
  });
});
