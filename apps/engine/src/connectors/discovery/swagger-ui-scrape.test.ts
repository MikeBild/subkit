import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { extractEmbeddedSpecUrl, swaggerUiScrapeStrategy } from "./swagger-ui-scrape.ts";
import { DiscoveryError } from "./types.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchSpy: ReturnType<typeof mock<FetchLike>>;

beforeEach(() => {
  fetchSpy = mock<FetchLike>();
});

function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withSelfHostedDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

const MINIMAL_SPEC = {
  openapi: "3.0.0",
  info: { title: "Embedded API", version: "1.0" },
  paths: {
    "/health": {
      get: {
        operationId: "health",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

describe("extractEmbeddedSpecUrl", () => {
  test("finds an explicit url field with a relative .json", () => {
    const html = `<html><body><script>SwaggerUIBundle({ url: "openapi.json" })</script></body></html>`;
    const found = extractEmbeddedSpecUrl(html, "https://docs.example.com/api");
    expect(found).toBe("https://docs.example.com/openapi.json");
  });

  test("finds a YAML spec URL", () => {
    const html = `<script>{ url: "/specs/api.yaml" }</script>`;
    const found = extractEmbeddedSpecUrl(html, "https://docs.example.com/api/");
    expect(found).toBe("https://docs.example.com/specs/api.yaml");
  });

  test("returns null when nothing matches", () => {
    expect(extractEmbeddedSpecUrl("<html>no spec here</html>", "https://x")).toBeNull();
  });
});

describe("swaggerUiScrapeStrategy", () => {
  seamTest("delegates to openapi-direct when spec URL is embedded", async () => {
    const HTML = `
      <!DOCTYPE html>
      <html><body>
        <div id="swagger-ui"></div>
        <script>
          window.onload = () => SwaggerUIBundle({ url: "openapi.json" });
        </script>
      </body></html>
    `;
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api-docs")) {
        return Promise.resolve(
          new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
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

    const result = await swaggerUiScrapeStrategy.fetch("https://docs.example.com/api-docs", {});
    expect(result.strategy).toBe("swagger-ui-scrape");
    expect(result.title).toBe("Embedded API");
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.operation_id).toBe("health");
  });

  seamTest("throws spec_not_found when HTML has no embedded url", async () => {
    fetchSpy.mockResolvedValue(
      new Response("<html><body>nothing here</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    let caught: DiscoveryError | null = null;
    try {
      await swaggerUiScrapeStrategy.fetch("https://docs.example.com/api-docs", {});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("spec_not_found");
  });

  seamTest("propagates http errors with code http_<status>", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));
    let caught: DiscoveryError | null = null;
    try {
      await swaggerUiScrapeStrategy.fetch("https://docs.example.com/api-docs", {});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("http_500");
  });
});
