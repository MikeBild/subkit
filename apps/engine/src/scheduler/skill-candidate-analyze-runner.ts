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

import { and, isNull, lt, or } from "drizzle-orm";
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
 * cadence.
 *
 * Claim is a SINGLE atomic `UPDATE ... WHERE <due> RETURNING id`: it flips
 * every due tenant's stamp to `now` and returns only the ids it actually
 * changed. Two properties fall out of doing it as one statement:
 *
 *   - Microsecond-safe. The predicate only ever uses range (`<`) and NULL
 *     tests against the cadence cutoff — never an equality on a value read
 *     back into a JS `Date`. (node-postgres truncates timestamptz to
 *     millisecond precision on read, so the previous read-then-CAS-on-
 *     equality silently matched 0 rows whenever the stored stamp carried
 *     sub-millisecond microseconds, stalling that tenant forever.)
 *   - Exactly-once across instances. Postgres takes a row lock per UPDATE;
 *     a concurrent reconciler's UPDATE blocks, then re-evaluates the WHERE
 *     against the now-advanced stamp (no longer `< cutoff`) and skips the
 *     row, so it never appears in two instances' RETURNING sets.
 *
 * The worker runs `runPatternAnalysis`, which fans out to the repair /
 * failure / success detectors and upserts Skill Candidate proposals
 * (always `status='proposed'` — promotion to a Skill stays behind the
 * operator-approval gate).
 *
 * Enqueue failures are caught per-tenant: the stamp has already advanced,
 * so a transient enqueue error simply waits for the next cadence rather
 * than hot-looping; the sweep keeps walking the other claimed tenants.
 */
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
