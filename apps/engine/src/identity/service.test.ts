import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { type MockOidcHandle, startMockOidc } from "../auth/providers/tests/fixtures/mock-oidc.ts";
import {
  apiKeys,
  auditLog,
  roles,
  sessions,
  tenants,
  userIdentities,
  users,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import {
  createHttpTestServer,
  type HttpTestServer,
  loadAuthProvidersForTest,
} from "../http/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { flushDiscoveryCache } from "./oidc-discovery.ts";
import {
  createSession,
  createSystemAccount,
  deleteSystemAccount,
  getApiKey,
  issueApiKey,
  issueCliOAuthSessionApiKey,
  issuePortalToken,
  listApiKeys,
  listPortalTokens,
  listSystemAccounts,
  listUsers,
  resolveSession,
  revokeApiKey,
  revokePortalToken,
  rotateApiKey,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_SLIDING_TTL_MS,
  updateUser,
} from "./service.ts";

let testDb: TestDb;
let tenantId = "";
let otherTenantId = "";
let userId = "";
const nextAuditId = createDeterministicUuidFactory(0x617564);

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

describe("service — user roles", () => {
  test("changing the built-in role by name sets its role_id", async () => {
    const builtinRoles = await testDb.db
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(isNull(roles.tenant_id));
    const memberRole = builtinRoles.find((role) => role.name === "member");
    const adminRole = builtinRoles.find((role) => role.name === "admin");
    if (!memberRole || !adminRole) throw new Error("built-in roles were not seeded");

    const [target] = await testDb.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "role-sync@test.local",
        role_id: memberRole.id,
      })
      .returning();
    if (!target) throw new Error("seed role-sync user failed");

    const updated = await updateUser(
      { tenant_id: tenantId, id: target.id, role: "admin", actor_id: userId },
      testDb.db,
    );

    expect(updated?.role_id).toBe(adminRole.id);

    const [audit] = await testDb.db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.role_changed"), eq(auditLog.resource_id, target.id)))
      .limit(1);
    expect(audit?.before).toEqual({ role_id: memberRole.id });
    expect(audit?.after).toEqual({ role_id: adminRole.id });
  });
});

describe("service — system accounts", () => {
  test("createSystemAccount writes a row + audit entry", async () => {
    const row = await createSystemAccount(
      { tenant_id: tenantId, name: "bot-1", actor_id: userId },
      testDb.db,
    );
    expect(row.name).toBe("bot-1");
    expect(row.tenant_id).toBe(tenantId);

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "system_account.created"), eq(auditLog.resource_id, row.id)));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]?.actor_type).toBe("unknown");
    expect(audit[0]?.actor_id).toBeNull();
  });

  test("attributes an actorless internal creation to the system", async () => {
    const row = await createSystemAccount(
      { tenant_id: tenantId, name: "internal-bot", actor_id: null },
      testDb.db,
    );
    const [audit] = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "system_account.created"), eq(auditLog.resource_id, row.id)));
    expect(audit?.actor_type).toBe("system");
    expect(audit?.actor_id).toBeNull();
  });

  test("listSystemAccounts — tenant isolation: wrong tenant returns empty", async () => {
    const rows = await listSystemAccounts(otherTenantId, {}, testDb.db);
    expect(rows.length).toBe(0);
  });

  test("deleteSystemAccount soft-deletes + audit entry", async () => {
    const created = await createSystemAccount(
      { tenant_id: tenantId, name: "bot-to-delete", actor_id: userId },
      testDb.db,
    );
    const deleted = await deleteSystemAccount(
      { tenant_id: tenantId, id: created.id, actor_id: userId },
      testDb.db,
    );
    expect(deleted).not.toBeNull();

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "system_account.deleted"), eq(auditLog.resource_id, created.id)),
      );
    expect(audit.length).toBeGreaterThan(0);

    const remaining = await listSystemAccounts(tenantId, {}, testDb.db);
    expect(remaining.find((r) => r.id === created.id)).toBeUndefined();
  });
});

describe("service — api keys", () => {
  test("ordinary keys have no CLI credential origin and the field cannot be backfilled", async () => {
    const issued = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "user", id: userId },
      },
      testDb.db,
    );
    const [stored] = await testDb.db
      .select({ credential_origin: apiKeys.credential_origin })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, tenantId), eq(apiKeys.id, issued.view.id)));
    expect(stored?.credential_origin).toBeNull();
    await expect(
      testDb.db
        .update(apiKeys)
        .set({ credential_origin: "cli_oauth_session" })
        .where(and(eq(apiKeys.tenant_id, tenantId), eq(apiKeys.id, issued.view.id)))
        .execute(),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  test("rotation preserves a CLI session credential origin", async () => {
    const issued = await issueCliOAuthSessionApiKey(
      {
        issuer: { kind: "login" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "user", id: userId },
      },
      testDb.db,
    );
    const rotated = await rotateApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        id: issued.view.id,
        actor: { kind: "user", id: userId },
      },
      testDb.db,
    );
    const rows = await testDb.db
      .select({ id: apiKeys.id, credential_origin: apiKeys.credential_origin })
      .from(apiKeys)
      .where(eq(apiKeys.tenant_id, tenantId));
    expect(rows.find((row) => row.id === issued.view.id)?.credential_origin).toBe(
      "cli_oauth_session",
    );
    expect(rows.find((row) => row.id === rotated?.new.id)?.credential_origin).toBe(
      "cli_oauth_session",
    );
  });

  test("issueApiKey returns plaintext + writes audit entry", async () => {
    const result = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor_id: userId,
      },
      testDb.db,
    );
    expect(result.plaintext).toMatch(/^wf_live_/);
    expect(result.view.tenant_id).toBe(tenantId);

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "api_key.issued"), eq(auditLog.resource_id, result.view.id)));
    expect(audit.length).toBeGreaterThan(0);
  });

  test("API key creator provenance is typed independently from owner", async () => {
    const actor = await createSystemAccount(
      { tenant_id: tenantId, name: "key-creator", actor_id: userId },
      testDb.db,
    );
    const issued = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "system_account", id: actor.id },
      },
      testDb.db,
    );
    expect(issued.view).toMatchObject({
      user_id: userId,
      system_account_id: null,
      creator: { kind: "system_account", id: actor.id },
    });
    const issueAudit = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.issued"),
          eq(auditLog.resource_id, issued.view.id),
        ),
      );
    expect(issueAudit).toEqual([{ actor_type: "system_account", actor_id: actor.id }]);
  });

  test("system rows and untyped legacy calls retain distinct provenance semantics", async () => {
    const systemCreated = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "system", id: null },
      },
      testDb.db,
    );
    const legacy = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor_id: userId,
      },
      testDb.db,
    );
    const legacyIssueAudit = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.issued"),
          eq(auditLog.resource_id, legacy.view.id),
        ),
      );
    const nullActor = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: null,
      },
      testDb.db,
    );
    expect(systemCreated.view.creator).toEqual({ kind: "system", id: null });
    const rotated = await rotateApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        id: systemCreated.view.id,
        actor: { kind: "system", id: null },
      },
      testDb.db,
    );
    expect(rotated?.new.creator).toEqual({ kind: "system", id: null });
    const systemIssueAudit = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.issued"),
          eq(auditLog.resource_id, rotated?.new.id ?? ""),
        ),
      );
    expect(systemIssueAudit).toEqual([{ actor_type: "system", actor_id: null }]);
    const systemRotationAudit = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.rotated"),
          eq(auditLog.resource_id, systemCreated.view.id),
        ),
      );
    expect(systemRotationAudit).toEqual([{ actor_type: "system", actor_id: null }]);
    expect(legacy.view.creator).toBeNull();
    const legacyRotated = await rotateApiKey(
      { issuer: { kind: "system" }, tenant_id: tenantId, id: legacy.view.id, actor_id: userId },
      testDb.db,
    );
    expect(legacyRotated?.new.creator).toBeNull();
    const unknownIssueAudit = await testDb.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.issued"),
          eq(auditLog.resource_id, legacyRotated?.new.id ?? ""),
        ),
      );
    const unknownRotationAudit = await testDb.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.rotated"),
          eq(auditLog.resource_id, legacy.view.id),
        ),
      );
    expect(unknownIssueAudit).toEqual([
      { action: "api_key.issued", actor_type: "unknown", actor_id: null },
    ]);
    expect(unknownRotationAudit).toEqual([
      { action: "api_key.rotated", actor_type: "unknown", actor_id: null },
    ]);
    const nullActorAudit = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.issued"),
          eq(auditLog.resource_id, nullActor.view.id),
        ),
      );
    expect(nullActorAudit).toEqual([{ actor_type: "unknown", actor_id: null }]);
    expect(legacyIssueAudit).toEqual([{ actor_type: "unknown", actor_id: null }]);
  });

  test("unknown audit actors cannot carry an untyped identifier", async () => {
    await expect(
      testDb.db
        .insert(auditLog)
        .values({
          id: nextAuditId(),
          tenant_id: tenantId,
          actor_type: "unknown",
          actor_id: userId,
          action: "api_key.issued",
          resource_type: "api_key",
          result: "success",
        })
        .then((rows) => rows),
    ).rejects.toThrow();
  });

  test("API key creator identity requires a valid kind and matching id", async () => {
    const issued = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: null,
      },
      testDb.db,
    );
    await expect(
      testDb.db
        .update(apiKeys)
        .set({ creator_kind: "system", creator_id: userId })
        .where(eq(apiKeys.id, issued.view.id))
        .then((rows) => rows),
    ).rejects.toThrow();
  });

  test("typed API-key actors cannot disagree with a legacy actor ID", async () => {
    const account = await createSystemAccount(
      { tenant_id: tenantId, name: "conflict-actor", actor_id: userId },
      testDb.db,
    );
    await expect(
      issueApiKey(
        {
          issuer: { kind: "system" },
          tenant_id: tenantId,
          owner_kind: "user",
          owner_id: userId,
          actor: { kind: "system_account", id: account.id },
          actor_id: userId,
        },
        testDb.db,
      ),
    ).rejects.toThrow("api_key_actor_provenance_mismatch");

    const original = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "user", id: userId },
      },
      testDb.db,
    );
    await expect(
      rotateApiKey(
        {
          issuer: { kind: "system" },
          tenant_id: tenantId,
          id: original.view.id,
          actor: { kind: "system_account", id: account.id },
          actor_id: userId,
        },
        testDb.db,
      ),
    ).rejects.toThrow("api_key_actor_provenance_mismatch");
    expect(
      (await listApiKeys(tenantId, testDb.db)).some(
        (key) => key.rotated_from_id === original.view.id,
      ),
    ).toBe(false);
  });

  test("engine callers carry known actor types and leave untyped actor IDs unknown", async () => {
    const account = await createSystemAccount(
      { tenant_id: tenantId, name: "engine-key-creator", actor_id: userId },
      testDb.db,
    );
    const untyped = new EngineClient({ tenant_id: tenantId, actor_id: account.id, db: testDb.db });
    const unknown = await untyped.identity.issueApiKey({
      issuer: { kind: "system" },
      owner_kind: "user",
      owner_id: userId,
    });
    const typed = new EngineClient({
      tenant_id: tenantId,
      actor_id: account.id,
      actor_type: "system_account",
      db: testDb.db,
    });
    const userClient = new EngineClient({
      tenant_id: tenantId,
      actor_id: userId,
      actor_type: "user",
      db: testDb.db,
    });
    const systemWithId = new EngineClient({
      tenant_id: tenantId,
      actor_id: account.id,
      actor_type: "system",
      db: testDb.db,
    });
    const userWithoutId = new EngineClient({
      tenant_id: tenantId,
      actor_id: null,
      actor_type: "user",
      db: testDb.db,
    });
    expect(systemWithId.context).toMatchObject({ actor_type: "system", actor_id: null });
    expect(userWithoutId.context).toMatchObject({ actor_type: "unknown", actor_id: null });
    const systemAuditId = await systemWithId.audit_write({
      resource_type: "test",
      resource_id: "system-normalization",
      action: "actor.normalization.test",
      result: "success",
    });
    const missingPrincipalAuditId = await userWithoutId.audit_write({
      resource_type: "test",
      resource_id: "missing-principal-normalization",
      action: "actor.normalization.test",
      result: "success",
    });
    const normalizedAudits = await testDb.db
      .select({ id: auditLog.id, actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "actor.normalization.test")),
      );
    expect(normalizedAudits.find((entry) => entry.id === systemAuditId)).toEqual({
      id: systemAuditId,
      actor_type: "system",
      actor_id: null,
    });
    expect(normalizedAudits.find((entry) => entry.id === missingPrincipalAuditId)).toEqual({
      id: missingPrincipalAuditId,
      actor_type: "unknown",
      actor_id: null,
    });
    const known = await typed.identity.issueApiKey({
      issuer: { kind: "system" },
      owner_kind: "user",
      owner_id: userId,
    });
    expect(unknown.view.creator).toBeNull();
    expect(known.view.creator).toEqual({ kind: "system_account", id: account.id });
    await typed.identity.revokeApiKey(known.view.id);
    const [keyRevokeAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "api_key.revoked"), eq(auditLog.resource_id, known.view.id)));
    expect(keyRevokeAudit).toEqual({ actor_type: "system_account", actor_id: account.id });

    const portalToken = await issuePortalToken(
      {
        tenant_id: tenantId,
        user_id: userId,
        allowed_workflows: ["engine-client-actor-revoke"],
        actor_kind: "system_account",
        actor_id: account.id,
      },
      testDb.db,
    );
    await typed.identity.revokePortalToken(portalToken.view.id);
    const [portalRevokeAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "portal_token.revoked"),
          eq(auditLog.resource_id, portalToken.view.id),
        ),
      );
    expect(portalRevokeAudit).toEqual({ actor_type: "system_account", actor_id: account.id });

    const unknownSkill = await untyped.skills.create({
      scope: "global",
      title: "unknown-engine-actor-skill",
      body: "test",
    });
    const typedSkill = await typed.skills.create({
      scope: "global",
      title: "typed-engine-actor-skill",
      body: "test",
    });
    const userSkill = await userClient.skills.create({
      scope: "global",
      title: "user-engine-actor-skill",
      body: "test",
    });
    await typed.skills.update(typedSkill.id, { title: "typed-engine-actor-skill-updated" });
    await untyped.skills.delete(unknownSkill.id);
    const skillAudit = await testDb.db
      .select({
        action: auditLog.action,
        resource_id: auditLog.resource_id,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_type, "skill")));
    expect(
      skillAudit.find(
        (entry) => entry.action === "skill.created" && entry.resource_id === unknownSkill.id,
      ),
    ).toEqual({
      action: "skill.created",
      resource_id: unknownSkill.id,
      actor_type: "unknown",
      actor_id: null,
    });
    expect(
      skillAudit.find(
        (entry) => entry.action === "skill.created" && entry.resource_id === typedSkill.id,
      ),
    ).toEqual({
      action: "skill.created",
      resource_id: typedSkill.id,
      actor_type: "system_account",
      actor_id: account.id,
    });
    expect(
      skillAudit.find(
        (entry) => entry.action === "skill.created" && entry.resource_id === userSkill.id,
      ),
    ).toEqual({
      action: "skill.created",
      resource_id: userSkill.id,
      actor_type: "user",
      actor_id: userId,
    });
    expect(
      skillAudit.find(
        (entry) => entry.action === "skill.updated" && entry.resource_id === typedSkill.id,
      ),
    ).toMatchObject({ actor_type: "system_account", actor_id: account.id });
    expect(
      skillAudit.find(
        (entry) => entry.action === "skill.deleted" && entry.resource_id === unknownSkill.id,
      ),
    ).toMatchObject({ actor_type: "unknown", actor_id: null });
  });

  test("rotation records the rotating actor and preserves the key owner", async () => {
    const actor = await createSystemAccount(
      { tenant_id: tenantId, name: "rotation-actor", actor_id: userId },
      testDb.db,
    );
    const original = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "user", id: userId },
      },
      testDb.db,
    );
    const rotated = await rotateApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        id: original.view.id,
        actor: { kind: "system_account", id: actor.id },
      },
      testDb.db,
    );
    expect(rotated?.new).toMatchObject({
      user_id: userId,
      system_account_id: null,
      rotated_from_id: original.view.id,
      creator: { kind: "system_account", id: actor.id },
    });
    const rotatedIssueAudit = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.issued"),
          eq(auditLog.resource_id, rotated?.new.id ?? ""),
        ),
      );
    expect(rotatedIssueAudit).toEqual([{ actor_type: "system_account", actor_id: actor.id }]);
    const rotationAudit = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "api_key.rotated"),
          eq(auditLog.resource_id, original.view.id),
        ),
      );
    expect(rotationAudit).toEqual([{ actor_type: "system_account", actor_id: actor.id }]);
  });

  test("revokeApiKey flips revoked_at + audit", async () => {
    const { view } = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor_id: userId,
      },
      testDb.db,
    );
    const revoked = await revokeApiKey(
      { tenant_id: tenantId, id: view.id, actor_id: userId },
      testDb.db,
    );
    expect(revoked?.revoked_at).not.toBeNull();

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "api_key.revoked"), eq(auditLog.resource_id, view.id)));
    expect(audit.length).toBeGreaterThan(0);
  });

  test("revokeApiKey preserves a system-account actor and leaves untyped actors unknown", async () => {
    const actor = await createSystemAccount(
      { tenant_id: tenantId, name: "revoke-key-actor", actor_id: null },
      testDb.db,
    );
    const typed = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "system", id: null },
      },
      testDb.db,
    );
    await revokeApiKey(
      { tenant_id: tenantId, id: typed.view.id, actor_kind: "system_account", actor_id: actor.id },
      testDb.db,
    );
    const [typedAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "api_key.revoked"), eq(auditLog.resource_id, typed.view.id)));
    expect(typedAudit).toEqual({ actor_type: "system_account", actor_id: actor.id });

    const legacy = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "system", id: null },
      },
      testDb.db,
    );
    await revokeApiKey({ tenant_id: tenantId, id: legacy.view.id, actor_id: actor.id }, testDb.db);
    const [legacyAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "api_key.revoked"), eq(auditLog.resource_id, legacy.view.id)));
    expect(legacyAudit).toEqual({ actor_type: "unknown", actor_id: null });

    const missingId = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "system", id: null },
      },
      testDb.db,
    );
    await revokeApiKey(
      {
        tenant_id: tenantId,
        id: missingId.view.id,
        actor_kind: "system_account",
        actor_id: null,
      },
      testDb.db,
    );
    const [missingIdAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "api_key.revoked"), eq(auditLog.resource_id, missingId.view.id)),
      );
    expect(missingIdAudit).toEqual({ actor_type: "unknown", actor_id: null });
  });

  test("listApiKeys — tenant isolation: wrong tenant returns empty", async () => {
    const rows = await listApiKeys(otherTenantId, testDb.db);
    expect(rows.length).toBe(0);
  });

  test("creator references stay behind the API key tenant boundary", async () => {
    const foreignAccount = await createSystemAccount(
      { tenant_id: otherTenantId, name: "foreign-key-creator", actor_id: null },
      testDb.db,
    );
    const foreignKey = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: otherTenantId,
        owner_kind: "system_account",
        owner_id: foreignAccount.id,
        actor: { kind: "system_account", id: foreignAccount.id },
      },
      testDb.db,
    );
    expect(await getApiKey(tenantId, foreignKey.view.id, testDb.db)).toBeNull();
    expect(
      (await listApiKeys(tenantId, testDb.db)).some(
        (key) => key.creator?.kind === "system_account" && key.creator.id === foreignAccount.id,
      ),
    ).toBe(false);
  });
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

let httpCtx: HttpTestServer;
let mockOidc: MockOidcHandle;

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let mockKid: string;

beforeAll(async () => {
  httpCtx = await createHttpTestServer("identity-jit");
  mockOidc = await startMockOidc();

  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  mockKid = "test-key-1";
});

afterAll(async () => {
  flushDiscoveryCache();
  try {
    await loadAuthProvidersForTest(
      [{ protocol: "api_key", id: "api-key", label: "SubKit API key" }],
      httpCtx.testDb.url,
    );
  } catch {}
  try {
    await mockOidc?.stop();
  } catch {}
  if (httpCtx) await httpCtx.cleanup();
});

beforeAll(async () => {
  await httpCtx.db
    .insert(tenants)
    .values({ slug: "default", display_name: "Default" })
    .onConflictDoNothing()
    .returning();
});

afterEach(() => {
  flushDiscoveryCache();
});

async function postIdentitySession(identityToken: string) {
  return fetch(`${httpCtx.baseUrl}/v1/identity/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "test-identity", identity_token: identityToken }),
  });
}

async function configureOidc(issuerUrl: string): Promise<void> {
  await loadAuthProvidersForTest(
    [
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
      {
        protocol: "oidc",
        id: "test-identity",
        label: "Test identity",
        issuer_url: issuerUrl,
        client_id: issuerUrl === mockOidc.url ? "mock-client" : "subkit-cli",
        scopes: "openid profile email",
        tenant_slug: "default",
      },
    ],
    httpCtx.testDb.url,
  );
}

describe("JIT provisioning — happy path (scenario 3)", () => {
  test("valid id_token creates user row + issues API key + audit entries", async () => {
    const provider = mockOidc;

    const issued = provider.issueFor(
      { sub: "jit-sub-1", email: "jit-happy@test.local", email_verified: true },
      { state: "", redirect_uri: "http://127.0.0.1:0/callback" },
    );
    const tokenRes = await fetch(`${provider.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issued.code,
        client_id: "mock-client",
        redirect_uri: "http://127.0.0.1:0/callback",
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { id_token: string };
    const id_token = tokenBody.id_token;
    expect(typeof id_token).toBe("string");

    await configureOidc(provider.url);
    const res = await postIdentitySession(id_token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      api_key: string;
      principal_id: string;
      context_id: string;
    };
    expect(body.api_key).toMatch(/^wf_live_/);

    const identityRows = await httpCtx.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.subject, "jit-sub-1"));
    expect(identityRows).toHaveLength(1);
    if (!identityRows[0]) throw new Error("provider binding missing");
    const userRows = await httpCtx.db
      .select()
      .from(users)
      .where(eq(users.id, identityRows[0].user_id));
    expect(userRows[0]?.email).toBe("jit-happy@test.local");

    const auditRows = await httpCtx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor_id, body.principal_id));
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain("session.issued");
    expect(actions).toContain("user.logged_in");
  });
});

describe("JIT provisioning — duplicate-email collision (scenario 4)", () => {
  test("second login with same email but different sub attaches sub to existing user", async () => {
    const provider = mockOidc;

    const [existingUser] = await httpCtx.db
      .insert(users)
      .values({
        tenant_id: httpCtx.tenantId,
        email: "collide@test.local",
        role_id: await builtinRoleId(httpCtx.db, "member"),
      })
      .returning();
    if (!existingUser) throw new Error("seed user failed");

    const [defaultTenant] = await httpCtx.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "default"))
      .limit(1);
    if (!defaultTenant) throw new Error("default tenant missing");

    const [defaultUser] = await httpCtx.db
      .insert(users)
      .values({
        tenant_id: defaultTenant.id,
        email: "collide@test.local",
        role_id: await builtinRoleId(httpCtx.db, "member"),
      })
      .returning();
    if (!defaultUser) throw new Error("default user seed failed");

    const issued = provider.issueFor(
      { sub: "collide-sub-99", email: "collide@test.local", email_verified: true },
      { state: "", redirect_uri: "http://127.0.0.1:0/callback" },
    );
    const tokenRes = await fetch(`${provider.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issued.code,
        client_id: "mock-client",
        redirect_uri: "http://127.0.0.1:0/callback",
      }).toString(),
    });
    const tokenBody = (await tokenRes.json()) as { id_token: string };

    await configureOidc(provider.url);
    const res = await postIdentitySession(tokenBody.id_token);
    expect(res.status).toBe(200);

    const linked = await httpCtx.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, defaultUser.id));
    expect(linked[0]?.provider_id).toBe("test-identity");
    expect(linked[0]?.subject).toBe("collide-sub-99");

    const allForEmail = await httpCtx.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, defaultTenant.id), eq(users.email, "collide@test.local")));
    expect(allForEmail.length).toBe(1);
  });
});

describe("JIT provisioning — clock-skew tolerance (scenario 5)", () => {
  test("iat = now - 1s (one second in the past) is accepted", async () => {
    const provider = mockOidc;
    const issued = provider.issueFor(
      { sub: "clockskew-past", email: "clockskew-past@test.local" },
      { state: "", redirect_uri: "http://127.0.0.1:0/callback" },
    );
    const tokenRes = await fetch(`${provider.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issued.code,
        client_id: "mock-client",
        redirect_uri: "http://127.0.0.1:0/callback",
      }).toString(),
    });
    const tokenBody = (await tokenRes.json()) as { id_token: string };

    await configureOidc(provider.url);
    const res = await postIdentitySession(tokenBody.id_token);
    expect(res.status).toBe(200);
  });

  test("exp = now - 1s (expired by one second) is rejected", async () => {
    const { createServer } = await import("node:http");
    const { exportJWK } = await import("jose");

    const jwk = await exportJWK(publicKey);
    jwk.kid = mockKid;
    jwk.alg = "RS256";
    jwk.use = "sig";

    const jwksServer = createServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://localhost");
      if (url.pathname === "/.well-known/openid-configuration") {
        const base = `http://127.0.0.1:${(jwksServer.address() as { port: number }).port}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      } else if (url.pathname === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", () => resolve()));
    const { port } = jwksServer.address() as { port: number };
    const issuerBase = `http://127.0.0.1:${port}`;

    try {
      const nowSec = Math.floor(getTestNow() / 1000);
      const id_token = await new SignJWT({ sub: "expired-sub", email: "expired@test.local" })
        .setProtectedHeader({ alg: "RS256", kid: mockKid })
        .setIssuer(issuerBase)
        .setAudience("subkit-cli")
        .setIssuedAt(nowSec - 120)
        .setExpirationTime(nowSec - 1)
        .sign(privateKey);

      await configureOidc(issuerBase);
      const res = await postIdentitySession(id_token);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    }
  });
});

describe("JIT provisioning — issuer-mismatch rejection (scenario 6)", () => {
  test("assertion issuer mismatch returns 401", async () => {
    const { createServer } = await import("node:http");
    const { exportJWK } = await import("jose");

    const jwk = await exportJWK(publicKey);
    jwk.kid = mockKid;
    jwk.alg = "RS256";
    jwk.use = "sig";

    const realServer = createServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://localhost");
      const base = `http://127.0.0.1:${(realServer.address() as { port: number }).port}`;
      if (url.pathname === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      } else if (url.pathname === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => realServer.listen(0, "127.0.0.1", () => resolve()));
    const { port } = realServer.address() as { port: number };
    const discoveredIssuer = `http://127.0.0.1:${port}`;

    try {
      const nowSec = Math.floor(getTestNow() / 1000);
      const id_token = await new SignJWT({
        sub: "mismatch-sub",
        email: "mismatch@test.local",
      })
        .setProtectedHeader({ alg: "RS256", kid: mockKid })
        .setIssuer("https://evil.example.com")
        .setAudience("subkit-cli")
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + 600)
        .sign(privateKey);

      await configureOidc(discoveredIssuer);
      const res = await postIdentitySession(id_token);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => realServer.close(() => resolve()));
    }
  });
});

describe("JIT provisioning — token without sub (scenario 7)", () => {
  test("id_token missing sub claim returns 401", async () => {
    const { createServer } = await import("node:http");
    const { exportJWK } = await import("jose");

    const jwk = await exportJWK(publicKey);
    jwk.kid = mockKid;
    jwk.alg = "RS256";
    jwk.use = "sig";

    const noSubServer = createServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://localhost");
      const base = `http://127.0.0.1:${(noSubServer.address() as { port: number }).port}`;
      if (url.pathname === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      } else if (url.pathname === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => noSubServer.listen(0, "127.0.0.1", () => resolve()));
    const { port } = noSubServer.address() as { port: number };
    const issuerBase = `http://127.0.0.1:${port}`;

    try {
      const nowSec = Math.floor(getTestNow() / 1000);
      const id_token = await new SignJWT({ email: "nosub@test.local" })
        .setProtectedHeader({ alg: "RS256", kid: mockKid })
        .setIssuer(issuerBase)
        .setAudience("subkit-cli")
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + 600)
        .sign(privateKey);

      await configureOidc(issuerBase);
      const res = await postIdentitySession(id_token);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => noSubServer.close(() => resolve()));
    }
  });
});
