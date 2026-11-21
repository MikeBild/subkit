import { describe, expect, test } from "bun:test";
import {
  freshHeld,
  HELD_MEMORY_MS,
  heldHint,
  type PauseInputs,
  parsePause,
  pauseSupportOf,
  pauseToggle,
  trayMute,
} from "./pause-model.ts";

const now = new Date(2026, 10, 21, 23, 0).getTime();
const quietHours = { enabled: true, start: "22:00", end: "07:00" };
const base: PauseInputs = {
  support: "server",
  server: { paused: false, mode: null, paused_at: null, until: null },
  held: null,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
  localPauseUntil: null,
  now,
};

describe("server pause", () => {
  test("the route decides whether the server owns the pause", () => {
    expect(pauseSupportOf(200)).toBe("server");
    expect(pauseSupportOf(404)).toBe("local");
    expect(pauseSupportOf(503)).toBeNull();
  });

  test("reads the pause body defensively", () => {
    expect(
      parsePause({ paused: true, mode: "until", paused_at: "x", until: "2026-11-22T00:00:00Z" }),
    ).toEqual({ paused: true, mode: "until", paused_at: "x", until: "2026-11-22T00:00:00Z" });
    expect(parsePause({ paused: "yes" })).toBeNull();
    expect(parsePause(null)).toBeNull();
    expect(parsePause({ paused: false, mode: "other" })?.mode).toBeNull();
  });

  test("toggling pauses for one hour or resumes", () => {
    expect(pauseToggle(false)).toEqual({ method: "PUT", body: { mode: "for", minutes: 60 } });
    expect(pauseToggle(true)).toEqual({ method: "DELETE" });
  });
});

describe("held hint on the stream", () => {
  test("reads who holds banners and until when", () => {
    expect(
      heldHint(
        JSON.stringify({ delivery: "held", held_by: "pause", held_until: "2026-11-22T00:00:00Z" }),
        now,
      ),
    ).toEqual({ by: "pause", until: Date.parse("2026-11-22T00:00:00Z"), at: now });
    expect(heldHint(JSON.stringify({ delivery: "held", held_by: "schedule" }), now)).toEqual({
      by: "schedule",
      until: null,
      at: now,
    });
    expect(heldHint(JSON.stringify({ delivery: "held" }), now)).toBeNull();
    expect(heldHint("{", now)).toBeNull();
  });

  test("forgets a hint after 90 seconds", () => {
    const held = { by: "schedule" as const, until: null, at: now };
    expect(freshHeld(held, now + HELD_MEMORY_MS)).toBe(held);
    expect(freshHeld(held, now + HELD_MEMORY_MS + 1)).toBeNull();
  });
});

describe("tray mute", () => {
  test("a timed server pause names its end", () => {
    const until = "2026-11-22T00:00:00.000Z";
    expect(
      trayMute({ ...base, server: { paused: true, mode: "until", paused_at: null, until } }),
    ).toEqual({ reason: "paused", until: new Date(until) });
  });

  test("a pause until resumed has no end", () => {
    expect(
      trayMute({
        ...base,
        server: { paused: true, mode: "until_resumed", paused_at: null, until: null },
      }),
    ).toEqual({ reason: "paused", until: null });
  });

  test("the server's quiet hours come from the stream", () => {
    const until = Date.parse("2026-11-22T06:00:00Z");
    expect(trayMute({ ...base, held: { by: "schedule", until, at: now } })).toEqual({
      reason: "quiet-hours",
      until: new Date(until),
    });
  });

  test("the device's quiet hours still count", () => {
    expect(trayMute({ ...base, quietHours })?.reason).toBe("quiet-hours");
    expect(trayMute(base)).toBeNull();
  });

  test("a server without the route keeps the local pause", () => {
    const local = { ...base, support: "local" as const, localPauseUntil: now + 60_000 };
    expect(trayMute(local)).toEqual({ reason: "paused", until: new Date(now + 60_000) });
    expect(
      trayMute({
        ...local,
        server: { paused: true, mode: "until_resumed", paused_at: null, until: null },
      })?.until,
    ).toEqual(new Date(now + 60_000));
  });
});
