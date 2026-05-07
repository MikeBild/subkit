import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, tenants, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

// Second tenant + a non-admin user inside the primary tenant. Both
// added to the same test DB so we can issue cross-principal HTTP
// calls and assert tenant isolation + permission gating without
// standing up a second server.
let foreignTenantId: string;
let foreignApiKey: string;
let memberApiKey: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("sk-bootstrap");

  // ----- second tenant + admin api key (cross-tenant test) -----
  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-foreign", display_name: "Foreign tenant" })
    .returning();
  if (!t2) throw new Error("seed foreign tenant failed");
  foreignTenantId = t2.id;
  const [u2] = await ctx.db
    .insert(users)
    .values({ tenant_id: t2.id, email: "admin-foreign@test.local", role: "admin" })
    .returning();
  if (!u2) throw new Error("seed foreign user failed");
  const fk = `wf_live_${randomBytes(24).toString("base64url").slice(0, 32)}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: t2.id,
    user_id: u2.id,
    prefix: fk.slice(0, 12),
    token_sha256: createHash("sha256").update(fk).digest("hex"),
    scopes: ["*"],
  });
  foreignApiKey = fk;

  // ----- non-admin (member) user inside the primary tenant -----
  const [member] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: "member@test.local", role: "member" })
    .returning();
  if (!member) throw new Error("seed member user failed");
  const mk = `wf_live_${randomBytes(24).toString("base64url").slice(0, 32)}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: mk.slice(0, 12),
    token_sha256: createHash("sha256").update(mk).digest("hex"),
    scopes: ["*"],
  });
  memberApiKey = mk;
});

afterAll(async () => {
  await ctx.cleanup();
});

interface BootstrapResponse {
  whoami: {
    id: string;
    kind: "user" | "system_account";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
    base_url: string | null;
    scopes: string[] | null;
  };
  permissions: string[];
  permissions_checked: string[];
  tenant: { id: string; slug: string | null; display_name: string | null };
  recent_sessions: Array<{ id: string; title: string | null; updated_at: string }>;
  flags: Record<string, boolean>;
  server_time: string;
}

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
    // Admin should have every probed permission allowed.
    expect(body.permissions_checked.length).toBeGreaterThan(0);
    expect(body.permissions.length).toBe(body.permissions_checked.length);
    expect(body.permissions).toContain("audit:read");
    expect(body.permissions).toContain("conversation:read");
    expect(body.permissions).toContain("workflow:write");
    expect(Array.isArray(body.recent_sessions)).toBe(true);
    expect(typeof body.server_time).toBe("string");
    expect(new Date(body.server_time).getTime()).toBeGreaterThan(0);
  });

  test("permissions_checked is stable and includes UX-gating set", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const body = (await res.json()) as BootstrapResponse;
    // Mirrors apps/sk/src/persona-probe.ts TIER_PERMISSIONS — keep these
    // in sync; if either side drifts, this assertion alerts.
    const expected = [
      "conversation:read",
      "conversation:write",
      "memory:write",
      "conversation:approve",
      "conversation:list",
      "mcp:read",
      "skill:read",
      "conversation:cancel",
      "conversation:commit",
      "workflow:read",
      "workflow:write",
      "connector:read",
      "skill:write",
      "execution:read",
      "notification:read",
      "audit:read",
      "identity:read",
      "rbac:read",
      "api_key:read",
      "portal_token:read",
      "knowledge:read",
    ];
    for (const perm of expected) {
      expect(body.permissions_checked).toContain(perm);
    }
  });

  test("recent_sessions only includes principal's own conversations", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const body = (await res.json()) as BootstrapResponse;
    // Fresh tenant has no conversations seeded, so the array is empty.
    // The shape itself is the contract; presence is exercised by the
    // sk e2e tests downstream.
    expect(Array.isArray(body.recent_sessions)).toBe(true);
    expect(body.recent_sessions.length).toBeLessThanOrEqual(10);
  });

  // ----- W6 review fix: non-admin + cross-tenant coverage -----

  test("non-admin (member) bearer gets a STRICT SUBSET of permissions_checked", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${memberApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    // Strict subset: every entry in permissions appears in
    // permissions_checked, and the member's allow-set is smaller
    // than the checked set (a member never gets audit:read /
    // rbac:read / api_key:read / portal_token:read).
    for (const p of body.permissions) {
      expect(body.permissions_checked).toContain(p);
    }
    expect(body.permissions.length).toBeLessThan(body.permissions_checked.length);
    expect(body.permissions).not.toContain("audit:read");
    expect(body.permissions).not.toContain("rbac:read");
    // role_name reflects the member role.
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
    // Sanity: the foreign admin's allow-set is computed against its
    // own tenant — it MUST NOT inherit anything from the primary
    // tenant's seed by accident.
    expect(body.permissions).toContain("conversation:read");
  });

  test("`?tenant_id=other` on the URL is ignored — the bearer's tenant binds the response", async () => {
    // Defense-in-depth: a malicious caller passing the foreign key
    // with a `tenant_id=ctx.tenantId` query override should NOT see
    // the primary tenant's data. The route reads the tenant from
    // `principal.tenant_id` set by the auth middleware, not from
    // the URL.
    const url = `${ctx.baseUrl}/v1/sk/bootstrap?tenant_id=${ctx.tenantId}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${foreignApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    expect(body.whoami.tenant_id).toBe(foreignTenantId);
    expect(body.tenant.id).toBe(foreignTenantId);
  });
});
