import { describe, expect, test } from "bun:test";
import { createEngineClient } from "../engine-api/client.ts";

describe("createEngineClient", () => {
  test("attaches Authorization and x-subkit-tenant headers", async () => {
    let captured: Headers | null = null;
    const client = createEngineClient({
      baseUrl: "http://example.test",
      token: "sk-test-token",
      tenantId: "tenant-xyz",
      fetch: async (input) => {
        const req = input instanceof Request ? input : new Request(String(input));
        captured = new Headers(req.headers);
        return new Response(JSON.stringify({ status: "ok", db: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await client.GET("/health");
    expect(result.response.status).toBe(200);
    expect(captured).not.toBeNull();
    const headers = captured as unknown as Headers;
    expect(headers.get("authorization")).toBe("Bearer sk-test-token");
    expect(headers.get("x-subkit-tenant")).toBe("tenant-xyz");
    expect(headers.has("x-tenant-id")).toBe(false);
  });

  test("strips trailing slash from baseUrl", async () => {
    const client = createEngineClient({
      baseUrl: "http://example.test/",
      token: "t",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        expect(url).toBe("http://example.test/health");
        return new Response(JSON.stringify({ status: "ok", db: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.GET("/health");
  });

  test("omits the tenant header when no tenant is set", async () => {
    let captured: Headers | null = null;
    const client = createEngineClient({
      baseUrl: "http://example.test",
      token: "t",
      fetch: async (input) => {
        const req = input instanceof Request ? input : new Request(String(input));
        captured = new Headers(req.headers);
        return new Response(JSON.stringify({ status: "ok", db: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.GET("/health");
    const headers = captured as unknown as Headers;
    expect(headers.has("x-subkit-tenant")).toBe(false);
  });
});
