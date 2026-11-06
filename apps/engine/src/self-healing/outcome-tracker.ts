import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { patchCandidates } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutcomeUpdate {
  tenant_id: string;
  workflow_id: string;
  outcome: "success" | "failure";
}

export async function recordExecutionOutcome(p: OutcomeUpdate, db: Executor): Promise<void> {
  try {
    const rows = await db
      .select({ id: patchCandidates.id })
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, p.tenant_id),
          eq(patchCandidates.workflow_id, p.workflow_id),
          eq(patchCandidates.status, "applied"),
          isNull(patchCandidates.outcome_window_ended_at),
        ),
      );
    if (rows.length === 0) return;

    const column =
      p.outcome === "success"
        ? patchCandidates.outcome_successes_after
        : patchCandidates.outcome_failures_after;

    for (const row of rows) {
      await db
        .update(patchCandidates)
        .set({
          [column.name]: sql`${column} + 1`,
        })
        .where(eq(patchCandidates.id, row.id));
    }
  } catch (err) {
    logger.debug({
      module: "self-healing",
      action: "outcome.track_failed",
      msg: "patch-candidate outcome tracker failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function closeExpiredOutcomeWindows(db: Executor): Promise<number> {
  const cutoff = new Date(Date.now() - WINDOW_MS);
  const result = await db
    .update(patchCandidates)
    .set({ outcome_window_ended_at: new Date() })
    .where(
      and(
        eq(patchCandidates.status, "applied"),
        isNull(patchCandidates.outcome_window_ended_at),
        sql`${patchCandidates.updated_at} < ${cutoff}`,
      ),
    );
  return Number((result as unknown as { rowCount?: number })?.rowCount ?? 0);
}
