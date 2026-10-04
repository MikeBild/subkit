import { describe, expect, test } from "bun:test";
import { scoreEndpoints } from "./endpoint-scorer.ts";
import type { DiscoveredEndpoint } from "./types.ts";

function makeEndpoint(over: Partial<DiscoveredEndpoint> & { path: string }): DiscoveredEndpoint {
  return {
    method: "GET",
    path: over.path,
    summary: over.summary ?? null,
    description: over.description ?? null,
    operation_id: over.operation_id ?? null,
    scopes: over.scopes ?? [],
    params: over.params ?? [],
    request_body_schema: null,
    request_content_type: null,
    response_schemas: {},
    pagination_hint: null,
    deprecated: false,
  };
}

describe("scoreEndpoints — relevance ranking", () => {
  test("'list droplets' against 50-endpoint index ranks /v2/droplets first", () => {
    const filler: DiscoveredEndpoint[] = Array.from({ length: 49 }, (_, i) =>
      makeEndpoint({
        path: `/v2/resource_${i}`,
        summary: `Resource ${i} operation`,
        operation_id: `resource_${i}_op`,
      }),
    );
    const target = makeEndpoint({
      path: "/v2/droplets",
      summary: "List all droplets",
      description: "Returns a list of droplets owned by the account.",
      operation_id: "droplets_list",
    });
    const all = [...filler.slice(0, 25), target, ...filler.slice(25)];

    const ranked = scoreEndpoints("list droplets", all, 3);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.endpoint.path).toBe("/v2/droplets");
    expect(ranked[0]?.score).toBeGreaterThan(0);
    const reasons = ranked[0]?.reasons ?? [];
    expect(reasons.some((r) => r.includes("droplets") && r.includes("path"))).toBe(true);
    expect(ranked.length).toBeLessThanOrEqual(3);
  });

  test("matches operation_id and parameter names", () => {
    const endpoints = [
      makeEndpoint({
        path: "/v2/widgets",
        summary: "Widget collection",
        operation_id: "widgets_list",
      }),
      makeEndpoint({
        path: "/v2/sprockets",
        summary: "Sprocket collection",
        operation_id: "sprockets_list",
        params: [{ name: "tenant_id", in: "query", required: false, type: "string" }],
      }),
    ];
    const ranked = scoreEndpoints("sprockets by tenant_id", endpoints, 3);
    expect(ranked[0]?.endpoint.path).toBe("/v2/sprockets");
    const reasons = ranked[0]?.reasons.join(" ") ?? "";
    expect(reasons).toContain("sprockets");
  });
});

describe("scoreEndpoints — empty / stop-words", () => {
  test("empty query returns []", () => {
    const endpoints = [makeEndpoint({ path: "/v2/droplets", summary: "List droplets" })];
    expect(scoreEndpoints("", endpoints, 3)).toEqual([]);
    expect(scoreEndpoints("   ", endpoints, 3)).toEqual([]);
  });

  test("all-stop-words query returns []", () => {
    const endpoints = [makeEndpoint({ path: "/v2/droplets", summary: "List droplets" })];
    expect(scoreEndpoints("get me all the", endpoints, 3)).toEqual([]);
    expect(scoreEndpoints("a from to of", endpoints, 3)).toEqual([]);
  });

  test("empty endpoint list returns []", () => {
    expect(scoreEndpoints("anything", [], 3)).toEqual([]);
  });
});

describe("scoreEndpoints — stable ordering", () => {
  test("tied scores preserve input order", () => {
    const a = makeEndpoint({ path: "/v2/alpha", summary: "shared term" });
    const b = makeEndpoint({ path: "/v2/beta", summary: "shared term" });
    const c = makeEndpoint({ path: "/v2/gamma", summary: "different" });
    const input = [a, b, c];
    const ranked = scoreEndpoints("shared", input, 3);
    expect(ranked[0]?.endpoint.path).toBe("/v2/alpha");
    expect(ranked[1]?.endpoint.path).toBe("/v2/beta");
    const reversed = scoreEndpoints("shared", [b, a, c], 3);
    expect(reversed[0]?.endpoint.path).toBe("/v2/beta");
    expect(reversed[1]?.endpoint.path).toBe("/v2/alpha");
  });

  test("topK clamps the result length", () => {
    const endpoints = Array.from({ length: 10 }, (_, i) =>
      makeEndpoint({ path: `/v2/x_${i}`, summary: "shared term" }),
    );
    const ranked = scoreEndpoints("shared", endpoints, 3);
    expect(ranked.length).toBe(3);
  });
});
