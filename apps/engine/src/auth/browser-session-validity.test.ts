import { describe, expect, test } from "bun:test";
import {
  browserSessionDenyReason,
  DESKTOP_SESSION_ABSOLUTE_TTL_MS,
  DESKTOP_SESSION_SLIDING_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_SLIDING_TTL_MS,
  sessionLifetime,
} from "./browser-session-validity.ts";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(lastSeenAgoMs: number, absoluteInMs: number) {
  return {
    revoked_at: null,
    expires_at: new Date(NOW.getTime() + HOUR),
    absolute_expires_at: new Date(NOW.getTime() + absoluteInMs),
    last_seen_at: new Date(NOW.getTime() - lastSeenAgoMs),
  };
}

describe("session lifetime", () => {
  test("a browser and an installed web app keep 8 hours idle and 24 hours at most", () => {
    for (const kind of [null, undefined, "browser"] as const)
      expect(sessionLifetime(kind)).toEqual({
        sliding_ms: SESSION_SLIDING_TTL_MS,
        absolute_ms: SESSION_ABSOLUTE_TTL_MS,
      });
    expect(SESSION_SLIDING_TTL_MS).toBe(8 * HOUR);
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(24 * HOUR);
  });

  test("a desktop device keeps 30 days idle and 90 days at most", () => {
    expect(sessionLifetime("desktop")).toEqual({
      sliding_ms: DESKTOP_SESSION_SLIDING_TTL_MS,
      absolute_ms: DESKTOP_SESSION_ABSOLUTE_TTL_MS,
    });
    expect(DESKTOP_SESSION_SLIDING_TTL_MS).toBe(30 * DAY);
    expect(DESKTOP_SESSION_ABSOLUTE_TTL_MS).toBe(90 * DAY);
  });

  test("the idle window decides only with the lifetime of the session's own kind", () => {
    const desktop = sessionLifetime("desktop").sliding_ms;
    expect(browserSessionDenyReason(row(9 * HOUR, DAY), NOW)).toBe("expired_sliding");
    expect(browserSessionDenyReason(row(9 * HOUR, DAY), NOW, desktop)).toBeNull();
    expect(browserSessionDenyReason(row(30 * DAY, DAY), NOW, desktop)).toBeNull();
    expect(browserSessionDenyReason(row(30 * DAY + 1, DAY), NOW, desktop)).toBe("expired_sliding");
  });

  test("the absolute end and a revocation win over any idle window", () => {
    const desktop = sessionLifetime("desktop").sliding_ms;
    expect(browserSessionDenyReason(row(0, 0), NOW, desktop)).toBe("expired_absolute");
    expect(browserSessionDenyReason({ ...row(0, DAY), revoked_at: NOW }, NOW, desktop)).toBe(
      "revoked",
    );
  });
});
