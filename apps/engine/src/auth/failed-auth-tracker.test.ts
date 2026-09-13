// In-memory failed-auth tracker — pins the brute-force threshold
// (exactly one WARN at the 10th failure within the window), the
// per-IP isolation (one IP's count never leaks into another's), and
// that a threshold already crossed doesn't re-alert on every
// subsequent failure.
//
// The tracker's failure map is process-wide module state, so every
// test in this file uses its own unique IP literal to stay isolated
// from the others regardless of execution order.

import { describe, expect, spyOn, test } from "bun:test";

import { logger } from "../logging/logger.ts";
import { recordAuthFailure } from "./failed-auth-tracker.ts";

function warnCallsFor(calls: unknown[][], ip: string) {
  return calls.filter(
    (c) =>
      (c[0] as { action?: string; ip?: string })?.action === "brute_force_detected" &&
      (c[0] as { ip?: string })?.ip === ip,
  );
}

describe("recordAuthFailure — threshold alerting", () => {
  test("no warning before the 10th failure for a fresh IP", () => {
    const ip = "203.0.113.10";
    const warnSpy = spyOn(logger, "warn");
    try {
      for (let i = 0; i < 9; i++) recordAuthFailure(ip);
      expect(warnCallsFor(warnSpy.mock.calls, ip).length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("the 10th failure in the window fires exactly one brute_force_detected warning", () => {
    const ip = "203.0.113.11";
    const warnSpy = spyOn(logger, "warn");
    try {
      for (let i = 0; i < 10; i++) recordAuthFailure(ip);
      const calls = warnCallsFor(warnSpy.mock.calls, ip);
      expect(calls.length).toBe(1);
      const payload = calls[0]?.[0] as {
        module?: string;
        ip?: string;
        count?: number;
        window_ms?: number;
      };
      expect(payload.module).toBe("auth");
      expect(payload.ip).toBe(ip);
      expect(payload.count).toBe(10);
      expect(payload.window_ms).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("failures past the threshold do not re-alert (alerted latch)", () => {
    const ip = "203.0.113.12";
    const warnSpy = spyOn(logger, "warn");
    try {
      for (let i = 0; i < 15; i++) recordAuthFailure(ip);
      expect(warnCallsFor(warnSpy.mock.calls, ip).length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("two different IPs are tracked independently", () => {
    const ipA = "203.0.113.20";
    const ipB = "203.0.113.21";
    const warnSpy = spyOn(logger, "warn");
    try {
      for (let i = 0; i < 5; i++) recordAuthFailure(ipA);
      expect(warnCallsFor(warnSpy.mock.calls, ipA).length).toBe(0);
      expect(warnCallsFor(warnSpy.mock.calls, ipB).length).toBe(0);

      for (let i = 0; i < 10; i++) recordAuthFailure(ipB);
      expect(warnCallsFor(warnSpy.mock.calls, ipB).length).toBe(1);
      // ipA is still below its own threshold and unaffected by ipB's alert.
      expect(warnCallsFor(warnSpy.mock.calls, ipA).length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
