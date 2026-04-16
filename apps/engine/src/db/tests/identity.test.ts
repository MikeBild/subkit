import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { writeAudit } from "../audit.ts";
import { apiKeys, auditLog, tenants, users } from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("identity");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("identity schema", () => {
  test("insert tenant + user + api_key and read them back", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "acme", display_name: "Acme Corp" })
      .returning();
    expect(tenant).toBeDefined();

    const [user] = await ctx.db
      .insert(users)
      .values({
        tenant_id: tenant!.id,
        email: "owner@acme.test",
        role: "admin",
      })
      .returning();
    expect(user).toBeDefined();
    expect(user!.role).toBe("admin");

    const plaintext = `wf_live_${randomBytes(24).toString("base64url").slice(0, 32)}`;
    const hash = createHash("sha256").update(plaintext).digest("hex");
    const [apiKey] = await ctx.db
      .insert(apiKeys)
      .values({
        tenant_id: tenant!.id,
        user_id: user!.id,
        prefix: plaintext.slice(0, 12),
        token_sha256: hash,
        scopes: ["read"],
      })
      .returning();
    expect(apiKey).toBeDefined();

    // read back by joining on the tenant
    const tenantRow = await ctx.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenant!.id))
      .limit(1);
    expect(tenantRow[0]?.slug).toBe("acme");

    const userRows = await ctx.db.select().from(users).where(eq(users.tenant_id, tenant!.id));
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.email).toBe("owner@acme.test");

    const keyRows = await ctx.db.select().from(apiKeys).where(eq(apiKeys.tenant_id, tenant!.id));
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]?.token_sha256).toBe(hash);
  });

  test("audit row can be persisted and read back", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "audit-co", display_name: "Audit Co" })
      .returning();

    const id = crypto.randomUUID();
    await writeAudit(
      {
        id,
        ts: new Date(),
        tenant_id: tenant!.id,
        actor_type: "system",
        actor_id: null,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: tenant!.id,
        result: "success",
        trace_id: "trace-abc",
        ip: null,
        user_agent: null,
        before: null,
        after: null,
        reason: null,
        metadata: { source: "test" },
      },
      ctx.db,
    );

    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("tenant.created");
    expect(rows[0]?.actor_type).toBe("system");
    expect(rows[0]?.tenant_id).toBe(tenant!.id);
  });
});
