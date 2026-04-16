// Worker for the `knowledge.ingest` queue.
//
// The job payload carries IDs + upload content. The handler calls
// ingestKnowledgeSource from the knowledge service.

import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { ingestKnowledgeSource } from "../../knowledge/service.ts";
import { logger } from "../../logging/logger.ts";

export const INGEST_KNOWLEDGE_QUEUE = "knowledge.ingest" as const;

export interface IngestKnowledgeJob {
  tenant_id: string;
  knowledge_source_id: string;
  filename: string;
  content: string;
  mime?: string;
  actor_id?: string | null;
}

export interface RegisterIngestKnowledgeOptions {
  boss: PgBoss;
  db: Db;
}

async function handleOne(job: Job<IngestKnowledgeJob>, db: Db): Promise<void> {
  const data = job.data;
  logger.info({
    module: "queue",
    action: "job.dequeued",
    msg: "knowledge.ingest job dequeued",
    queue: INGEST_KNOWLEDGE_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
    knowledge_source_id: data.knowledge_source_id,
  });
  const started = Date.now();
  try {
    const result = await ingestKnowledgeSource(
      {
        tenant_id: data.tenant_id,
        knowledge_source_id: data.knowledge_source_id,
        upload: {
          buffer: Buffer.from(data.content),
          filename: data.filename,
          ...(data.mime ? { mime: data.mime } : {}),
        },
        actor_id: data.actor_id ?? null,
      },
      db,
    );
    logger.info({
      module: "queue",
      action: "job.completed",
      msg: "knowledge.ingest job completed",
      queue: INGEST_KNOWLEDGE_QUEUE,
      job_id: job.id,
      ingested: result.ingested_count,
      skipped: result.skipped_count,
      bytes: result.total_bytes,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({
      module: "queue",
      action: "job.failed",
      msg: "knowledge.ingest job failed",
      queue: INGEST_KNOWLEDGE_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerIngestKnowledgeHandler(
  opts: RegisterIngestKnowledgeOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<IngestKnowledgeJob>(
    INGEST_KNOWLEDGE_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<IngestKnowledgeJob>[]) => {
      for (const job of jobs) {
        await handleOne(job, db);
      }
    },
  );
  logger.info({
    module: "queue",
    action: "worker.registered",
    msg: "knowledge.ingest worker registered",
    worker_id: workerId,
  });
  return workerId;
}

export async function enqueueKnowledgeIngest(
  boss: PgBoss,
  payload: IngestKnowledgeJob,
): Promise<string | null> {
  return await boss.send(INGEST_KNOWLEDGE_QUEUE, payload);
}
