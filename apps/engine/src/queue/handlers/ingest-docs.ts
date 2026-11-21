import type { Job, PgBoss } from "pg-boss";
import type { Db, Executor } from "../../db/client.ts";
import * as docs from "../../docs-ingestion/service.ts";
import type { DocSourceType } from "../../docs-ingestion/types.ts";
import { log } from "../../logging/index.ts";
import { withActiveTenantJobContext } from "../job-context.ts";
import { queuedSendTransaction } from "../transaction-adapter.ts";

export const INGEST_DOCS_QUEUE = "connector.ingest-docs" as const;

export interface IngestDocsJob {
  tenant_id: string;
  connector_id: string;
  source_type: DocSourceType;
  url?: string;
  content?: string;
  actor_id?: string | null;
}

interface RegisterIngestDocsOptions {
  boss: PgBoss;
  db: Db;
}

async function handleOne(job: Job<IngestDocsJob>, db: Db): Promise<void> {
  const data = job.data;
  log.queue.job.dequeued({
    msg: "connector.ingest-docs job dequeued",
    queue: INGEST_DOCS_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
    connector_id: data.connector_id,
    source_type: data.source_type,
  });
  const started = Date.now();
  try {
    const input: docs.IngestParams["input"] = { source_type: data.source_type };
    if (data.url !== undefined) input.url = data.url;
    if (data.content !== undefined) input.content = data.content;
    const result = await docs.ingestDocs(
      {
        tenant_id: data.tenant_id,
        connector_id: data.connector_id,
        input,
        actor_id: data.actor_id ?? null,
      },
      db,
    );
    log.queue.job.completed({
      msg: "connector.ingest-docs job completed",
      queue: INGEST_DOCS_QUEUE,
      job_id: job.id,
      ingested: result.ingested_count,
      skipped: result.skipped_count,
      bytes: result.total_bytes,
      budget_exceeded: result.budget_exceeded,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.queue.job.failed({
      msg: "connector.ingest-docs job failed",
      queue: INGEST_DOCS_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerIngestDocsHandler(opts: RegisterIngestDocsOptions): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<IngestDocsJob>(
    INGEST_DOCS_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<IngestDocsJob>[]) => {
      for (const job of jobs) {
        await withActiveTenantJobContext(job.data, db, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
    msg: "connector.ingest-docs worker registered",
    worker_id: workerId,
  });
  return workerId;
}

export async function enqueueIngest(
  boss: PgBoss,
  payload: IngestDocsJob,
  exec?: Executor,
): Promise<string | null> {
  if (exec) return await boss.send(INGEST_DOCS_QUEUE, payload, { db: queuedSendTransaction(exec) });
  return await boss.send(INGEST_DOCS_QUEUE, payload);
}
