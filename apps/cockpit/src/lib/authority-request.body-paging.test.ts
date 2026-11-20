import { describe, expect, test } from "bun:test";
import { translate, translatePlural } from "@/lib/i18n";
import { presentRequestBoundary, type RequestBoundaryView } from "./authority-request";

const plain = (value: number) => String(value);
const base: RequestBoundaryView = {
  method: "POST",
  origin: "https://api.example.test",
  segments: ["", "v2", "search"],
  variables: {},
  query: { fixed: {}, variable: [] },
  max_body_bytes: 500,
  max_calls: 1,
};

describe("body paging in the review", () => {
  test("paging through the body names its fields and its page ceiling", () => {
    const shown = presentRequestBoundary(
      { ...base, pagination: { params: ["cursor", "limit"], max_requests: 4, location: "body" } },
      plain,
    );
    expect(shown.paging).toEqual({
      key: "authority.boundary.bodyPaging.other",
      values: { params: "cursor, limit", count: 4 },
    });
    expect(shown.target).toBe("https://api.example.test/v2/search");
    const de = translate("de", shown.paging!.key, shown.paging!.values);
    expect(de).toContain("bis zu 4 Anfragen");
    expect(de).toContain("nur cursor, limit");
    const en = translate("en", shown.paging!.key, shown.paging!.values);
    expect(en).toContain("up to 4 requests");
    expect(en).toContain("only cursor, limit");
  });

  test("a single page reads as one request", () => {
    const shown = presentRequestBoundary(
      { ...base, pagination: { params: ["cursor"], max_requests: 1, location: "body" } },
      plain,
    );
    expect(shown.paging?.key).toBe("authority.boundary.bodyPaging.one");
  });

  test("paging through the query keeps its own sentence", () => {
    const shown = presentRequestBoundary(
      { ...base, method: "GET", pagination: { params: ["cursor"], max_requests: 4 } },
      plain,
    );
    expect(shown.paging?.key).toBe("authority.boundary.paging.other");
  });

  test("the plain note counts pages without naming a field", () => {
    for (const locale of ["de", "en"] as const) {
      const many = translatePlural(locale, "authority.boundary.bodyPagingNote", 12);
      expect(many).toContain("12");
      expect(many).not.toContain("{");
      const one = translatePlural(locale, "authority.boundary.bodyPagingNote", 1);
      expect(one).toContain("1");
      for (const key of [
        "authority.refusal.pagination_unsupported",
        "authority.refusal.pagination_body_unsupported",
      ] as const) {
        const text = translate(locale, key);
        expect(text.length).toBeGreaterThan(40);
        expect(text).not.toContain("!");
        expect(text).not.toContain("_");
      }
    }
  });
});
