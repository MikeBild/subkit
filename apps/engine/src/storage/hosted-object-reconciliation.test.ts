import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createBrowserSessionProvider } from "../auth/providers/browser-session.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { setConfigKey } from "../config/loader.ts";
import {
  auditLog,
  hostedStorageObjects,
  hostedTenantUsage,
  hostedWorkAdmissions,
  tenants,
} from "../db/schema/index.ts";
import { beginTenantWork, tenantWorkSnapshot } from "../execution/tenant-work.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../http/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { eraseExpiredTenant } from "../identity/tenant-erasure.ts";
import { logRing } from "../observability/log-ring.ts";
import type { TenantErasureQueue } from "../queue/tenant-erasure.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { reconcileHostedObjectAfterReviewedRemoteStop } from "./hosted-object-reconciliation.ts";
import { reserveHostedObject } from "./hosted-objects.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "./object-store.ts";

let ctx: HttpTestServer;
let headers: Record<string, string>;
let principal: ResolvedPrincipal;
let objects: MemoryObjectStore;
const uuid = createDeterministicUuidFactory(77421);
const evidenceCanary = "storage-review-private-evidence-canary";
const evidence = `${evidenceCanary}: A human reviewed the provider's terminal request acknowledgements for this exact key and storage namespace, verified every possible upload origin stopped, and confirmed no remote PUT can finish later.`;
beforeAll(async () => {
  ctx = await createHttpTestServer("storage-reconciliation");
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
  await setConfigKey("storage.object_store.bucket", "storage-review-test", { force: true });
  headers = await browserSessionHeaders(ctx, ctx.userId);
  const resolved = await createBrowserSessionProvider({ db: ctx.db }).resolve(
    new Request(ctx.baseUrl, { headers }),
  );
  if (!resolved) throw new Error("operator browser fixture missing");
  principal = resolved;
});
beforeEach(async () => {
  objects = new MemoryObjectStore();
  setObjectStoreForTesting(objects);
  await policy("50000000");
});
afterAll(async () => {
  setObjectStoreForTesting(null);
  if (ctx) await ctx.cleanup();
});
async function policy(bytes: string, rows = 1000) {
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${bytes}::text)),'{storage,hosted,retained_rows_per_resource}',to_jsonb(${rows}::int)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
}
async function fixture(due = true) {
  const subject = uuid();
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://objects.example.test",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    ctx.db,
  );
  const key = `offload/${owned.tenant.id}/${uuid()}.json`;
  const id = await reserveHostedObject(ctx.db, owned.tenant.id, key, 7);
  if (!id) throw new Error("reservation missing");
  await objects.put(key, Buffer.from("private"));
  const [row] = await ctx.db
    .select()
    .from(hostedStorageObjects)
    .where(
      and(eq(hostedStorageObjects.tenant_id, owned.tenant.id), eq(hostedStorageObjects.id, id)),
    );
  if (!row) throw new Error("reservation missing");
  if (due)
    await ctx.db
      .update(tenants)
      .set({
        status: "pending_deletion",
        deletion_requested_at: new Date(getTestNow() - 8 * 86400000),
        deletion_scheduled_for: new Date(getTestNow() - 86400000),
      })
      .where(eq(tenants.id, owned.tenant.id));
  return { tenantId: owned.tenant.id, row, key };
}
function body(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    reservation_id: f.row.id,
    storage_namespace: f.row.storage_namespace,
    expected_updated_at: f.row.updated_at.toISOString(),
    all_possible_upload_origins_stopped: true as const,
    all_remote_puts_terminal: true as const,
    reviewed_remote_stop_evidence: evidence,
  };
}
function path(tenantId: string) {
  return `${ctx.baseUrl}/v1/settings/hosted-storage/${tenantId}`;
}
function post(
  f: Awaited<ReturnType<typeof fixture>>,
  value: unknown = body(f),
  requestHeaders = headers,
) {
  return fetch(path(f.tenantId), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(value),
  });
}
async function saved(f: Awaited<ReturnType<typeof fixture>>) {
  return ctx.db
    .select()
    .from(hostedStorageObjects)
    .where(
      and(eq(hostedStorageObjects.tenant_id, f.tenantId), eq(hostedStorageObjects.id, f.row.id)),
    );
}

test("real operator browser auth and CSRF protect remote-upload review", async () => {
  const f = await fixture();
  expect((await fetch(path(f.tenantId))).status).toBe(401);
  const bearer = { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
  expect((await fetch(path(f.tenantId), { headers: bearer })).status).toBe(403);
  expect((await post(f, body(f), bearer)).status).toBe(403);
  const noCsrf = { ...headers };
  delete noCsrf["x-subkit-csrf"];
  expect((await post(f, body(f), noCsrf)).status).toBe(403);
  expect((await post(f, body(f), { ...headers, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect(await saved(f)).toHaveLength(1);
  const listed = await fetch(path(f.tenantId), { headers });
  expect(listed.status).toBe(200);
  expect((await listed.json()).items).toContainEqual(
    expect.objectContaining({
      reservation_id: f.row.id,
      storage_namespace: f.row.storage_namespace,
    }),
  );
});

test("per-object terminal proof is mandatory even when all work admissions were released", async () => {
  const f = await fixture();
  for (const patch of [
    { all_remote_puts_terminal: false },
    { all_possible_upload_origins_stopped: false },
    { reviewed_remote_stop_evidence: "owner process stopped" },
  ]) {
    expect((await post(f, { ...body(f), ...patch })).status).toBe(400);
  }
  expect(await saved(f)).toHaveLength(1);
  expect(await objects.head(f.key)).not.toBeNull();
});

test("wrong namespace, stale snapshot, neighboring reservation and active tenant fail closed", async () => {
  const f = await fixture();
  const neighbor = await fixture();
  const active = await fixture(false);
  for (const patch of [
    { storage_namespace: "0".repeat(64) },
    { expected_updated_at: new Date(getTestNow() - 86400000).toISOString() },
    { reservation_id: neighbor.row.id },
  ])
    expect((await post(f, { ...body(f), ...patch })).status).toBe(409);
  expect((await post(active)).status).toBe(409);
  expect(await saved(f)).toHaveLength(1);
  expect(await saved(neighbor)).toHaveLength(1);
});

test("local producers and persisted unresolved admissions prevent cleanup", async () => {
  const f = await fixture();
  const finish = beginTenantWork(f.tenantId);
  try {
    expect((await post(f)).status).toBe(409);
  } finally {
    finish();
  }
  await ctx.db
    .insert(hostedWorkAdmissions)
    .values({ tenant_id: f.tenantId, kind: "execution", state: "active", owner_boot_id: uuid() });
  expect((await post(f)).status).toBe(409);
  expect(await objects.head(f.key)).not.toBeNull();
});

test("verified object absence releases quota once, binds replay and allows actual erasure at zero allowance", async () => {
  const f = await fixture();
  const queue: TenantErasureQueue = {
    async getQueues() {
      return [];
    },
    async getSchedules() {
      return [];
    },
    async findJobs() {
      return [];
    },
    async cancel() {},
    async deleteJob() {},
    async unschedule() {},
  };
  expect(await eraseExpiredTenant(f.tenantId, { queue, objects }, ctx.db)).toEqual({
    status: "blocked",
    reason: "object_cleanup_failed",
  });
  const [beforeUsage] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, f.tenantId));
  if (!beforeUsage) throw new Error("missing usage");
  await policy("0", Number(beforeUsage.resource_counts.audit_log ?? "0"));
  logRing.clear();
  const response = await post(f);
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt).toMatchObject({ reservation_id: f.row.id, state: "resolved_absent" });
  expect(JSON.stringify(receipt)).not.toContain(evidence);
  expect(await saved(f)).toHaveLength(0);
  expect(await objects.head(f.key)).toBeNull();
  const [usage] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, f.tenantId));
  expect(usage?.logical_bytes).toBe(beforeUsage.logical_bytes - f.row.declared_bytes);
  expect(usage?.resource_counts.audit_log).toBe(beforeUsage.resource_counts.audit_log);
  expect((await post(f)).status).toBe(200);
  const [afterReplay] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, f.tenantId));
  expect(afterReplay?.logical_bytes).toBe(usage?.logical_bytes);
  expect(
    (await post(f, { ...body(f), reviewed_remote_stop_evidence: `${evidence} Different proof.` }))
      .status,
  ).toBe(409);
  expect(
    (
      await post(f, {
        ...body(f),
        expected_updated_at: new Date(getTestNow() - 86400000).toISOString(),
      })
    ).status,
  ).toBe(409);
  const receipts = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.tenantId),
        eq(auditLog.action, "hosted_storage_object.reconciled"),
      ),
    );
  expect(receipts).toHaveLength(1);
  expect(JSON.stringify(receipts)).not.toContain(evidenceCanary);
  expect(JSON.stringify(logRing.tail({ limit: 1000 }))).not.toContain(evidenceCanary);
  expect(await eraseExpiredTenant(f.tenantId, { queue, objects }, ctx.db)).toEqual({
    status: "completed",
  });
  const [erasedUsage] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, f.tenantId));
  expect(erasedUsage?.logical_bytes).toBe(0n);
});

test("failed delete or present HEAD rolls back the receipt and keeps storage charged", async () => {
  for (const mode of ["delete_failure", "present"]) {
    const f = await fixture();
    class Store extends MemoryObjectStore {
      override async delete() {
        if (mode === "delete_failure") throw new Error("private-provider-canary");
      }
    }
    const store = new Store();
    await store.put(f.key, Buffer.from("private"));
    setObjectStoreForTesting(store);
    const response = await post(f);
    expect(response.status).toBe(mode === "delete_failure" ? 503 : 409);
    expect(await response.text()).not.toContain("private-provider-canary");
    expect((await saved(f))[0]?.state).toBe("pending");
    const receipt = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, f.tenantId),
          eq(auditLog.action, "hosted_storage_object.reconciled"),
        ),
      );
    expect(receipt).toHaveLength(0);
  }
});

test("bounded DELETE and HEAD timeouts cannot become producer stop acknowledgements", async () => {
  for (const operation of ["delete", "head"] as const) {
    const f = await fixture();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    class Store extends MemoryObjectStore {
      override async delete() {
        if (operation === "delete") await pending;
      }
      override async head() {
        if (operation === "head") await pending;
        return null;
      }
    }
    const review = reconcileHostedObjectAfterReviewedRemoteStop(
      ctx.db,
      f.tenantId,
      principal,
      body(f),
      { objects: new Store(), operationTimeoutMs: 1 },
    );
    try {
      await expect(review).rejects.toMatchObject({ code: "storage_operation_failed" });
      expect(tenantWorkSnapshot(f.tenantId).in_flight).toBe(1);
      expect((await saved(f))[0]?.state).toBe("pending");
      expect((await post(f)).status).toBe(409);
    } finally {
      release();
      await waitFor(() => tenantWorkSnapshot(f.tenantId).in_flight === 0);
    }
  }
});
