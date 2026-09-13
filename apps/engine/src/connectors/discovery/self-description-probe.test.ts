// Unit tests for probeAllSelfDescriptionLinks.
//
// Uses the driver-fetch seam (`withDriverFetchForTests`) so no real outbound
// HTTP is made — mirrors the pattern in llms-txt.test.ts.

import { describe, expect, mock, test } from "bun:test";

import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { probeAllSelfDescriptionLinks } from "./self-description-probe.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Minimal OpenAPI spec JSON body — enough for the plausibility check.
const OPENAPI_BODY = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test API", version: "1" },
  paths: {},
});

// Minimal llms-full.txt body (must exceed MIN_PLAUSIBLE_BYTES = 40).
const LLMS_FULL_BODY = `# Test API llms-full\n\nThis connector publishes its docs via llms-full.txt. Authenticate with a Bearer token.\n`;

// A valid GraphQL `{ __typename }` response.
const GRAPHQL_TYPENAME_RESPONSE = JSON.stringify({ data: { __typename: "Query" } });

// Helper: build a mock fetch that returns different responses per URL pattern.
function buildMockFetch(
  routes: Array<{ match: (url: string) => boolean; status: number; body: string }>,
  defaultStatus = 404,
): typeof fetch {
  const fn = mock<FetchLike>((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const route of routes) {
      if (route.match(url)) {
        return Promise.resolve(new Response(route.body, { status: route.status }));
      }
    }
    return Promise.resolve(new Response(null, { status: defaultStatus }));
  });
  return fn as unknown as typeof fetch;
}

// Wrap each test body in the driver-fetch seam.
function seamTest(name: string, body: () => Promise<void>): void {
  test(name, async () => {
    await body();
  });
}

describe("probeAllSelfDescriptionLinks", () => {
  seamTest("both /openapi.json and /llms-full.txt present → ≥2 link kinds", async () => {
    const mockFetch = buildMockFetch([
      {
        match: (u) => u.endsWith("/openapi.json"),
        status: 200,
        body: OPENAPI_BODY,
      },
      {
        match: (u) => u.endsWith("/llms-full.txt"),
        status: 200,
        body: LLMS_FULL_BODY,
      },
    ]);

    const links = await withDriverFetchForTests(mockFetch, () =>
      probeAllSelfDescriptionLinks("https://api.example.com", {}),
    );

    const kinds = links.map((l) => l.kind).sort();
    expect(kinds).toContain("openapi");
    expect(kinds).toContain("llms_full");
    expect(links.length).toBeGreaterThanOrEqual(2);

    for (const link of links) {
      expect(link.source).toBe("self_healing");
      expect(typeof link.discovered_at).toBe("string");
      expect(typeof link.url).toBe("string");
    }
  });

  seamTest("graphql endpoint at /graphql → graphql link", async () => {
    const mockFetch = buildMockFetch([
      {
        match: (u) => u.endsWith("/graphql"),
        status: 200,
        body: GRAPHQL_TYPENAME_RESPONSE,
      },
    ]);

    const links = await withDriverFetchForTests(mockFetch, () =>
      probeAllSelfDescriptionLinks("https://api.example.com", {}),
    );

    const kinds = links.map((l) => l.kind);
    expect(kinds).toContain("graphql");
    const graphqlLink = links.find((l) => l.kind === "graphql");
    expect(graphqlLink?.url).toContain("/graphql");
    expect(graphqlLink?.source).toBe("self_healing");
  });

  seamTest("base URL that is a graphql endpoint is probed first", async () => {
    const mockFetch = buildMockFetch([
      {
        // The base URL IS the graphql endpoint (path ends with /graphql).
        match: (u) => u === "https://api.example.com/graphql",
        status: 200,
        body: GRAPHQL_TYPENAME_RESPONSE,
      },
    ]);

    const links = await withDriverFetchForTests(mockFetch, () =>
      probeAllSelfDescriptionLinks("https://api.example.com/graphql", {}),
    );

    const kinds = links.map((l) => l.kind);
    expect(kinds).toContain("graphql");
  });

  seamTest("all surfaces 404 → returns []", async () => {
    const mockFetch = mock<FetchLike>(() => Promise.resolve(new Response(null, { status: 404 })));

    const links = await withDriverFetchForTests(mockFetch as unknown as typeof fetch, () =>
      probeAllSelfDescriptionLinks("https://api.example.com", {}),
    );

    expect(links).toEqual([]);
  });

  seamTest("egress-blocked origin → returns [] non-fatally", async () => {
    // `localhost` is blocked by assertEgressAllowed in both strict and
    // permissive modes (the permissive-mode short-list includes it). The
    // probe must catch the EgressBlockedError and return [] without throwing.
    const mockFetch = mock<FetchLike>(() => Promise.resolve(new Response(null, { status: 200 })));

    let caught: Error | null = null;
    let links: Awaited<ReturnType<typeof probeAllSelfDescriptionLinks>> = [];
    try {
      links = await withDriverFetchForTests(mockFetch as unknown as typeof fetch, () =>
        probeAllSelfDescriptionLinks("http://localhost:8080", {}),
      );
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }

    expect(caught).toBeNull();
    expect(links).toEqual([]);
  });

  seamTest("invalid base URL → returns []", async () => {
    const mockFetch = mock<FetchLike>(() => Promise.resolve(new Response(null, { status: 200 })));

    const links = await withDriverFetchForTests(mockFetch as unknown as typeof fetch, () =>
      probeAllSelfDescriptionLinks("not-a-url", {}),
    );

    expect(links).toEqual([]);
  });

  seamTest("llms.txt (index variant) found → llms_txt link kind", async () => {
    const llmsIndexBody =
      "# API docs index\n\nAuthenticate via Bearer.\n\nSee https://api.example.com/widgets for widgets.\n";
    const mockFetch = buildMockFetch([
      {
        match: (u) => u.endsWith("/llms.txt") && !u.endsWith("llms-full.txt"),
        status: 200,
        body: llmsIndexBody,
      },
    ]);

    const links = await withDriverFetchForTests(mockFetch, () =>
      probeAllSelfDescriptionLinks("https://api.example.com", {}),
    );

    const llmsLink = links.find((l) => l.kind === "llms_txt" || l.kind === "llms_full");
    // The full variant was 404, so the index variant wins.
    expect(llmsLink?.kind).toBe("llms_txt");
    expect(llmsLink?.source).toBe("self_healing");
  });

  seamTest("openapi body without spec keywords is not recorded", async () => {
    // A 200 response with an HTML body should NOT be treated as an OpenAPI spec.
    const mockFetch = buildMockFetch([
      {
        match: (u) => u.endsWith("/openapi.json"),
        status: 200,
        body: "<html><body>Not an API spec</body></html>",
      },
    ]);

    const links = await withDriverFetchForTests(mockFetch, () =>
      probeAllSelfDescriptionLinks("https://api.example.com", {}),
    );

    expect(links.find((l) => l.kind === "openapi")).toBeUndefined();
  });

  seamTest("graphql: non-JSON response is not recorded", async () => {
    const mockFetch = buildMockFetch([
      {
        match: (u) => u.endsWith("/graphql"),
        status: 200,
        body: "not json",
      },
    ]);

    const links = await withDriverFetchForTests(mockFetch, () =>
      probeAllSelfDescriptionLinks("https://api.example.com", {}),
    );

    expect(links.find((l) => l.kind === "graphql")).toBeUndefined();
  });
});
