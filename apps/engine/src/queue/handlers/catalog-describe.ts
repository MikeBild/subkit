import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { describePendingCatalog } from "../../workflows/catalog-describe.ts";
import { withActiveTenantJobContext } from "../job-context.ts";

export const CATALOG_DESCRIBE_QUEUE = "catalog.describe" as const;

export interface CatalogDescribeJob {
  tenant_id: string;
}

export interface RegisterCatalogDescribeOptions {
  boss: PgBoss;
  db: Db;
}

async function handleOne(job: Job<CatalogDescribeJob>, db: Db): Promise<void> {
  const started = Date.now();
  log.queue.job.dequeued({
    msg: "catalog.describe job dequeued",
    queue: CATALOG_DESCRIBE_QUEUE,
    job_id: job.id,
    tenant_id: job.data.tenant_id,
  });
  try {
    const run = await describePendingCatalog(job.data.tenant_id, db);
    log.queue.job.completed({
      msg: "catalog.describe job completed",
      queue: CATALOG_DESCRIBE_QUEUE,
      job_id: job.id,
      tenant_id: job.data.tenant_id,
      described: run.described,
      unchanged: run.unchanged,
      skipped: run.skipped,
      failed: run.failed,
      remaining: run.remaining,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    log.queue.job.failed({
      msg: "catalog.describe job failed",
      queue: CATALOG_DESCRIBE_QUEUE,
      job_id: job.id,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerCatalogDescribeHandler(
  opts: RegisterCatalogDescribeOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<CatalogDescribeJob>(
    CATALOG_DESCRIBE_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<CatalogDescribeJob>[]) => {
      for (const job of jobs) {
        await withActiveTenantJobContext(job.data, db, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
    msg: "catalog.describe worker registered",
    worker_id: workerId,
  });
  return workerId;
}

export async function enqueueCatalogDescribe(
  boss: PgBoss,
  payload: CatalogDescribeJob,
): Promise<string | null> {
  return await boss.send(CATALOG_DESCRIBE_QUEUE, payload, {
    singletonKey: `catalog-describe:${payload.tenant_id}`,
  });
}
