import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  authIdentities,
  chatIdentities,
  groupMembers,
  groups,
  permissions,
  resourceGrants,
  sessions,
  tenants,
  userIdentities,
  users,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import {
  createInvitedUser,
  createUser,
  DuplicateUserError,
  deactivateUser,
} from "./provisioning.ts";

let testDb: TestDb;
let tenantId = "";
let otherTenantId = "";

beforeAll(async () => {
  testDb = await createTestDb("user-restore");
  const seeded = await testDb.db
    .insert(tenants)
    .values([
      { slug: "restore-tenant", display_name: "Restore Tenant" },
      { slug: "restore-other", display_name: "Other Tenant" },
    ])
    .returning();
  tenantId = seeded[0]?.id ?? "";
  otherTenantId = seeded[1]?.id ?? "";
  if (!tenantId || !otherTenantId) throw new Error("seed tenants failed");
});

afterAll(async () => {
  if (testDb) await testDb.cleanup();
});

async function seedInvitedUser(email: string) {
  return createUser(
    { tenant_id: tenantId, email, role: "member", status: "invited", actor_id: null },
    testDb.db,
  );
}

describe("createUser — an address that was removed before", () => {
  async function joinedThenRemoved(email: string) {
    const user = await seedInvitedUser(email);
    const [identity] = await testDb.db
      .insert(authIdentities)
      .values({ issuer_url: "https://issuer.test.local", subject: email, email })
      .returning();
    if (!identity) throw new Error("seed auth identity failed");
    await testDb.db
      .update(users)
      .set({ auth_identity_id: identity.id, status: "active" })
      .where(eq(users.id, user.id));
    await testDb.db.insert(userIdentities).values({
      tenant_id: tenantId,
      user_id: user.id,
      provider_id: "workspace-sso",
      issuer_url: "https://issuer.test.local",
      subject: email,
      email,
    });
    await testDb.db.insert(sessions).values({
      tenant_id: tenantId,
      user_id: user.id,
      auth_identity_id: identity.id,
      expires_at: new Date(getTestNow() + 60_000),
    });
    await testDb.db.insert(chatIdentities).values({
      tenant_id: tenantId,
      user_id: user.id,
      platform: "slack",
      workspace_id: "T-restore",
      platform_user_id: email,
    });
    const [group] = await testDb.db
      .insert(groups)
      .values({ tenant_id: tenantId, name: `group-${email}` })
      .returning();
    if (!group) throw new Error("seed group failed");
    await testDb.db.insert(groupMembers).values({ group_id: group.id, user_id: user.id });
    const [permission] = await testDb.db.select().from(permissions).limit(1);
    if (!permission) throw new Error("no builtin permission");
    await testDb.db.insert(resourceGrants).values({
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: user.id,
      resource_type: "workflow",
      resource_id: group.id,
      permission_id: permission.id,
    });
    const removed = await deactivateUser(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );
    expect(removed?.deleted_at).not.toBeNull();
    return user;
  }

  test("inviting it again brings the person back with nothing but the new role and invitation", async () => {
    const email = "inv-restore@test.local";
    const before = await joinedThenRemoved(email);

    const { user, invite } = await createInvitedUser(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        email,
        role: "enduser",
        display_name: "Restored",
        actor_id: null,
      },
      testDb.db,
    );

    expect(user.id).toBe(before.id);
    expect(user).toMatchObject({
      status: "invited",
      display_name: "Restored",
      deleted_at: null,
      auth_identity_id: null,
    });
    expect(user.role_id).not.toBe(before.role_id);
    expect(invite.view.user_id).toBe(user.id);
    expect(
      await testDb.db.select().from(userIdentities).where(eq(userIdentities.user_id, user.id)),
    ).toHaveLength(0);
    expect(
      await testDb.db.select().from(chatIdentities).where(eq(chatIdentities.user_id, user.id)),
    ).toHaveLength(0);
    expect(
      await testDb.db.select().from(groupMembers).where(eq(groupMembers.user_id, user.id)),
    ).toHaveLength(0);
    expect(
      await testDb.db.select().from(resourceGrants).where(eq(resourceGrants.subject_id, user.id)),
    ).toHaveLength(0);
    const created = await testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.created"), eq(auditLog.resource_id, user.id)));
    expect(created.map((entry) => entry.metadata)).toEqual([
      expect.not.objectContaining({ restored: true }),
      expect.objectContaining({ restored: true, status: "invited" }),
    ]);

    const withdrawn = await deactivateUser(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );
    expect(withdrawn?.deleted_at).not.toBeNull();
    const third = await createInvitedUser(
      { issuer: { kind: "system" }, tenant_id: tenantId, email, actor_id: null },
      testDb.db,
    );
    expect(third.user.id).toBe(before.id);
  });

  test("the same removed address in another workspace is untouched", async () => {
    const email = "inv-restore-isolated@test.local";
    const before = await joinedThenRemoved(email);
    const elsewhere = await createUser(
      { tenant_id: otherTenantId, email, actor_id: null },
      testDb.db,
    );
    expect(elsewhere.id).not.toBe(before.id);
    const [still] = await testDb.db.select().from(users).where(eq(users.id, before.id));
    expect(still?.deleted_at).not.toBeNull();
    expect(
      await testDb.db.select().from(groupMembers).where(eq(groupMembers.user_id, before.id)),
    ).toHaveLength(1);
  });

  test("an address that is still in use is a duplicate, also when two requests race", async () => {
    const email = "inv-race@test.local";
    const outcomes = await Promise.allSettled([
      createUser({ tenant_id: tenantId, email, actor_id: null }, testDb.db),
      createUser({ tenant_id: tenantId, email, actor_id: null }, testDb.db),
    ]);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DuplicateUserError);
    await expect(
      createUser({ tenant_id: tenantId, email, actor_id: null }, testDb.db),
    ).rejects.toBeInstanceOf(DuplicateUserError);
  });
});
