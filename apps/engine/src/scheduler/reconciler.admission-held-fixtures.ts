import { afterAll, beforeAll } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog } from "../db/schema/index.ts";
import { createEngineCtx, type EngineTestCtx } from "../execution/tests/setup.ts";

export let ctx: EngineTestCtx;

export async function occurrenceAudits(schedule_id: string) {
  const rows = await ctx.testDb.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.resource_id, schedule_id),
        inArray(auditLog.action, ["schedule.occurrence_claimed", "schedule.occurrence_restored"]),
      ),
    );
  return {
    claimed: rows.filter((row) => row.action === "schedule.occurrence_claimed").length,
    restored: rows.filter((row) => row.action === "schedule.occurrence_restored").length,
  };
}

export function useAdmissionHeldDb(): void {
  beforeAll(async () => {
    ctx = await createEngineCtx("schedule-admission-held");
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
}
