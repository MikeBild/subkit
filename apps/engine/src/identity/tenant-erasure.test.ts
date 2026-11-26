import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  auditLog,
  authIdentities,
  cockpitInstallations,
  cockpitPushKeys,
  cockpitPushSubscriptions,
  hostedTenantUsage,
  sessions,
  tenantBranding,
  tenantErasureStates,
  tenants,
  users,
} from "../db/schema/index.ts";
import { beginTenantWork } from "../execution/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { runTenantErasureSweep } from "./scheduled/tenant-erasure-runner.ts";
import { provisionSelfServiceTenant } from "./self-service.ts";
import { eraseExpiredTenant } from "./tenant-erasure.ts";
import { queue, tenantErasureFixtures } from "./tenant-erasure-fixtures.ts";
import { erasureTableOrder } from "./tenant-erasure-schema.ts";

const { fixture, nextUuid } = tenantErasureFixtures({
  get ctx() {
    return ctx;
  },
});

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("tenant-erasure");
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

test("erasure schema classifies every product table and orders children before parents", () => {
  const order = erasureTableOrder();
  expect(order.indexOf("conversation_messages")).toBeLessThan(order.indexOf("conversations"));
  expect(order.indexOf("user_invites")).toBeLessThan(order.indexOf("users"));
  expect(order).toContain("webhook_held_deliveries");
  expect(order.indexOf("webhook_held_deliveries")).toBeLessThan(order.indexOf("webhooks_inbound"));
  expect(order.indexOf("webhook_held_deliveries")).toBeLessThan(order.indexOf("workflows"));
  expect(order).not.toContain("auth_identities");
  expect(order).not.toContain("hosted_tenant_usage");
});

test("empty lifecycle sweep never initializes object storage", async () => {
  expect(
    await runTenantErasureSweep(ctx.db, () => {
      throw new Error("must not initialize");
    }),
  ).toEqual({ examined: 0, completed: 0, blocked: 0 });
});

test("erases app icons and encrypted push storage for exactly the requested tenant", async () => {
  const { owned, objects } = await fixture("erase-cockpit-content");
  const neighbor = await fixture("erase-cockpit-neighbor", false);
  const [owner] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.tenant_id, owned.tenant.id))
    .limit(1);
  const [neighborOwner] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.tenant_id, neighbor.owned.tenant.id))
    .limit(1);
  if (!owner || !neighborOwner) throw new Error("tenant owner fixture missing");
  const installationId = nextUuid();
  const sessionId = nextUuid();
  const neighborInstallationId = nextUuid();
  const neighborSessionId = nextUuid();
  await ctx.db.insert(cockpitInstallations).values([
    { id: installationId, tenant_id: owned.tenant.id, owner_user_id: owner.id },
    {
      id: neighborInstallationId,
      tenant_id: neighbor.owned.tenant.id,
      owner_user_id: neighborOwner.id,
    },
  ]);
  await ctx.db.insert(sessions).values([
    {
      id: sessionId,
      tenant_id: owned.tenant.id,
      user_id: owner.id,
      installation_id: installationId,
      expires_at: new Date(getTestNow() + 60_000),
    },
    {
      id: neighborSessionId,
      tenant_id: neighbor.owned.tenant.id,
      user_id: neighborOwner.id,
      installation_id: neighborInstallationId,
      expires_at: new Date(getTestNow() + 60_000),
    },
  ]);
  const appIcon192 = Buffer.alloc(192, 1);
  const appIcon512 = Buffer.alloc(512, 2);
  await ctx.db.insert(tenantBranding).values([
    {
      tenant_id: owned.tenant.id,
      revision: 1,
      app_icon_192: appIcon192,
      app_icon_512: appIcon512,
    },
    {
      tenant_id: neighbor.owned.tenant.id,
      revision: 1,
      app_icon_192: appIcon192,
      app_icon_512: appIcon512,
    },
  ]);
  const encrypted = {
    ciphertext: Buffer.alloc(32, 3),
    iv: Buffer.alloc(12, 4),
    auth_tag: Buffer.alloc(16, 5),
  };
  await ctx.db.insert(cockpitPushKeys).values([
    { tenant_id: owned.tenant.id, ...encrypted },
    { tenant_id: neighbor.owned.tenant.id, ...encrypted },
  ]);
  await ctx.db.insert(cockpitPushSubscriptions).values([
    {
      tenant_id: owned.tenant.id,
      installation_id: installationId,
      session_id: sessionId,
      endpoint_sha256: "a".repeat(64),
      ...encrypted,
    },
    {
      tenant_id: neighbor.owned.tenant.id,
      installation_id: neighborInstallationId,
      session_id: neighborSessionId,
      endpoint_sha256: "b".repeat(64),
      ...encrypted,
    },
  ]);
  const [usage] = await ctx.db
    .select({ logical_bytes: hostedTenantUsage.logical_bytes })
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, owned.tenant.id));
  expect(usage?.logical_bytes).toBeGreaterThanOrEqual(
    BigInt(appIcon192.length + appIcon512.length + 2 * (32 + 12 + 16)),
  );

  expect(await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).toEqual({
    status: "completed",
  });
  expect(
    await ctx.db.select().from(tenantBranding).where(eq(tenantBranding.tenant_id, owned.tenant.id)),
  ).toHaveLength(0);
  expect(
    await ctx.db
      .select()
      .from(cockpitPushKeys)
      .where(eq(cockpitPushKeys.tenant_id, owned.tenant.id)),
  ).toHaveLength(0);
  expect(
    await ctx.db
      .select()
      .from(cockpitPushSubscriptions)
      .where(eq(cockpitPushSubscriptions.tenant_id, owned.tenant.id)),
  ).toHaveLength(0);
  expect(
    await ctx.db
      .select()
      .from(cockpitPushSubscriptions)
      .where(eq(cockpitPushSubscriptions.tenant_id, neighbor.owned.tenant.id)),
  ).toHaveLength(1);
  expect(
    await ctx.db
      .select()
      .from(tenantBranding)
      .where(eq(tenantBranding.tenant_id, neighbor.owned.tenant.id)),
  ).toHaveLength(1);
});

test("expired owned tenant erases online content and objects while retaining ownership", async () => {
  const { owned, objects } = await fixture("erase-owner", true, true);
  const foreign = await fixture("erase-foreign", false);
  await objects.put(`${foreign.owned.tenant.id}/untouched`, Buffer.from("foreign"));
  expect(await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).toEqual({
    status: "completed",
  });
  expect(await objects.list(`${owned.tenant.id}/`)).toHaveLength(0);
  expect(await objects.list(`offload/${owned.tenant.id}/`)).toHaveLength(0);
  expect(await objects.exists(`${foreign.owned.tenant.id}/untouched`)).toBe(true);
  expect(
    await ctx.db.select().from(users).where(eq(users.tenant_id, owned.tenant.id)),
  ).toHaveLength(0);
  const [tombstone] = await ctx.db.select().from(tenants).where(eq(tenants.id, owned.tenant.id));
  expect(tombstone?.owner_identity_id).toBe(owned.identity.id);
  expect(tombstone?.deleted_at).toBeInstanceOf(Date);
  const [identity] = await ctx.db
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.id, owned.identity.id));
  expect(identity?.email).toBe("");
  expect(identity?.subject).toBe("erase-owner");
  expect(
    await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, owned.tenant.id)),
  ).toHaveLength(1);
  expect(await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).toEqual({
    status: "skipped",
  });
  await expect(
    provisionSelfServiceTenant(
      {
        issuer_url: "https://erase.example.test",
        subject: "erase-owner",
        email: "erase-owner@example.test",
        email_verified: true,
      },
      TEST_WORKSPACE_REGISTRATION,
      ctx.db,
    ),
  ).rejects.toThrow();
});

test("canceling an active handler cannot erase until its tracked execution actually returns", async () => {
  const { owned, objects } = await fixture("erase-running");
  const finish = beginTenantWork(owned.tenant.id);
  const jobs = queue(owned.tenant.id);
  expect((await eraseExpiredTenant(owned.tenant.id, { queue: jobs, objects }, ctx.db)).status).toBe(
    "blocked",
  );
  expect(jobs.canceled).toBe(1);
  expect((await eraseExpiredTenant(owned.tenant.id, { queue: jobs, objects }, ctx.db)).status).toBe(
    "blocked",
  );
  expect(await objects.exists(`${owned.tenant.id}/file`)).toBe(true);
  finish();
  expect((await eraseExpiredTenant(owned.tenant.id, { queue: jobs, objects }, ctx.db)).status).toBe(
    "completed",
  );
});

test("untracked cancellation remains blocked even when public queue no longer reports active work", async () => {
  const { owned, objects } = await fixture("erase-untracked");
  const jobs = queue(owned.tenant.id);
  expect((await eraseExpiredTenant(owned.tenant.id, { queue: jobs, objects }, ctx.db)).status).toBe(
    "blocked",
  );
  expect(await eraseExpiredTenant(owned.tenant.id, { queue: jobs, objects }, ctx.db)).toEqual({
    status: "blocked",
    reason: "producer_drain_evidence_required",
  });
  expect(await objects.exists(`${owned.tenant.id}/file`)).toBe(true);
  const [state] = await ctx.db
    .select()
    .from(tenantErasureStates)
    .where(eq(tenantErasureStates.tenant_id, owned.tenant.id));
  expect(state?.drain_untracked).toBe(true);
});

test("object cleanup failure preserves database content and retries idempotently before tombstone", async () => {
  const { owned, objects } = await fixture("erase-retry");
  const remove = objects.deleteMany.bind(objects);
  objects.deleteMany = async () => {
    throw new Error("synthetic object outage");
  };
  expect(await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).toEqual({
    status: "blocked",
    reason: "object_cleanup_failed",
  });
  expect(
    await ctx.db.select().from(users).where(eq(users.tenant_id, owned.tenant.id)),
  ).toHaveLength(1);
  objects.deleteMany = remove;
  expect(
    (await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).status,
  ).toBe("completed");
});

test("deletion grace deadline never erases early", async () => {
  const { owned, objects } = await fixture("erase-grace", false);
  expect(await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).toEqual({
    status: "skipped",
  });
  expect(await objects.exists(`${owned.tenant.id}/file`)).toBe(true);
});
