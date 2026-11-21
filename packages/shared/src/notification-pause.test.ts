import { describe, expect, test } from "bun:test";
import {
  isPausedAt,
  pauseRequestForMinutes,
  pauseState,
  pauseUntilForMinutes,
} from "./notification-pause.ts";

const NOW = Date.parse("2026-11-21T10:00:00.000Z");

describe("the shared notification pause state", () => {
  test("no answer or an unpaused answer is off", () => {
    expect(pauseState(null, NOW)).toEqual({ kind: "off" });
    expect(pauseState({ paused: false, mode: null, paused_at: null, until: null }, NOW)).toEqual({
      kind: "off",
    });
  });

  test("a pause until a time shows the remaining time and ends by itself", () => {
    const body = {
      paused: true,
      mode: "until" as const,
      paused_at: "2026-11-21T09:30:00.000Z",
      until: "2026-11-21T10:30:00.000Z",
    };
    expect(pauseState(body, NOW)).toEqual({
      kind: "until",
      until: Date.parse("2026-11-21T10:30:00.000Z"),
      remaining_ms: 30 * 60_000,
    });
    expect(isPausedAt(body, Date.parse("2026-11-21T10:30:00.000Z"))).toBe(false);
  });

  test("a pause until resumed has no end", () => {
    expect(
      pauseState(
        { paused: true, mode: "until_resumed", paused_at: "2026-11-21T09:00:00.000Z", until: null },
        NOW,
      ),
    ).toEqual({ kind: "until_resumed", since: Date.parse("2026-11-21T09:00:00.000Z") });
  });

  test("the tray's hour becomes a request the server plans", () => {
    expect(pauseRequestForMinutes(60)).toEqual({ mode: "for", minutes: 60 });
    expect(pauseRequestForMinutes(0)).toEqual({ mode: "for", minutes: 1 });
    expect(pauseUntilForMinutes(NOW, 60)).toBe(NOW + 3_600_000);
  });
});
