import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  authIdentities,
  roles,
  tenants,
  userIdentities,
  users,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import {
  assertTenantActive,
  getMembershipForIdentity,
  listMembershipsForIdentity,
  provisionSelfServiceTenant,
} from "./self-service.ts";

let testDb: TestDb;
const issuer = "https://identity.example.test/realm";
const claims = (subject: string, email = `${subject}@example.test`) => ({
  issuer_url: issuer,
  subject,
  email,
  email_verified: true as const,
});

beforeAll(async () => {
  testDb = await createTestDb("self-service");
  await configureHostedPolicyForTests(testDb.db, testDb.url);
});
afterAll(async () => {
  if (testDb) await testDb.cleanup();
});

describe("self-service identity provisioning", () => {
  test("parallel callbacks provision one tenant and owner without operator rights", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => provisionSelfServiceTenant(claims("concurrent"), testDb.db)),
    );
    expect(new Set(outcomes.map((outcome) => outcome.tenant.id)).size).toBe(1);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    const outcome = outcomes[0];
    if (!outcome) throw new Error("no provisioning outcome");
    expect(outcome.tenant.origin).toBe("self_service");
    expect(outcome.tenant.status).toBe("active");
    expect(outcome.tenant.is_operator).toBe(false);
    expect(outcome.tenant.owner_identity_id).toBe(outcome.identity.id);
    expect(outcome.membership.role).toBe("admin");
    expect(outcome.membership.is_owner).toBe(true);
    expect(outcome.tenant.slug).not.toContain("concurrent");
    const events = await testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, outcome.tenant.id));
    expect(events.filter((event) => event.action === "tenant.created")).toHaveLength(1);
    expect(events.filter((event) => event.action === "user.created")).toHaveLength(1);
    const [role] = await testDb.db
      .select()
      .from(roles)
      .where(eq(roles.id, outcome.membership.role_id));
    expect(role?.name).toBe("admin");
  });

  test("same email across subjects or issuers does not merge identities or tenants", async () => {
    const first = await provisionSelfServiceTenant(
      claims("same-email", "same@example.test"),
      testDb.db,
    );
    const second = await provisionSelfServiceTenant(
      claims("other-subject", "same@example.test"),
      testDb.db,
    );
    const third = await provisionSelfServiceTenant(
      { ...claims("same-email", "same@example.test"), issuer_url: "https://other.example.test" },
      testDb.db,
    );
    expect(new Set([first.identity.id, second.identity.id, third.identity.id]).size).toBe(3);
    expect(new Set([first.tenant.id, second.tenant.id, third.tenant.id]).size).toBe(3);
    expect(
      await getMembershipForIdentity(first.identity.id, second.tenant.id, testDb.db),
    ).toBeNull();
  });

  test("unverified claims cannot persist an identity or tenant", async () => {
    await expect(
      provisionSelfServiceTenant(
        { ...claims("unverified"), email_verified: false } as unknown as Parameters<
          typeof provisionSelfServiceTenant
        >[0],
        testDb.db,
      ),
    ).rejects.toThrow();
    expect(
      await testDb.db.select().from(authIdentities).where(eq(authIdentities.subject, "unverified")),
    ).toHaveLength(0);
  });

  test("legacy non-product bindings require explicit migration and remain unchanged", async () => {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "legacy-binding", display_name: "Existing" })
      .returning();
    if (!tenant) throw new Error("tenant missing");
    const [user] = await testDb.db
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: "bound@example.test",
        role_id: await builtinRoleId(testDb.db, "admin"),
      })
      .returning();
    if (!user) throw new Error("user missing");
    await testDb.db.insert(userIdentities).values({
      tenant_id: tenant.id,
      user_id: user.id,
      provider_id: "browser",
      issuer_url: issuer,
      subject: "legacy-binding",
      email: user.email,
    });
    await expect(provisionSelfServiceTenant(claims("legacy-binding"), testDb.db)).rejects.toThrow(
      "identity_migration_required",
    );
    const [unchanged] = await testDb.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenant.id), eq(users.id, user.id)));
    expect(unchanged?.auth_identity_id).toBeNull();
    expect(
      await testDb.db
        .select()
        .from(authIdentities)
        .where(eq(authIdentities.subject, "legacy-binding")),
    ).toHaveLength(0);
  });

  test("product identities do not become cloud memberships", async () => {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "product-binding", display_name: "Product" })
      .returning();
    if (!tenant) throw new Error("tenant missing");
    const [user] = await testDb.db
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: "product@example.test",
        role_id: await builtinRoleId(testDb.db, "member"),
      })
      .returning();
    if (!user) throw new Error("user missing");
    await testDb.db.insert(userIdentities).values({
      tenant_id: tenant.id,
      user_id: user.id,
      provider_id: "product",
      issuer_url: issuer,
      subject: "product-binding",
      product_id: "product",
      email: user.email,
    });
    const outcome = await provisionSelfServiceTenant(claims("product-binding"), testDb.db);
    expect(outcome.tenant.id).not.toBe(tenant.id);
    expect(await getMembershipForIdentity(outcome.identity.id, tenant.id, testDb.db)).toBeNull();
  });

  test("membership lookup excludes inactive users and inactive tenants", async () => {
    const own = await provisionSelfServiceTenant(claims("membership"), testDb.db);
    const other = await provisionSelfServiceTenant(claims("inviting-owner"), testDb.db);
    const [member] = await testDb.db
      .insert(users)
      .values({
        tenant_id: other.tenant.id,
        auth_identity_id: own.identity.id,
        email: "membership@example.test",
        role_id: await builtinRoleId(testDb.db, "member"),
      })
      .returning();
    if (!member) throw new Error("member missing");
    expect(await listMembershipsForIdentity(own.identity.id, testDb.db)).toHaveLength(2);
    expect(
      (await getMembershipForIdentity(own.identity.id, other.tenant.id, testDb.db))?.is_owner,
    ).toBe(false);
    await testDb.db
      .update(users)
      .set({ status: "disabled" })
      .where(and(eq(users.tenant_id, other.tenant.id), eq(users.id, member.id)));
    expect(await getMembershipForIdentity(own.identity.id, other.tenant.id, testDb.db)).toBeNull();
    await testDb.db
      .update(tenants)
      .set({ status: "suspended" })
      .where(eq(tenants.id, own.tenant.id));
    expect(await listMembershipsForIdentity(own.identity.id, testDb.db)).toHaveLength(0);
    await expect(assertTenantActive(own.tenant.id, testDb.db)).rejects.toThrow(
      "tenant_unavailable",
    );
    await expect(provisionSelfServiceTenant(claims("membership"), testDb.db)).rejects.toThrow(
      "tenant_unavailable",
    );
    expect(
      await testDb.db.select().from(tenants).where(eq(tenants.owner_identity_id, own.identity.id)),
    ).toHaveLength(1);
  });

  test("deleted or pending tenants cannot be replaced by retrying signup", async () => {
    for (const state of ["pending_deletion", "deleted"] as const) {
      const outcome = await provisionSelfServiceTenant(claims(state), testDb.db);
      await testDb.db
        .update(tenants)
        .set(
          state === "deleted"
            ? { deleted_at: new Date(getTestNow()) }
            : {
                status: state,
                deletion_requested_at: new Date(getTestNow()),
                deletion_scheduled_for: new Date(getTestNow() + 86_400_000),
              },
        )
        .where(eq(tenants.id, outcome.tenant.id));
      await expect(provisionSelfServiceTenant(claims(state), testDb.db)).rejects.toThrow(
        "tenant_unavailable",
      );
      expect(
        await testDb.db
          .select()
          .from(tenants)
          .where(eq(tenants.owner_identity_id, outcome.identity.id)),
      ).toHaveLength(1);
    }
  });

  test("existing tenant defaults stay self-hosted and active", async () => {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "self-hosted-default", display_name: "Self hosted" })
      .returning();
    expect(tenant?.origin).toBe("self_hosted");
    expect(tenant?.status).toBe("active");
    expect(tenant?.owner_identity_id).toBeNull();
    if (!tenant) throw new Error("tenant missing");
    await assertTenantActive(tenant.id, testDb.db);
  });

  test("schema rejects a self-service operator and duplicate own tenant", async () => {
    const outcome = await provisionSelfServiceTenant(claims("constraints"), testDb.db);
    await expect(
      testDb.db
        .update(tenants)
        .set({ is_operator: true })
        .where(eq(tenants.id, outcome.tenant.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      testDb.db
        .insert(tenants)
        .values({
          slug: "duplicate-owned",
          display_name: "Duplicate",
          origin: "self_service",
          owner_identity_id: outcome.identity.id,
        })
        .execute(),
    ).rejects.toThrow();
  });
});
