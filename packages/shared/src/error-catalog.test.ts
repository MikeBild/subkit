import { describe, expect, test } from "bun:test";
import { ERROR_CASES, ERROR_CATALOG, ERROR_CAUSE_LABELS, errorCatalog } from "./error-catalog.ts";
import { CLIENT_ERROR_CAUSES } from "./error-taxonomy.ts";

describe("the client error catalog", () => {
  test("maps the skill version conflict to an approval mismatch", () => {
    expect(ERROR_CATALOG.skillConflict.cause).toBe("authority_mismatch");
    expect(ERROR_CATALOG.keyRejected).toMatchObject({ cause: "auth_failed", http: 401 });
  });

  test("every case reads in both languages, and differently", () => {
    for (const kind of ERROR_CASES) {
      const { de, en } = ERROR_CATALOG[kind].text;
      expect(de.title.length, kind).toBeGreaterThan(3);
      expect(en.body.length, kind).toBeGreaterThan(10);
      expect(de.body, kind).not.toBe(en.body);
    }
  });

  test("every cause of the taxonomy has a label in both languages", () => {
    for (const lang of ["de", "en"] as const)
      expect(Object.keys(ERROR_CAUSE_LABELS[lang]).sort()).toEqual([...CLIENT_ERROR_CAUSES].sort());
  });

  test("a view hands the design system copy and meta for one language, built once", () => {
    const view = errorCatalog("en");
    expect(view.cases.offline?.meta).toEqual({
      cause: "timeout",
      code: "server_offline",
      http: 503,
    });
    expect(view.cases.offline?.copy.title).toBe(ERROR_CATALOG.offline.text.en.title);
    expect(errorCatalog("en")).toBe(view);
  });
});
