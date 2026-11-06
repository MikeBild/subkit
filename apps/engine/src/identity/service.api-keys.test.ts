import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import {
  createSystemAccount,
  getApiKey,
  issueApiKey,
  issuePortalToken,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
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

describe("service — api keys", () => {
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
