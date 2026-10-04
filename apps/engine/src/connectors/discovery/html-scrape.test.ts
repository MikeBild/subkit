import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { extractSpecHrefs, htmlScrapeStrategy } from "./html-scrape.ts";
import { DiscoveryError } from "./types.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchSpy: ReturnType<typeof mock<FetchLike>>;

beforeEach(() => {
  fetchSpy = mock<FetchLike>();
});

function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

const MINIMAL_SPEC = {
  openapi: "3.0.0",
  info: { title: "Well-Known API", version: "1.0" },
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

describe("extractSpecHrefs", () => {
  test("collects openapi/swagger anchors", () => {
    const html = `
      <a href="/api/openapi.yaml">OpenAPI YAML</a>
      <a href="https://elsewhere.example.com/openapi.json">JSON</a>
      <a href="/swagger.json">Swagger</a>
    `;
    const hrefs = extractSpecHrefs(html, "https://docs.example.com/start");
    expect(hrefs).toContain("https://docs.example.com/api/openapi.yaml");
    expect(hrefs).toContain("https://elsewhere.example.com/openapi.json");
    expect(hrefs).toContain("https://docs.example.com/swagger.json");
  });

  test("returns [] when no candidates exist", () => {
    expect(extractSpecHrefs("<html>nothing</html>", "https://x")).toEqual([]);
  });
});

describe("htmlScrapeStrategy", () => {
  seamTest("falls through to a well-known /openapi.json when HTML has no spec link", async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.example.com/docs") {
        return Promise.resolve(
          new Response("<html><body>Welcome</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }
      if (url === "https://api.example.com/openapi.json") {
        return Promise.resolve(
          new Response(JSON.stringify(MINIMAL_SPEC), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const result = await htmlScrapeStrategy.fetch("https://api.example.com/docs", {});
    expect(result.strategy).toBe("html-scrape");
    expect(result.title).toBe("Well-Known API");
    expect(result.endpoints).toHaveLength(1);
  });

  seamTest("uses anchor-discovered href before well-known paths", async () => {
    const HTML = `<html><body><a href="/spec/openapi.yaml">spec</a></body></html>`;
    const yaml = `openapi: 3.0.0
info:
  title: anchor-spec
  version: '1.0'
paths:
  /a:
    get:
      operationId: a
      responses:
        '200':
          description: ok
`;
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.example.com/docs") {
        return Promise.resolve(
          new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
        );
      }
      if (url === "https://api.example.com/spec/openapi.yaml") {
        return Promise.resolve(
          new Response(yaml, { status: 200, headers: { "content-type": "text/yaml" } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const result = await htmlScrapeStrategy.fetch("https://api.example.com/docs", {});
    expect(result.title).toBe("anchor-spec");
  });

  seamTest(
    "throws spec_not_found when neither HTML nor well-known paths yield a spec",
    async () => {
      fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
      let caught: DiscoveryError | null = null;
      try {
        await htmlScrapeStrategy.fetch("https://api.example.com/docs", {});
      } catch (e) {
        if (e instanceof DiscoveryError) caught = e;
      }
      expect(caught?.code).toBe("spec_not_found");
    },
  );
});
