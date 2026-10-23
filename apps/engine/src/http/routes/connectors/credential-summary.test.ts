import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, outboundConnections } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;
let connectorId: string;

function auth(): Record<string, string> {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}

async function send(path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, { method, headers: auth(), body: JSON.stringify(body) });
}

async function summary(): Promise<{ mode: string } | null> {
  const res = await fetch(`${ctx.baseUrl}/v1/connectors/${connectorId}/credential`, {
    headers: auth(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { mode: string } | null;
}

async function listed(): Promise<{ list: unknown; detail: unknown }> {
  const res = await fetch(`${ctx.baseUrl}/v1/connectors?limit=200`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { id: string; credential?: unknown }[] };
  const one = await fetch(`${ctx.baseUrl}/v1/connectors/${connectorId}`, { headers: auth() });
  expect(one.status).toBe(200);
  return {
    list: body.items.find((item) => item.id === connectorId)?.credential,
    detail: ((await one.json()) as { credential?: unknown }).credential,
  };
}

async function expectListedLike(mode: string | null): Promise<void> {
  const expected = mode === null ? null : { mode, connection: null };
  expect(await listed()).toEqual({ list: expected, detail: expected });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("connector-credential-summary");
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "switchable",
      display_name: "Switchable",
      driver: "http",
      environment: "prod",
      base_url: "https://switchable.example.test",
    })
    .returning();
  if (!row) throw new Error("connector seed failed");
  connectorId = row.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("GET /v1/connectors/{id}/credential after the sign-in changes", () => {
  test("a stored key is the sign-in only while the connector signs in with a key", async () => {
    await expectListedLike(null);
    const stored = await send(`/v1/connectors/${connectorId}/credentials`, "POST", {
      mode: "bearer",
      token: "switchable-test-token",
    });
    expect(stored.status).toBe(201);
    expect((await summary())?.mode).toBe("bearer");
    await expectListedLike("bearer");

    expect(
      (await send(`/v1/connectors/${connectorId}`, "PATCH", { auth_type: "oauth2" })).status,
    ).toBe(200);
    expect(await summary()).toBeNull();
    await expectListedLike(null);

    expect(
      (await send(`/v1/connectors/${connectorId}`, "PATCH", { auth_type: "none" })).status,
    ).toBe(200);
    expect(await summary()).toBeNull();

    expect(
      (await send(`/v1/connectors/${connectorId}`, "PATCH", { auth_type: "bearer" })).status,
    ).toBe(200);
    expect((await summary())?.mode).toBe("bearer");
    await expectListedLike("bearer");
  });

  test("connection credentials retain the authenticated principal kind in audit", async () => {
    const [connector] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "connection-authored",
        display_name: "Connection authored",
        driver: "http",
        environment: "prod",
        base_url: "https://connection-authored.example.test",
      })
      .returning();
    if (!connector) throw new Error("connector seed failed");
    const [connection] = await ctx.db
      .insert(outboundConnections)
      .values({
        tenant_id: ctx.tenantId,
        name: "test connection",
        base_url: "https://provider.example.test",
        issuer: "https://provider.example.test",
        authorization_endpoint: "https://provider.example.test/authorize",
        token_endpoint: "https://provider.example.test/token",
        client_id: "fixture",
        scopes: [],
        access_token_version: 1,
      })
      .returning();
    if (!connection) throw new Error("connection seed failed");

    const response = await send(`/v1/connectors/${connector.id}/credentials`, "POST", {
      mode: "connection",
      connection_id: connection.id,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    const [audit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "credential.created"),
          eq(auditLog.resource_id, body.id),
        ),
      );
    expect(audit).toEqual({ actor_type: "user", actor_id: ctx.userId });
  });
});
