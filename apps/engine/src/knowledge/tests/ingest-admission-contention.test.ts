import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  executions,
  fileLinks,
  files,
  hostedTenantUsage,
  knowledgeChunks,
  knowledgeSources,
  tenants,
} from "../../db/schema/index.ts";
import { admitSystemWorkflowExecution } from "../../execution/authority-admission.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { eraseExpiredTenant } from "../../identity/tenant-erasure.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import type { TenantErasureQueue } from "../../queue/tenant-erasure.ts";
import { grantScheduleAuthorityFixture } from "../../scheduler/tests/authority-fixture.ts";
import { getObjectStore, MemoryObjectStore } from "../../storage/object-store.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createKnowledgeSource, ingestKnowledgeSource } from "../service.ts";

const PARKED_MS = 450;
const ADMISSION_RETRY_WINDOW_MS = 400;

let srv: HttpTestServer;
let workflowId: string;
let sourceId: string;

beforeAll(async () => {
  srv = await createHttpTestServer("knowledge-admission-contention", { hosted: true });
  const created = await createWorkflowRow(
    { testDb: srv.testDb, tenantId: srv.tenantId, cleanup: async () => {} },
    {
      name: "contention-wf",
      slug: "contention-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    },
  );
  workflowId = created.workflow_id;
  await grantScheduleAuthorityFixture(srv.db, srv.tenantId, workflowId, "prod", 10);
  const source = await createKnowledgeSource(
    {
      tenant_id: srv.tenantId,
      input: { name: "Contention Runbook", scope: "global" },
      upload: {
        buffer: Buffer.from("# Runbook\n\nInitial content."),
        filename: "runbook.md",
        mime: "text/markdown",
      },
      actor: null,
    },
    srv.db,
  );
  sourceId = source.id;
}, 60_000);

afterAll(async () => {
  if (srv) await srv.cleanup();
}, 60_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function parkObjectWrites() {
  const store = getObjectStore();
  const original = store.put.bind(store);
  const entered = deferred();
  const gate = deferred();
  const spy = spyOn(store, "put").mockImplementation(async (key, bytes) => {
    entered.resolve();
    await gate.promise;
    return original(key, bytes);
  });
  return {
    entered: entered.promise,
    release: () => {
      gate.resolve();
      spy.mockRestore();
    },
  };
}

function sampleTenantLock(tenantId: string) {
  let stopped = false;
  let heldSince: number | null = null;
  let longestMs = 0;
  const done = (async () => {
    while (!stopped) {
      const result = await srv.testDb.pool.query<{ held: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks l, (SELECT hashtextextended($1::text, 741937) AS k) h
           WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
             AND l.classid::bigint = ((h.k >> 32) & 4294967295)
             AND l.objid::bigint = (h.k & 4294967295)
         ) AS held`,
        [tenantId],
      );
      const now = performance.now();
      if (result.rows[0]?.held) {
        heldSince ??= now;
        longestMs = Math.max(longestMs, now - heldSince);
      } else {
        heldSince = null;
      }
      await Bun.sleep(2);
    }
  })();
  return async () => {
    stopped = true;
    await done;
    return Math.round(longestMs);
  };
}

function admissionRetries(): number {
  return (
    getMetrics()
      .snapshot()
      .find((metric) => metric.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL)
      ?.samples.find((sample) => sample.labels.label === "execution_admission_catalog")?.value ?? 0
  );
}

async function admit(idempotency_key: string) {
  const started = performance.now();
  try {
    const admitted = await admitSystemWorkflowExecution(
      {
        tenant_id: srv.tenantId,
        workflow_id: workflowId,
        execution_environment: "prod",
        request_source: "scheduler",
        input: { from: idempotency_key },
        idempotency_key,
      },
      srv.db,
    );
    return {
      ok: true as const,
      execution_id: admitted.execution_id,
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      ok: false as const,
      code: (error as { code?: string }).code ?? null,
      ms: Math.round(performance.now() - started),
    };
  }
}

async function assertExactMetering() {
  const [usage] = await srv.db
    .select({ resource_counts: hostedTenantUsage.resource_counts })
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, srv.tenantId));
  const counted = usage?.resource_counts ?? {};
  const actual = {
    executions: await srv.db.$count(executions, eq(executions.tenant_id, srv.tenantId)),
    files: await srv.db.$count(files, eq(files.tenant_id, srv.tenantId)),
    file_links: await srv.db.$count(fileLinks, eq(fileLinks.tenant_id, srv.tenantId)),
    knowledge_sources: await srv.db.$count(
      knowledgeSources,
      eq(knowledgeSources.tenant_id, srv.tenantId),
    ),
    knowledge_chunks: await srv.db.$count(
      knowledgeChunks,
      eq(knowledgeChunks.tenant_id, srv.tenantId),
    ),
  };
  const metered = Object.fromEntries(
    Object.keys(actual).map((table) => [table, Number(counted[table] ?? "0")]),
  );
  expect(metered).toEqual(actual);
}

function erasureQueue(): TenantErasureQueue {
  return {
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
}

test("a parked knowledge file write no longer holds the tenant lock against concurrent admissions", async () => {
  const parked = parkObjectWrites();
  const stopSampling = sampleTenantLock(srv.tenantId);
  const retriesBefore = admissionRetries();
  const ingest = ingestKnowledgeSource(
    {
      tenant_id: srv.tenantId,
      knowledge_source_id: sourceId,
      upload: {
        buffer: Buffer.from("# Runbook\n\nRefreshed content while admissions run."),
        filename: "runbook.md",
        mime: "text/markdown",
      },
      actor: null,
    },
    srv.db,
  ).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let admissions: Awaited<ReturnType<typeof admit>>[] = [];
  try {
    await parked.entered;
    const parkedAt = performance.now();
    await Bun.sleep(PARKED_MS);
    admissions = await Promise.all([
      admit("contention-first"),
      admit("contention-second"),
      admit("contention-shared"),
      admit("contention-shared"),
    ]);
    expect(performance.now() - parkedAt).toBeGreaterThan(ADMISSION_RETRY_WINDOW_MS);
  } finally {
    parked.release();
  }
  const ingested = await ingest;
  const longestHoldMs = await stopSampling();
  const observed = {
    longest_tenant_lock_hold_ms: longestHoldMs,
    admission_retries: admissionRetries() - retriesBefore,
    admissions: admissions.map((admission) => ({ ok: admission.ok, ms: admission.ms })),
    ingest_ok: ingested.ok,
  };
  expect({
    hold_below_retry_window: observed.longest_tenant_lock_hold_ms < ADMISSION_RETRY_WINDOW_MS,
    admissions_ok: observed.admissions.every((admission) => admission.ok),
    ingest_ok: observed.ingest_ok,
    observed,
  }).toMatchObject({ hold_below_retry_window: true, admissions_ok: true, ingest_ok: true });

  const [first, second, shared, sharedAgain] = admissions;
  if (!first?.ok || !second?.ok || !shared?.ok || !sharedAgain?.ok)
    throw new Error("admission outcome missing");
  expect(new Set([first.execution_id, second.execution_id, shared.execution_id]).size).toBe(3);
  expect(sharedAgain.execution_id).toBe(shared.execution_id);
  expect(
    await srv.db.$count(
      executions,
      and(
        eq(executions.tenant_id, srv.tenantId),
        eq(executions.idempotency_key, "contention-shared"),
      ),
    ),
  ).toBe(1);
  const [source] = await srv.db
    .select({ chunk_count: knowledgeSources.chunk_count, status: knowledgeSources.status })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, sourceId));
  expect(source?.status).toBe("active");
  expect(source?.chunk_count).toBe(
    await srv.db.$count(knowledgeChunks, eq(knowledgeChunks.knowledge_source_id, sourceId)),
  );
  await assertExactMetering();
}, 30_000);

test("erasure stays blocked while an unlocked knowledge file write is in flight", async () => {
  const filesBefore = await srv.db.$count(
    files,
    and(eq(files.tenant_id, srv.tenantId), sql`${files.deleted_at} IS NULL`),
  );
  const chunksBefore = await srv.db.$count(
    knowledgeChunks,
    eq(knowledgeChunks.knowledge_source_id, sourceId),
  );
  const parked = parkObjectWrites();
  const ingest = ingestKnowledgeSource(
    {
      tenant_id: srv.tenantId,
      knowledge_source_id: sourceId,
      upload: {
        buffer: Buffer.from("# Runbook\n\nContent written while erasure is requested."),
        filename: "runbook.md",
        mime: "text/markdown",
      },
      actor: null,
    },
    srv.db,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await parked.entered;
    await srv.db
      .update(tenants)
      .set({
        status: "pending_deletion",
        deletion_requested_at: new Date(getTestNow() - 8 * 86_400_000),
        deletion_scheduled_for: new Date(getTestNow() - 86_400_000),
      })
      .where(eq(tenants.id, srv.tenantId));
    const erased = await eraseExpiredTenant(
      srv.tenantId,
      { queue: erasureQueue(), objects: new MemoryObjectStore() },
      srv.db,
    );
    expect(erased.status).toBe("blocked");
  } finally {
    parked.release();
  }
  expect(await ingest).toMatchObject({ message: "tenant_unavailable" });
  const [tenant] = await srv.db
    .select({ deleted_at: tenants.deleted_at })
    .from(tenants)
    .where(eq(tenants.id, srv.tenantId));
  expect(tenant?.deleted_at).toBeNull();
  expect(
    await srv.db.$count(knowledgeChunks, eq(knowledgeChunks.knowledge_source_id, sourceId)),
  ).toBe(chunksBefore);
  expect(
    await srv.db.$count(
      files,
      and(eq(files.tenant_id, srv.tenantId), sql`${files.deleted_at} IS NULL`),
    ),
  ).toBe(filesBefore);
  await assertExactMetering();
}, 30_000);
