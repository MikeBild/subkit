// Worker for the `skill-candidate.analyze` queue.
//
// Runs pattern analysis for a single tenant. Enqueued periodically
// (every 6 hours) by the scheduler or manually by operators.

import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { runPatternAnalysis } from "../../skill-candidates/service.ts";
import { withJobContext } from "../job-context.ts";

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
  log.queue.job.dequeued({
    msg: "skill-candidate.analyze job dequeued",
    queue: SKILL_CANDIDATE_ANALYZE_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
  });
  const started = Date.now();
  // rss baseline around the LLM-heavy pattern analysis, so the success
  // log attributes the transient to THIS tenant's analysis run.
  const rssBefore = process.memoryUsage().rss;
  try {
    const result = await runPatternAnalysis({ tenant_id: data.tenant_id }, db);
    log.queue.job.completed({
      msg: "skill-candidate.analyze job completed",
      queue: SKILL_CANDIDATE_ANALYZE_QUEUE,
      job_id: job.id,
      proposed: result.candidates_proposed,
      updated: result.candidates_updated,
      patterns: result.patterns_checked,
      duration_ms: Date.now() - started,
      rss_mb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
      rss_delta_mb: Math.round(((process.memoryUsage().rss - rssBefore) / 1048576) * 10) / 10,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.queue.job.failed({
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
        await withJobContext(job.data, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
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
