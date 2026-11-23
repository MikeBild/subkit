import type { Executor } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import { intakeGroupKey } from "../core/intake-dedupe.ts";
import { intakeItemsWithoutGroupKey, setIntakeGroupKey } from "../persistence/intake-dedupe.ts";
import { backfillApplied, markBackfillApplied } from "../persistence/rechunk.ts";

export const INTAKE_GROUP_KEY_BACKFILL_NAME = "intake_group_key_v1";
const BATCH = 500;

export async function runIntakeGroupKeyBackfill(
  db: Executor,
): Promise<{ skipped: boolean; scanned: number; grouped: number }> {
  if (await backfillApplied(db, INTAKE_GROUP_KEY_BACKFILL_NAME))
    return { skipped: true, scanned: 0, grouped: 0 };
  let after: string | null = null;
  let scanned = 0;
  let grouped = 0;
  for (;;) {
    const rows = await intakeItemsWithoutGroupKey(db, { after, limit: BATCH });
    for (const row of rows) {
      const group_key = intakeGroupKey(row.snapshot);
      if (!group_key) continue;
      await setIntakeGroupKey(db, { tenant_id: row.tenant_id, id: row.id, group_key });
      grouped += 1;
    }
    scanned += rows.length;
    const last = rows.at(-1);
    if (!last || rows.length < BATCH) break;
    after = last.id;
  }
  await markBackfillApplied(db, INTAKE_GROUP_KEY_BACKFILL_NAME);
  logger.info({
    module: "knowledge",
    action: "intake.group_key_backfill.completed",
    msg: "intake group key backfill finished",
    scanned,
    grouped,
  });
  return { skipped: false, scanned, grouped };
}
