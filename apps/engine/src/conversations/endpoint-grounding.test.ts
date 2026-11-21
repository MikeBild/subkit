import { describe, expect, test } from "bun:test";
import {
  type DiscoveredConnectorEndpoints,
  evaluateEndpointGrounding,
  normalizeRequestPath,
  pathMatchesTemplate,
} from "./endpoint-grounding.ts";

const SITEKIT: DiscoveredConnectorEndpoints = {
  slug: "sitekit-admin",
  base_url: "https://sitekit-api.example.com",
  endpoints: [
    { method: "POST", path: "/v1/sites", request_content_type: "application/json" },
    {
      method: "POST",
      path: "/v1/sites/{site}/content",
      request_content_type: "text/markdown",
    },
    { method: "POST", path: "/v1/sites/{site}/releases", request_content_type: "application/json" },
    { method: "POST", path: "/v1/api-keys", request_content_type: "application/json" },
    { method: "GET", path: "/v1/sites/{site}", request_content_type: null },
  ],
};

function indexFor(c: DiscoveredConnectorEndpoints): Map<string, DiscoveredConnectorEndpoints> {
  return new Map([
    ["conn-id", c],
    [c.slug, c],
  ]);
}

describe("normalizeRequestPath", () => {
  test("keeps a relative path, drops query + trailing slash", () => {
    expect(normalizeRequestPath("/v1/sites?foo=1", null)).toBe("/v1/sites");
    expect(normalizeRequestPath("/v1/sites/", null)).toBe("/v1/sites");
    expect(normalizeRequestPath("v1/sites", null)).toBe("/v1/sites");
  });

  test("strips an absolute base_url prefix", () => {
    expect(normalizeRequestPath("https://sitekit-api.example.com/v1/sites", SITEKIT.base_url)).toBe(
      "/v1/sites",
    );
  });

  test("strips a ${connector.<slug>.base_url} placeholder prefix", () => {
    expect(normalizeRequestPath("${connector.sitekit-admin.base_url}/v1/sites", null)).toBe(
      "/v1/sites",
    );
  });

  test("keeps interior ${...} placeholders verbatim", () => {
    expect(normalizeRequestPath("/v1/sites/${input.site}/content", null)).toBe(
      "/v1/sites/${input.site}/content",
    );
  });
});

describe("pathMatchesTemplate", () => {
  test("literal match", () => {
    expect(pathMatchesTemplate("/v1/sites", "/v1/sites")).toBe(true);
  });
  test("{param} matches any value segment", () => {
    expect(pathMatchesTemplate("/v1/sites/abc/content", "/v1/sites/{site}/content")).toBe(true);
  });
  test("${placeholder} segment matches a {param} template", () => {
    expect(pathMatchesTemplate("/v1/sites/${input.site}/content", "/v1/sites/{site}/content")).toBe(
      true,
    );
  });
  test("segment-count mismatch fails", () => {
    expect(pathMatchesTemplate("/v1/sites", "/v1/sites/{site}/content")).toBe(false);
  });
  test("literal mismatch fails (the invented-route case)", () => {
    expect(pathMatchesTemplate("/sites", "/v1/sites")).toBe(false);
    expect(pathMatchesTemplate("/v1/sites/abc/items", "/v1/sites/{site}/content")).toBe(false);
  });
});

describe("evaluateEndpointGrounding", () => {
  test("flags an invented path missing the /v1 prefix and suggests the real route", () => {
    const steps = [
      {
        id: "create_site",
        kind: "request",
        connector_id: "conn-id",
        method: "POST",
        path: "/sites",
      },
    ];
    const result = evaluateEndpointGrounding(steps, indexFor(SITEKIT));
    expect(result.ok).toBe(false);
    expect(result.blocks).toHaveLength(1);
    const b = result.blocks[0];
    expect(b?.reason).toBe("path_not_in_discovered_spec");
    expect(b?.step_id).toBe("create_site");
    expect(b?.nearest).toContain("POST /v1/sites");
  });

  test("flags a REST-ified collection name (/items for /content)", () => {
    const steps = [
      {
        id: "post_item",
        kind: "request",
        connector_id: "conn-id",
        method: "POST",
        path: "/sites/${input.site}/items",
      },
    ];
    const result = evaluateEndpointGrounding(steps, indexFor(SITEKIT));
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("path_not_in_discovered_spec");
  });

  test("accepts the documented route with a templated segment", () => {
    const steps = [
      {
        id: "create_site",
        kind: "request",
        connector_id: "conn-id",
        method: "POST",
        path: "/v1/sites",
      },
      {
        id: "put_content",
        kind: "request",
        connector_id: "conn-id",
        method: "POST",
        path: "/v1/sites/${scope.create_site.data.id}/content",
        body: "# hello",
      },
    ];
    const result = evaluateEndpointGrounding(steps, indexFor(SITEKIT));
    expect(result.ok).toBe(true);
  });

  test("flags a JSON object body where the spec declares text/markdown", () => {
    const steps = [
      {
        id: "put_content",
        kind: "request",
        connector_id: "conn-id",
        method: "POST",
        path: "/v1/sites/abc/content",
        body: { markdown: "# hello" },
      },
    ];
    const result = evaluateEndpointGrounding(steps, indexFor(SITEKIT));
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("content_type_mismatch");
    expect(result.blocks[0]?.nearest).toEqual(["text/markdown"]);
  });

  test("does not flag a markdown body when an explicit Content-Type header is set", () => {
    const steps = [
      {
        id: "put_content",
        kind: "request",
        connector_id: "conn-id",
        method: "POST",
        path: "/v1/sites/abc/content",
        headers: { "Content-Type": "text/markdown" },
        body: { raw: "# hello" },
      },
    ];
    const result = evaluateEndpointGrounding(steps, indexFor(SITEKIT));
    expect(result.ok).toBe(true);
  });

  test("fail-open: a connector with no discovered index is never flagged", () => {
    const steps = [
      { id: "x", kind: "request", connector_id: "unknown-conn", method: "POST", path: "/whatever" },
    ];
    const result = evaluateEndpointGrounding(steps, indexFor(SITEKIT));
    expect(result.ok).toBe(true);
  });

  test("resolves a connector bound via ${connector.<slug>.base_url} in the url", () => {
    const steps = [
      {
        id: "create_site",
        kind: "request",
        method: "POST",
        url: "${connector.sitekit-admin.base_url}/sites",
      },
    ];
    const result = evaluateEndpointGrounding(steps, indexFor(SITEKIT));
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.connector_slug).toBe("sitekit-admin");
  });

  test("ignores non-request steps", () => {
    const steps = [
      { id: "t", kind: "transform", expression: "input.scope.x.data" },
      {
        id: "create_site",
        kind: "request",
        connector_id: "conn-id",
        method: "POST",
        path: "/v1/sites",
      },
    ];
    const result = evaluateEndpointGrounding(steps, indexFor(SITEKIT));
    expect(result.ok).toBe(true);
  });
});
