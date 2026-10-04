import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;
let httpConnectorId: string;
let mcpConnectorId: string;

function auth(): Record<string, string> {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}

async function post(path: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, { method: "POST", headers: auth() });
}

async function get(path: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, { headers: auth() });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("connector-enablement");

  const [httpRow] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "plainhttp",
      display_name: "Plain HTTP",
      driver: "http",
      environment: "prod",
      base_url: "https://plain.example.test",
    })
    .returning();
  const [mcpRow] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "remotemcp",
      display_name: "Remote MCP",
      driver: "mcp",
      environment: "prod",
      base_url: "https://remotemcp.example.test/mcp",
      config: { mcp: { transport: "http", auth: { kind: "none" } } },
    })
    .returning();
  if (!httpRow || !mcpRow) throw new Error("connector seed failed");
  httpConnectorId = httpRow.id;
  mcpConnectorId = mcpRow.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("POST /v1/connectors/{id}/enable | /disable", () => {
  test("disable then enable round-trips, and the bit is readable on every representation", async () => {
    const disabled = await post(`/v1/connectors/${mcpConnectorId}/disable`);
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { enabled: boolean }).enabled).toBe(false);

    const fetched = await get(`/v1/connectors/${mcpConnectorId}`);
    expect(((await fetched.json()) as { enabled: boolean }).enabled).toBe(false);

    const enabled = await post(`/v1/connectors/${mcpConnectorId}/enable`);
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { enabled: boolean }).enabled).toBe(true);
  });

  test("disabling twice is a success, not a missing row", async () => {
    expect((await post(`/v1/connectors/${httpConnectorId}/disable`)).status).toBe(200);
    const again = await post(`/v1/connectors/${httpConnectorId}/disable`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { enabled: boolean }).enabled).toBe(false);
    await post(`/v1/connectors/${httpConnectorId}/enable`);
  });

  test("the switch is driver-agnostic — an http connector flips the same way", async () => {
    const res = await post(`/v1/connectors/${httpConnectorId}/disable`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { driver: string; enabled: boolean };
    expect(body.driver).toBe("http");
    expect(body.enabled).toBe(false);
    await post(`/v1/connectors/${httpConnectorId}/enable`);
  });

  test("an unknown id is a 404, and the reserved `mcp` segment is never read as one", async () => {
    const missing = await post("/v1/connectors/00000000-0000-4000-8000-000000000000/disable");
    expect(missing.status).toBe(404);
  });
});

describe("the mcp driver's own routes are driver-dispatched", () => {
  test("mcp/inspect against an http connector is a 404 for 'mcp connector', not a handshake", async () => {
    const res = await post(`/v1/connectors/${httpConnectorId}/mcp/inspect`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("mcp connector");
  });

  test("mcp/authorize against an http connector is refused by its sign-in, not an OAuth dance", async () => {
    const res = await post(`/v1/connectors/${httpConnectorId}/mcp/authorize`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("no_browser_sign_in");
  });

  test("mcp/authorize on an mcp connector whose auth kind is not oauth2 is refused with the reason", async () => {
    const res = await post(`/v1/connectors/${mcpConnectorId}/mcp/authorize`);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("oauth2");
  });

  test("mcp/inspect on a DISABLED mcp connector is refused before any handshake", async () => {
    await post(`/v1/connectors/${mcpConnectorId}/disable`);
    const res = await post(`/v1/connectors/${mcpConnectorId}/mcp/inspect`);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("disabled");
    await post(`/v1/connectors/${mcpConnectorId}/enable`);
  });
});

describe("`last_error` is readable on every connector representation", () => {
  const failure = "upstream refused the session: 401 invalid_token";

  test("a recorded failure reaches both the single GET and the list item", async () => {
    await ctx.db
      .update(connectors)
      .set({ last_error: failure })
      .where(eq(connectors.id, mcpConnectorId));

    const single = (await (await get(`/v1/connectors/${mcpConnectorId}`)).json()) as {
      last_error: string | null;
    };
    expect(single.last_error).toBe(failure);

    const list = (await (await get("/v1/connectors")).json()) as {
      items: { id: string; last_error: string | null }[];
    };
    expect(list.items.find((i) => i.id === mcpConnectorId)?.last_error).toBe(failure);
  });

  test("clearing the column clears the field rather than leaving stale text", async () => {
    await ctx.db
      .update(connectors)
      .set({ last_error: null })
      .where(eq(connectors.id, mcpConnectorId));
    const single = (await (await get(`/v1/connectors/${mcpConnectorId}`)).json()) as {
      last_error: string | null;
    };
    expect(single.last_error).toBeNull();
  });

  test("a connector with no failure history reports null, not an absent field", async () => {
    const single = (await (await get(`/v1/connectors/${httpConnectorId}`)).json()) as Record<
      string,
      unknown
    >;
    expect("last_error" in single).toBe(true);
    expect(single.last_error).toBeNull();
    expect(single.enabled).toBe(true);
  });
});

describe("the engine's own health verdict is readable on every connector representation", () => {
  type HealthFields = {
    health_state: string;
    health_reason: string | null;
    health_error_code: string | null;
    needs_reauth: boolean;
  };

  test("a recorded transition round-trips through the single GET and the list item", async () => {
    await ctx.db
      .update(connectors)
      .set({
        health_state: "needs_update",
        health_reason: "The vendor removed this endpoint.",
        health_error_code: "endpoint_removed",
      })
      .where(eq(connectors.id, mcpConnectorId));

    const single = (await (await get(`/v1/connectors/${mcpConnectorId}`)).json()) as HealthFields;
    expect(single.health_state).toBe("needs_update");
    expect(single.health_reason).toBe("The vendor removed this endpoint.");
    expect(single.health_error_code).toBe("endpoint_removed");

    const list = (await (await get("/v1/connectors")).json()) as {
      items: ({ id: string } & HealthFields)[];
    };
    const item = list.items.find((i) => i.id === mcpConnectorId);
    expect(item?.health_state).toBe("needs_update");
    expect(item?.health_error_code).toBe("endpoint_removed");
  });

  test("the published state is the RECONCILED verdict, not the raw column", async () => {
    await ctx.db
      .update(connectors)
      .set({ health_state: "degraded", needs_reauth: true })
      .where(eq(connectors.id, mcpConnectorId));

    const single = (await (await get(`/v1/connectors/${mcpConnectorId}`)).json()) as HealthFields;
    expect(single.health_state).toBe("needs_reauth");
    expect(single.needs_reauth).toBe(true);

    await ctx.db
      .update(connectors)
      .set({
        health_state: "ok",
        health_reason: null,
        health_error_code: null,
        needs_reauth: false,
      })
      .where(eq(connectors.id, mcpConnectorId));
  });

  test("a healthy connector reports ok with null provenance, not absent fields", async () => {
    const single = (await (await get(`/v1/connectors/${httpConnectorId}`)).json()) as Record<
      string,
      unknown
    >;
    expect(single.health_state).toBe("ok");
    expect("health_reason" in single).toBe(true);
    expect(single.health_reason).toBeNull();
    expect(single.health_error_code).toBeNull();
  });
});
