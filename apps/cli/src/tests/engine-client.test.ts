// Engine-client smoke: inject a fake fetch, assert headers + path +
// error mapping. The commands-level tests reuse the same pattern.

import { describe, expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";
import { EngineError, TransportError } from "../utils/errors.ts";

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  };
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  const out: Record<string, string> = {};
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v as string;
  return out;
}

describe("EngineClient", () => {
  test("attaches authorization + tenant headers", async () => {
    let seenHeaders: Record<string, string> = {};
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "wf_test_abc",
      tenant: "t1",
      fetchImpl: makeFetch((_url, init) => {
        seenHeaders = headersToRecord(init.headers);
        return new Response(
          JSON.stringify({ status: "ok", version: "1.0", db_connected: true, uptime_seconds: 1 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    });
    const body = await client.health();
    expect(body.status).toBe("ok");
    expect(seenHeaders.authorization).toBe("Bearer wf_test_abc");
    expect(seenHeaders["x-subkit-tenant"]).toBe("t1");
  });

  test("maps error envelopes to EngineError", async () => {
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "k",
      fetchImpl: makeFetch(
        () =>
          new Response(
            JSON.stringify({ code: "not_found", message: "workflow", trace_id: "abc" }),
            { status: 404, headers: { "content-type": "application/json" } },
          ),
      ),
    });
    try {
      await client.getWorkflow("00000000-0000-0000-0000-000000000000");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      const e = err as EngineError;
      expect(e.status).toBe(404);
      expect(e.code).toBe("not_found");
      expect(e.trace_id).toBe("abc");
    }
  });

  test("wraps network failures as TransportError", async () => {
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "k",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    try {
      await client.health();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
    }
  });

  test("serializes query params through request()", async () => {
    let seenUrl = "";
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "k",
      fetchImpl: makeFetch((url) => {
        seenUrl = url;
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
    await client.listWorkflows({ limit: 3, status: "active" });
    expect(seenUrl).toContain("/v1/workflows?");
    expect(seenUrl).toContain("limit=3");
    expect(seenUrl).toContain("status=active");
  });

  test("hits setup validation through the typed helper", async () => {
    let seenUrl = "";
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "k",
      fetchImpl: makeFetch((url) => {
        seenUrl = url;
        return new Response(
          JSON.stringify({ overall_status: "ok", issues: [], recommendations: [] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    });
    const body = await client.setupValidation();
    expect(seenUrl).toContain("/v1/diagnostics/setup");
    expect(body.overall_status).toBe("ok");
  });

  test("posts summarize requests through the typed helper", async () => {
    let seenBody = "";
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "k",
      fetchImpl: makeFetch((_url, init) => {
        seenBody = typeof init.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({
            summary: "Summary: done",
            tokens: { total: 42 },
            model_used: "claude-sonnet-4-5",
            fell_back: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    });
    const body = await client.summarize({ prompt: "hello world" });
    expect(JSON.parse(seenBody)).toEqual({ prompt: "hello world" });
    expect(body.summary).toBe("Summary: done");
  });
});
