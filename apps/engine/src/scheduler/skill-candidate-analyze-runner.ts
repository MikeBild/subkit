import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { enqueueSkillCandidateAnalysis } from "../queue/handlers/skill-candidate-analyze.ts";

export const SKILL_CANDIDATE_ANALYZE_CADENCE_MS = 6 * 60 * 60 * 1000;

export async function runSkillCandidateAnalysisSweep(
  now: Date,
  db: Db,
  boss: PgBoss,
): Promise<void> {
  // tenant-filter:exempt — analysis sweeps every tenant; row carries tenant_id forward
  const cadenceCutoff = new Date(now.getTime() - SKILL_CANDIDATE_ANALYZE_CADENCE_MS);
  const claimed = await db
    .update(tenants)
    .set({ last_skill_candidate_analyze_at: now })
    .where(
      and(
        isNull(tenants.deleted_at),
        eq(tenants.status, "active"),
        or(
          isNull(tenants.last_skill_candidate_analyze_at),
          lt(tenants.last_skill_candidate_analyze_at, cadenceCutoff),
        ),
      ),
    )
    .returning({ id: tenants.id });

  for (const tenant of claimed) {
    try {
      await enqueueSkillCandidateAnalysis(boss, { tenant_id: tenant.id });
      logger.info({
        module: "scheduler",
        action: "skill_candidate_analyze.enqueued",
        msg: "skill-candidate analysis enqueued",
        tenant_id: tenant.id,
      });
    } catch (err) {
      logger.error({
        module: "scheduler",
        action: "skill_candidate_analyze.enqueue_failed",
        msg: "failed to enqueue skill-candidate analysis",
        tenant_id: tenant.id,
        ...errorFields(err),
      });
    }
  }
}
