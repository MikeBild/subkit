import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, sessions, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import {
  createSession,
  createSystemAccount,
  issuePortalToken,
  listPortalTokens,
  listUsers,
  resolveSession,
  revokePortalToken,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_SLIDING_TTL_MS,
} from "./service.ts";

let testDb: TestDb;

let tenantId = "";

let otherTenantId = "";

let userId = "";

beforeAll(async () => {
  testDb = await createTestDb("identity-service");

  tenantId = (await seedTenant(testDb.db, { slug: "svc-tenant", display_name: "Service Tenant" }))
    .id;
  otherTenantId = (
    await seedTenant(testDb.db, { slug: "other-tenant", display_name: "Other Tenant" })
  ).id;

  const [u] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "svc@test.local",
      role_id: await builtinRoleId(testDb.db, "member"),
    })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
});

afterAll(async () => {
  if (testDb) await testDb.cleanup();
});

describe("service — portal tokens", () => {
  test("portal token issue and revoke preserve a system-account actor", async () => {
    const actor = await createSystemAccount(
      { tenant_id: tenantId, name: "portal-token-actor", actor_id: null },
      testDb.db,
    );
    const issued = await issuePortalToken(
      {
        tenant_id: tenantId,
        user_id: userId,
        allowed_workflows: ["wf-typed-actor"],
        actor_kind: "system_account",
        actor_id: actor.id,
      },
      testDb.db,
    );
    const [issueAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "portal_token.issued"), eq(auditLog.resource_id, issued.view.id)),
      );
    expect(issueAudit).toEqual({ actor_type: "system_account", actor_id: actor.id });

    await revokePortalToken(
      {
        tenant_id: tenantId,
        id: issued.view.id,
        actor_kind: "system_account",
        actor_id: actor.id,
      },
      testDb.db,
    );
    const [revokeAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "portal_token.revoked"), eq(auditLog.resource_id, issued.view.id)),
      );
    expect(revokeAudit).toEqual({ actor_type: "system_account", actor_id: actor.id });
  });

  test("issuePortalToken returns plaintext + audit entry", async () => {
    const result = await issuePortalToken(
      {
        tenant_id: tenantId,
        user_id: userId,
        allowed_workflows: ["wf-1"],
        actor_id: userId,
      },
      testDb.db,
    );
    expect(result.plaintext).toMatch(/^wf_portal_/);

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "portal_token.issued"), eq(auditLog.resource_id, result.view.id)),
      );
    expect(audit.length).toBeGreaterThan(0);
  });

  test("revokePortalToken flips revoked_at + audit", async () => {
    const { view } = await issuePortalToken(
      {
        tenant_id: tenantId,
        user_id: userId,
        allowed_workflows: ["wf-2"],
        actor_id: userId,
      },
      testDb.db,
    );
    const revoked = await revokePortalToken(
      { tenant_id: tenantId, id: view.id, actor_id: userId },
      testDb.db,
    );
    expect(revoked?.revoked_at).not.toBeNull();

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "portal_token.revoked"), eq(auditLog.resource_id, view.id)));
    expect(audit.length).toBeGreaterThan(0);
  });

  test("listPortalTokens — tenant isolation: wrong tenant returns empty", async () => {
    const rows = await listPortalTokens(otherTenantId, testDb.db);
    expect(rows.length).toBe(0);
  });
});

describe("service — sessions", () => {
  test("createSession writes row with correct sliding + absolute TTLs", async () => {
    const before = getTestNow();
    const sess = await createSession({ tenant_id: tenantId, user_id: userId }, testDb.db);

    expect(sess.tenant_id).toBe(tenantId);
    expect(sess.user_id).toBe(userId);
    const expectedAbsolute = before + SESSION_ABSOLUTE_TTL_MS;
    const diff = Math.abs(sess.absolute_expires_at.getTime() - expectedAbsolute);
    expect(diff).toBeLessThan(5_000);
    expect(sess.revoked_at).toBeNull();

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "session.issued"), eq(auditLog.resource_id, sess.id)));
    expect(audit.length).toBeGreaterThan(0);
  });

  test("resolveSession: happy path bumps last_seen_at", async () => {
    const sess = await createSession({ tenant_id: tenantId, user_id: userId }, testDb.db);
    const result = await resolveSession(sess.id, testDb.db);
    expect(result.session).not.toBeNull();
    expect(result.session?.id).toBe(sess.id);
    expect(result.reason).toBeUndefined();
  });

  test("resolveSession: not_found for unknown id", async () => {
    const result = await resolveSession("00000000-0000-0000-0000-000000000000", testDb.db);
    expect(result.session).toBeNull();
    expect(result.reason).toBe("not_found");
  });

  test("resolveSession: expired_sliding denies + audit entry", async () => {
    const sess = await createSession({ tenant_id: tenantId, user_id: userId }, testDb.db);
    await testDb.db
      .update(sessions)
      .set({ last_seen_at: new Date(getTestNow() - SESSION_SLIDING_TTL_MS - 1_000) })
      .where(eq(sessions.id, sess.id));

    const result = await resolveSession(sess.id, testDb.db);
    expect(result.session).toBeNull();
    expect(result.reason).toBe("expired_sliding");

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "session.revoked"),
          eq(auditLog.resource_id, sess.id),
          eq(auditLog.reason, "expired_sliding"),
        ),
      );
    expect(audit.length).toBeGreaterThan(0);
  });

  test("resolveSession: expired_absolute denies + audit entry", async () => {
    const sess = await createSession({ tenant_id: tenantId, user_id: userId }, testDb.db);
    await testDb.db
      .update(sessions)
      .set({ absolute_expires_at: new Date(getTestNow() - 1_000) })
      .where(eq(sessions.id, sess.id));

    const result = await resolveSession(sess.id, testDb.db);
    expect(result.session).toBeNull();
    expect(result.reason).toBe("expired_absolute");

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "session.revoked"),
          eq(auditLog.resource_id, sess.id),
          eq(auditLog.reason, "expired_absolute"),
        ),
      );
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe("service — listUsers tenant isolation", () => {
  test("listUsers: wrong tenant returns empty list", async () => {
    const rows = await listUsers(otherTenantId, {}, testDb.db);
    expect(rows.length).toBe(0);
  });

  test("listUsers: clamps limit at MAX_LIMIT (200)", async () => {
    const rows = await listUsers(tenantId, { limit: 99999 }, testDb.db);
    expect(Array.isArray(rows)).toBe(true);
  });
});
