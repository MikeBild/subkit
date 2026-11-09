import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import { outboundConnections, tenants } from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { createSecretVersion, readSecretVersion } from "./service.ts";

let ctx: HttpTestServer;
let connectionId: string;
let foreignTenantId: string;
let name: string;
let version: number;

beforeAll(async () => {
  ctx = await createHttpTestServer("connection-secret-lock");
  name = `connection.${ctx.tenantId}.lock-fixture.access_token`;
  const secret = await createSecretVersion(ctx.db, {
    name,
    value: "connection-lock-private-canary",
    created_by: ctx.userId,
  });
  version = secret.version;
  const [row] = await ctx.db
    .insert(outboundConnections)
    .values({
      tenant_id: ctx.tenantId,
      name: "lock-fixture",
      base_url: "https://connection.example.test",
      issuer: "https://connection.example.test",
      authorization_endpoint: "https://connection.example.test/authorize",
      token_endpoint: "https://connection.example.test/token",
      client_id: "lock-fixture",
      scopes: ["read"],
      access_token_version: version,
    })
    .returning({ id: outboundConnections.id });
  if (!row) throw new Error("connection fixture missing");
  connectionId = row.id;
  const [foreign] = await ctx.db
    .insert(tenants)
    .values({
      slug: "connection-lock-foreign",
      display_name: "Foreign lock fixture",
    })
    .returning({ id: tenants.id });
  if (!foreign) throw new Error("foreign tenant fixture missing");
  foreignTenantId = foreign.id;
});

afterAll(async () => ctx?.cleanup());

async function withHeldCatalogLock(tenantId: string, check: () => Promise<void>): Promise<void> {
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = ctx.db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenantId);
    acquired.resolve();
    await release.promise;
  });
  void holder.catch(acquired.reject);
  try {
    await acquired.promise;
    await check();
  } finally {
    release.resolve();
    await holder;
  }
}

async function readConnection(
  path: string,
): Promise<{ state: string; state_reason: string | null }> {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("connection-lock-private-canary");
  const body = JSON.parse(text);
  return path === "/v1/connections"
    ? body.items.find((item: { id: string }) => item.id === connectionId)
    : body;
}

for (const endpoint of ["list", "detail"] as const) {
  test(`connection ${endpoint} bounds its secret lock wait and recovers after release`, async () => {
    const path = endpoint === "list" ? "/v1/connections" : `/v1/connections/${connectionId}`;
    await withHeldCatalogLock(ctx.tenantId, async () => {
      expect(await readConnection(path)).toMatchObject({
        state: "unreadable",
        state_reason: "secret_unreadable",
      });
    });
    expect(await readConnection(path)).toMatchObject({ state: "valid", state_reason: null });
  });
}

test("another tenant's catalog lock does not block a connection read", async () => {
  await withHeldCatalogLock(foreignTenantId, async () => {
    expect(await readConnection(`/v1/connections/${connectionId}`)).toMatchObject({
      state: "valid",
    });
  });
});

test("a root database secret read keeps the active-tenant policy", async () => {
  await ctx.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, foreignTenantId));
  await expect(
    readSecretVersion(ctx.db, `connection.${foreignTenantId}.missing.access_token`, 1),
  ).rejects.toThrow("known active workspace");
  expect(await readSecretVersion(ctx.db, name, version)).toBe("connection-lock-private-canary");
});
