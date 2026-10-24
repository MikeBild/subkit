import { describe, expect, it } from "bun:test";
import { normalizeToolResultPayload } from "../result-payload.ts";
import { searchDocsTool } from "../search-docs.ts";

const MISSING_SCOPE =
  "connector_id is required — pass it explicitly or bind the conversation to a connector first";

interface ProductHit {
  id: string;
  source: string;
  slug: string;
  locale: string;
  title: string;
  heading: string;
  anchor: string | null;
  sha256: string;
  snippet: string;
}

async function productHits(args: Record<string, unknown>): Promise<ProductHit[]> {
  const result = await searchDocsTool.execute({ connector_id: null } as never, args);
  expect(result.ok).toBe(true);
  return (result.data as { hits: ProductHit[] }).hits;
}

describe("search_docs product documentation", () => {
  it("answers the German Web Clipper install question from the install chapter", async () => {
    const [top] = await productHits({ query: "Wie installiere ich den Web Clipper?" });
    expect(top).toMatchObject({
      source: "product_docs",
      slug: "web-clipper",
      locale: "de",
      anchor: "die-erweiterung-installieren",
    });
    expect(top?.snippet).toContain("sk clipper install");
    expect(top?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers the English Web Clipper install question from the install chapter", async () => {
    const [top] = await productHits({ query: "How do I install the Web Clipper?" });
    expect(top).toMatchObject({
      id: "product-docs:en:web-clipper#install-the-extension",
      slug: "web-clipper",
      title: "Collect web pages with the Web Clipper",
      heading: "Install the extension",
    });
    expect(top?.snippet).toContain("sk clipper install");
  });

  it("narrows product hits to one locale", async () => {
    const hits = await productHits({ query: "Web Clipper", locale: "en" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.locale === "en")).toBe(true);
  });
});

describe("search_docs failure envelope", () => {
  it("a connector search without connector scope names the code, the message and the recovery tools", async () => {
    const result = await searchDocsTool.execute({ connector_id: null } as never, {
      query: "create customer",
      source: "connector",
    });

    expect(result.ok).toBe(false);
    expect(normalizeToolResultPayload(result)).toEqual({
      error: MISSING_SCOPE,
      error_code: "connector_scope_required",
      message: MISSING_SCOPE,
      next_best_actions: ["find_connector", "list_connectors"],
    });
  });
});
