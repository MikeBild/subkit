import { describe, expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";

function clientAnswering(bodies: Record<string, unknown>): EngineClient {
  return new EngineClient({
    engine_url: "https://engine.test/",
    api_key: "key",
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      const body = bodies[path] as { status?: string } | undefined;
      if (!body) return Response.json({ code: "not_found" }, { status: 404 });
      return Response.json(body, { status: body.status === "not_ready" ? 503 : 200 });
    },
  });
}

describe("readiness EngineClient", () => {
  test("keeps the engine's own health and readiness answers", async () => {
    const client = clientAnswering({
      "/health": { status: "ok", service: "subkit", version: "10.4.7" },
      "/ready": {
        status: "ready",
        service: "subkit",
        version: "10.4.7",
        checks: { lifecycle: "pass", database: "fail" },
      },
    });
    expect(await client.health()).toEqual({ status: "ok", service: "subkit", version: "10.4.7" });
    expect(await client.ready()).toEqual({
      status: "ready",
      service: "subkit",
      checks: { lifecycle: "pass", database: "fail", schema: "unknown" },
      failing: [],
    });
  });

  test("a 503 still reports which dependency fails", async () => {
    const client = clientAnswering({
      "/ready": {
        status: "not_ready",
        service: "subkit",
        version: "12.1.2",
        checks: { lifecycle: "pass", database: "fail", schema: "drift" },
        failing: ["database"],
      },
    });
    expect(await client.ready()).toEqual({
      status: "not_ready",
      service: "subkit",
      checks: { lifecycle: "pass", database: "fail", schema: "drift" },
      failing: ["database"],
    });
  });

  test("a proxy's bare answer becomes unknown checks and the descriptor's version", async () => {
    const client = clientAnswering({
      "/health": { status: "ok" },
      "/ready": { status: "ok" },
      "/.well-known/service-descriptor.json": { service: "subkit", version: "10.4.7" },
    });
    expect((await client.health()).version).toBe("10.4.7");
    expect(await client.ready()).toEqual({
      status: "ready",
      service: "subkit",
      checks: { lifecycle: "unknown", database: "unknown", schema: "unknown" },
      failing: [],
    });
  });

  test("a missing descriptor leaves the version unknown instead of failing", async () => {
    const client = clientAnswering({ "/health": { status: "ok" } });
    expect((await client.health()).version).toBe("unknown");
  });
});
