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
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import {
  assertTenantActive,
  completeHostedRegistration,
  getMembershipForIdentity,
  listMembershipsForIdentity,
  provisionSelfServiceTenant,
  resolveHostedIdentity,
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
      Array.from({ length: 8 }, () =>
        provisionSelfServiceTenant(claims("concurrent"), TEST_WORKSPACE_REGISTRATION, testDb.db),
      ),
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
      TEST_WORKSPACE_REGISTRATION,
      testDb.db,
    );
    const second = await provisionSelfServiceTenant(
      claims("other-subject", "same@example.test"),
      TEST_WORKSPACE_REGISTRATION,
      testDb.db,
    );
    const third = await provisionSelfServiceTenant(
      { ...claims("same-email", "same@example.test"), issuer_url: "https://other.example.test" },
      TEST_WORKSPACE_REGISTRATION,
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
        TEST_WORKSPACE_REGISTRATION,
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
    await expect(
      provisionSelfServiceTenant(claims("legacy-binding"), TEST_WORKSPACE_REGISTRATION, testDb.db),
    ).rejects.toThrow("identity_migration_required");
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
    const outcome = await provisionSelfServiceTenant(
      claims("product-binding"),
      TEST_WORKSPACE_REGISTRATION,
      testDb.db,
    );
    expect(outcome.tenant.id).not.toBe(tenant.id);
    expect(await getMembershipForIdentity(outcome.identity.id, tenant.id, testDb.db)).toBeNull();
  });

  test("membership lookup excludes inactive users and inactive tenants", async () => {
    const own = await provisionSelfServiceTenant(
      claims("membership"),
      TEST_WORKSPACE_REGISTRATION,
      testDb.db,
    );
    const other = await provisionSelfServiceTenant(
      claims("inviting-owner"),
      TEST_WORKSPACE_REGISTRATION,
      testDb.db,
    );
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
    await expect(
      provisionSelfServiceTenant(claims("membership"), TEST_WORKSPACE_REGISTRATION, testDb.db),
    ).rejects.toThrow("tenant_unavailable");
    expect(
      await testDb.db.select().from(tenants).where(eq(tenants.owner_identity_id, own.identity.id)),
    ).toHaveLength(1);
  });

  test("deleted or pending tenants cannot be replaced by retrying signup", async () => {
    for (const state of ["pending_deletion", "deleted"] as const) {
      const outcome = await provisionSelfServiceTenant(
        claims(state),
        TEST_WORKSPACE_REGISTRATION,
        testDb.db,
      );
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
      await expect(
        provisionSelfServiceTenant(claims(state), TEST_WORKSPACE_REGISTRATION, testDb.db),
      ).rejects.toThrow("tenant_unavailable");
      expect(
        await testDb.db
          .select()
          .from(tenants)
          .where(eq(tenants.owner_identity_id, outcome.identity.id)),
      ).toHaveLength(1);
    }
  });

  test("a created workspace carries the registered name, time zone and owner name", async () => {
    const outcome = await provisionSelfServiceTenant(
      claims("registered-values"),
      { display_name: " Ada ", workspace_name: " Engines ", timezone: "Europe/Berlin" },
      testDb.db,
    );
    expect(outcome.tenant).toMatchObject({ display_name: "Engines", timezone: "Europe/Berlin" });
    const [owner] = await testDb.db
      .select()
      .from(users)
      .where(eq(users.tenant_id, outcome.tenant.id));
    expect(owner?.display_name).toBe("Ada");
    await expect(
      provisionSelfServiceTenant(
        claims("bad-zone"),
        { ...TEST_WORKSPACE_REGISTRATION, timezone: "Mars/Olympus" },
        testDb.db,
      ),
    ).rejects.toThrow();
    expect(
      await testDb.db.select().from(authIdentities).where(eq(authIdentities.subject, "bad-zone")),
    ).toHaveLength(0);
  });

  test("resolving an unknown identity records it for registration without creating a workspace", async () => {
    await expect(
      resolveHostedIdentity(claims("resolve-closed"), { registration_enabled: false }, testDb.db),
    ).rejects.toThrow("registration_closed");
    expect(
      await testDb.db
        .select()
        .from(authIdentities)
        .where(eq(authIdentities.subject, "resolve-closed")),
    ).toHaveLength(0);

    const pending = await resolveHostedIdentity(
      claims("resolve-open"),
      { registration_enabled: true },
      testDb.db,
    );
    expect(pending.kind).toBe("registration");
    expect(
      await testDb.db
        .select()
        .from(tenants)
        .where(eq(tenants.owner_identity_id, pending.identity.id)),
    ).toHaveLength(0);
    const again = await resolveHostedIdentity(
      claims("resolve-open", "renamed@example.test"),
      { registration_enabled: true },
      testDb.db,
    );
    expect(again.kind).toBe("registration");
    expect(again.identity).toMatchObject({
      id: pending.identity.id,
      email: "renamed@example.test",
    });
    await expect(
      resolveHostedIdentity(
        claims("resolve-open", "renamed@example.test"),
        { registration_enabled: false },
        testDb.db,
      ),
    ).rejects.toThrow("registration_closed");

    await expect(
      completeHostedRegistration(
        pending.identity.id,
        TEST_WORKSPACE_REGISTRATION,
        { registration_enabled: false },
        testDb.db,
      ),
    ).rejects.toThrow("registration_closed");
    const first = await completeHostedRegistration(
      pending.identity.id,
      TEST_WORKSPACE_REGISTRATION,
      { registration_enabled: true },
      testDb.db,
    );
    const second = await completeHostedRegistration(
      pending.identity.id,
      { ...TEST_WORKSPACE_REGISTRATION, workspace_name: "Another" },
      { registration_enabled: false },
      testDb.db,
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.tenant).toMatchObject({ id: first.tenant.id, display_name: "Test workspace" });
    const member = await resolveHostedIdentity(
      claims("resolve-open", "renamed@example.test"),
      { registration_enabled: false },
      testDb.db,
    );
    expect(member.kind).toBe("member");
  });

  test("an owner whose workspace is unavailable is sent to recovery, never to a second registration", async () => {
    const outcome = await provisionSelfServiceTenant(
      claims("resolve-suspended"),
      TEST_WORKSPACE_REGISTRATION,
      testDb.db,
    );
    await testDb.db
      .update(tenants)
      .set({ status: "suspended" })
      .where(eq(tenants.id, outcome.tenant.id));
    await expect(
      resolveHostedIdentity(claims("resolve-suspended"), { registration_enabled: true }, testDb.db),
    ).rejects.toThrow("tenant_unavailable");
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
    const outcome = await provisionSelfServiceTenant(
      claims("constraints"),
      TEST_WORKSPACE_REGISTRATION,
      testDb.db,
    );
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
