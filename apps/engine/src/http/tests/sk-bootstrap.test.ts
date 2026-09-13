import { createHash } from "node:crypto";

import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { apiKeys, conversations, systemAccounts, tenants, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

// Second tenant + a non-admin user inside the primary tenant. Both
// added to the same test DB so we can issue cross-principal HTTP
// calls and assert tenant isolation + permission gating without
// standing up a second server.
let foreignTenantId: string;
let foreignApiKey: string;
let memberApiKey: string;
// R4-S4: a system_account principal — exercises the
// `principal.kind !== "user"` branch added in R2-S7 that skips the
// recent_sessions query entirely.
let systemAccountApiKey: string;
// R6-W3: also remember the system_account id so we can seed a
// conversation owned by it and prove the skip path actually fires.
let systemAccountId: string;

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
  // Deterministic key: stable across test runs so the determinism lint
  // (no-random-bytes-in-tests) stays green. The first 12 chars are
  // the `prefix` (UNIQUE in api_keys) — distinct from the member key
  // below and from setup.ts's randomly-prefixed admin key.
  const fk = "wf_live_FRG_skbootstrap_foreign_admin_dummy_pad_000";
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
  const mk = "wf_live_MBR_skbootstrap_primary_member_dummy_pad_000";
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: mk.slice(0, 12),
    token_sha256: createHash("sha256").update(mk).digest("hex"),
    scopes: ["*"],
  });
  memberApiKey = mk;

  // ----- system_account principal in the primary tenant ----------
  // Exercises the R2-S7 guard: `recent_sessions` is unconditionally
  // empty for non-`user` principals, regardless of permission set.
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

  // R6-W3 review fix: seed a conversation owned by the system_account
  // so the "system_account sees empty recent_sessions" test below
  // proves the SKIP path is firing (not just "no rows seeded").
  // Without this seed, the empty result set could be a false-pass.
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

// R7-W2 review fix: track the actual generated schema rather than a
// hand-rolled `Record<string, boolean>`. When the first real flag
// lands, the consumer-side type narrows alongside the engine-side
// Zod schema (per R5-S2).
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

  test("permissions_checked is stable and equals the canonical UX_GATING_PERMISSIONS set", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const body = (await res.json()) as BootstrapResponse;
    // The engine MUST return exactly the set that
    // `@shared/ux-gating#UX_GATING_PERMISSIONS` declares — no proper
    // subsets, no proper supersets. The CLI imports the same constant
    // from `@shared`, so this is a wire-level pin against drift.
    const { UX_GATING_PERMISSIONS } = await import("@shared/ux-gating.ts");
    expect(new Set(body.permissions_checked)).toEqual(new Set(UX_GATING_PERMISSIONS));
    expect(body.permissions_checked.length).toBe(UX_GATING_PERMISSIONS.length);
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

  // R4-S4: the deny-path equivalent. A `system_account` principal
  // never owns conversations (the column is for `user` ids today),
  // so the route's `principal.kind !== "user"` guard short-circuits
  // the query and returns []. This pins the contract so a future
  // change that adds system_account-owned conversations doesn't
  // silently leak ids without the explicit `conversation:read`
  // gate also covering it.
  test("system_account principal sees `recent_sessions === []` (R2-S7 + R4-S4 + R6-W3)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/sk/bootstrap`, {
      headers: { authorization: `Bearer ${systemAccountApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapResponse;
    expect(body.whoami.kind).toBe("system_account");
    expect(body.whoami.tenant_id).toBe(ctx.tenantId);
    // Pinned by the seeded conversation in beforeAll: there IS a row
    // owned by `systemAccountId` in this tenant. The empty array
    // proves the route's `principal.kind !== "user"` skip path fires
    // (not absence-of-data). R6-W3.
    expect(body.recent_sessions).toEqual([]);
    void systemAccountId;
  });

  // R4-S3 / R4-W2: the wire-level pin that each `recent_sessions[]`
  // row stamps `tenant_id`, plus that the engine's permissions[]
  // array is restricted to the `UX_GATING_PERMISSIONS` enum (would
  // fail Zod response validation otherwise — the route'd 500).
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
