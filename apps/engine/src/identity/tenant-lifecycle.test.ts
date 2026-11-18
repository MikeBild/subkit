import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { AuditAction } from "../audit/index.ts";
import {
  apiKeys,
  auditLog,
  hostedTenantUsage,
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  portalTokens,
  sessions,
  tenants,
  userInvites,
  users,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import {
  createDeterministicClock,
  installClock,
  restoreClock,
} from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import type { BrowserMembershipContext } from "./browser-memberships.ts";
import { browserMembershipIdentity } from "./browser-memberships.ts";
import { assertTenantActive, provisionSelfServiceTenant } from "./self-service.ts";
import {
  requestOwnedTenantDeletion,
  restoreOwnedTenant,
  TenantLifecycleError,
} from "./tenant-lifecycle.ts";

let tdb: TestDb;
const clock = createDeterministicClock();
let previousClock: ReturnType<typeof installClock>;
const grace = 7 * 24 * 60 * 60 * 1000;

beforeAll(async () => {
  previousClock = installClock(clock);
  tdb = await createTestDb("tenant-lifecycle");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
});
afterAll(async () => {
  restoreClock(previousClock);
  await tdb.cleanup();
});

async function fixture(label: string) {
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: label,
      email: `${label}@example.test`,
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    tdb.db,
  );
  const expires = new Date(clock.now() + grace + 1000);
  const [session] = await tdb.db
    .insert(sessions)
    .values({
      tenant_id: owned.tenant.id,
      user_id: owned.membership.user_id,
      auth_identity_id: owned.identity.id,
      expires_at: expires,
      absolute_expires_at: expires,
      last_seen_at: new Date(clock.now()),
      token_sha256: createHash("sha256").update(`${label}-session`).digest("hex"),
    })
    .returning();
  if (!session) throw new Error("session fixture missing");
  await tdb.db.insert(apiKeys).values({
    tenant_id: owned.tenant.id,
    user_id: owned.membership.user_id,
    creator_kind: "user",
    creator_id: owned.membership.user_id,
    prefix: `${label}-api`,
    token_sha256: createHash("sha256").update(`${label}-api`).digest("hex"),
    scopes: [],
  });
  await tdb.db.insert(portalTokens).values({
    tenant_id: owned.tenant.id,
    enduser_ref: "recipient",
    prefix: `${label}-portal`,
    token_sha256: createHash("sha256").update(`${label}-portal`).digest("hex"),
    allowed_workflows: [],
    expires_at: expires,
  });
  await tdb.db.insert(userInvites).values({
    tenant_id: owned.tenant.id,
    user_id: owned.membership.user_id,
    prefix: `${label}-invite`,
    token_sha256: createHash("sha256").update(`${label}-invite`).digest("hex"),
    scopes: [],
    expires_at: expires,
  });
  const [grant] = await tdb.db
    .insert(mcpOauthGrants)
    .values({ tenant_id: owned.tenant.id, client_id: label, user_id: owned.membership.user_id })
    .returning();
  if (!grant) throw new Error("grant fixture missing");
  const oauth = {
    tenant_id: owned.tenant.id,
    client_id: label,
    user_id: owned.membership.user_id,
    grant_id: grant.id,
    scope: "mcp:read",
    expires_at: expires,
  };
  await tdb.db.insert(mcpOauthRefreshTokens).values({
    ...oauth,
    prefix: `${label}-refresh`,
    token_sha256: createHash("sha256").update(`${label}-refresh`).digest("hex"),
  });
  await tdb.db.insert(mcpOauthAccessTokens).values({
    ...oauth,
    prefix: `${label}-access`,
    token_sha256: createHash("sha256").update(`${label}-access`).digest("hex"),
  });
  await tdb.db.insert(mcpOauthAuthorizationCodes).values({
    tenant_id: owned.tenant.id,
    client_id: label,
    user_id: owned.membership.user_id,
    code_sha256: createHash("sha256").update(`${label}-code`).digest("hex"),
    code_challenge: "challenge",
    code_challenge_method: "S256",
    redirect_uri: "https://client.example.test/callback",
    scope: "mcp:read",
    expires_at: expires,
  });
  const browser: BrowserMembershipContext = {
    tenant_id: owned.tenant.id,
    user_id: owned.membership.user_id,
    session_id: session.id,
  };
  return { ...owned, browser, input: { ...browser, confirmation: owned.tenant.display_name } };
}

async function authorities(tenantId: string) {
  const result = await tdb.db.execute(sql`
    SELECT revoked_at AS invalidated_at FROM sessions WHERE tenant_id = ${tenantId}::uuid
    UNION ALL SELECT revoked_at FROM api_keys WHERE tenant_id = ${tenantId}::uuid
    UNION ALL SELECT revoked_at FROM portal_tokens WHERE tenant_id = ${tenantId}::uuid
    UNION ALL SELECT revoked_at FROM user_invites WHERE tenant_id = ${tenantId}::uuid
    UNION ALL SELECT revoked_at FROM mcp_oauth_grants WHERE tenant_id = ${tenantId}::uuid
    UNION ALL SELECT revoked_at FROM mcp_oauth_access_tokens WHERE tenant_id = ${tenantId}::uuid
    UNION ALL SELECT revoked_at FROM mcp_oauth_refresh_tokens WHERE tenant_id = ${tenantId}::uuid
    UNION ALL SELECT consumed_at FROM mcp_oauth_authorization_codes WHERE tenant_id = ${tenantId}::uuid
  `);
  return result.rows.map((row) => row.invalidated_at);
}

async function tenant(tenantId: string) {
  const [row] = await tdb.db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new Error("tenant fixture missing");
  return row;
}

test("owner deletion atomically revokes all authority and a restore never revives it", async () => {
  const own = await fixture("permanent-revocation");
  const other = await fixture("untouched-neighbor");
  const started = clock.now();
  const requested = await requestOwnedTenantDeletion(own.input, tdb.db);
  expect(requested.deletion_scheduled_for.getTime()).toBe(started + grace);
  expect((await tenant(own.tenant.id)).status).toBe("pending_deletion");
  await expect(assertTenantActive(own.tenant.id, tdb.db)).rejects.toThrow("tenant_unavailable");
  expect(await authorities(own.tenant.id)).toHaveLength(8);
  expect((await authorities(own.tenant.id)).every((value) => value !== null)).toBe(true);
  expect((await authorities(other.tenant.id)).every((value) => value === null)).toBe(true);
  clock.setTo(requested.deletion_scheduled_for.getTime() - 1);
  expect(await tdb.db.transaction((tx) => restoreOwnedTenant(own.identity.id, tx))).toEqual({
    tenant_id: own.tenant.id,
    status: "active",
  });
  expect((await tenant(own.tenant.id)).deletion_scheduled_for).toBeNull();
  await expect(assertTenantActive(own.tenant.id, tdb.db)).resolves.toBeUndefined();
  expect((await authorities(own.tenant.id)).every((value) => value !== null)).toBe(true);
  await expect(browserMembershipIdentity(own.browser, tdb.db)).rejects.toThrow(
    "membership_unavailable",
  );
});

test("transaction rollback leaves the tenant, authorities and audit unchanged", async () => {
  const own = await fixture("atomic-rollback");
  await expect(
    tdb.db.transaction(async (tx) => {
      await requestOwnedTenantDeletion(own.input, tx);
      throw new Error("force rollback");
    }),
  ).rejects.toThrow("force rollback");
  expect((await tenant(own.tenant.id)).status).toBe("active");
  expect((await authorities(own.tenant.id)).every((value) => value === null)).toBe(true);
  const audit = await tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, own.tenant.id),
        eq(auditLog.action, AuditAction.TENANT_DELETION_REQUESTED),
      ),
    );
  expect(audit).toHaveLength(0);
});

test("simultaneous deletion requests have one effect and one audit entry", async () => {
  const own = await fixture("parallel-delete");
  const outcomes = await Promise.allSettled([
    requestOwnedTenantDeletion(own.input, tdb.db),
    requestOwnedTenantDeletion(own.input, tdb.db),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const audit = await tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, own.tenant.id),
        eq(auditLog.action, AuditAction.TENANT_DELETION_REQUESTED),
      ),
    );
  expect(audit).toHaveLength(1);
});

test("cross-tenant sessions, nonowners and an incorrect name cannot delete", async () => {
  const own = await fixture("owner-check");
  const visitor = await fixture("visitor-check");
  await expect(
    requestOwnedTenantDeletion({ ...own.input, confirmation: "wrong name" }, tdb.db),
  ).rejects.toMatchObject({ code: "tenant_confirmation_mismatch" });
  await expect(
    requestOwnedTenantDeletion(
      { ...own.input, user_id: visitor.browser.user_id, session_id: visitor.browser.session_id },
      tdb.db,
    ),
  ).rejects.toThrow("membership_unavailable");
  const [membership] = await tdb.db
    .insert(users)
    .values({
      tenant_id: own.tenant.id,
      auth_identity_id: visitor.identity.id,
      email: "visitor@example.test",
      role_id: await builtinRoleId(tdb.db, "admin"),
    })
    .returning();
  if (!membership) throw new Error("membership fixture missing");
  const expires = new Date(clock.now() + 60000);
  const [session] = await tdb.db
    .insert(sessions)
    .values({
      tenant_id: own.tenant.id,
      user_id: membership.id,
      auth_identity_id: visitor.identity.id,
      expires_at: expires,
      absolute_expires_at: expires,
      last_seen_at: new Date(clock.now()),
    })
    .returning();
  if (!session) throw new Error("session fixture missing");
  await expect(
    requestOwnedTenantDeletion(
      { ...own.input, user_id: membership.id, session_id: session.id },
      tdb.db,
    ),
  ).rejects.toBeInstanceOf(TenantLifecycleError);
  expect((await tenant(own.tenant.id)).status).toBe("active");
});

test("restore fails exactly at the deadline and for another identity", async () => {
  const own = await fixture("expiry-boundary");
  const other = await fixture("other-restore-identity");
  const requested = await requestOwnedTenantDeletion(own.input, tdb.db);
  await expect(
    tdb.db.transaction((tx) => restoreOwnedTenant(other.identity.id, tx)),
  ).rejects.toThrow("tenant_restore_unavailable");
  clock.setTo(requested.deletion_scheduled_for.getTime());
  await expect(tdb.db.transaction((tx) => restoreOwnedTenant(own.identity.id, tx))).rejects.toThrow(
    "tenant_restore_unavailable",
  );
  expect((await tenant(own.tenant.id)).status).toBe("pending_deletion");
});

test("expired, idle and revoked browser proofs cannot request deletion", async () => {
  const expired = await fixture("expired-browser-proof");
  await tdb.db
    .update(sessions)
    .set({ absolute_expires_at: new Date(clock.now()) })
    .where(eq(sessions.id, expired.browser.session_id));
  await expect(requestOwnedTenantDeletion(expired.input, tdb.db)).rejects.toThrow(
    "membership_unavailable",
  );
  expect((await tenant(expired.tenant.id)).status).toBe("active");
  const idle = await fixture("idle-browser-proof");
  await tdb.db
    .update(sessions)
    .set({ last_seen_at: new Date(clock.now() - 8 * 60 * 60 * 1000 - 1) })
    .where(eq(sessions.id, idle.browser.session_id));
  await expect(requestOwnedTenantDeletion(idle.input, tdb.db)).rejects.toThrow(
    "membership_unavailable",
  );
  expect((await tenant(idle.tenant.id)).status).toBe("active");
  const revoked = await fixture("revoked-browser-proof");
  await tdb.db
    .update(sessions)
    .set({ revoked_at: new Date(clock.now()) })
    .where(eq(sessions.id, revoked.browser.session_id));
  await expect(requestOwnedTenantDeletion(revoked.input, tdb.db)).rejects.toThrow(
    "membership_unavailable",
  );
  expect((await tenant(revoked.tenant.id)).status).toBe("active");
});

test("simultaneous restore operations produce one state change", async () => {
  const own = await fixture("parallel-restore");
  await requestOwnedTenantDeletion(own.input, tdb.db);
  const outcomes = await Promise.allSettled([
    tdb.db.transaction((tx) => restoreOwnedTenant(own.identity.id, tx)),
    tdb.db.transaction((tx) => restoreOwnedTenant(own.identity.id, tx)),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const audit = await tdb.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, own.tenant.id), eq(auditLog.action, AuditAction.TENANT_RESTORED)),
    );
  expect(audit).toHaveLength(1);
  expect((await authorities(own.tenant.id)).every((value) => value !== null)).toBe(true);
});

test("a full content allowance never prevents owner deletion or verified restoration", async () => {
  const own = await fixture("full-content-lifecycle");
  const [usage] = await tdb.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, own.tenant.id));
  await tdb.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${usage!.logical_bytes.toString()}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  try {
    await requestOwnedTenantDeletion(own.input, tdb.db);
    expect((await tenant(own.tenant.id)).status).toBe("pending_deletion");
    await tdb.db.transaction((tx) => restoreOwnedTenant(own.identity.id, tx));
    expect((await tenant(own.tenant.id)).status).toBe("active");
    expect((await authorities(own.tenant.id)).every((value) => value !== null)).toBe(true);
    const [after] = await tdb.db
      .select()
      .from(hostedTenantUsage)
      .where(eq(hostedTenantUsage.tenant_id, own.tenant.id));
    expect(after?.logical_bytes).toBe(usage?.logical_bytes);
  } finally {
    await tdb.db.execute(
      sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}','"50000000"'::jsonb) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
    );
  }
});
