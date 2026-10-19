import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import type { Request as BossRequest, PgBoss, SendOptions } from "pg-boss";
import { z } from "zod";
import {
  auditLog,
  connectors,
  knowledgeSources,
  schedulerSweepCursors,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { tenantWorkSnapshot } from "../execution/index.ts";
import { logRing } from "../observability/log-ring.ts";
import { createBoss, disposeBoss } from "../queue/boss.ts";
import { INGEST_DOCS_QUEUE, type IngestDocsJob } from "../queue/handlers/ingest-docs.ts";
import {
  INGEST_KNOWLEDGE_QUEUE,
  type IngestKnowledgeJob,
} from "../queue/handlers/ingest-knowledge.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import {
  REFRESH_ADDRESS_MAX_BYTES,
  REFRESH_CRON_MAX_BYTES,
} from "./refresh-producer-projection.ts";
import { runDocsRefreshSweep, runKnowledgeRefreshSweep } from "./refresh-producer-runner.ts";
import { SWEEP_PAGE_LIMIT } from "./sweep-cursor.ts";

const uuid = createDeterministicUuidFactory(0x5c0ef123);
const now = new Date(getTestNow());
let fixture: TestDb;
let boss: PgBoss;
let tenantId: string;

async function addDocs(config: Record<string, unknown>, cron = "every:60", tenant_id = tenantId) {
  const id = uuid();
  await fixture.db.insert(connectors).values({
    id,
    tenant_id,
    slug: id,
    display_name: "Refresh fixture",
    driver: "http",
    config,
    auto_refresh_cron: cron,
    created_at: now,
  });
  return id;
}
async function addKnowledge(
  address = "https://example.test/knowledge",
  source_type = "url",
  tenant_id = tenantId,
) {
  const id = uuid();
  await fixture.db.insert(knowledgeSources).values({
    id,
    tenant_id,
    name: "Refresh fixture",
    slug: id,
    version: "fixture",
    source_type,
    source_uri: address,
    refresh_strategy: "scheduled",
    refresh_cron: "every:60",
    created_at: now,
  });
  return id;
}
function docsConfig() {
  return { docs_source_type: "openapi", docs_source_url: "https://example.test/docs" };
}
async function docsStamp(id: string) {
  const [row] = await fixture.db
    .select({ at: connectors.last_ingested_at })
    .from(connectors)
    .where(and(eq(connectors.id, id), eq(connectors.tenant_id, tenantId)));
  return row?.at;
}
async function knowledgeStamp(id: string) {
  const [row] = await fixture.db
    .select({ at: knowledgeSources.last_refreshed_at })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.id, id), eq(knowledgeSources.tenant_id, tenantId)));
  return row?.at;
}

beforeAll(async () => {
  fixture = await createTestDb("refresh_sweep");
  boss = await createBoss({ connectionString: fixture.url, schema: "refresh_jobs" });
}, TEST_DB_HOOK_TIMEOUT);
beforeEach(async () => {
  await boss.deleteAllJobs();
  await fixture.db.delete(tenants);
  await fixture.db.delete(auditLog);
  await fixture.db.update(schedulerSweepCursors).set({
    epoch: 0,
    revision: 0,
    after_id: null,
    epoch_upper_id: null,
    epoch_cutoff_at: null,
    lease_owner_boot_id: null,
    lease_token: null,
    lease_until: null,
    updated_at: sql`date_trunc('milliseconds', clock_timestamp())`,
  });
  tenantId = uuid();
  await fixture.db
    .insert(tenants)
    .values({ id: tenantId, slug: tenantId, display_name: "Refresh tenant", created_at: now });
});
afterAll(async () => {
  if (boss) await disposeBoss(boss);
  if (fixture) await fixture.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

for (const producer of ["docs", "knowledge"] as const) {
  test(`${producer} public SDK handoff progresses beyond two pages without duplicate concurrent admission`, async () => {
    const ids: string[] = [];
    for (let index = 0; index < SWEEP_PAGE_LIMIT * 2 + 3; index++)
      ids.push(producer === "docs" ? await addDocs(docsConfig()) : await addKnowledge());
    const queue = producer === "docs" ? INGEST_DOCS_QUEUE : INGEST_KNOWLEDGE_QUEUE;
    const run = producer === "docs" ? runDocsRefreshSweep : runKnowledgeRefreshSweep;
    for (let pass = 0; pass < 8; pass++) {
      await Promise.all([run(fixture.db, boss, now), run(fixture.db, boss, now)]);
      const jobs = await boss.findJobs<IngestDocsJob & IngestKnowledgeJob>(queue);
      const actual = jobs.map((job) =>
        producer === "docs" ? job.data.connector_id : job.data.knowledge_source_id,
      );
      expect(new Set(actual).size).toBe(actual.length);
      if (jobs.length === ids.length) break;
    }
    const jobs = await boss.findJobs<IngestDocsJob & IngestKnowledgeJob>(queue);
    expect(
      jobs
        .map((job) => (producer === "docs" ? job.data.connector_id : job.data.knowledge_source_id))
        .sort(),
    ).toEqual(ids.sort());
    await run(fixture.db, boss, now);
    expect(await boss.findJobs(queue)).toHaveLength(ids.length);
  }, 30_000);
}

test("guarded docs projections reject malformed or oversized relevant fields and keep later work progressing", async () => {
  const marker = "fixture-unrelated-source-body";
  const kept = await addDocs({
    ...docsConfig(),
    unrelated: marker.repeat(Math.ceil((2 * REFRESH_ADDRESS_MAX_BYTES) / marker.length)),
  });
  const skipped = [
    await addDocs({
      ...docsConfig(),
      docs_source_url: "é".repeat(REFRESH_ADDRESS_MAX_BYTES / 2 + 1),
    }),
    await addDocs(docsConfig(), "x".repeat(REFRESH_CRON_MAX_BYTES + 1)),
    await addDocs({ ...docsConfig(), docs_source_type: "x".repeat(65) }),
    await addDocs({ ...docsConfig(), docs_source_url: { url: "https://example.test" } }),
    await addDocs({ ...docsConfig(), docs_source_url: 5 }),
    await addDocs({ ...docsConfig(), docs_source_type: "file_upload" }),
  ];
  const next = await addDocs(docsConfig());
  await runDocsRefreshSweep(fixture.db, boss, now);
  const jobs = await boss.findJobs<IngestDocsJob>(INGEST_DOCS_QUEUE);
  expect(jobs.map((job) => job.data.connector_id).sort()).toEqual([kept, next].sort());
  expect(JSON.stringify(jobs.map((job) => job.data)).includes(marker)).toBe(false);
  for (const id of skipped) expect(await docsStamp(id)).toBeNull();
  expect(await docsStamp(kept)).toEqual(now);
});

test("knowledge refresh excludes oversized addresses, collected-content targets and inactive parents", async () => {
  const oversized = await addKnowledge("x".repeat(REFRESH_ADDRESS_MAX_BYTES + 1));
  const bundle = await addKnowledge("intake:fixture", "bundle");
  const inactive = uuid();
  await fixture.db.insert(tenants).values({
    id: inactive,
    slug: inactive,
    display_name: "Suspended refresh tenant",
    status: "suspended",
    created_at: now,
  });
  await addKnowledge("https://example.test/suspended", "url", inactive);
  const ready = await addKnowledge();
  await runKnowledgeRefreshSweep(fixture.db, boss, now);
  const jobs = await boss.findJobs<IngestKnowledgeJob>(INGEST_KNOWLEDGE_QUEUE);
  expect(jobs.map((job) => job.data.knowledge_source_id)).toEqual([ready]);
  expect(jobs[0]?.data).toMatchObject({ content: "", actor: null, read_address_again: true });
  expect(await knowledgeStamp(oversized)).toBeNull();
  expect(await knowledgeStamp(bundle)).toBeNull();
});

test("microsecond source births remain eligible and private addresses never enter admission receipts", async () => {
  const address = "https://example.test/docs?signed=fixture-private-address";
  const id = await addDocs({ ...docsConfig(), docs_source_url: address });
  await fixture.db.execute(
    sql`UPDATE ${connectors} SET created_at = ${now}::timestamptz + interval '123 microseconds' WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid`,
  );
  await runDocsRefreshSweep(fixture.db, boss, now);
  const jobs = await boss.findJobs<IngestDocsJob>(INGEST_DOCS_QUEUE);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.data.url).toBe(address);
  const entries = await fixture.db.select().from(auditLog);
  expect(JSON.stringify(entries).includes("fixture-private-address")).toBe(false);
  expect(await docsStamp(id)).toEqual(now);
});

test("a null actual public SDK send keeps the exact source due without claiming equivalent work", async () => {
  const id = await addDocs(docsConfig());
  await boss.deleteQueue(INGEST_DOCS_QUEUE);
  await boss.createQueue(INGEST_DOCS_QUEUE, { policy: "short" });
  try {
    const existing = await boss.send(INGEST_DOCS_QUEUE, { fixture: true });
    expect(typeof existing).toBe("string");
    await runDocsRefreshSweep(fixture.db, boss, now);
    expect(await boss.findJobs(INGEST_DOCS_QUEUE)).toHaveLength(1);
    expect(await docsStamp(id)).toBeNull();
    const admissions = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "scheduler.sweep_queue_admitted"));
    expect(admissions).toHaveLength(0);
  } finally {
    await boss.deleteAllJobs(INGEST_DOCS_QUEUE);
    await boss.deleteQueue(INGEST_DOCS_QUEUE);
    await boss.createQueue(INGEST_DOCS_QUEUE);
  }
});

test("queue admission audit refusal rolls back actual public SDK insertion and the source timestamp", async () => {
  const id = await addKnowledge();
  await fixture.db.execute(
    sql`CREATE FUNCTION subkit.reject_refresh_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_refresh_audit_refused'; END $$`,
  );
  await fixture.db.execute(
    sql`CREATE TRIGGER reject_refresh_admission BEFORE INSERT ON subkit.audit_log FOR EACH ROW WHEN (NEW.action = 'scheduler.sweep_queue_admitted') EXECUTE FUNCTION subkit.reject_refresh_admission()`,
  );
  try {
    await runKnowledgeRefreshSweep(fixture.db, boss, now);
    expect(await boss.findJobs(INGEST_KNOWLEDGE_QUEUE)).toHaveLength(0);
    expect(await knowledgeStamp(id)).toBeNull();
    const admissions = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "scheduler.sweep_queue_admitted"));
    expect(admissions).toHaveLength(0);
  } finally {
    await fixture.db.execute(sql`DROP TRIGGER reject_refresh_admission ON subkit.audit_log`);
    await fixture.db.execute(sql`DROP FUNCTION subkit.reject_refresh_admission()`);
  }
});

test("a missing public SDK dead-letter target causes an actual FK rollback and leaves the source retryable", async () => {
  const id = await addKnowledge();
  const send = boss.send.bind(boss);
  const states: (string | undefined)[] = [];
  boss.send = mapSendOptions(send, (options) => {
    if (!options?.db) throw new Error("fixture_transaction_adapter_missing");
    const db = options.db;
    const observedDb: NonNullable<SendOptions["db"]> = {
      executeSql: async (text, values) => {
        try {
          return await db.executeSql(text, values);
        } catch (error) {
          states.push(databaseCode(error));
          throw error;
        }
      },
    };
    return { ...options, deadLetter: "fixture-refresh-missing-target", db: observedDb };
  });
  try {
    await runKnowledgeRefreshSweep(fixture.db, boss, now);
    expect(states).toEqual(["23503"]);
    expect(await boss.findJobs(INGEST_KNOWLEDGE_QUEUE)).toHaveLength(0);
    expect(await knowledgeStamp(id)).toBeNull();
    expect(await admissionReceipts()).toHaveLength(0);
  } finally {
    boss.send = send;
  }
  await runKnowledgeRefreshSweep(fixture.db, boss, now);
  expect(await boss.findJobs(INGEST_KNOWLEDGE_QUEUE)).toHaveLength(1);
  expect(await knowledgeStamp(id)).toEqual(now);
});

test("the actual SDK promise remains owned tenant work and a second producer cannot enter", async () => {
  await addDocs(docsConfig());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const send = boss.send.bind(boss);
  boss.send = interceptSend(send, async () => {
    entered.resolve();
    await release.promise;
  });
  const running = runDocsRefreshSweep(fixture.db, boss, now);
  try {
    await reached(entered.promise);
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
    expect(await boss.findJobs(INGEST_DOCS_QUEUE)).toHaveLength(0);
    await runDocsRefreshSweep(fixture.db, boss, now);
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
  } finally {
    release.resolve();
    await running;
    boss.send = send;
  }
  expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
  expect(await boss.findJobs(INGEST_DOCS_QUEUE)).toHaveLength(1);
});

function interceptSend(
  send: PgBoss["send"],
  after: (jobId: string | null, options?: SendOptions) => Promise<void>,
): PgBoss["send"] {
  async function intercepted(request: BossRequest): Promise<string | null>;
  async function intercepted(
    name: string,
    data?: object | null,
    options?: SendOptions,
  ): Promise<string | null>;
  async function intercepted(
    request: BossRequest | string,
    data?: object | null,
    options?: SendOptions,
  ): Promise<string | null> {
    const result =
      typeof request === "string" ? await send(request, data, options) : await send(request);
    await after(result, typeof request === "string" ? options : request.options);
    return result;
  }
  return intercepted;
}
function mapSendOptions(
  send: PgBoss["send"],
  map: (options?: SendOptions) => SendOptions,
): PgBoss["send"] {
  function mapped(request: BossRequest): Promise<string | null>;
  function mapped(
    name: string,
    data?: object | null,
    options?: SendOptions,
  ): Promise<string | null>;
  function mapped(request: BossRequest | string, data?: object | null, options?: SendOptions) {
    return typeof request === "string"
      ? send(request, data, map(options))
      : send({ ...request, options: map(request.options) });
  }
  return mapped;
}
function databaseCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== "object") return undefined;
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
async function reached(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        // allow-wall-clock: bounded watchdog for an actual PostgreSQL barrier
        timer = setTimeout(() => reject(new Error("fixture_barrier_not_reached")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function admissionReceipts() {
  return fixture.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "scheduler.sweep_queue_admitted"));
}

for (const producer of ["docs", "knowledge"] as const) {
  test(`${producer} actual SDK insertion expires before commit and rolls back queue stamp and admission audit`, async () => {
    const id = producer === "docs" ? await addDocs(docsConfig()) : await addKnowledge();
    const run = producer === "docs" ? runDocsRefreshSweep : runKnowledgeRefreshSweep;
    const queue = producer === "docs" ? INGEST_DOCS_QUEUE : INGEST_KNOWLEDGE_QUEUE;
    await fixture.pool.query(
      "CREATE FUNCTION subkit.shorten_refresh_lease() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE observed timestamptz := date_trunc('milliseconds',clock_timestamp()); BEGIN UPDATE subkit.scheduler_sweep_cursors SET updated_at=observed,lease_until=observed+interval '300 milliseconds' WHERE producer=NEW.resource_id; RETURN NEW; END $$; CREATE TRIGGER shorten_refresh_lease AFTER INSERT ON subkit.audit_log FOR EACH ROW WHEN (NEW.action='scheduler.sweep_claimed' AND NEW.resource_id IN ('docs','knowledge')) EXECUTE FUNCTION subkit.shorten_refresh_lease()",
    );
    const send = boss.send.bind(boss);
    let sends = 0;
    boss.send = interceptSend(send, async () => {
      sends++;
      await fixture.pool.query("SELECT pg_sleep(0.4)");
    });
    try {
      await run(fixture.db, boss, now);
      expect(sends).toBe(1);
      expect(await boss.findJobs(queue)).toHaveLength(0);
      expect(producer === "docs" ? await docsStamp(id) : await knowledgeStamp(id)).toBeNull();
      expect(await admissionReceipts()).toHaveLength(0);
      const [cursor] = await fixture.db
        .select()
        .from(schedulerSweepCursors)
        .where(eq(schedulerSweepCursors.producer, producer));
      expect(cursor?.after_id).toBeNull();
    } finally {
      boss.send = send;
      await fixture.pool.query(
        "DROP TRIGGER shorten_refresh_lease ON subkit.audit_log; DROP FUNCTION subkit.shorten_refresh_lease()",
      );
    }
  });
}

for (const producer of ["docs", "knowledge"] as const) {
  for (const change of ["suspended", "deleted"] as const) {
    test(`${producer} ${change} barrier before projection cannot admit a discovered source`, async () => {
      const id = producer === "docs" ? await addDocs(docsConfig()) : await addKnowledge();
      const run = producer === "docs" ? runDocsRefreshSweep : runKnowledgeRefreshSweep;
      const queue = producer === "docs" ? INGEST_DOCS_QUEUE : INGEST_KNOWLEDGE_QUEUE;
      const client = await fixture.pool.connect();
      try {
        await client.query("BEGIN");
        if (change === "suspended") {
          await client.query("UPDATE subkit.tenants SET status='suspended' WHERE id=$1", [
            tenantId,
          ]);
        } else if (producer === "docs") {
          await client.query(
            "UPDATE subkit.connectors SET deleted_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
            [tenantId, id],
          );
        } else {
          await client.query(
            "UPDATE subkit.knowledge_sources SET deleted_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
            [tenantId, id],
          );
        }
        await run(fixture.db, boss, now);
        expect(await boss.findJobs(queue)).toHaveLength(0);
        expect(producer === "docs" ? await docsStamp(id) : await knowledgeStamp(id)).toBeNull();
        expect(await admissionReceipts()).toHaveLength(0);
        await client.query("COMMIT");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      await run(fixture.db, boss, now);
      expect(await boss.findJobs(queue)).toHaveLength(0);
      expect(await admissionReceipts()).toHaveLength(0);
    });
  }

  test(`${producer} parent suspension and source deletion cannot cross the held admission locks`, async () => {
    const id = producer === "docs" ? await addDocs(docsConfig()) : await addKnowledge();
    const run = producer === "docs" ? runDocsRefreshSweep : runKnowledgeRefreshSweep;
    const queue = producer === "docs" ? INGEST_DOCS_QUEUE : INGEST_KNOWLEDGE_QUEUE;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const send = boss.send.bind(boss);
    boss.send = interceptSend(send, async () => {
      entered.resolve();
      await release.promise;
    });
    const running = run(fixture.db, boss, now);
    try {
      await reached(entered.promise);
      expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
      expect(await boss.findJobs(queue)).toHaveLength(0);
      expect(producer === "docs" ? await docsStamp(id) : await knowledgeStamp(id)).toBeNull();
      for (const mutation of ["parent", "source"] as const) {
        const client = await fixture.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL lock_timeout='50ms'");
          const change =
            mutation === "parent"
              ? client.query("UPDATE subkit.tenants SET status='suspended' WHERE id=$1", [tenantId])
              : producer === "docs"
                ? client.query(
                    "UPDATE subkit.connectors SET deleted_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
                    [tenantId, id],
                  )
                : client.query(
                    "UPDATE subkit.knowledge_sources SET deleted_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
                    [tenantId, id],
                  );
          await expect(change).rejects.toMatchObject({ code: "55P03" });
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
    } finally {
      release.resolve();
      await running;
      boss.send = send;
    }
    expect(await boss.findJobs(queue)).toHaveLength(1);
    expect(producer === "docs" ? await docsStamp(id) : await knowledgeStamp(id)).toEqual(now);
    expect(await admissionReceipts()).toHaveLength(1);
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
  });

  test(`${producer} disconnected stale owner rolls back its insertion and cannot consume the new owner's source tail`, async () => {
    const ids = [
      producer === "docs" ? await addDocs(docsConfig()) : await addKnowledge(),
      producer === "docs" ? await addDocs(docsConfig()) : await addKnowledge(),
    ].sort();
    const run = producer === "docs" ? runDocsRefreshSweep : runKnowledgeRefreshSweep;
    const queue = producer === "docs" ? INGEST_DOCS_QUEUE : INGEST_KNOWLEDGE_QUEUE;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const send = boss.send.bind(boss);
    let transactionPid: number | undefined;
    let calls = 0;
    const clients = new Map<PoolClient, (error: Error) => void>();
    const disconnectErrors: { client: PoolClient; error: Error }[] = [];
    let disconnectedClient: PoolClient | undefined;
    const disconnected = Promise.withResolvers<void>();
    const onAcquire = (client: PoolClient) => {
      if (clients.has(client)) return;
      const onError = (error: Error) => {
        disconnectErrors.push({ client, error });
        if (databaseCode(error) === "57P01") {
          disconnectedClient = client;
          client.once("end", () => disconnected.resolve());
        }
      };
      clients.set(client, onError);
      client.on("error", onError);
    };
    fixture.pool.on("acquire", onAcquire);
    boss.send = interceptSend(send, async (_, options) => {
      if (calls++ > 0) return;
      if (!options?.db) throw new Error("fixture_transaction_adapter_missing");
      const result = await options.db.executeSql(
        "SELECT pg_backend_pid() AS pid WHERE $1::text IS NOT NULL",
        ["fixture"],
      );
      transactionPid = z.object({ pid: z.number().int().positive() }).parse(result.rows[0]).pid;
      entered.resolve();
      await release.promise;
    });
    const running = run(fixture.db, boss, now);
    try {
      await reached(entered.promise);
      if (transactionPid === undefined) throw new Error("fixture_transaction_pid_missing");
      expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
      await fixture.pool.query("SELECT pg_terminate_backend($1)", [transactionPid]);
      await reached(disconnected.promise);
      expect(disconnectErrors.some(({ error }) => databaseCode(error) === "57P01")).toBe(true);
      expect(
        disconnectErrors.every(
          ({ client, error }) =>
            client === disconnectedClient &&
            (databaseCode(error) === "57P01" ||
              error.message === "Connection terminated unexpectedly"),
        ),
      ).toBe(true);
      expect(await boss.findJobs(queue)).toHaveLength(0);
      expect(await admissionReceipts()).toHaveLength(0);
      for (const id of ids)
        expect(producer === "docs" ? await docsStamp(id) : await knowledgeStamp(id)).toBeNull();
      await fixture.db.execute(sql`WITH observed AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS at)
        UPDATE ${schedulerSweepCursors} SET updated_at=observed.at-interval '120 seconds', lease_until=observed.at-interval '60 seconds'
        FROM observed WHERE producer=${producer}`);
      await run(fixture.db, boss, now);
      expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
      const jobs = await boss.findJobs<IngestDocsJob & IngestKnowledgeJob>(queue);
      expect(
        jobs
          .map((job) =>
            producer === "docs" ? job.data.connector_id : job.data.knowledge_source_id,
          )
          .sort(),
      ).toEqual(ids);
      expect(await admissionReceipts()).toHaveLength(ids.length);
    } finally {
      release.resolve();
      try {
        await running;
      } finally {
        boss.send = send;
        fixture.pool.removeListener("acquire", onAcquire);
        for (const [client, onError] of clients) client.removeListener("error", onError);
      }
    }
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
    expect(await boss.findJobs(queue)).toHaveLength(ids.length);
    expect(await admissionReceipts()).toHaveLength(ids.length);
    for (const id of ids)
      expect(producer === "docs" ? await docsStamp(id) : await knowledgeStamp(id)).toEqual(now);
  });
}

test("a rejected private-address handoff rolls back real insertion without echoing its source input", async () => {
  const marker = "fixture-private-address-post-insert";
  const id = await addDocs({
    ...docsConfig(),
    docs_source_url: `https://example.test/docs?signed=${marker}`,
  });
  const send = boss.send.bind(boss);
  logRing.clear();
  let sends = 0;
  boss.send = interceptSend(send, async () => {
    sends++;
    throw new Error(marker);
  });
  try {
    await runDocsRefreshSweep(fixture.db, boss, now);
    expect(sends).toBe(1);
    expect(await boss.findJobs(INGEST_DOCS_QUEUE)).toHaveLength(0);
    expect(await docsStamp(id)).toBeNull();
    expect(await admissionReceipts()).toHaveLength(0);
    expect(JSON.stringify(logRing.tail({ limit: 1_000 })).includes(marker)).toBe(false);
  } finally {
    boss.send = send;
  }
});

test("stop drains the actual refresh promise and preserves the unvisited source tail for restart", async () => {
  const ids = [
    await addDocs(docsConfig()),
    await addDocs(docsConfig()),
    await addDocs(docsConfig()),
  ].sort();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const send = boss.send.bind(boss);
  let sends = 0;
  boss.send = interceptSend(send, async () => {
    if (sends++ > 0) return;
    entered.resolve();
    await release.promise;
  });
  class RefreshOnly extends SchedulerReconciler {
    override async reconcileOnce(): Promise<void> {
      await runDocsRefreshSweep(fixture.db, boss, now);
    }
  }
  const reconciler = new RefreshOnly({ db: fixture.db, boss, intervalMs: 60_000 });
  const installed = reconciler.install();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  try {
    await reached(entered.promise);
    stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
    expect(await boss.findJobs(INGEST_DOCS_QUEUE)).toHaveLength(0);
    // allow-wall-clock: hold actual queue work across a scheduler interval during shutdown
    await new Promise((resolve) => setTimeout(resolve, 5_100));
  } finally {
    release.resolve();
    await installed.firstPass;
    await (stopping ?? reconciler.stop());
    boss.send = send;
  }
  expect(stopped).toBe(true);
  expect(sends).toBe(1);
  expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
  const [cursor] = await fixture.db
    .select()
    .from(schedulerSweepCursors)
    .where(eq(schedulerSweepCursors.producer, "docs"));
  expect(cursor?.after_id).toBe(ids[0]);
  expect(cursor?.lease_token).toBeNull();
  for (const id of ids.slice(1)) expect(await docsStamp(id)).toBeNull();
  await runDocsRefreshSweep(fixture.db, boss, now);
  const jobs = await boss.findJobs<IngestDocsJob>(INGEST_DOCS_QUEUE);
  expect(jobs.map((job) => job.data.connector_id).sort()).toEqual(ids);
  expect(new Set(jobs.map((job) => job.data.connector_id)).size).toBe(ids.length);
}, 15_000);
