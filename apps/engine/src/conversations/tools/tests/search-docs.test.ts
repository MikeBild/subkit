import { describe, expect, it } from "bun:test";
import type { Executor } from "../../../db/client.ts";
import { harvestCitations } from "../../citations.ts";
import { keepResolvableCitations } from "../../source-faithful.ts";
import type { TurnEvent } from "../../types.ts";
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
    expect(top?.snippet).toContain("subkit clipper install");
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
    expect(top?.snippet).toContain("subkit clipper install");
  });

  it("narrows product hits to one locale", async () => {
    const hits = await productHits({ query: "Web Clipper", locale: "en" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.locale === "en")).toBe(true);
  });
});

describe("search_docs product documentation citations", () => {
  const unusedDb = new Proxy({} as Executor, {
    get() {
      throw new Error("product documentation citations must not query the database");
    },
  });

  async function citationsFor(query: string) {
    const result = await searchDocsTool.execute({ connector_id: null } as never, { query });
    const event = {
      type: "tool_result",
      call_id: "c",
      tool: "search_docs",
      output: result.data,
    } as TurnEvent;
    return harvestCitations([event]);
  }

  it("keeps every product documentation hit as a resolvable product_doc citation", async () => {
    const citations = await citationsFor("Wie installiere ich den Web Clipper?");
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0]).toMatchObject({
      source_type: "product_doc",
      id: "product-docs:de:web-clipper#die-erweiterung-installieren",
    });
    expect(citations[0]?.source_name).toContain("›");
    const kept = await keepResolvableCitations(citations, "tenant", unusedDb);
    expect(kept).toEqual(citations);
  });

  it("drops a product_doc citation whose section is not in the shipped documentation", async () => {
    const [real] = await citationsFor("Wie installiere ich den Web Clipper?");
    if (!real) throw new Error("expected a product documentation citation");
    const fabricated = { ...real, id: "product-docs:de:web-clipper#erfunden" };
    const kept = await keepResolvableCitations([real, fabricated], "tenant", unusedDb);
    expect(kept).toEqual([real]);
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
