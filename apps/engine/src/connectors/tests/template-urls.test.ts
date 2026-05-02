import { describe, expect, test } from "bun:test";
import { loadBuiltinTemplates } from "../templates.ts";

// URL reachability tests are opt-in: set CHECK_URLS=1 to run them.
// They hit external APIs and may fail due to rate limits or network issues.
const RUN_URL_CHECKS = !!process.env.CHECK_URLS;

describe.skipIf(!RUN_URL_CHECKS)("connector template ingestion URLs", () => {
  const templates = loadBuiltinTemplates();
  const withUrls = templates.filter((t) => t.ingestion_url !== null);

  test("at least 25 templates have ingestion URLs", () => {
    expect(withUrls.length).toBeGreaterThanOrEqual(25);
  });

  for (const tmpl of withUrls) {
    test(`${tmpl.slug}: ${tmpl.ingestion_source} URL is reachable`, async () => {
      const url = tmpl.ingestion_url!;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000); // allow-wall-clock: legacy; review before changing
      try {
        const res = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "follow",
        });
        // Several real servers (Google Discovery on `*.googleapis.com`,
        // some GitHub raw paths) respond 4xx to HEAD even when GET
        // returns 200. Retry on any 4xx (not just 403/405) so the
        // probe surfaces genuine link rot, not protocol quirks.
        if (res.status >= 400 && res.status < 500) {
          const getRes = await fetch(url, {
            method: "GET",
            signal: controller.signal,
            redirect: "follow",
            headers: { Range: "bytes=0-1024" },
          });
          expect(getRes.status).toBeLessThan(400);
        } else {
          expect(res.status).toBeLessThan(400);
        }
      } finally {
        clearTimeout(timeout);
      }
    });
  }
});

describe("connector template schema validation", () => {
  test("all slugs are unique", () => {
    const templates = loadBuiltinTemplates();
    const slugs = templates.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("no template has both oauth and auth_type=none", () => {
    const templates = loadBuiltinTemplates();
    for (const t of templates) {
      if (t.auth_type === "none") {
        expect(t.oauth).toBeNull();
      }
    }
  });

  test("every template with oauth has auth_type oauth2 or bearer", () => {
    const templates = loadBuiltinTemplates();
    for (const t of templates) {
      if (t.oauth !== null) {
        expect(["oauth2", "bearer"]).toContain(t.auth_type);
      }
    }
  });

  test("every template with ingestion_url has non-unsupported ingestion_source", () => {
    const templates = loadBuiltinTemplates();
    for (const t of templates) {
      if (t.ingestion_url !== null) {
        expect(t.ingestion_source).not.toBe("unsupported");
      }
    }
  });

  test("category distribution covers all major categories", () => {
    const templates = loadBuiltinTemplates();
    const categories = new Set(templates.map((t) => t.category));
    expect(categories.size).toBeGreaterThanOrEqual(10);
    expect(categories.has("payments")).toBe(true);
    expect(categories.has("devops")).toBe(true);
    expect(categories.has("enterprise")).toBe(true);
    expect(categories.has("cloud")).toBe(true);
    expect(categories.has("database")).toBe(true);
  });
});
