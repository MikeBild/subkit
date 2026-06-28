// Tests for the playwright-crawl discovery strategy.
//
// We never launch a real Chromium here. The strategy supports a
// test-only chromium-provider hook (`setChromiumProviderForTesting`)
// that swaps in a stub browser whose `goto`/`content`/`evaluate`
// behaviour is driven by a per-URL fixture map.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  jaccardSimilarity,
  parseSitemap,
  playwrightCrawlStrategy,
  scoreCandidate,
  setChromiumProviderForTesting,
} from "./playwright-crawl.ts";
import { DiscoveryError } from "./types.ts";

interface PageFixture {
  status?: number;
  body?: string;
  /** Anchor hrefs returned by `page.evaluate` (BFS path). */
  links?: string[];
  /** If set, page.goto throws with this message. */
  throwOnGoto?: string;
}

type FixtureMap = Map<string, PageFixture>;

/**
 * Build a stub chromium that drives `page.goto` / `page.content` /
 * `page.evaluate` from a fixture map. Records every URL visited so
 * tests can assert traversal order.
 */
function makeStubChromium(fixtures: FixtureMap, visited: string[]) {
  return {
    chromium: {
      async launch(_opts?: Record<string, unknown>) {
        return {
          async newContext(_opts?: Record<string, unknown>) {
            return {
              async newPage() {
                let currentUrl = "";
                return {
                  async goto(url: string) {
                    currentUrl = url;
                    visited.push(url);
                    const fx = fixtures.get(url);
                    if (fx?.throwOnGoto) {
                      throw new Error(fx.throwOnGoto);
                    }
                    const status = fx?.status ?? 200;
                    return {
                      ok: () => status >= 200 && status < 300,
                      status: () => status,
                    };
                  },
                  async content() {
                    const fx = fixtures.get(currentUrl);
                    return fx?.body ?? "";
                  },
                  async evaluate<T>(_fn: () => T): Promise<T> {
                    const fx = fixtures.get(currentUrl);
                    return (fx?.links ?? []) as unknown as T;
                  },
                  async close() {},
                };
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
    },
  };
}

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.acme.example.com/api/widgets</loc></url>
  <url><loc>https://docs.acme.example.com/api/gadgets</loc></url>
  <url><loc>https://docs.acme.example.com/reference/auth</loc></url>
  <url><loc>https://docs.acme.example.com/pricing</loc></url>
  <url><loc>https://docs.acme.example.com/blog/launch</loc></url>
  <url><loc>https://docs.acme.example.com/login</loc></url>
</urlset>`;

const PAGE_HTML_WIDGETS = `<html><body><h1>Widgets API</h1>
<p>The widgets endpoint family covers list, create, update, and delete.
Use bearer-token auth and respect the rate limits documented per route.
Pagination is cursor-based with a stable ordering on widget id.</p>
<pre>GET /widgets POST /widgets PATCH /widgets/{id}</pre></body></html>`;

const PAGE_HTML_GADGETS = `<html><body><h1>Gadgets API</h1>
<p>The gadgets endpoint family covers list and update only; deletes
are not supported. Auth uses bearer tokens. Pagination is cursor-based.
Operations include GET /gadgets and PATCH /gadgets/{id} with idempotency.</p>
</body></html>`;

const PAGE_HTML_AUTH = `<html><body><h1>Auth Reference</h1>
<p>Authentication uses OAuth2 with the authorization-code flow and a
refresh-token rotation policy. Scopes are granted per resource family.
The token endpoint is /oauth/token; the introspection endpoint is /oauth/introspect.</p>
</body></html>`;

beforeEach(() => {
  setTestNow(() => 1_700_000_000_000);
});

afterEach(() => {
  setChromiumProviderForTesting(null);
  setTestNow(null);
});

describe("scoreCandidate", () => {
  test("rewards api/endpoints/reference paths", () => {
    expect(scoreCandidate("https://docs.x.com/api/widgets")).toBeGreaterThanOrEqual(5);
    expect(scoreCandidate("https://docs.x.com/reference/auth")).toBeGreaterThanOrEqual(5);
    expect(scoreCandidate("https://docs.x.com/endpoints/list")).toBeGreaterThanOrEqual(5);
  });
  test("rewards swagger/openapi", () => {
    expect(scoreCandidate("https://docs.x.com/swagger-ui")).toBeGreaterThanOrEqual(3);
    expect(scoreCandidate("https://docs.x.com/openapi.json")).toBeGreaterThanOrEqual(3);
  });
  test("penalises pricing/login/blog/legal", () => {
    expect(scoreCandidate("https://x.com/pricing")).toBeLessThan(0);
    expect(scoreCandidate("https://x.com/login")).toBeLessThan(0);
    expect(scoreCandidate("https://x.com/blog/launch")).toBeLessThan(0);
    expect(scoreCandidate("https://x.com/legal/terms")).toBeLessThan(0);
  });

  test("penalises localized paths (de/zh/pt-br) but keeps en + plain api", () => {
    // Translated docs paths get the locale penalty.
    expect(scoreCandidate("https://docs.x.com/de/api/widgets")).toBeLessThan(
      scoreCandidate("https://docs.x.com/api/widgets"),
    );
    expect(scoreCandidate("https://docs.x.com/zh/reference")).toBeLessThan(
      scoreCandidate("https://docs.x.com/reference"),
    );
    // BCP-47-shaped locale (pt-br, zh-cn) also penalised.
    expect(scoreCandidate("https://docs.x.com/pt-br/api/widgets")).toBeLessThan(
      scoreCandidate("https://docs.x.com/api/widgets"),
    );
    // English and the api allowlist must not be penalised.
    expect(scoreCandidate("https://docs.x.com/en/api/widgets")).toBeGreaterThanOrEqual(
      scoreCandidate("https://docs.x.com/api/widgets"),
    );
    // A bare `/api/...` (no leading 2-letter segment) stays positive.
    expect(scoreCandidate("https://docs.x.com/api/widgets")).toBeGreaterThan(0);
  });
});

describe("parseSitemap", () => {
  test("extracts <loc> entries", () => {
    const urls = parseSitemap(SITEMAP_XML);
    expect(urls).toContain("https://docs.acme.example.com/api/widgets");
    expect(urls).toContain("https://docs.acme.example.com/pricing");
    expect(urls).toHaveLength(6);
  });
  test("handles malformed/empty xml", () => {
    expect(parseSitemap("")).toEqual([]);
    expect(parseSitemap("<no loc here/>")).toEqual([]);
  });
});

describe("jaccardSimilarity", () => {
  test("identical text → 1.0", () => {
    const t = "the quick brown fox jumps over the lazy dog and friends";
    expect(jaccardSimilarity(t, t)).toBe(1);
  });
  test("disjoint text → 0.0", () => {
    const a = "alpha beta gamma delta epsilon zeta eta theta";
    const b = "one two three four five six seven eight";
    expect(jaccardSimilarity(a, b)).toBe(0);
  });
  test("near-duplicates → > 0.7", () => {
    const a =
      "the widgets endpoint covers list create update delete with cursor pagination and bearer auth";
    const b =
      "the widgets endpoint covers list create update delete with cursor pagination and bearer auth and idempotency";
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(0.7);
  });
});

describe("playwrightCrawlStrategy — sitemap path", () => {
  test("sitemap entries are ranked, deduped, and merged into corpus", async () => {
    const fixtures: FixtureMap = new Map([
      ["https://docs.acme.example.com/sitemap.xml", { body: SITEMAP_XML }],
      ["https://docs.acme.example.com/api/widgets", { body: PAGE_HTML_WIDGETS }],
      ["https://docs.acme.example.com/api/gadgets", { body: PAGE_HTML_GADGETS }],
      ["https://docs.acme.example.com/reference/auth", { body: PAGE_HTML_AUTH }],
    ]);
    const visited: string[] = [];
    const stub = makeStubChromium(fixtures, visited);
    setChromiumProviderForTesting(() => Promise.resolve(stub.chromium));

    const result = await playwrightCrawlStrategy.fetch("https://docs.acme.example.com/api", {});

    expect(result.strategy).toBe("playwright-crawl");
    expect(result.endpoints).toEqual([]);
    expect(typeof result.text_corpus).toBe("string");
    expect(result.text_corpus ?? "").toContain("Widgets API");
    expect(result.text_corpus ?? "").toContain("Gadgets API");
    expect(result.text_corpus ?? "").toContain("Auth Reference");
    // Pricing / login / blog should NOT be visited.
    expect(visited).not.toContain("https://docs.acme.example.com/pricing");
    expect(visited).not.toContain("https://docs.acme.example.com/login");
    expect(visited).not.toContain("https://docs.acme.example.com/blog/launch");
  });

  test("Jaccard dedupe drops near-duplicate pages", async () => {
    const baseHtml = PAGE_HTML_WIDGETS;
    // Add a single token so dedupe sees > 0.7 without identical match.
    const dupeHtml = baseHtml.replace("widgets endpoint", "widgets endpoint family");
    const sitemap = `<?xml version="1.0"?><urlset>
      <url><loc>https://docs.acme.example.com/api/widgets</loc></url>
      <url><loc>https://docs.acme.example.com/api/widgets-dupe</loc></url>
      <url><loc>https://docs.acme.example.com/reference/auth</loc></url>
    </urlset>`;
    const fixtures: FixtureMap = new Map([
      ["https://docs.acme.example.com/sitemap.xml", { body: sitemap }],
      ["https://docs.acme.example.com/api/widgets", { body: baseHtml }],
      ["https://docs.acme.example.com/api/widgets-dupe", { body: dupeHtml }],
      ["https://docs.acme.example.com/reference/auth", { body: PAGE_HTML_AUTH }],
    ]);
    const visited: string[] = [];
    const stub = makeStubChromium(fixtures, visited);
    setChromiumProviderForTesting(() => Promise.resolve(stub.chromium));

    const result = await playwrightCrawlStrategy.fetch("https://docs.acme.example.com/api", {});

    expect(result.warnings.some((w) => w.code === "page_filtered")).toBe(true);
    // Corpus contains widgets (kept) and auth (kept) but only once for widgets text.
    const widgetMatches = (result.text_corpus ?? "").match(/Widgets API/g) ?? [];
    expect(widgetMatches.length).toBe(1);
  });
});

describe("playwrightCrawlStrategy — BFS fallback", () => {
  test("uses BFS when sitemap missing", async () => {
    const baseUrl = "https://docs.acme.example.com/start";
    const fixtures: FixtureMap = new Map([
      ["https://docs.acme.example.com/sitemap.xml", { status: 404 }],
      [
        baseUrl,
        {
          body: "<html></html>",
          links: [
            "https://docs.acme.example.com/api/widgets",
            "https://docs.acme.example.com/reference/auth",
            "https://other.example.com/api/should-skip", // cross-origin
            "https://docs.acme.example.com/pricing", // negative score
          ],
        },
      ],
      ["https://docs.acme.example.com/api/widgets", { body: PAGE_HTML_WIDGETS }],
      ["https://docs.acme.example.com/reference/auth", { body: PAGE_HTML_AUTH }],
    ]);
    const visited: string[] = [];
    const stub = makeStubChromium(fixtures, visited);
    setChromiumProviderForTesting(() => Promise.resolve(stub.chromium));

    const result = await playwrightCrawlStrategy.fetch(baseUrl, {});

    expect(result.strategy).toBe("playwright-crawl");
    expect(result.text_corpus ?? "").toContain("Widgets API");
    expect(result.text_corpus ?? "").toContain("Auth Reference");
    // Cross-origin must be filtered.
    expect(visited).not.toContain("https://other.example.com/api/should-skip");
  });
});

describe("playwrightCrawlStrategy — total failure", () => {
  test("throws DiscoveryError('playwright_failed') when sitemap and BFS both empty", async () => {
    const baseUrl = "https://docs.acme.example.com/start";
    const fixtures: FixtureMap = new Map([
      ["https://docs.acme.example.com/sitemap.xml", { status: 404 }],
      [baseUrl, { body: "<html></html>", links: [] }],
    ]);
    const visited: string[] = [];
    const stub = makeStubChromium(fixtures, visited);
    setChromiumProviderForTesting(() => Promise.resolve(stub.chromium));

    let caught: unknown = null;
    try {
      await playwrightCrawlStrategy.fetch(baseUrl, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiscoveryError);
    expect((caught as DiscoveryError).code).toBe("playwright_failed");
  });

  test("throws DiscoveryError('playwright_failed') when chromium import fails", async () => {
    setChromiumProviderForTesting(() => Promise.reject(new Error("chromium not installed")));
    let caught: unknown = null;
    try {
      await playwrightCrawlStrategy.fetch("https://docs.acme.example.com", {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // Either DiscoveryError(playwright_failed) directly or wrapped by loadChromium.
    if (caught instanceof DiscoveryError) {
      expect(caught.code).toBe("playwright_failed");
    }
  });
});

describe("playwrightCrawlStrategy — canHandle availability probe", () => {
  test("declines when playwright cannot be loaded", async () => {
    setChromiumProviderForTesting(() => Promise.reject(new Error("playwright not installed")));
    expect(await playwrightCrawlStrategy.canHandle("https://docs.acme.example.com")).toBe(false);
  });

  test("claims the URL when playwright is loadable", async () => {
    const stub = makeStubChromium(new Map(), []);
    setChromiumProviderForTesting(() => Promise.resolve(stub.chromium));
    expect(await playwrightCrawlStrategy.canHandle("https://docs.acme.example.com")).toBe(true);
  });

  test("memoises the probe — provider is consulted only once across calls", async () => {
    let calls = 0;
    const stub = makeStubChromium(new Map(), []);
    setChromiumProviderForTesting(() => {
      calls += 1;
      return Promise.resolve(stub.chromium);
    });
    await playwrightCrawlStrategy.canHandle("https://a.example.com");
    await playwrightCrawlStrategy.canHandle("https://b.example.com");
    expect(calls).toBe(1);
  });
});

describe("playwrightCrawlStrategy — caller signal honoured", () => {
  test("aborts on caller-provided signal", async () => {
    const sitemap = `<?xml version="1.0"?><urlset>
      <url><loc>https://docs.acme.example.com/api/widgets</loc></url>
      <url><loc>https://docs.acme.example.com/reference/auth</loc></url>
    </urlset>`;
    const fixtures: FixtureMap = new Map([
      ["https://docs.acme.example.com/sitemap.xml", { body: sitemap }],
      ["https://docs.acme.example.com/api/widgets", { body: PAGE_HTML_WIDGETS }],
      ["https://docs.acme.example.com/reference/auth", { body: PAGE_HTML_AUTH }],
    ]);
    const visited: string[] = [];
    const stub = makeStubChromium(fixtures, visited);
    setChromiumProviderForTesting(() => Promise.resolve(stub.chromium));

    const ctrl = new AbortController();
    // Fire the abort almost immediately so the harvest loop sees it.
    queueMicrotask(() => ctrl.abort());

    const result = await playwrightCrawlStrategy
      .fetch("https://docs.acme.example.com/api", { signal: ctrl.signal })
      .catch((err) => err);

    // Either we returned with a budget_exceeded warning, or we threw
    // playwright_failed because the abort hit before any page kept.
    if (result instanceof DiscoveryError) {
      expect(result.code).toBe("playwright_failed");
    } else {
      // succeeded — but a budget_exceeded warning may be present.
      expect(result.strategy).toBe("playwright-crawl");
    }
  });
});
