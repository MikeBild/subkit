import { describe, expect, test } from "bun:test";
import { expectedKpiLinks } from "../lib/cockpit-kpi-links.mjs";

describe("the ways in a KPI card owes (§1)", () => {
  test("a red ratio at zero must lead to its cause", () => {
    // Execution success 0 %: the worst state, not "nothing".
    expect(expectedKpiLinks({ kind: "ratio", value: 0, unread: false, severity: "critical" })).toBe(
      1,
    );
    expect(expectedKpiLinks({ kind: "score", value: 0, unread: false, severity: "critical" })).toBe(
      1,
    );
    expect(
      expectedKpiLinks({ kind: "duration", value: 0, unread: false, severity: "healthy" }),
    ).toBe(1);
  });

  test("a counted zero has nothing to open, however it is coloured", () => {
    expect(expectedKpiLinks({ kind: "count", value: 0, unread: false, severity: "critical" })).toBe(
      0,
    );
    expect(expectedKpiLinks({ value: 0, unread: false, severity: "healthy" })).toBe(0);
    expect(expectedKpiLinks({ kind: "count", value: 3, unread: false, severity: "urgent" })).toBe(
      1,
    );
  });

  test("an unread value links only when it is red", () => {
    expect(expectedKpiLinks({ kind: "score", value: 0, unread: true, severity: "critical" })).toBe(
      1,
    );
    expect(expectedKpiLinks({ kind: "ratio", value: 0, unread: true, severity: "unknown" })).toBe(
      0,
    );
  });
});
