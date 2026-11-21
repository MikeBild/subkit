import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { z } from "zod";
import { schedulerSweepCursors } from "../../db/schema/index.ts";
import { tenantWorkSnapshot } from "../../execution/index.ts";
import { logRing } from "../../observability/log-ring.ts";
import { INGEST_DOCS_QUEUE, type IngestDocsJob } from "../../queue/handlers/ingest-docs.ts";
import {
  INGEST_KNOWLEDGE_QUEUE,
  type IngestKnowledgeJob,
} from "../../queue/handlers/ingest-knowledge.ts";
import { SchedulerReconciler } from "../../scheduler/reconciler.ts";
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
} from "./refresh-producer-runner-fixtures.ts";

useRefreshProducerDb();

for (const producer of ["docs", "knowledge"] as const) {
  test(`${producer} actual SDK insertion expires before commit and rolls back queue stamp and admission audit`, async () => {
    const id = producer === "docs" ? await addDocs(docsConfig()) : await addKnowledge();
    const run = producer === "docs" ? runDocsRefreshSweep : runKnowledgeRefreshSweep;
    const queue = producer === "docs" ? INGEST_DOCS_QUEUE : INGEST_KNOWLEDGE_QUEUE;
    await fixture.pool.query(
      "CREATE FUNCTION subkit.shorten_refresh_lease() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE observed timestamptz := date_trunc('milliseconds',clock_timestamp()); BEGIN UPDATE subkit.scheduler_sweep_cursors SET updated_at=observed,lease_until=observed+interval '300 milliseconds' WHERE producer::text=NEW.resource_id; RETURN NEW; END $$; CREATE TRIGGER shorten_refresh_lease AFTER INSERT ON subkit.audit_log FOR EACH ROW WHEN (NEW.action='scheduler.sweep_claimed' AND NEW.resource_id IN ('docs','knowledge')) EXECUTE FUNCTION subkit.shorten_refresh_lease()",
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
