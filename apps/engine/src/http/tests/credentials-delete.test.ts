// DELETE /v1/credentials/:id — route wiring over the (already unit-tested)
// credentials service: tenant-scoped 404s, hard delete, and the
// { deleted: true } envelope.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/index.ts";
import { connectors, credentials, tenants } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("credentials-delete");
});

afterAll(async () => {
  await ctx.cleanup();
});

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

describe("http DELETE /v1/credentials/:id", () => {
  test("deletes the row and returns { deleted: true }; repeat delete 404s", async () => {
    const id = await seedCredential(ctx.tenantId);

    const res = await fetch(`${ctx.baseUrl}/v1/credentials/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const remaining = await ctx.db.select().from(credentials).where(eq(credentials.id, id));
    expect(remaining.length).toBe(0);

    const again = await fetch(`${ctx.baseUrl}/v1/credentials/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(again.status).toBe(404);
  });

  test("cannot delete another tenant's credential", async () => {
    const [other] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-cred-del-other", display_name: "Other" })
      .returning();
    const foreignId = await seedCredential(other!.id);

    const res = await fetch(`${ctx.baseUrl}/v1/credentials/${foreignId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(404);

    const remaining = await ctx.db.select().from(credentials).where(eq(credentials.id, foreignId));
    expect(remaining.length).toBe(1);
  });

  test("rejects unauthenticated requests", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/credentials/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
