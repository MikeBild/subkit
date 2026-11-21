import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  llmUsage,
  permissions,
  rolePermissions,
  roles,
  users,
} from "../../db/schema/index.ts";
import { issueApiKey } from "../../identity/service.ts";
import { currentMonthBucket } from "../../llm/accounting/index.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { setTestNow } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const NOW = Date.parse("2026-11-21T10:00:00Z");
let ctx: HttpTestServer;
let admin: Record<string, string>;
let member: Record<string, string>;
let reader: Record<string, string>;

async function personKey(label: string, role_id: string): Promise<Record<string, string>> {
  const [person] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: `${label}@example.test`, role_id })
    .returning();
  if (!person) throw new Error("person missing");
  const key = await issueApiKey(
    {
      issuer: { kind: "system" },
      tenant_id: ctx.tenantId,
      owner_kind: "user",
      owner_id: person.id,
      actor_id: null,
    },
    ctx.db,
  );
  return { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" };
}

async function call(auth: Record<string, string>, method: string, path: string, body?: unknown) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: auth,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function auditActions(action: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, action)));
  return rows.length;
}

async function attentionIds(): Promise<string[]> {
  invalidateAttention(ctx.tenantId);
  const { body } = await call(admin, "GET", "/v1/attention");
  return (body.items as Array<{ id: string }>).map((item) => item.id);
}

beforeAll(async () => {
  ctx = await createHttpTestServer("spend-limit");
  setTestNow(() => NOW);
  admin = { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
  member = await personKey("member-spend", await builtinRoleId(ctx.db, "member"));
  const [readerRole] = await ctx.db
    .insert(roles)
    .values({ tenant_id: ctx.tenantId, name: "usage-reader" })
    .returning();
  if (!readerRole) throw new Error("role missing");
  // tenant-filter:exempt — the permission catalog is global
  const [statsRead] = await ctx.db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.name, "stats:read"))
    .limit(1);
  if (!statsRead) throw new Error("stats:read missing");
  await ctx.db
    .insert(rolePermissions)
    .values({ role_id: readerRole.id, permission_id: statsRead.id });
  reader = await personKey("reader-spend", readerRole.id);
  await ctx.db.insert(llmUsage).values({
    tenant_id: ctx.tenantId,
    flow: "converse",
    model: "claude-sonnet-4-5",
    completion_tokens: 2_000_000,
    total_tokens: 2_000_000,
    result: "success",
    month_bucket: currentMonthBucket(new Date(NOW)),
    created_at: new Date("2026-11-10T08:00:00Z"),
  });
});

afterAll(async () => {
  setTestNow(null);
  await ctx.cleanup();
});

describe("the workspace spending limit", () => {
  test("reads this month's dollars against the default limit of 50 $", async () => {
    const { status, body } = await call(admin, "GET", "/v1/workspace/spend-limit");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      currency: "USD",
      month: "2026-11",
      limit_usd: 50,
      spent_usd: 30,
      state: "ok",
      choices: [20, 50, 200, 0],
      can_change: true,
    });
    expect((await call(member, "GET", "/v1/workspace/spend-limit")).status).toBe(403);
    const asReader = await call(reader, "GET", "/v1/workspace/spend-limit");
    expect(asReader.status).toBe(200);
    expect(asReader.body).toMatchObject({ limit_usd: 50, spent_usd: 30, can_change: false });
    expect((await call(reader, "PUT", "/v1/workspace/spend-limit", { limit_usd: 1 })).status).toBe(
      403,
    );
  });

  test("only an admin changes it, and the change is audited", async () => {
    expect(
      (await call(member, "PUT", "/v1/workspace/spend-limit", { limit_usd: 200 })).status,
    ).toBe(403);
    const changed = await call(admin, "PUT", "/v1/workspace/spend-limit", { limit_usd: 35 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ limit_usd: 35, state: "warning" });
    expect(await auditActions("workspace.spend_limit_changed")).toBe(1);
    expect(await attentionIds()).toContain("spend-warning:2026-11");
    expect(
      (await call(member, "PUT", "/v1/settings/tokens.monthly_spend_usd", { value: 1 })).status,
    ).toBe(404);
  });

  test("at 100 % it asks the admin, who may continue for this month", async () => {
    await call(admin, "PUT", "/v1/workspace/spend-limit", { limit_usd: 20 });
    expect((await call(admin, "GET", "/v1/workspace/spend-limit")).body.state).toBe("reached");
    const ids = await attentionIds();
    expect(ids).toContain("spend-limit:2026-11");
    expect(ids).not.toContain("spend-warning:2026-11");
    expect((await call(member, "POST", "/v1/workspace/spend-limit/continue")).status).toBe(403);
    const continued = await call(admin, "POST", "/v1/workspace/spend-limit/continue");
    expect(continued.status).toBe(200);
    expect(continued.body.state).toBe("continued");
    expect(await auditActions("workspace.spend_continued")).toBe(1);
    expect(await attentionIds()).not.toContain("spend-limit:2026-11");
  });

  test("setup sets the same limit and shows it", async () => {
    const before = await call(admin, "GET", "/v1/identity/me/setup");
    expect(before.status).toBe(200);
    const saved = await call(admin, "PUT", "/v1/identity/me/setup", { monthly_spend_usd: 200 });
    expect(saved.status).toBe(200);
    expect(saved.body.spend).toEqual({ limit_usd: 200, can_change: true });
    expect(
      (await call(member, "PUT", "/v1/identity/me/setup", { monthly_spend_usd: 0 })).body,
    ).toMatchObject({ code: "spend_admin_required" });
  });

  test("without a limit there is nothing to continue past", async () => {
    await call(admin, "PUT", "/v1/workspace/spend-limit", { limit_usd: 0 });
    const refused = await call(admin, "POST", "/v1/workspace/spend-limit/continue");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("no_limit");
  });
});
