import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, auditLog, roles, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import {
  createSystemAccount,
  deleteSystemAccount,
  issueApiKey,
  issueCliOAuthSessionApiKey,
  listSystemAccounts,
  rotateApiKey,
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
});
