import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { enqueueSkillCandidateAnalysis } from "../queue/handlers/skill-candidate-analyze.ts";
import { runTenantCadenceSweep } from "./cadence-sweep.ts";

export async function runSkillCandidateAnalysisSweep(
  now: Date,
  db: Db,
  boss: PgBoss,
): Promise<void> {
  await runTenantCadenceSweep("skill", now, db, async (tenantId) => {
    try {
      await enqueueSkillCandidateAnalysis(boss, { tenant_id: tenantId });
      logger.info({
        module: "scheduler",
        action: "skill_candidate_analyze.enqueued",
        msg: "skill-candidate analysis enqueued",
        tenant_id: tenantId,
      });
    } catch (err) {
      logger.error({
        module: "scheduler",
        action: "skill_candidate_analyze.enqueue_failed",
        msg: "failed to enqueue skill-candidate analysis",
        tenant_id: tenantId,
        ...errorFields(err),
      });
    }
  });
}
