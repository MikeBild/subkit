import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
} from "../../db/schema/mcp_oauth.ts";
import { builtinRoleId, createRole } from "../../rbac/roles.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;
let priorBaseUrl = "";
let memberApiKey = "";
const PAST_DATE = new Date("2000-01-01T00:00:00.000Z");
const FUTURE_DATE = new Date("2099-01-01T00:00:00.000Z");

beforeAll(async () => {
  ctx = await createHttpTestServer("oauth-clients-admin");
  const { getConfig } = await import("../../config/loader.ts");
  priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", "https://test.example.com", { force: true });

  const noopRole = await createRole(ctx.db, ctx.tenantId, "noop-oauth-clients", "no permissions");
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-oauth-clients@test.local",
      role_id: noopRole.id,
    })
    .returning();
  if (!member) throw new Error("seed member failed");

  const rand = createHash("sha256").update("member-oauth-clients-seed").digest("hex").slice(0, 32);
  memberApiKey = `wf_live_${rand}`;
  const memberPrefix = memberApiKey.slice(0, 12);
  const memberHash = createHash("sha256").update(memberApiKey).digest("hex");
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: memberPrefix,
    token_sha256: memberHash,
    scopes: ["*"],
  });
}, 30_000);

afterAll(async () => {
  await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  await ctx.cleanup();
}, 30_000);

async function seedClient(clientId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(mcpOauthClients)
    .values({
      client_id: clientId,
      redirect_uris: ["https://example.com/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "mcp:read",
      client_name: `Test Client ${clientId}`,
      registration_source: "dcr",
    })
    .returning({ id: mcpOauthClients.id });
  if (!row) throw new Error(`seed client ${clientId} failed`);
  return row.id;
}

let personSeq = 0;
async function seedPerson(): Promise<{ id: string; email: string }> {
  const email = `approver-${++personSeq}@test.local`;
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id: await builtinRoleId(ctx.db, "admin") })
    .returning({ id: users.id, email: users.email });
  if (!row) throw new Error("seed person failed");
  return row;
}

let tokenSeq = 0;
async function seedApprovedConnection(
  clientId: string,
  userId: string,
  state: "live" | "revoked" | "expired" = "live",
): Promise<void> {
  const expiresAt = state === "expired" ? PAST_DATE : FUTURE_DATE;
  const revokedAt = state === "revoked" ? PAST_DATE : null;
  const n = ++tokenSeq;
  await ctx.db.insert(mcpOauthAccessTokens).values({
    tenant_id: ctx.tenantId,
    client_id: clientId,
    user_id: userId,
    prefix: `wf_mcp_a${n}`,
    token_sha256: createHash("sha256").update(`access-${clientId}-${userId}-${n}`).digest("hex"),
    scope: "mcp:read",
    expires_at: expiresAt,
    revoked_at: revokedAt,
  });
  await ctx.db.insert(mcpOauthRefreshTokens).values({
    tenant_id: ctx.tenantId,
    client_id: clientId,
    user_id: userId,
    prefix: `wf_mcr_r${n}`,
    token_sha256: createHash("sha256").update(`refresh-${clientId}-${userId}-${n}`).digest("hex"),
    scope: "mcp:read",
    expires_at: expiresAt,
    revoked_at: revokedAt,
  });
}

async function listClients(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients`, { headers: authHeader() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  return body.items;
}

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

function memberAuthHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${memberApiKey}` };
}

describe("GET /v1/oauth/clients", () => {
  test("reports latest recorded token use, including ended connections, without inventing activity", async () => {
    const clientId = "last-activity-client";
    const unusedClient = "unused-activity-client";
    await seedClient(clientId);
    await seedClient(unusedClient);
    const earlier = await seedPerson();
    const later = await seedPerson();
    await seedApprovedConnection(clientId, earlier.id);
    await seedApprovedConnection(clientId, later.id, "revoked");
    for (const [userId, offset] of [
      [earlier.id, -1000],
      [later.id, 0],
    ] as const) {
      await ctx.db
        .update(mcpOauthAccessTokens)
        .set({ last_used_at: new Date(FROZEN_NOW + offset) })
        .where(
          and(
            eq(mcpOauthAccessTokens.tenant_id, ctx.tenantId),
            eq(mcpOauthAccessTokens.client_id, clientId),
            eq(mcpOauthAccessTokens.user_id, userId),
          ),
        );
    }
    const clients = await listClients();
    expect(clients.find((client) => client.client_id === clientId)?.last_used_at).toBe(
      new Date(FROZEN_NOW).toISOString(),
    );
    expect(clients.find((client) => client.client_id === unusedClient)?.last_used_at).toBeNull();
  });

  test("returns 401 without auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients`);
    expect(res.status).toBe(401);
  });

  test("returns 403 for a member-role principal", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients`, {
      headers: memberAuthHeader(),
    });
    expect(res.status).toBe(403);
  });

  test("lists registered clients for an admin principal", async () => {
    const clientId = "list-test-client-aaa111";
    await seedClient(clientId);

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients`, {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(Array.isArray(body.items)).toBe(true);
    const found = body.items.find((i) => i.client_id === clientId);
    expect(found).toBeDefined();
    expect(typeof found?.id).toBe("string");
    expect(found?.client_name).toBe(`Test Client ${clientId}`);
    expect(found?.client_secret).toBeUndefined();
    expect(found?.token_sha256).toBeUndefined();
  });

  test("names the people whose approval keeps a client connected", async () => {
    const clientId = "approved-by-client-bbb222";
    await seedClient(clientId);
    const first = await seedPerson();
    const second = await seedPerson();
    await seedApprovedConnection(clientId, first.id);
    await seedApprovedConnection(clientId, second.id);

    const found = (await listClients()).find((i) => i.client_id === clientId);
    expect(found).toBeDefined();
    expect(found?.approved_by).toEqual([first.email, second.email].sort());
    expect(found?.live_connections).toBe(2);
  });

  test("a client nobody has approved reports no approver and no connection", async () => {
    const clientId = "unapproved-client-ccc333";
    await seedClient(clientId);

    const found = (await listClients()).find((i) => i.client_id === clientId);
    expect(found?.approved_by).toEqual([]);
    expect(found?.live_connections).toBe(0);
  });

  test("a revoked or expired grant is not an approval", async () => {
    const clientId = "dead-grant-client-ddd444";
    await seedClient(clientId);
    const revoked = await seedPerson();
    const expired = await seedPerson();
    await seedApprovedConnection(clientId, revoked.id, "revoked");
    await seedApprovedConnection(clientId, expired.id, "expired");

    const found = (await listClients()).find((i) => i.client_id === clientId);
    expect(found?.approved_by).toEqual([]);
    expect(found?.live_connections).toBe(0);
  });

  test("reports the tenant user and timestamp for a known OAuth grant", async () => {
    const clientId = "connected-by-client-fff666";
    await seedClient(clientId);
    const [person] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "connected-by@example.test",
        display_name: "Connected By",
        role_id: await builtinRoleId(ctx.db, "admin"),
      })
      .returning({ id: users.id, email: users.email, display_name: users.display_name });
    if (!person) throw new Error("seed connected-by person failed");
    const connectedAt = new Date("2026-10-10T09:00:00.000Z");
    const [grant] = await ctx.db
      .insert(mcpOauthGrants)
      .values({
        tenant_id: ctx.tenantId,
        client_id: clientId,
        user_id: person.id,
        connected_at: connectedAt,
      })
      .returning({ id: mcpOauthGrants.id });
    if (!grant) throw new Error("seed OAuth grant failed");
    const [access] = await ctx.db
      .insert(mcpOauthAccessTokens)
      .values({
        tenant_id: ctx.tenantId,
        client_id: clientId,
        user_id: person.id,
        grant_id: grant.id,
        prefix: "wf_mcp_known",
        token_sha256: createHash("sha256").update("known-grant-access").digest("hex"),
        scope: "mcp:read",
        expires_at: FUTURE_DATE,
      })
      .returning({ id: mcpOauthAccessTokens.id });
    expect(access).toBeDefined();

    const found = (await listClients()).find((i) => i.client_id === clientId);
    expect(found?.connected_by).toEqual({
      grants: [
        {
          user_id: person.id,
          display_name: person.display_name,
          email: person.email,
          connected_at: connectedAt.toISOString(),
          revoked_at: null,
        },
      ],
      has_unknown_legacy: false,
    });
  });

  test("marks legacy OAuth rows unknown without attributing them to a user", async () => {
    const clientId = "connected-by-unknown-client-ggg777";
    await seedClient(clientId);
    const person = await seedPerson();
    await seedApprovedConnection(clientId, person.id);

    const found = (await listClients()).find((i) => i.client_id === clientId);
    expect(found?.connected_by).toEqual({ grants: [], has_unknown_legacy: true });
  });

  test("does not return another tenant's OAuth identities or activity", async () => {
    const clientId = "connected-by-tenant-isolation-client-hhh888";
    await seedClient(clientId);
    const ownUser = await seedPerson();
    const connectedAt = new Date("2026-10-10T09:00:00.000Z");
    const [ownGrant] = await ctx.db
      .insert(mcpOauthGrants)
      .values({
        tenant_id: ctx.tenantId,
        client_id: clientId,
        user_id: ownUser.id,
        connected_at: connectedAt,
      })
      .returning({ id: mcpOauthGrants.id });
    if (!ownGrant) throw new Error("seed own OAuth grant failed");

    const otherTenant = await seedTenant(ctx.db, {
      slug: "oauth-other-tenant",
      display_name: "Other OAuth tenant",
    });
    const [otherUser] = await ctx.db
      .insert(users)
      .values({
        tenant_id: otherTenant.id,
        email: "private-other-tenant@example.test",
        display_name: "Private Other Tenant",
        role_id: await builtinRoleId(ctx.db, "admin"),
      })
      .returning({ id: users.id });
    if (!otherUser) throw new Error("seed other OAuth user failed");
    await ctx.db.insert(mcpOauthGrants).values({
      tenant_id: otherTenant.id,
      client_id: clientId,
      user_id: otherUser.id,
      connected_at: new Date("2026-10-10T10:00:00.000Z"),
    });
    await ctx.db.insert(mcpOauthUnknownGrants).values({
      tenant_id: otherTenant.id,
      client_id: clientId,
    });
    await ctx.db.insert(mcpOauthAccessTokens).values({
      tenant_id: ctx.tenantId,
      client_id: clientId,
      user_id: ownUser.id,
      grant_id: ownGrant.id,
      prefix: "wf_mcp_own",
      token_sha256: createHash("sha256").update("own-tenant-token").digest("hex"),
      scope: "mcp:read",
      expires_at: FUTURE_DATE,
      last_used_at: new Date(FROZEN_NOW - 1_000),
    });
    await ctx.db.insert(mcpOauthAccessTokens).values({
      tenant_id: otherTenant.id,
      client_id: clientId,
      user_id: otherUser.id,
      prefix: "wf_mcp_other",
      token_sha256: createHash("sha256").update("other-tenant-token").digest("hex"),
      scope: "mcp:read",
      expires_at: FUTURE_DATE,
      last_used_at: new Date(FROZEN_NOW),
    });

    const found = (await listClients()).find((i) => i.client_id === clientId);
    expect(found?.connected_by).toEqual({
      grants: [
        {
          user_id: ownUser.id,
          display_name: null,
          email: ownUser.email,
          connected_at: connectedAt.toISOString(),
          revoked_at: null,
        },
      ],
      has_unknown_legacy: false,
    });
    expect(found?.approved_by).toEqual([ownUser.email]);
    expect(found?.last_used_at).toBe(new Date(FROZEN_NOW - 1_000).toISOString());
    expect(JSON.stringify(found)).not.toContain("private-other-tenant@example.test");
    expect(JSON.stringify(found)).not.toContain(otherUser.id);
  });
});

describe("DELETE /v1/oauth/clients/{client_id}", () => {
  test("returns 401 without auth", async () => {
    const clientId = "delete-no-auth-bbb222";
    await seedClient(clientId);

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for a member-role principal", async () => {
    const clientId = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    await seedClient(clientId);

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: memberAuthHeader(),
    });
    expect(res.status).toBe(403);
  });

  test("returns 404 for unknown client_id", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients/nonexistent-client-id`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res.status).toBe(404);
  });

  test("the engine operator soft-disables a known client engine-wide", async () => {
    const clientId = "disable-test-client-ccc333";
    await seedClient(clientId);

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { effect: string }).effect).toBe("client_disabled");

    const rows = await ctx.db
      .select({ disabled_at: mcpOauthClients.disabled_at })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, clientId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.disabled_at).not.toBeNull();
  });

  test("global client revocation ends OAuth grants and tokens in every tenant", async () => {
    const clientId = "global-revoke-client-iii999";
    await seedClient(clientId);
    const otherTenant = await seedTenant(ctx.db, {
      slug: "oauth-revoke-other-tenant",
      display_name: "Other revoke tenant",
    });
    const otherRoleId = await builtinRoleId(ctx.db, "admin");
    const [otherUser] = await ctx.db
      .insert(users)
      .values({
        tenant_id: otherTenant.id,
        email: "global-revoke-other@example.test",
        role_id: otherRoleId,
      })
      .returning({ id: users.id });
    if (!otherUser) throw new Error("seed other tenant user failed");
    const ownUser = await seedPerson();
    const grants = await ctx.db
      .insert(mcpOauthGrants)
      .values([
        { tenant_id: ctx.tenantId, client_id: clientId, user_id: ownUser.id },
        { tenant_id: otherTenant.id, client_id: clientId, user_id: otherUser.id },
      ])
      .returning({ id: mcpOauthGrants.id, tenant_id: mcpOauthGrants.tenant_id });
    const ownGrant = grants.find((grant) => grant.tenant_id === ctx.tenantId);
    const otherGrant = grants.find((grant) => grant.tenant_id === otherTenant.id);
    if (!ownGrant || !otherGrant) throw new Error("seed cross-tenant grants failed");
    for (const [tenant_id, user_id, grant_id, suffix] of [
      [ctx.tenantId, ownUser.id, ownGrant.id, "own"],
      [otherTenant.id, otherUser.id, otherGrant.id, "other"],
    ] as const) {
      await ctx.db.insert(mcpOauthAccessTokens).values({
        tenant_id,
        client_id: clientId,
        user_id,
        grant_id,
        prefix: `wf_mcp_${suffix}`,
        token_sha256: createHash("sha256").update(`global-revoke-access-${suffix}`).digest("hex"),
        scope: "mcp:read",
        expires_at: FUTURE_DATE,
      });
    }

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { effect: string }).effect).toBe("client_disabled");
    const revokedGrants = await ctx.db
      .select({ tenant_id: mcpOauthGrants.tenant_id, revoked_at: mcpOauthGrants.revoked_at })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.client_id, clientId));
    expect(revokedGrants).toHaveLength(2);
    expect(revokedGrants.every((grant) => grant.revoked_at !== null)).toBe(true);
    const revokedTokens = await ctx.db
      .select({
        tenant_id: mcpOauthAccessTokens.tenant_id,
        revoked_at: mcpOauthAccessTokens.revoked_at,
      })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.client_id, clientId));
    expect(revokedTokens).toHaveLength(2);
    expect(revokedTokens.every((token) => token.revoked_at !== null)).toBe(true);
  });

  test("is idempotent — second DELETE still reports the client disabled", async () => {
    const clientId = "idempotent-disable-ddd444";
    await seedClient(clientId);

    const res1 = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { effect: string }).effect).toBe("client_disabled");
  });

  test("disabled client is rejected by GET /v1/oauth/authorize", async () => {
    const clientId = "disabled-auth-test-eee555";
    await seedClient(clientId);

    const del = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(del.status).toBe(200);

    const res = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?client_id=${clientId}&redirect_uri=https://example.com/callback&response_type=code&code_challenge=abc&code_challenge_method=S256`,
      { redirect: "manual", headers: { accept: "application/json" } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });
});
