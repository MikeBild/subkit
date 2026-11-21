import { expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Request as BossRequest, PgBoss, SendOptions } from "pg-boss";
import { auditLog, connectors, tenants } from "../../db/schema/index.ts";
import { tenantWorkSnapshot } from "../../execution/index.ts";
import { INGEST_DOCS_QUEUE, type IngestDocsJob } from "../../queue/handlers/ingest-docs.ts";
import {
  INGEST_KNOWLEDGE_QUEUE,
  type IngestKnowledgeJob,
} from "../../queue/handlers/ingest-knowledge.ts";
import {
  REFRESH_ADDRESS_MAX_BYTES,
  REFRESH_CRON_MAX_BYTES,
} from "../../scheduler/refresh-producer-projection.ts";
import { SWEEP_PAGE_LIMIT } from "../../scheduler/sweep-cursor.ts";
import { runDocsRefreshSweep, runKnowledgeRefreshSweep } from "./refresh-producer-runner.ts";
import {
  addDocs,
  addKnowledge,
  admissionReceipts,
  boss,
  databaseCode,
  docsConfig,
  docsStamp,
  fixture,
  interceptSend,
  knowledgeStamp,
  now,
  reached,
  tenantId,
  useRefreshProducerDb,
  uuid,
} from "./refresh-producer-runner-fixtures.ts";

useRefreshProducerDb();

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
  const transaction: typeof fixture.db.transaction = fixture.db.transaction.bind(fixture.db);
  const observedTransaction: typeof fixture.db.transaction = async (work, options) => {
    try {
      return await transaction(work, options);
    } catch (error) {
      states.push(databaseCode(error));
      throw error;
    }
  };
  const transactionSpy = spyOn(fixture.db, "transaction").mockImplementation(observedTransaction);
  boss.send = mapSendOptions(send, (options) => {
    if (!options?.db) throw new Error("fixture_transaction_adapter_missing");
    return { ...options, deadLetter: "fixture-refresh-missing-target" };
  });
  try {
    await runKnowledgeRefreshSweep(fixture.db, boss, now);
    expect(states).toEqual(["23503"]);
    expect(await boss.findJobs(INGEST_KNOWLEDGE_QUEUE)).toHaveLength(0);
    expect(await knowledgeStamp(id)).toBeNull();
    expect(await admissionReceipts()).toHaveLength(0);
  } finally {
    boss.send = send;
    transactionSpy.mockRestore();
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
