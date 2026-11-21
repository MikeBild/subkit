import { describe, expect, test } from "bun:test";
import {
  presentRequestBoundary,
  type RequestBoundaryView,
} from "@/features/grants/model/authority-request";
import { translate } from "@/lib/i18n";

const plain = (value: number) => String(value);
const base: RequestBoundaryView = {
  method: "GET",
  origin: "https://api.example.test",
  segments: ["", "v2", "stats"],
  variables: {},
  query: { fixed: { tz: "UTC" }, variable: [] },
  max_body_bytes: 0,
  max_calls: 1,
};

describe("connector query keys in the review", () => {
  test("a boundary without connector keys shows nothing about them", () => {
    const shown = presentRequestBoundary(base, plain);
    expect(shown.connectorQuery).toBeNull();
    expect(shown.target).toBe("https://api.example.test/v2/stats?tz=UTC");
  });

  test("the key names are shown, a value never is", () => {
    const shown = presentRequestBoundary(
      { ...base, connector_query: { fixed: { format: "json-s3cr3t" }, credential: ["api_key"] } },
      plain,
    );
    expect(shown.target).toBe("https://api.example.test/v2/stats?tz=UTC&format=…&api_key=…");
    expect(shown.connectorQuery).toEqual({
      key: "authority.boundary.connectorQuery.other",
      values: { names: "format, api_key" },
    });
    for (const locale of ["de", "en"] as const) {
      const text = translate(locale, shown.connectorQuery!.key, shown.connectorQuery!.values);
      expect(text).toContain("format, api_key");
      expect(text).not.toContain("s3cr3t");
    }
    expect(JSON.stringify(shown)).not.toContain("s3cr3t");
  });

  test("one key reads as one parameter in both languages", () => {
    const shown = presentRequestBoundary(
      { ...base, connector_query: { fixed: {}, credential: ["api_key"] } },
      plain,
    );
    expect(shown.connectorQuery?.key).toBe("authority.boundary.connectorQuery.one");
    expect(translate("de", shown.connectorQuery!.key, shown.connectorQuery!.values)).toContain(
      "den Parameter api_key",
    );
    expect(translate("en", shown.connectorQuery!.key, shown.connectorQuery!.values)).toContain(
      "the parameter api_key",
    );
  });

  test("both refusals have a plain sentence in both languages", () => {
    for (const locale of ["de", "en"] as const)
      for (const key of [
        "authority.refusal.connector_query_conflict",
        "authority.refusal.connector_query_unresolved",
        "authority.boundary.connectorAdds",
      ] as const) {
        const text = translate(locale, key);
        expect(text.length).toBeGreaterThan(40);
        expect(text).not.toContain("!");
        expect(text).not.toContain("_");
      }
  });
});
