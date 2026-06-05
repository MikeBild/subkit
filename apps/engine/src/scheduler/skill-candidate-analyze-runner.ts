// Per-tenant runner for the scheduler's skill-candidate analysis sweep.
//
// Extracted out of `reconciler.ts` to keep that file under the 1000-LOC
// ceiling enforced by the audit-invariants gate (same split as
// `proactive-drift-scan-runner.ts`). The reconciler keeps a thin call
// site; this module owns the cadence + CAS-stamp sweep and the per-tenant
// enqueue of the `skill-candidate.analyze` job.
//
// Background: the repair / failure / success detectors run inside the
// `skill-candidate.analyze` pg-boss job, but nothing enqueued that job —
// the worker was registered yet never fired, so the detectors never ran in
// normal operation. This sweep is what actually drives them.

import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { enqueueSkillCandidateAnalysis } from "../queue/handlers/skill-candidate-analyze.ts";

/** Fixed cadence for the skill-candidate pattern-analysis sweep. The
 *  detectors aggregate recurring patches / failures / successes into Skill
 *  Candidate proposals; six hours balances surfacing the learning promptly
 *  against the cost of repeatedly scanning patch + execution history. The
 *  job itself is idempotent (fingerprint dedup in upsertFromSignal), so a
 *  multi-instance clock-overlap that fires twice is safe. */
export const SKILL_CANDIDATE_ANALYZE_CADENCE_MS = 6 * 60 * 60 * 1000;

/**
 * Sweep tenants and enqueue a `skill-candidate.analyze` job for each one
 * whose `last_skill_candidate_analyze_at` is NULL or older than the
 * cadence. Each due tenant wins a compare-and-set on the column, so a
 * multi-instance deployment fires exactly once per cadence per tenant.
 *
 * The worker runs `runPatternAnalysis`, which fans out to the repair /
 * failure / success detectors and upserts Skill Candidate proposals
 * (always `status='proposed'` — promotion to a Skill stays behind the
 * operator-approval gate).
 *
 * Enqueue failures are caught per-tenant: the CAS-stamp has already
 * advanced, so a transient enqueue error simply waits for the next cadence
 * rather than hot-looping; the sweep keeps walking the other tenants.
 */
export async function runSkillCandidateAnalysisSweep(
  now: Date,
  db: Db,
  boss: PgBoss,
): Promise<void> {
  // tenant-filter:exempt — analysis sweeps every tenant; row carries tenant_id forward
  const cadenceCutoff = new Date(now.getTime() - SKILL_CANDIDATE_ANALYZE_CADENCE_MS);
  const dueRows = await db
    .select({
      id: tenants.id,
      last_skill_candidate_analyze_at: tenants.last_skill_candidate_analyze_at,
    })
    .from(tenants)
    .where(
      and(
        isNull(tenants.deleted_at),
        or(
          isNull(tenants.last_skill_candidate_analyze_at),
          lt(tenants.last_skill_candidate_analyze_at, cadenceCutoff),
        ),
      ),
    );

  for (const tenant of dueRows) {
    // Compare-and-set on `last_skill_candidate_analyze_at`: a concurrent
    // reconciler in another engine instance racing for the same tenant
    // only sees one successful UPDATE; the loser's RETURNING comes back
    // empty and skips the enqueue.
    const priorWhere =
      tenant.last_skill_candidate_analyze_at === null
        ? isNull(tenants.last_skill_candidate_analyze_at)
        : eq(tenants.last_skill_candidate_analyze_at, tenant.last_skill_candidate_analyze_at);
    const stamped = await db
      .update(tenants)
      .set({ last_skill_candidate_analyze_at: now })
      .where(and(eq(tenants.id, tenant.id), priorWhere))
      .returning({ id: tenants.id });
    if (stamped.length === 0) continue;

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
