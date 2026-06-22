// Worker for the `knowledge.ingest` queue.
//
// The job payload carries IDs + upload content. The handler calls
// ingestKnowledgeSource from the knowledge service.

import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import { knowledgeSources } from "../../db/schema/index.ts";
import { ingestKnowledgeSource } from "../../knowledge/service.ts";
import { log } from "../../logging/logger.ts";
import { withJobContext } from "../job-context.ts";

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

/** Process one `knowledge.ingest` job. Exported as the unit seam — the
 *  worker loop below and the DB-backed tests both drive it. */
export async function processIngestKnowledgeJob(
  job: Job<IngestKnowledgeJob>,
  db: Db,
): Promise<void> {
  const data = job.data;
  log.queue.job.dequeued({
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
    log.queue.job.completed({
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
    log.queue.job.failed({
      msg: "knowledge.ingest job failed",
      queue: INGEST_KNOWLEDGE_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
    // Surface the failure on the source row so the operator sees it in
    // `sk knowledge-sources list/get` instead of only in the logs. The
    // rethrow below keeps pg-boss retry semantics; a later successful
    // ingest clears both fields again (service.ts sets status='active',
    // last_error=null).
    await markIngestFailed(db, data.tenant_id, data.knowledge_source_id, message);
    throw err;
  }
}

async function markIngestFailed(
  db: Db,
  tenant_id: string,
  knowledge_source_id: string,
  message: string,
): Promise<void> {
  try {
    const updated = await db
      .update(knowledgeSources)
      .set({ status: "error", last_error: message.slice(0, 2_000), updated_at: new Date() })
      .where(
        and(
          eq(knowledgeSources.tenant_id, tenant_id),
          eq(knowledgeSources.id, knowledge_source_id),
        ),
      )
      .returning({ id: knowledgeSources.id, status: knowledgeSources.status });
    if (!updated[0]) return;
    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.KNOWLEDGE_SOURCE_UPDATED,
        resource_type: "knowledge_source",
        resource_id: knowledge_source_id,
        result: "success",
        metadata: { status: "error", last_error: message.slice(0, 2_000) },
      },
      db,
    );
  } catch (markErr) {
    // Best-effort: failing to mark the row must not mask the original
    // ingest error (the rethrow above carries it to pg-boss).
    log.queue.job.failed({
      msg: "knowledge.ingest failed to mark source row as error",
      queue: INGEST_KNOWLEDGE_QUEUE,
      knowledge_source_id,
      error: markErr instanceof Error ? markErr.message : String(markErr),
    });
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
        await withJobContext(job.data, () => processIngestKnowledgeJob(job, db));
      }
    },
  );
  log.queue.worker.registered({
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
