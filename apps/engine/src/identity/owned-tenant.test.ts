import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { authIdentities, sessions, tenants, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import {
  createDeterministicClock,
  installClock,
  restoreClock,
} from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import type { BrowserMembershipContext } from "./browser-memberships.ts";
import { readOwnedTenant } from "./owned-tenant.ts";
import { provisionSelfServiceTenant } from "./self-service.ts";
import { SelfServiceIdentityError } from "./tenant-status.ts";

let tdb: TestDb;
const clock = createDeterministicClock();
let previousClock: ReturnType<typeof installClock>;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  previousClock = installClock(clock);
  tdb = await createTestDb("owned-tenant");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
});
afterAll(async () => {
  restoreClock(previousClock);
  await tdb.cleanup();
});

async function openSession(
  tenant_id: string,
  user_id: string,
  auth_identity_id: string,
  label: string,
  overrides: Partial<typeof sessions.$inferInsert> = {},
): Promise<BrowserMembershipContext> {
  const expires = new Date(clock.now() + HOUR);
  const [session] = await tdb.db
    .insert(sessions)
    .values({
      tenant_id,
      user_id,
      auth_identity_id,
      expires_at: expires,
      absolute_expires_at: expires,
      last_seen_at: new Date(clock.now()),
      token_sha256: createHash("sha256").update(`session-${label}`).digest("hex"),
      ...overrides,
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("session fixture missing");
  return { tenant_id, user_id, session_id: session.id };
}

async function ownerFixture(label: string) {
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: label,
      email: `${label}@example.test`,
      email_verified: true,
    },
    tdb.db,
  );
  const browser = await openSession(
    owned.tenant.id,
    owned.membership.user_id,
    owned.identity.id,
    label,
  );
  return { owned, browser };
}

async function memberElsewhere(identity_id: string, label: string) {
  const workspace = await seedTenant(tdb.db);
  const [user] = await tdb.db
    .insert(users)
    .values({
      tenant_id: workspace.id,
      email: `${label}@example.test`,
      auth_identity_id: identity_id,
      role_id: await builtinRoleId(tdb.db, "member"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("member fixture missing");
  return openSession(workspace.id, user.id, identity_id, `${label}-elsewhere`);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SelfServiceIdentityError)) throw new Error("expected a refusal");
  return error.code;
}

describe("reading the owned tenant", () => {
  test("the owner reads their active tenant without a deletion schedule", async () => {
    const { owned, browser } = await ownerFixture("owned-active");

    expect(await readOwnedTenant(browser, tdb.db)).toEqual({
      id: owned.tenant.id,
      display_name: owned.tenant.display_name,
      status: "active",
      deletion_requested_at: null,
      deletion_scheduled_for: null,
    });
  });

  test("an owner whose tenant awaits deletion sees it and its schedule from another membership", async () => {
    const { owned } = await ownerFixture("owned-pending");
    const requested = new Date(clock.now());
    const scheduled = new Date(clock.now() + 7 * 24 * HOUR);
    await tdb.db
      .update(tenants)
      .set({
        status: "pending_deletion",
        deletion_requested_at: requested,
        deletion_scheduled_for: scheduled,
      })
      .where(eq(tenants.id, owned.tenant.id));
    const elsewhere = await memberElsewhere(owned.identity.id, "owned-pending-member");

    const tenant = await readOwnedTenant(elsewhere, tdb.db);

    expect(tenant?.id).toBe(owned.tenant.id);
    expect(tenant?.status).toBe("pending_deletion");
    expect(tenant?.deletion_requested_at?.getTime()).toBe(requested.getTime());
    expect(tenant?.deletion_scheduled_for?.getTime()).toBe(scheduled.getTime());
  });

  test("an erased tenant is no longer reported as owned", async () => {
    const { owned } = await ownerFixture("owned-erased");
    await tdb.db
      .update(tenants)
      .set({
        status: "pending_deletion",
        deletion_requested_at: new Date(clock.now() - HOUR),
        deletion_scheduled_for: new Date(clock.now()),
        deleted_at: new Date(clock.now()),
      })
      .where(eq(tenants.id, owned.tenant.id));
    const elsewhere = await memberElsewhere(owned.identity.id, "owned-erased-member");

    expect(await readOwnedTenant(elsewhere, tdb.db)).toBeNull();
  });

  test("an identity that owns no tenant reads none", async () => {
    const [identity] = await tdb.db
      .insert(authIdentities)
      .values({
        issuer_url: "https://identity.example.test",
        subject: "owns-nothing",
        email: "owns-nothing@example.test",
      })
      .returning({ id: authIdentities.id });
    if (!identity) throw new Error("identity fixture missing");
    const elsewhere = await memberElsewhere(identity.id, "owns-nothing-member");

    expect(await readOwnedTenant(elsewhere, tdb.db)).toBeNull();
  });

  test("another owner's tenant is never returned", async () => {
    const first = await ownerFixture("owned-first");
    const second = await ownerFixture("owned-second");

    expect((await readOwnedTenant(first.browser, tdb.db))?.id).toBe(first.owned.tenant.id);
    expect((await readOwnedTenant(second.browser, tdb.db))?.id).toBe(second.owned.tenant.id);
  });
});

describe("refusing to read the owned tenant", () => {
  test("a revoked session is refused", async () => {
    const { owned } = await ownerFixture("refuse-revoked");
    const browser = await openSession(
      owned.tenant.id,
      owned.membership.user_id,
      owned.identity.id,
      "refuse-revoked-2",
      { revoked_at: new Date(clock.now()) },
    );

    expect(await refusal(readOwnedTenant(browser, tdb.db))).toBe("membership_unavailable");
  });

  test("an expired session is refused", async () => {
    const { owned } = await ownerFixture("refuse-expired");
    const browser = await openSession(
      owned.tenant.id,
      owned.membership.user_id,
      owned.identity.id,
      "refuse-expired-2",
      { absolute_expires_at: new Date(clock.now()) },
    );

    expect(await refusal(readOwnedTenant(browser, tdb.db))).toBe("membership_unavailable");
  });

  test("a product session is refused", async () => {
    const { owned } = await ownerFixture("refuse-product");
    const browser = await openSession(
      owned.tenant.id,
      owned.membership.user_id,
      owned.identity.id,
      "refuse-product-2",
      { product_id: "app-one" },
    );

    expect(await refusal(readOwnedTenant(browser, tdb.db))).toBe("membership_unavailable");
  });

  test("another user's session id is refused", async () => {
    const victim = await ownerFixture("refuse-victim");
    const attacker = await ownerFixture("refuse-attacker");

    expect(
      await refusal(
        readOwnedTenant({ ...attacker.browser, session_id: victim.browser.session_id }, tdb.db),
      ),
    ).toBe("membership_unavailable");
  });

  test("a session presented under another tenant is refused", async () => {
    const { browser } = await ownerFixture("refuse-tenant");
    const other = await seedTenant(tdb.db);

    expect(await refusal(readOwnedTenant({ ...browser, tenant_id: other.id }, tdb.db))).toBe(
      "membership_unavailable",
    );
  });

  test("the owner of a tenant that is no longer active cannot read through that tenant", async () => {
    const { owned, browser } = await ownerFixture("refuse-suspended");
    await tdb.db
      .update(tenants)
      .set({ status: "suspended" })
      .where(eq(tenants.id, owned.tenant.id));

    expect(await refusal(readOwnedTenant(browser, tdb.db))).toBe("membership_unavailable");
  });
});
