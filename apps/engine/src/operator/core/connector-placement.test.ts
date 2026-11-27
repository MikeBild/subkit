import { describe, expect, test } from "bun:test";
import { connectorPlacement } from "./connector-placement.ts";

const NOW = new Date("2026-11-27T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function inDays(days: number): Date {
  return new Date(NOW.getTime() + days * DAY);
}

describe("connector attention placement", () => {
  test("an announced retirement far in the future is a notice to decide, not a failure", () => {
    expect(
      connectorPlacement(
        {
          reason: "needs_update",
          health_error_code: "endpoint_deprecated",
          sunset_at: new Date("2028-03-10T00:00:00Z"),
        },
        NOW,
      ),
    ).toEqual({ class: "decide", severity: "notice" });
  });

  test("an announced retirement without a date stays a notice", () => {
    expect(
      connectorPlacement(
        { reason: "needs_update", health_error_code: "endpoint_deprecated", sunset_at: null },
        NOW,
      ),
    ).toEqual({ class: "decide", severity: "notice" });
  });

  test("thirty days or less before the sunset the same entry turns urgent and keeps its class", () => {
    const at = (days: number) =>
      connectorPlacement(
        {
          reason: "needs_update",
          health_error_code: "endpoint_deprecated",
          sunset_at: inDays(days),
        },
        NOW,
      );
    expect(at(31)).toEqual({ class: "decide", severity: "notice" });
    expect(at(30)).toEqual({ class: "decide", severity: "urgent" });
    expect(at(1)).toEqual({ class: "decide", severity: "urgent" });
  });

  test("a sunset that has passed is a failure", () => {
    expect(
      connectorPlacement(
        { reason: "needs_update", health_error_code: "endpoint_deprecated", sunset_at: inDays(-1) },
        NOW,
      ),
    ).toEqual({ class: "failing", severity: "urgent" });
  });

  test("an endpoint that is gone stays failing and urgent, even with a future sunset", () => {
    expect(
      connectorPlacement(
        { reason: "needs_update", health_error_code: "endpoint_removed", sunset_at: inDays(400) },
        NOW,
      ),
    ).toEqual({ class: "failing", severity: "urgent" });
  });

  test("other connector reasons keep failing and urgent", () => {
    for (const reason of ["needs_reauth", "degraded", "unhealthy"])
      expect(
        connectorPlacement(
          { reason, health_error_code: "endpoint_deprecated", sunset_at: inDays(400) },
          NOW,
        ),
      ).toEqual({ class: "failing", severity: "urgent" });
  });
});
