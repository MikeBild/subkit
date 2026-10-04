import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { apiKeys, conversations, systemAccounts, tenants, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

let foreignTenantId: string;
let foreignApiKey: string;
let memberApiKey: string;
let systemAccountApiKey: string;
let systemAccountId: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("sk-bootstrap");

  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-foreign", display_name: "Foreign tenant" })
    .returning();
  if (!t2) throw new Error("seed foreign tenant failed");
  foreignTenantId = t2.id;
  const [u2] = await ctx.db
    .insert(users)
    .values({
      tenant_id: t2.id,
      email: "admin-foreign@test.local",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!u2) throw new Error("seed foreign user failed");
  const fk = "wf_live_FRG_skbootstrap_foreign_admin_dummy_pad_000";
  await ctx.db.insert(apiKeys).values({
    tenant_id: t2.id,
    user_id: u2.id,
    prefix: fk.slice(0, 12),
    token_sha256: createHash("sha256").update(fk).digest("hex"),
    scopes: ["*"],
  });
  foreignApiKey = fk;

  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member@test.local",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member user failed");
  const mk = "wf_live_MBR_skbootstrap_primary_member_dummy_pad_000";
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: mk.slice(0, 12),
    token_sha256: createHash("sha256").update(mk).digest("hex"),
    scopes: ["*"],
  });
  memberApiKey = mk;

  const [sysAcct] = await ctx.db
    .insert(systemAccounts)
    .values({
      tenant_id: ctx.tenantId,
      name: "bot-sk-bootstrap-deny-test",
      description: "exercises R2-S7 system_account branch",
    })
    .returning();
  if (!sysAcct) throw new Error("seed system_account for deny-test failed");
  const sk = "wf_live_SYS_skbootstrap_system_account_dummy_pad000";
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    system_account_id: sysAcct.id,
    prefix: sk.slice(0, 12),
    token_sha256: createHash("sha256").update(sk).digest("hex"),
    scopes: ["*"],
  });
  systemAccountApiKey = sk;
  systemAccountId = sysAcct.id;

  await ctx.db.insert(conversations).values({
    tenant_id: ctx.tenantId,
    owner_id: sysAcct.id,
    title: "system-account-owned-conversation",
    status: "active",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

type BootstrapResponse = components["schemas"]["SkBootstrap"];

describe("GET /v1/sk/bootstrap", () => {
  test("no bearer -> 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`);
    expect(res.status).toBe(401);
  });

  test("admin bearer -> 200, whoami populated, all UX permissions allowed", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    expect(body.whoami.kind).toBe("user");
    expect(body.whoami.tenant_id).toBe(ctx.tenantId);
    expect(body.whoami.email).toBe(`admin-sk-bootstrap@test.local`);
    expect(body.tenant.id).toBe(ctx.tenantId);
    expect(body.tenant.slug).toBe("t-sk-bootstrap");
    expect(body.permissions_checked.length).toBeGreaterThan(0);
    expect(body.permissions.length).toBe(body.permissions_checked.length);
    expect(body.permissions).toContain("audit:read");
    expect(body.permissions).toContain("conversation:read");
    expect(body.permissions).toContain("workflow:write");
    expect(Array.isArray(body.recent_sessions)).toBe(true);
    expect(typeof body.server_time).toBe("string");
    expect(new Date(body.server_time).getTime()).toBeGreaterThan(0);
  });

  test("permissions_checked is stable and equals the canonical UX_GATING_PERMISSIONS set", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const body = (await res.json()) as BootstrapResponse;
    const { UX_GATING_PERMISSIONS } = await import("@shared/ux-gating.ts");
    expect(new Set(body.permissions_checked)).toEqual(new Set(UX_GATING_PERMISSIONS));
    expect(body.permissions_checked.length).toBe(UX_GATING_PERMISSIONS.length);
  });

  test("recent_sessions only includes principal's own conversations", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const body = (await res.json()) as BootstrapResponse;
    expect(Array.isArray(body.recent_sessions)).toBe(true);
    expect(body.recent_sessions.length).toBeLessThanOrEqual(10);
  });

  test("non-admin (member) bearer gets a STRICT SUBSET of permissions_checked", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${memberApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    for (const p of body.permissions) {
      expect(body.permissions_checked).toContain(p);
    }
    expect(body.permissions.length).toBeLessThan(body.permissions_checked.length);
    expect(body.permissions).not.toContain("audit:read");
    expect(body.permissions).not.toContain("rbac:read");
    expect(body.whoami.role_name).toBe("member");
  });

  test("cross-tenant: foreign-tenant bearer never sees the primary tenant's data", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${foreignApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    expect(body.whoami.tenant_id).toBe(foreignTenantId);
    expect(body.whoami.tenant_id).not.toBe(ctx.tenantId);
    expect(body.tenant.id).toBe(foreignTenantId);
    expect(body.tenant.slug).toBe("t-foreign");
    expect(body.recent_sessions).toEqual([]);
    expect(body.permissions).toContain("conversation:read");
  });

  test("`?tenant_id=other` on the URL is ignored — the bearer's tenant binds the response", async () => {
    const url = `${ctx.baseUrl}/v1/sk/bootstrap?tenant_id=${ctx.tenantId}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${foreignApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    expect(body.whoami.tenant_id).toBe(foreignTenantId);
    expect(body.tenant.id).toBe(foreignTenantId);
  });

  test("system_account principal sees `recent_sessions === []` (R2-S7 + R4-S4 + R6-W3)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${systemAccountApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    expect(body.whoami.kind).toBe("system_account");
    expect(body.whoami.tenant_id).toBe(ctx.tenantId);
    expect(body.recent_sessions).toEqual([]);
    void systemAccountId;
  });

  test("recent_sessions[] rows carry tenant_id; permissions only contains canonical entries", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    for (const row of body.recent_sessions) {
      expect(row.tenant_id).toBe(ctx.tenantId);
    }
    const { UX_GATING_PERMISSIONS } = await import("@shared/ux-gating.ts");
    const canonical = new Set<string>(UX_GATING_PERMISSIONS);
    for (const p of body.permissions) {
      expect(canonical.has(p)).toBe(true);
    }
  });
});
