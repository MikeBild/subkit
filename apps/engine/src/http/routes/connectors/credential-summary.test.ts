import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors } from "../../../db/schema/index.ts";
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
    const stored = await send(`/v1/connectors/${connectorId}/credentials`, "POST", {
      mode: "bearer",
      token: "switchable-test-token",
    });
    expect(stored.status).toBe(201);
    expect((await summary())?.mode).toBe("bearer");

    expect(
      (await send(`/v1/connectors/${connectorId}`, "PATCH", { auth_type: "oauth2" })).status,
    ).toBe(200);
    expect(await summary()).toBeNull();

    expect(
      (await send(`/v1/connectors/${connectorId}`, "PATCH", { auth_type: "none" })).status,
    ).toBe(200);
    expect(await summary()).toBeNull();

    expect(
      (await send(`/v1/connectors/${connectorId}`, "PATCH", { auth_type: "bearer" })).status,
    ).toBe(200);
    expect((await summary())?.mode).toBe("bearer");
  });
});
