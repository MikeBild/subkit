import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { FindJobsOptions, JobWithMetadata } from "pg-boss";
import { createMigrationDbFromUrl } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../db/migrations/embedded.ts";
import {
  auditLog,
  authIdentities,
  cockpitInstallations,
  cockpitPushKeys,
  cockpitPushSubscriptions,
  hostedBudgetReservations,
  hostedTenantUsage,
  hostedWorkAdmissions,
  runtimeConfigReplicas,
  runtimeConfigRevisions,
  runtimeSecretVersions,
  sessions,
  tenantBranding,
  tenantErasureStates,
  tenants,
  users,
} from "../db/schema/index.ts";
import { createTestDb } from "../db/tests/setup.ts";
import { beginTenantWork } from "../execution/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { createBoss } from "../queue/boss.ts";
import type { TenantErasureQueue } from "../queue/tenant-erasure.ts";
import { configDigest } from "../runtime-config/document.ts";
import { runTenantErasureSweep } from "../scheduler/tenant-erasure-runner.ts";
import { reserveHostedObject, retainHostedObject } from "../storage/hosted-objects.ts";
import { MemoryObjectStore } from "../storage/object-store.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { provisionSelfServiceTenant } from "./self-service.ts";
import { eraseExpiredTenant } from "./tenant-erasure.ts";
import { erasureTableOrder } from "./tenant-erasure-schema.ts";
import { requestOwnedTenantDeletion } from "./tenant-lifecycle.ts";

const nextUuid = createDeterministicUuidFactory(89712);
let ctx: HttpTestServer;
beforeAll(async () => {
  ctx = await createHttpTestServer("tenant-erasure");
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
function queue(activeTenant?: string): TenantErasureQueue & { canceled: number } {
  let active = !!activeTenant;
  return {
    canceled: 0,
    async getQueues() {
      return [{ name: "execution.run" }];
    },
    async getSchedules() {
      return [];
    },
    async findJobs<T>(_name: string, options?: FindJobsOptions) {
      return (
        active &&
        options?.data &&
        (options.data as { tenant_id?: string }).tenant_id === activeTenant
          ? [{ id: "exact-job", state: "active", data: { tenant_id: activeTenant } }]
          : []
      ) as JobWithMetadata<T>[];
    },
    async cancel(_name, ids) {
      expect(ids).toEqual(["exact-job"]);
      this.canceled += 1;
      active = false;
    },
    async deleteJob() {},
    async unschedule() {},
  };
}
async function fixture(
  name: string,
  due = true,
  trackOffload = false,
  scope: Pick<HttpTestServer, "db"> = ctx,
) {
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://erase.example.test",
      subject: name,
      email: `${name}@example.test`,
      email_verified: true,
    },
    scope.db,
  );
  const objects = new MemoryObjectStore();
  const objectKey = `offload/${owned.tenant.id}/${nextUuid()}.json`;
  const reservation = trackOffload
    ? await reserveHostedObject(scope.db, owned.tenant.id, objectKey, 7)
    : null;
  await objects.put(`${owned.tenant.id}/file`, Buffer.from("private"));
  await objects.put(objectKey, Buffer.from("private"));
  if (reservation) await retainHostedObject(scope.db, owned.tenant.id, reservation);
  await scope.db
    .update(tenants)
    .set({
      status: "pending_deletion",
      deletion_requested_at: new Date(getTestNow() - 8 * 86_400_000),
      deletion_scheduled_for: new Date(getTestNow() + (due ? -1 : 1) * 86_400_000),
    })
    .where(eq(tenants.id, owned.tenant.id));
  return { owned, objects };
}

test("erasure schema classifies every product table and orders children before parents", () => {
  const order = erasureTableOrder();
  expect(order.indexOf("conversation_messages")).toBeLessThan(order.indexOf("conversations"));
  expect(order.indexOf("user_invites")).toBeLessThan(order.indexOf("users"));
  expect(order).not.toContain("auth_identities");
  expect(order).not.toContain("hosted_budget_reservations");
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

test("expired owned tenant erases online content and objects while retaining ownership and budget cap", async () => {
  const { owned, objects } = await fixture("erase-owner", true, true);
  const foreign = await fixture("erase-foreign", false);
  await objects.put(`${foreign.owned.tenant.id}/untouched`, Buffer.from("foreign"));
  await ctx.db.insert(hostedBudgetReservations).values({
    tenant_id: owned.tenant.id,
    request_key: createHash("sha256").update("sensitive-request@example.test").digest("hex"),
    month_bucket: "2000-01",
    currency: "USD",
    model: "provider:model",
    reserved_microunits: 100n,
    state: "reserved",
  });
  await ctx.db.insert(hostedBudgetReservations).values([
    {
      tenant_id: owned.tenant.id,
      request_key: createHash("sha256").update("old-settled").digest("hex"),
      month_bucket: "2000-01",
      currency: "USD",
      model: "provider:model",
      reserved_microunits: 100n,
      reported_microunits: 50n,
      state: "settled",
    },
    {
      tenant_id: owned.tenant.id,
      request_key: createHash("sha256").update("current-settled").digest("hex"),
      month_bucket: new Date(getTestNow()).toISOString().slice(0, 7),
      currency: "USD",
      model: "provider:model",
      reserved_microunits: 100n,
      reported_microunits: 50n,
      state: "settled",
    },
  ]);
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
  const budgets = await ctx.db
    .select()
    .from(hostedBudgetReservations)
    .where(eq(hostedBudgetReservations.tenant_id, owned.tenant.id));
  const budget = budgets.find((row) => row.state === "reserved");
  expect(budgets).toHaveLength(2);
  expect(budgets.filter((row) => row.month_bucket === "2000-01").map((row) => row.state)).toEqual([
    "reserved",
  ]);
  expect(budget?.state).toBe("reserved");
  expect(budget?.reserved_microunits).toBe(100n);
  expect(budget?.request_key).toMatch(/^[0-9a-f]{64}$/);
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

test("shared global identity and foreign runtime overlay survive exact tenant erasure", async () => {
  const firstGuard = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.statements.some(
      (statement) =>
        statement.includes("runtime_secret_owner_guard()") ||
        statement.includes("hosted_runtime_secret_overlay_forbidden"),
    ),
  );
  if (!firstGuard) throw new Error("runtime secret ownership migration missing");
  expect(firstGuard.tag.endsWith("_runtime_secret_ownership")).toBe(true);
  const ctx = await createHttpTestServer("erasure-legacy-runtime", {
    testDbOptions: { upToIdx: firstGuard.idx - 1 },
  });
  try {
    await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
    const owned = await provisionSelfServiceTenant(
      {
        issuer_url: "https://erase.example.test",
        subject: "erase-shared",
        email: "erase-shared@example.test",
        email_verified: true,
      },
      ctx.db,
    );
    const objects = new MemoryObjectStore();
    await objects.put(`${owned.tenant.id}/file`, Buffer.from("private"));
    await ctx.db.insert(users).values({
      tenant_id: ctx.tenantId,
      auth_identity_id: owned.identity.id,
      email: "retained@example.test",
      role_id: owned.membership.role_id,
    });
    const document = {
      global: { label: "operator" },
      tenants: { [owned.tenant.id]: { label: "sensitive" }, [ctx.tenantId]: { label: "foreign" } },
    };
    const [revision] = await ctx.db
      .insert(runtimeConfigRevisions)
      .values({ document, digest: configDigest(document) })
      .returning();
    if (!revision) throw new Error("revision missing");
    await ctx.testDb.pool.query(
      "INSERT INTO subkit.runtime_secret_versions(name,version,ciphertext,iv,auth_tag,pending_bindings) VALUES($1,1,$2,$3,$4,NULL),('global.retained',1,$5,$3,$4,$6::jsonb)",
      [
        `tenants.${owned.tenant.id}.secret`,
        Buffer.from("sensitive"),
        Buffer.alloc(12),
        Buffer.alloc(16),
        Buffer.from("foreign"),
        JSON.stringify([`tenants.${owned.tenant.id}.key`, `tenants.${ctx.tenantId}.key`]),
      ],
    );
    await ctx.db
      .update(tenants)
      .set({
        status: "pending_deletion",
        deletion_requested_at: new Date(getTestNow() - 8 * 86400000),
        deletion_scheduled_for: new Date(getTestNow() - 86400000),
      })
      .where(eq(tenants.id, owned.tenant.id));
    const migration = createMigrationDbFromUrl(ctx.testDb.url);
    try {
      expect((await runMigrations(migration.db)).hash_drift_backfilled).toBe(0);
    } finally {
      await migration.pool.end();
    }
    const [upgraded] = await ctx.db
      .select()
      .from(runtimeSecretVersions)
      .where(eq(runtimeSecretVersions.name, `tenants.${owned.tenant.id}.secret`));
    expect(upgraded?.tenant_id).toBe(owned.tenant.id);
    expect(upgraded?.ciphertext).toEqual(Buffer.from("sensitive"));
    expect(
      (await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).status,
    ).toBe("completed");
    const [identity] = await ctx.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, owned.identity.id));
    expect(identity?.email).toBe("erase-shared@example.test");
    const [cleaned] = await ctx.db
      .select()
      .from(runtimeConfigRevisions)
      .where(eq(runtimeConfigRevisions.revision, revision.revision));
    expect(cleaned?.document).toEqual({
      global: { label: "operator" },
      tenants: { [ctx.tenantId]: { label: "foreign" } },
    });
    expect(cleaned?.digest).toBe(configDigest(cleaned?.document ?? {}));
    const versions = await ctx.db.select().from(runtimeSecretVersions);
    expect(versions.some((row) => row.name === `tenants.${owned.tenant.id}.secret`)).toBe(false);
    expect(versions.find((row) => row.name === "global.retained")?.pending_bindings).toEqual([
      `tenants.${ctx.tenantId}.key`,
    ]);
    expect(versions.find((row) => row.name === "global.retained")?.ciphertext).toEqual(
      Buffer.from("foreign"),
    );
  } finally {
    await ctx.cleanup();
  }
});

test("foreign tenant reference blocks before object or database erasure", async () => {
  const { owned, objects } = await fixture("erase-foreign-reference");
  const [member] = await ctx.db.select().from(users).where(eq(users.tenant_id, owned.tenant.id));
  if (!member) throw new Error("member missing");
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: member.id,
      expires_at: new Date(getTestNow() + 60_000),
      absolute_expires_at: new Date(getTestNow() + 60_000),
    })
    .returning();
  expect(await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).toEqual({
    status: "blocked",
    reason: "tenant_reference_review_required",
  });
  expect(await objects.exists(`${owned.tenant.id}/file`)).toBe(true);
  expect(
    await ctx.db.select().from(users).where(eq(users.tenant_id, owned.tenant.id)),
  ).toHaveLength(1);
  if (session) await ctx.db.delete(sessions).where(eq(sessions.id, session.id));
});

test("unresolved persisted producer survives cancellation and blocks content erasure", async () => {
  const { owned, objects } = await fixture("erase-persisted-work");
  await ctx.db.insert(hostedWorkAdmissions).values({
    tenant_id: owned.tenant.id,
    kind: "execution",
    state: "reconciliation_required",
    owner_boot_id: nextUuid(),
  });
  expect(await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).toEqual({
    status: "blocked",
    reason: "producer_drain_required",
  });
  expect(await objects.exists(`${owned.tenant.id}/file`)).toBe(true);
  expect(
    await ctx.db.select().from(users).where(eq(users.tenant_id, owned.tenant.id)),
  ).toHaveLength(1);
});

test("real public queue erasure removes exact jobs with SDK scheduling disabled", async () => {
  const { owned, objects } = await fixture("erase-real-queue");
  const foreign = nextUuid();
  const boss = await createBoss({ connectionString: ctx.testDb.url });
  try {
    expect(await boss.getSchedules()).toHaveLength(0);
    expect((await boss.getQueues()).some((queue) => queue.name === "__pgboss__send-it")).toBe(
      false,
    );
    await boss.send("execution.run", { tenant_id: owned.tenant.id });
    const foreignId = await boss.send("execution.run", { tenant_id: foreign });
    expect(
      (await eraseExpiredTenant(owned.tenant.id, { queue: boss, objects }, ctx.db)).status,
    ).toBe("completed");
    expect(
      await boss.findJobs("execution.run", { data: { tenant_id: owned.tenant.id } }),
    ).toHaveLength(0);
    expect(
      (await boss.findJobs("execution.run", { data: { tenant_id: foreign } })).map((job) => job.id),
    ).toEqual([foreignId as string]);
  } finally {
    await boss.stop();
  }
});

test("bounded lifecycle sweep finishes twenty tenants then continues without blocked-tenant starvation", async () => {
  const isolated = await createTestDb("erasure-bounded-sweep");
  try {
    await configureHostedPolicyForTests(isolated.db, isolated.url);
    const blocked = await fixture("erase-sweep-blocked", true, false, isolated);
    const [foreign] = await isolated.db
      .insert(tenants)
      .values({ slug: "sweep-reference-owner", display_name: "Sweep reference owner" })
      .returning();
    if (!foreign) throw new Error("foreign reference fixture missing");
    await isolated.db.insert(sessions).values({
      tenant_id: foreign.id,
      user_id: blocked.owned.membership.user_id,
      expires_at: new Date(getTestNow() + 60000),
      absolute_expires_at: new Date(getTestNow() + 60000),
    });
    expect(
      await eraseExpiredTenant(
        blocked.owned.tenant.id,
        { queue: queue(), objects: blocked.objects },
        isolated.db,
      ),
    ).toEqual({ status: "blocked", reason: "tenant_reference_review_required" });
    const objects = new MemoryObjectStore();
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const { owned } = await fixture(`erase-sweep-${i}`, true, false, isolated);
      ids.push(owned.tenant.id);
      await objects.put(`${owned.tenant.id}/file`, Buffer.from("synthetic"));
    }
    const dependencies = () => ({ queue: queue(), objects });
    expect(await runTenantErasureSweep(isolated.db, dependencies)).toEqual({
      examined: 20,
      completed: 20,
      blocked: 0,
    });
    expect(await runTenantErasureSweep(isolated.db, dependencies)).toEqual({
      examined: 1,
      completed: 1,
      blocked: 0,
    });
    for (const id of ids) expect(await objects.list(`${id}/`)).toHaveLength(0);
    expect(await blocked.objects.exists(`${blocked.owned.tenant.id}/file`)).toBe(true);
  } finally {
    await isolated.cleanup();
  }
});

test("multiple live replicas cannot begin destructive erasure", async () => {
  const { owned, objects } = await fixture("erase-multiple");
  const replicas = [nextUuid(), nextUuid()];
  await ctx.db
    .insert(runtimeConfigReplicas)
    .values(replicas.map((instance_id) => ({ instance_id, product_version: "test" })));
  try {
    await expect(
      eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db),
    ).rejects.toThrow("tenant_erasure_multiple_replicas_unsupported");
    expect(await objects.exists(`${owned.tenant.id}/file`)).toBe(true);
  } finally {
    await ctx.db
      .delete(runtimeConfigReplicas)
      .where(inArray(runtimeConfigReplicas.instance_id, replicas));
  }
});

test("foreign boot cancellation never treats a process restart as a producer acknowledgement", async () => {
  const { owned, objects } = await fixture("erase-foreign-boot");
  await ctx.db
    .insert(tenantErasureStates)
    .values({ tenant_id: owned.tenant.id, drain_boot_id: nextUuid() });
  expect(await eraseExpiredTenant(owned.tenant.id, { queue: queue(), objects }, ctx.db)).toEqual({
    status: "blocked",
    reason: "producer_drain_evidence_required",
  });
  expect(await objects.exists(`${owned.tenant.id}/file`)).toBe(true);
});

test("an unknown remote object upload blocks erasure even after local producers stop", async () => {
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://erase.example.test",
      subject: "unknown-upload",
      email: "unknown-upload@example.test",
      email_verified: true,
    },
    ctx.db,
  );
  const key = `offload/${owned.tenant.id}/${nextUuid()}.json`;
  await reserveHostedObject(ctx.db, owned.tenant.id, key, 100);
  await ctx.db
    .update(tenants)
    .set({
      status: "pending_deletion",
      deletion_requested_at: new Date(getTestNow() - 8 * 86_400_000),
      deletion_scheduled_for: new Date(getTestNow() - 86_400_000),
    })
    .where(eq(tenants.id, owned.tenant.id));
  const result = await eraseExpiredTenant(
    owned.tenant.id,
    { queue: queue(), objects: new MemoryObjectStore() },
    ctx.db,
  );
  expect(result).toEqual({ status: "blocked", reason: "object_cleanup_failed" });
  const [tenant] = await ctx.db.select().from(tenants).where(eq(tenants.id, owned.tenant.id));
  expect(tenant?.deleted_at).toBeNull();
});

test("zero growth policy still erases a short tenant name and retains zero charged bytes", async () => {
  const isolated = await createTestDb("erasure-disabled-growth");
  try {
    await configureHostedPolicyForTests(isolated.db, isolated.url);
    const owned = await provisionSelfServiceTenant(
      {
        issuer_url: "https://erase.example.test",
        subject: "zero-growth",
        email: "zero-growth@example.test",
        email_verified: true,
      },
      isolated.db,
    );
    await isolated.db
      .update(tenants)
      .set({ display_name: "A" })
      .where(eq(tenants.id, owned.tenant.id));
    const expires = new Date(getTestNow() + 86_400_000);
    const [session] = await isolated.db
      .insert(sessions)
      .values({
        tenant_id: owned.tenant.id,
        user_id: owned.membership.user_id,
        auth_identity_id: owned.identity.id,
        expires_at: expires,
        absolute_expires_at: expires,
        last_seen_at: new Date(getTestNow()),
        token_sha256: createHash("sha256").update("zero-growth-session").digest("hex"),
      })
      .returning();
    await requestOwnedTenantDeletion(
      {
        tenant_id: owned.tenant.id,
        user_id: owned.membership.user_id,
        session_id: session!.id,
        confirmation: "A",
      },
      isolated.db,
    );
    await isolated.db
      .update(tenants)
      .set({
        deletion_requested_at: new Date(getTestNow() - 8 * 86_400_000),
        deletion_scheduled_for: new Date(getTestNow() - 86_400_000),
      })
      .where(eq(tenants.id, owned.tenant.id));
    await isolated.db.execute(
      sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}','"0"'::jsonb) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
    );
    expect(
      await eraseExpiredTenant(
        owned.tenant.id,
        { queue: queue(), objects: new MemoryObjectStore() },
        isolated.db,
      ),
    ).toEqual({ status: "completed" });
    const [usage] = await isolated.db
      .select()
      .from(hostedTenantUsage)
      .where(eq(hostedTenantUsage.tenant_id, owned.tenant.id));
    expect(usage?.logical_bytes).toBe(0n);
    const [receipt] = await isolated.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, owned.tenant.id));
    expect(receipt?.action).toBe("tenant.deleted");
  } finally {
    await isolated.cleanup();
  }
});
