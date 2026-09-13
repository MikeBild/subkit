// Pure unit tests for the self-description link mapping + the cache
// usefulness gate (two-tier TTL input). No DB, no network.

import { describe, expect, test } from "bun:test";

import { isUsefulDiscovery, selfDescriptionLinksFromResult } from "./service.ts";
import type { DiscoveryResult } from "./types.ts";

function result(overrides: Partial<DiscoveryResult>): DiscoveryResult {
  return {
    source_url: "https://api.example.com",
    fetched_at: "2026-01-01T00:00:00.000Z",
    strategy: "llms-txt",
    spec_version: null,
    title: null,
    servers: [],
    auth_schemes: [],
    endpoints: [],
    warnings: [],
    text_corpus: null,
    ...overrides,
  };
}

describe("selfDescriptionLinksFromResult", () => {
  test("llms-txt full-content URL → llms_full link", () => {
    const links = selfDescriptionLinksFromResult(
      result({ strategy: "llms-txt", source_url: "https://api.example.com/llms-full.txt" }),
    );
    expect(links).toEqual([
      {
        kind: "llms_full",
        url: "https://api.example.com/llms-full.txt",
        source: "discovery",
        discovered_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("llms-txt index URL → llms_txt link", () => {
    const links = selfDescriptionLinksFromResult(
      result({ strategy: "llms-txt", source_url: "https://api.example.com/llms.txt" }),
    );
    expect(links[0]?.kind).toBe("llms_txt");
  });

  test("openapi strategies → openapi link", () => {
    expect(
      selfDescriptionLinksFromResult(
        result({ strategy: "openapi-direct", source_url: "https://x/openapi.json" }),
      )[0]?.kind,
    ).toBe("openapi");
    expect(
      selfDescriptionLinksFromResult(
        result({ strategy: "swagger-ui-scrape", source_url: "https://x/swagger.json" }),
      )[0]?.kind,
    ).toBe("openapi");
  });

  test("graphql introspection → graphql link", () => {
    expect(
      selfDescriptionLinksFromResult(
        result({ strategy: "graphql-introspect", source_url: "https://x/graphql" }),
      )[0]?.kind,
    ).toBe("graphql");
  });

  test("non-self-describing strategies yield no link", () => {
    expect(selfDescriptionLinksFromResult(result({ strategy: "html-scrape" }))).toEqual([]);
    expect(
      selfDescriptionLinksFromResult(result({ strategy: "llms-txt", source_url: "" })),
    ).toEqual([]);
  });
});

describe("isUsefulDiscovery (two-tier TTL gate)", () => {
  test("endpoints make a result useful (24h TTL)", () => {
    expect(
      isUsefulDiscovery(
        result({ endpoints: [{ method: "GET", path: "/x" } as never], strategy: "openapi-direct" }),
      ),
    ).toBe(true);
  });

  test("a text corpus makes a result useful", () => {
    expect(isUsefulDiscovery(result({ text_corpus: "# docs" }))).toBe(true);
  });

  test("auth schemes alone do NOT make it useful (negative → short TTL)", () => {
    expect(
      isUsefulDiscovery(result({ auth_schemes: [{ type: "bearer" } as never], endpoints: [] })),
    ).toBe(false);
  });

  test("empty result is not useful", () => {
    expect(isUsefulDiscovery(result({}))).toBe(false);
  });
});
