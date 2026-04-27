import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { discoverConnectorEndpoints } from "./index.ts";
import {
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyName,
} from "./types.ts";

const MINIMAL_SPEC = {
  openapi: "3.0.0",
  info: { title: "Stripe-shaped API", version: "1.0" },
  paths: {
    "/customers": {
      get: {
        operationId: "listCustomers",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

function makeStrategy(
  name: DiscoveryStrategyName,
  impl: (url: string) => Promise<DiscoveryResult>,
): DiscoveryStrategy {
  return {
    name,
    canHandle: () => true,
    fetch: (url: string) => impl(url),
  };
}

describe("discoverConnectorEndpoints — fallback chain", () => {
  test("falls through to a later strategy and records earlier failures as warnings", async () => {
    const failing = makeStrategy("openapi-direct", () =>
      Promise.reject(new DiscoveryError("http_404", "404 not found")),
    );
    const succeeding = makeStrategy("swagger-ui-scrape", () =>
      Promise.resolve({
        source_url: "https://api.example.com/docs",
        fetched_at: "2024-01-01T00:00:00Z",
        strategy: "swagger-ui-scrape",
        spec_version: "openapi-3",
        title: "ok",
        servers: [],
        auth_schemes: [],
        endpoints: [
          {
            method: "GET",
            path: "/x",
            summary: null,
            description: null,
            operation_id: "x",
            scopes: [],
            params: [],
            request_body_schema: null,
            response_schemas: {},
            pagination_hint: null,
            deprecated: false,
          },
        ],
        warnings: [],
      }),
    );
    const skipped = makeStrategy("html-scrape", () => {
      throw new Error("should never be invoked");
    });

    const result = await discoverConnectorEndpoints({
      ingestion_url: "https://api.example.com/docs",
      strategies: [failing, succeeding, skipped],
    });

    expect(result.strategy).toBe("swagger-ui-scrape");
    expect(result.endpoints).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.code === "openapi-direct:http_404")).toBe(true);
  });

  test("throws all_strategies_failed when every strategy fails", async () => {
    const fail1 = makeStrategy("openapi-direct", () =>
      Promise.reject(new DiscoveryError("http_404", "first failed")),
    );
    const fail2 = makeStrategy("swagger-ui-scrape", () =>
      Promise.reject(new DiscoveryError("spec_not_found", "second failed")),
    );
    const fail3 = makeStrategy("html-scrape", () =>
      Promise.reject(new DiscoveryError("spec_not_found", "third failed")),
    );

    let caught: DiscoveryError | null = null;
    try {
      await discoverConnectorEndpoints({
        ingestion_url: "https://api.example.com/docs",
        strategies: [fail1, fail2, fail3],
      });
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("all_strategies_failed");
    expect(caught?.message).toContain("first failed");
    expect(caught?.message).toContain("second failed");
    expect(caught?.message).toContain("third failed");
  });

  test("template_id resolves the bundled stripe ingestion_url and discovers endpoints", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(MINIMAL_SPEC), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const result = await discoverConnectorEndpoints({ template_id: "stripe" });
      expect(result.endpoints.length).toBeGreaterThan(0);
      expect(result.endpoints[0]?.operation_id).toBe("listCustomers");
      expect(result.source_url).toMatch(/openapi/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("template_id throws template_not_found for unknown slug", async () => {
    let caught: DiscoveryError | null = null;
    try {
      await discoverConnectorEndpoints({ template_id: "this-template-does-not-exist" });
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("template_not_found");
  });

  test("requires at least one of template_id, ingestion_url, base_url", async () => {
    let caught: DiscoveryError | null = null;
    try {
      await discoverConnectorEndpoints({});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("no_url_provided");
  });
});

describe("discoverConnectorEndpoints — extended chain (graphql + llms-txt)", () => {
  test("falls through openapi-direct + swagger-ui-scrape and lands on llms-txt", async () => {
    const fail1 = makeStrategy("openapi-direct", () =>
      Promise.reject(new DiscoveryError("http_404", "openapi missing")),
    );
    const fail2 = makeStrategy("graphql-introspect", () =>
      Promise.reject(new DiscoveryError("http_404", "not graphql")),
    );
    const fail3 = makeStrategy("swagger-ui-scrape", () =>
      Promise.reject(new DiscoveryError("spec_not_found", "no swagger ui")),
    );
    const success = makeStrategy("llms-txt", () =>
      Promise.resolve({
        source_url: "https://docs.example.com/.well-known/llms-full.txt",
        fetched_at: "2024-01-01T00:00:00Z",
        strategy: "llms-txt",
        spec_version: null,
        title: null,
        servers: ["https://docs.example.com"],
        auth_schemes: [],
        endpoints: [],
        warnings: [],
        text_corpus: "# example\n\nFull markdown corpus describing the API.",
      }),
    );
    const skipped = makeStrategy("html-scrape", () => {
      throw new Error("should never be invoked");
    });

    const result = await discoverConnectorEndpoints({
      ingestion_url: "https://docs.example.com/api",
      strategies: [fail1, fail2, fail3, success, skipped],
    });

    expect(result.strategy).toBe("llms-txt");
    expect(result.text_corpus).toContain("Full markdown corpus");
    expect(result.warnings.some((w) => w.code === "openapi-direct:http_404")).toBe(true);
    expect(result.warnings.some((w) => w.code === "graphql-introspect:http_404")).toBe(true);
    expect(result.warnings.some((w) => w.code === "swagger-ui-scrape:spec_not_found")).toBe(true);
  });
});

describe("discoverConnectorEndpoints — integration with default strategies", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("first strategy 404s, swagger-ui-scrape wins and records the warning", async () => {
    const HTML_WITH_EMBEDDED = `<html><body>
      <script>SwaggerUIBundle({ url: "openapi.json" })</script>
    </body></html>`;

    let calls = 0;
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls += 1;
      // openapi-direct's first attempt at the input URL returns 404.
      if (calls === 1) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (url.endsWith("/api-docs")) {
        return Promise.resolve(
          new Response(HTML_WITH_EMBEDDED, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }
      if (url.endsWith("/openapi.json")) {
        return Promise.resolve(
          new Response(JSON.stringify(MINIMAL_SPEC), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const result = await discoverConnectorEndpoints({
      ingestion_url: "https://docs.example.com/api-docs",
    });

    expect(result.strategy).toBe("swagger-ui-scrape");
    expect(result.endpoints.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.code.startsWith("openapi-direct:"))).toBe(true);
  });
});
