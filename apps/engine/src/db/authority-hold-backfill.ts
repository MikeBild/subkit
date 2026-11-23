import { AUTHORITY_HOLD_BACKFILL } from "@shared/authority-refusal.ts";
import { eq, sql } from "drizzle-orm";
import { logger } from "../logging/index.ts";
import type { Db } from "./client.ts";
import { dataMigrations, webhooksInbound, workflowsSchedules } from "./schema/index.ts";

export const AUTHORITY_HOLD_REASONS_BACKFILL_NAME = "authority_hold_reasons_v1";

export interface AuthorityHoldReasonsBackfillReport {
  skipped: boolean;
  schedules: number;
  inbound_hooks: number;
  paused_schedules: number;
}

export async function runAuthorityHoldReasonsBackfill(
  db: Db,
): Promise<AuthorityHoldReasonsBackfillReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger; markers are instance-global by design
    .where(eq(dataMigrations.name, AUTHORITY_HOLD_REASONS_BACKFILL_NAME))
    .limit(1);
  if (marker.length > 0)
    return { skipped: true, schedules: 0, inbound_hooks: 0, paused_schedules: 0 };
  const { from, to } = AUTHORITY_HOLD_BACKFILL;
  const report = await db.transaction(async (tx) => {
    const schedules = await tx
      .update(workflowsSchedules)
      .set({
        admission_hold: sql`jsonb_set(${workflowsSchedules.admission_hold}, '{reason_code}', to_jsonb(${to}::text))`,
      })
      .where(sql`(${workflowsSchedules.admission_hold}->>'reason_code') = ${from}`)
      .returning({ id: workflowsSchedules.id });
    const paused = await tx
      .update(workflowsSchedules)
      .set({ paused_failure_class: to })
      .where(eq(workflowsSchedules.paused_failure_class, from))
      .returning({ id: workflowsSchedules.id });
    const hooks = await tx
      .update(webhooksInbound)
      .set({
        admission_hold: sql`jsonb_set(${webhooksInbound.admission_hold}, '{reason_code}', to_jsonb(${to}::text))`,
      })
      .where(sql`(${webhooksInbound.admission_hold}->>'reason_code') = ${from}`)
      .returning({ id: webhooksInbound.id });
    await tx
      .insert(dataMigrations)
      .values({ name: AUTHORITY_HOLD_REASONS_BACKFILL_NAME })
      .onConflictDoNothing();
    return {
      skipped: false,
      schedules: schedules.length,
      inbound_hooks: hooks.length,
      paused_schedules: paused.length,
    };
  });
  logger.info({
    module: "db",
    action: "migrate.authority_hold_reasons_backfill",
    msg: "rewrote persisted holds from the removed approval reason to the expired reason",
    ...report,
  });
  return report;
}
