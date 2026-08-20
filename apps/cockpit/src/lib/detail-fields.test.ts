import { describe, expect, test } from "bun:test";
import { DETAIL_FIELDS, detailEntries } from "@/lib/detail-fields";
import { CATALOGS } from "@/lib/i18n";

// The record the connector detail page renders, in the engine's own key order.
// It is the shape the screenshot round caught: an identifier first, a raw
// instant last, and every label in between produced by machine.
const CONNECTOR = {
  id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
  tenant_id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
  updated_at: "2026-08-19T12:19:08.347Z",
  slug: "reporting-api",
  display_name: "Reporting API",
  category: "reporting",
  driver: "http",
  environment: "prod",
  auth_type: "oauth2",
  health_state: "ok",
  health_reason: null,
  needs_reauth: false,
  auth_failed_at: null,
  enabled: true,
};

describe("cockpit detail fields", () => {
  test("names every curated field in both catalogs", () => {
    for (const field of DETAIL_FIELDS) {
      expect(CATALOGS.en[field.labelKey], `${field.key} has no English label`).toBeTruthy();
      expect(CATALOGS.de[field.labelKey], `${field.key} has no German label`).toBeTruthy();
      // A German label that still reads as the engine's key would pass the
      // catalog lookup and fail the reader.
      expect(CATALOGS.de[field.labelKey]).not.toBe(field.key.replaceAll("_", " "));
    }
  });

  test("keeps identifiers off the connector overview", () => {
    const keys = detailEntries(CONNECTOR).map((entry) => entry.key);
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("tenant_id");
  });

  test("leaves the record's own name to the heading above it", () => {
    expect(detailEntries(CONNECTOR).map((entry) => entry.key)).not.toContain("display_name");
  });

  test("drops a field nobody curated instead of inventing a label for it", () => {
    const keys = detailEntries({ ...CONNECTOR, oauth_refresh_strategy: "rotating" }).map(
      (entry) => entry.key,
    );
    expect(keys).not.toContain("oauth_refresh_strategy");
  });

  test("reads in the curated order, not the order the engine serialised", () => {
    expect(detailEntries(CONNECTOR).map((entry) => entry.key)).toEqual([
      "health_state",
      "health_reason",
      "enabled",
      "auth_type",
      "needs_reauth",
      "auth_failed_at",
      "category",
      "driver",
      "environment",
      "slug",
      "updated_at",
    ]);
  });

  test("keeps a measured absence and skips a field the record never had", () => {
    const entries = detailEntries(CONNECTOR);
    expect(entries.find((entry) => entry.key === "health_reason")?.value).toBeNull();
    expect(entries.map((entry) => entry.key)).not.toContain("scan_result");
  });

  test("marks a timestamp as a date so it cannot reach the page as an instant", () => {
    for (const key of ["updated_at", "created_at", "last_executed_at", "auth_failed_at"]) {
      expect(DETAIL_FIELDS.find((field) => field.key === key)?.format).toBe("date");
    }
  });
});
