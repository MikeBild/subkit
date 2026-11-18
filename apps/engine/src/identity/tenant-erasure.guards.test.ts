import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  authIdentities,
  hostedTenantUsage,
  hostedWorkAdmissions,
  runtimeConfigReplicas,
  runtimeConfigRevisions,
  runtimeSecretVersions,
  sessions,
  tenantErasureStates,
  tenants,
  users,
} from "../db/schema/index.ts";
import { createTestDb } from "../db/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { createBoss } from "../queue/boss.ts";
import { configDigest } from "../runtime-config/document.ts";
import { runTenantErasureSweep } from "../scheduler/tenant-erasure-runner.ts";
import { reserveHostedObject } from "../storage/hosted-objects.ts";
import { MemoryObjectStore } from "../storage/object-store.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { provisionSelfServiceTenant } from "./self-service.ts";
import { eraseExpiredTenant } from "./tenant-erasure.ts";
import { queue, tenantErasureFixtures } from "./tenant-erasure-fixtures.ts";
import { requestOwnedTenantDeletion } from "./tenant-lifecycle.ts";

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

test("shared global identity and foreign runtime overlay survive exact tenant erasure", async () => {
  const ctx = await createHttpTestServer("erasure-shared-runtime");
  try {
    await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
    const owned = await provisionSelfServiceTenant(
      {
        issuer_url: "https://erase.example.test",
        subject: "erase-shared",
        email: "erase-shared@example.test",
        email_verified: true,
      },
      TEST_WORKSPACE_REGISTRATION,
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
    const seeder = await ctx.testDb.pool.connect();
    try {
      await seeder.query("BEGIN");
      await seeder.query(
        "ALTER TABLE subkit.runtime_secret_versions DISABLE TRIGGER runtime_secret_owner_guard",
      );
      await seeder.query(
        "INSERT INTO subkit.runtime_secret_versions(tenant_id,name,version,ciphertext,iv,auth_tag,pending_bindings) VALUES($7,$1,1,$2,$3,$4,NULL),(NULL,'global.retained',1,$5,$3,$4,$6::jsonb)",
        [
          `tenants.${owned.tenant.id}.secret`,
          Buffer.from("sensitive"),
          Buffer.alloc(12),
          Buffer.alloc(16),
          Buffer.from("foreign"),
          JSON.stringify([`tenants.${owned.tenant.id}.key`, `tenants.${ctx.tenantId}.key`]),
          owned.tenant.id,
        ],
      );
      await seeder.query(
        "ALTER TABLE subkit.runtime_secret_versions ENABLE TRIGGER runtime_secret_owner_guard",
      );
      await seeder.query("COMMIT");
    } finally {
      seeder.release();
    }
    await ctx.db
      .update(tenants)
      .set({
        status: "pending_deletion",
        deletion_requested_at: new Date(getTestNow() - 8 * 86400000),
        deletion_scheduled_for: new Date(getTestNow() - 86400000),
      })
      .where(eq(tenants.id, owned.tenant.id));
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
}, 30_000);

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
    TEST_WORKSPACE_REGISTRATION,
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
      TEST_WORKSPACE_REGISTRATION,
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
}, 30_000);
