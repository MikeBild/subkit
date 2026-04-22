// Cascade orchestrator — pure unit tests driven by a mocked fetch.
// No DB, no network. Verifies probe order, short-circuit on first hit,
// and the HTML-link-extractor sub-cascade.

import { describe, expect, test } from "bun:test";
import { cascadeIngest, discoverOpenApiLinks } from "../cascade.ts";

function makeFetchMock(
  responses: Array<{
    match: RegExp;
    status: number;
    body: string;
    content_type?: string;
  }>,
): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push(url);
    for (const r of responses) {
      if (r.match.test(url)) {
        return new Response(r.body, {
          status: r.status,
          headers: { "content-type": r.content_type ?? "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("cascadeIngest", () => {
  test("short-circuits on the first successful OpenAPI probe", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Demo API", version: "1.0.0" },
      paths: {
        "/items": {
          get: { summary: "List items" },
        },
      },
    });
    const { fn, calls } = makeFetchMock([{ match: /\/openapi\.json$/, status: 200, body: spec }]);
    const res = await cascadeIngest({ base_url: "https://api.example.com", fetchImpl: fn });
    expect(res.winning_source).toBe("openapi");
    expect(res.source_uri).toBe("https://api.example.com/openapi.json");
    expect(res.chunks.length).toBeGreaterThan(0);
    // Should not have fallen through to GraphQL / markdown.
    expect(calls.some((c) => c.includes("/graphql"))).toBe(false);
    expect(calls.some((c) => c.endsWith("/README.md"))).toBe(false);
  });

  test("falls through OpenAPI → GraphQL when no spec is reachable", async () => {
    const introspection = JSON.stringify({
      data: {
        __schema: {
          queryType: { name: "Query" },
          types: [
            {
              kind: "OBJECT",
              name: "Query",
              fields: [
                {
                  name: "hello",
                  args: [],
                  type: { kind: "SCALAR", name: "String" },
                },
              ],
            },
          ],
        },
      },
    });
    const { fn } = makeFetchMock([{ match: /\/graphql$/, status: 200, body: introspection }]);
    const res = await cascadeIngest({ base_url: "https://api.example.com", fetchImpl: fn });
    expect(res.winning_source).toBe("graphql");
    // At least one openapi attempt must have been recorded as not_found / error.
    const openapiAttempts = res.attempts.filter((a) => a.source === "openapi");
    expect(openapiAttempts.length).toBeGreaterThan(0);
    expect(openapiAttempts.every((a) => a.status !== "ok")).toBe(true);
  });

  test("falls through to llms.txt when neither openapi nor graphql respond", async () => {
    const llmsTxt = `# Example API

[Getting started](https://example.com/docs/start)
[Reference](https://example.com/docs/ref)`;
    const { fn } = makeFetchMock([
      { match: /llms\.txt$/, status: 200, body: llmsTxt, content_type: "text/plain" },
    ]);
    const res = await cascadeIngest({ base_url: "https://api.example.com", fetchImpl: fn });
    expect(res.winning_source).toBe("llms_txt");
    expect(res.source_uri).toMatch(/llms\.txt$/);
  });

  test("returns winning_source: null when every probe fails", async () => {
    const { fn } = makeFetchMock([]);
    const res = await cascadeIngest({ base_url: "https://api.example.com", fetchImpl: fn });
    // The raw-http fallback also fails (base URL → 404), so the final
    // result surfaces no winner.
    expect(res.winning_source).toBeNull();
    expect(res.chunks.length).toBe(0);
    expect(res.attempts.length).toBeGreaterThan(0);
  });

  test("allowed_sources restricts the probe set", async () => {
    const { fn, calls } = makeFetchMock([]);
    await cascadeIngest({
      base_url: "https://api.example.com",
      fetchImpl: fn,
      allowed_sources: ["graphql"],
    });
    // Only graphql candidate paths (plus the raw-http fallback that hits the
    // bare base URL) should appear — nothing pointing at /openapi.json,
    // /llms.txt, or /README.md.
    const disallowed = calls.filter((c) =>
      /\/openapi\.json|\/swagger|\/api-docs|\/llms\.txt|\.md($|\?)/i.test(c),
    );
    expect(disallowed).toHaveLength(0);
    // At least one graphql probe must be present.
    expect(calls.some((c) => /\/graphql|\/query$/i.test(c))).toBe(true);
  });

  test("discoverOpenApiLinks extracts spec URLs from HTML", async () => {
    const html = `<html><body>
      <a href="/v2/openapi.json">Spec</a>
      <a href="/swagger-ui.html">UI</a>
      <a href="/docs/swagger.yaml">YAML</a>
      <a href="/login">Login</a>
    </body></html>`;
    const fn = (async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const links = await discoverOpenApiLinks("https://api.example.com/", fn);
    expect(links).toContain("https://api.example.com/v2/openapi.json");
    expect(links).toContain("https://api.example.com/swagger-ui.html");
    expect(links.some((l) => l.endsWith("/login"))).toBe(false);
  });
});
