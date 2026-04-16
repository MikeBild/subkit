// Worker for the `skill-candidate.analyze` queue.
//
// Runs pattern analysis for a single tenant. Enqueued periodically
// (every 6 hours) by the scheduler or manually by operators.

import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { runPatternAnalysis } from "../../skill-candidates/service.ts";

export const SKILL_CANDIDATE_ANALYZE_QUEUE = "skill-candidate.analyze" as const;

export interface SkillCandidateAnalyzeJob {
  tenant_id: string;
}

export interface RegisterSkillCandidateAnalyzeOptions {
  boss: PgBoss;
  db: Db;
}

async function handleOne(job: Job<SkillCandidateAnalyzeJob>, db: Db): Promise<void> {
  const data = job.data;
  logger.info({
    module: "queue",
    action: "job.dequeued",
    msg: "skill-candidate.analyze job dequeued",
    queue: SKILL_CANDIDATE_ANALYZE_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
  });
  const started = Date.now();
  try {
    const result = await runPatternAnalysis({ tenant_id: data.tenant_id }, db);
    logger.info({
      module: "queue",
      action: "job.completed",
      msg: "skill-candidate.analyze job completed",
      queue: SKILL_CANDIDATE_ANALYZE_QUEUE,
      job_id: job.id,
      proposed: result.candidates_proposed,
      updated: result.candidates_updated,
      patterns: result.patterns_checked,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({
      module: "queue",
      action: "job.failed",
      msg: "skill-candidate.analyze job failed",
      queue: SKILL_CANDIDATE_ANALYZE_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerSkillCandidateAnalyzeHandler(
  opts: RegisterSkillCandidateAnalyzeOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<SkillCandidateAnalyzeJob>(
    SKILL_CANDIDATE_ANALYZE_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<SkillCandidateAnalyzeJob>[]) => {
      for (const job of jobs) {
        await handleOne(job, db);
      }
    },
  );
  logger.info({
    module: "queue",
    action: "worker.registered",
    msg: "skill-candidate.analyze worker registered",
    worker_id: workerId,
  });
  return workerId;
}

export async function enqueueSkillCandidateAnalysis(
  boss: PgBoss,
  payload: SkillCandidateAnalyzeJob,
): Promise<string | null> {
  return await boss.send(SKILL_CANDIDATE_ANALYZE_QUEUE, payload);
}
