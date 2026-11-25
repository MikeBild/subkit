import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/index.ts";
import { connectors, vaultItems } from "../../db/schema/index.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const TOKEN = "fixture-http-vault-token-3b7c";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("vault-routes");
});

afterAll(async () => {
  await ctx.cleanup();
});

function call(path: string, init: RequestInit = {}) {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function seedCredential(tenantId: string): Promise<string> {
  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: `c-del-${tenantId.slice(0, 8)}`,
      display_name: "C",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://example.test",
    })
    .returning();
  const row = await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: conn!.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "delete-me" },
      actor_id: null,
    },
    ctx.db,
  );
  return row.id;
}

describe("http /v1/vault", () => {
  test("creates, lists without values, reveals, rotates and shows activity", async () => {
    const created = await call("/v1/vault", {
      method: "POST",
      body: JSON.stringify({ kind: "secret", name: "crm-token", environment: "dev", token: TOKEN }),
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string; version: number };
    expect(item.version).toBe(1);

    const list = await call("/v1/vault");
    expect(list.status).toBe(200);
    const listed = await list.text();
    expect(listed).toContain("crm-token");
    expect(listed).not.toContain(TOKEN);

    const reveal = await call(`/v1/vault/${item.id}/reveal`, { method: "POST" });
    expect(reveal.status).toBe(200);
    expect(reveal.headers.get("cache-control")).toBe("no-store");
    expect(((await reveal.json()) as { values: unknown }).values).toEqual({ token: TOKEN });

    const rotated = await call(`/v1/vault/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ token: `${TOKEN}-2` }),
    });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { version: number }).version).toBe(2);

    const activity = await call(`/v1/vault/${item.id}/activity`);
    const actions = ((await activity.json()) as { items: Array<{ action: string }> }).items.map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(["vault.item.rotated", "vault.item.revealed", "vault.item.created"]);
  });

  test("refuses names outside the handle grammar and a login without a password", async () => {
    const badName = await call("/v1/vault", {
      method: "POST",
      body: JSON.stringify({ kind: "secret", name: "CRM Token", token: "x" }),
    });
    expect(badName.status).toBe(400);
    const noPassword = await call("/v1/vault", {
      method: "POST",
      body: JSON.stringify({ kind: "login", name: "erp", username: "u" }),
    });
    expect(noPassword.status).toBe(400);
  });

  test("rotating a login with one field keeps the other stored field", async () => {
    const created = await call("/v1/vault", {
      method: "POST",
      body: JSON.stringify({
        kind: "login",
        name: "erp-login",
        environment: "dev",
        username: "erp.user",
        password: "fixture-erp-password-1",
      }),
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string };
    const revealValues = async () =>
      (
        (await (await call(`/v1/vault/${item.id}/reveal`, { method: "POST" })).json()) as {
          values: Record<string, string>;
        }
      ).values;

    const passwordOnly = await call(`/v1/vault/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ password: "fixture-erp-password-2" }),
    });
    expect(passwordOnly.status).toBe(200);
    expect(((await passwordOnly.json()) as { version: number }).version).toBe(2);
    expect(await revealValues()).toEqual({
      username: "erp.user",
      password: "fixture-erp-password-2",
    });

    const usernameOnly = await call(`/v1/vault/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ username: "erp.renamed" }),
    });
    expect(usernameOnly.status).toBe(200);
    expect(((await usernameOnly.json()) as { version: number }).version).toBe(3);
    expect(await revealValues()).toEqual({
      username: "erp.renamed",
      password: "fixture-erp-password-2",
    });

    const emptyPassword = await call(`/v1/vault/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ password: "" }),
    });
    expect(emptyPassword.status).toBe(400);
  });

  test("deleting a connector item removes the row; a repeat delete 404s", async () => {
    const id = await seedCredential(ctx.tenantId);
    const res = await call(`/v1/vault/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const remaining = await ctx.db.select().from(vaultItems).where(eq(vaultItems.id, id));
    expect(remaining.length).toBe(0);
    const again = await call(`/v1/vault/${id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("cannot delete another tenant's item", async () => {
    const other = await seedTenant(ctx.db, { slug: "t-vault-del-other", display_name: "Other" });
    const foreignId = await seedCredential(other.id);
    const res = await call(`/v1/vault/${foreignId}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const remaining = await ctx.db.select().from(vaultItems).where(eq(vaultItems.id, foreignId));
    expect(remaining.length).toBe(1);
  });

  test("rejects unauthenticated requests", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/vault/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
