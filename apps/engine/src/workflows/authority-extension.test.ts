import { describe, expect, test } from "bun:test";
import { expiryStage } from "./authority-extension.ts";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const DAY = 86_400_000;
const inDays = (days: number, ms = 0) => new Date(NOW.getTime() + days * DAY + ms);

describe("expiryStage", () => {
  test("an open-ended approval never expires", () => {
    expect(expiryStage(null, NOW)).toBe("none");
  });

  test("more than seven days away needs nothing yet", () => {
    expect(expiryStage(inDays(7, 1), NOW)).toBe("none");
    expect(expiryStage(inDays(31), NOW)).toBe("none");
  });

  test("within seven days it needs attention", () => {
    expect(expiryStage(inDays(7), NOW)).toBe("attention");
    expect(expiryStage(inDays(3, 1), NOW)).toBe("attention");
  });

  test("within three days it is announced", () => {
    expect(expiryStage(inDays(3), NOW)).toBe("notify");
    expect(expiryStage(inDays(0, 1), NOW)).toBe("notify");
  });

  test("at or after its end it has ended", () => {
    expect(expiryStage(inDays(0), NOW)).toBe("ended");
    expect(expiryStage(inDays(-1), NOW)).toBe("ended");
  });
});
