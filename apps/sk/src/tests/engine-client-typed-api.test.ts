import { describe, expect, test } from "bun:test";
import { EngineError, TransportError } from "@cli-core/errors";
import { EngineClient, type FetchLike } from "../engine-client.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function client(
  respond: (seen: Seen) => Response | Promise<Response>,
  engine_url = "http://engine.test",
): { client: EngineClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    seen.push(entry);
    return respond(entry);
  };
  return {
    client: new EngineClient({ engine_url, api_key: "k", tenant: "t-1", fetchImpl }),
    seen,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("EngineClient typed api transport", () => {
  test("routes typed calls through the instrumented request pipeline", async () => {
    const { client: c, seen } = client(() => json({ items: [] }));
    expect(await c.listSubscriptions()).toEqual({ items: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://engine.test/v1/subscriptions");
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers.authorization).toBe("Bearer k");
    expect(seen[0]?.headers["x-subkit-tenant"]).toBe("t-1");
    expect(seen[0]?.headers["x-sk-trace-id"]).toMatch(/^cli-/);
    expect(seen[0]?.headers).not.toHaveProperty("x-tenant-id");
  });

  test("keeps a base path prefix and encodes path params", async () => {
    const { client: c, seen } = client(() => json({ id: "a/b" }), "http://engine.test/api/");
    await c.getSubscription("a/b");
    expect(seen[0]?.url).toBe("http://engine.test/api/v1/subscriptions/a%2Fb");
  });

  test("sends the JSON body unchanged", async () => {
    const { client: c, seen } = client(() => json({ id: "s" }, 201));
    await c.createSubscription({ event_pattern: "e.*", target_url: "https://t.test", secret: "x" });
    expect(seen[0]?.method).toBe("POST");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      event_pattern: "e.*",
      target_url: "https://t.test",
      secret: "x",
    });
  });

  test("forwards a header the typed call sets and keeps the transport headers its own", async () => {
    const { client: c, seen } = client(() => json({ id: "c" }, 201));
    await c.api.POST("/v1/connectors/{id}/promote", {
      params: { path: { id: "c-1" }, header: { "idempotency-key": "promo-1" } },
      body: { target_environment: "prod", strategy: "copy" },
    });
    const headers = Object.fromEntries(
      Object.entries(seen[0]?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    expect(headers["idempotency-key"]).toBe("promo-1");
    expect(headers.authorization).toBe("Bearer k");
  });

  test("a call without body sends none", async () => {
    const { client: c, seen } = client(() => json({ replayed: true }, 202));
    expect(await c.replaySubscriptionDelivery("s", "d")).toEqual({ replayed: true });
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]?.url).toBe("http://engine.test/v1/subscriptions/s/deliveries/d/replay");
  });

  test("sends query params like the request pipeline", async () => {
    const { client: c, seen } = client(() => json({ items: [], total: 0, next_cursor: null }));
    await c.listExecutions({ limit: 5, workflow_id: "w 1" });
    expect(seen[0]?.url).toBe("http://engine.test/v1/executions?limit=5&workflow_id=w+1");
  });

  test("keeps the tenant query on settings reads", async () => {
    const { client: c, seen } = client(() => json({ path: "a.b" }));
    await c.getSetting("a.b", { tenant: "t-2" });
    await c.listSettings();
    expect(seen.map((s) => s.url)).toEqual([
      "http://engine.test/v1/settings/a.b?tenant=t-2",
      "http://engine.test/v1/settings",
    ]);
  });

  test("returns null data from a JSON null body unchanged", async () => {
    const { client: c } = client(() => json(null));
    expect(await c.getRole("r")).toBeNull();
  });

  test("an empty response resolves without data", async () => {
    const { client: c } = client(() => new Response(null, { status: 204 }));
    expect(await c.deleteSubscription("s")).toBeUndefined();
  });

  test("engine errors surface as EngineError", async () => {
    const { client: c } = client(() => json({ error: "gone", code: "not_found" }, 404));
    const err = await c.getSubscription("s").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).status).toBe(404);
  });

  test("transport failures surface as TransportError", async () => {
    const { client: c } = client(() => {
      throw new Error("ECONNREFUSED");
    });
    const err = await c.listSubscriptions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
  });
});
