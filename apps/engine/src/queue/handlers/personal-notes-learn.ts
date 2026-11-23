import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/index.ts";
import { log } from "../../logging/index.ts";
import {
  learnPersonalNotes,
  PERSONAL_NOTES_LEARN_QUEUE,
  type PersonalNotesLearnJob,
  PersonalNotesLearnJobSchema,
  rejectionCounts,
} from "../../personal-notes/index.ts";
import { withActiveTenantJobContext } from "../job-context.ts";

async function handleOne(job: Job<PersonalNotesLearnJob>, db: Db): Promise<void> {
  const data = PersonalNotesLearnJobSchema.parse(job.data);
  const started = Date.now();
  try {
    const result = await learnPersonalNotes(db, data, { now: new Date() });
    log.queue.job.completed({
      msg: "personal-notes.learn job completed",
      queue: PERSONAL_NOTES_LEARN_QUEUE,
      job_id: job.id,
      outcome: result.outcome,
      mode: data.explicit ? "explicit" : "background",
      messages: result.messages,
      applied: result.applied,
      skipped: result.skipped,
      rejected: rejectionCounts(result.rejected),
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    log.queue.job.failed({
      msg: "personal-notes.learn job failed",
      queue: PERSONAL_NOTES_LEARN_QUEUE,
      job_id: job.id,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerPersonalNotesLearnHandler(opts: {
  boss: PgBoss;
  db: Db;
}): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<PersonalNotesLearnJob>(
    PERSONAL_NOTES_LEARN_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<PersonalNotesLearnJob>[]) => {
      for (const job of jobs) {
        await withActiveTenantJobContext(job.data, db, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
    msg: "personal-notes.learn worker registered",
    worker_id: workerId,
  });
  return workerId;
}
