import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflowsSchedules } from "../db/schema/index.ts";
import { isCriticalPush } from "../notifications/quiet-hours.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { buildAttention } from "./attention.ts";
import { tenant_id, testDb, useAttentionTenant, wf } from "./attention-fixtures.ts";

useAttentionTenant();

async function heldItem() {
  const attention = await buildAttention(testDb.db, adminPrincipal(tenant_id), {
    readers: {},
  });
  const item = attention.items.find((entry) => entry.id === `workflow:${wf.held}`);
  if (!item) throw new Error("held workflow item missing");
  return item;
}

async function runIn(environment: "dev" | "prod"): Promise<void> {
  await testDb.db
    .update(workflowsSchedules)
    .set({ execution_mode: environment })
    .where(
      and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.workflow_id, wf.held)),
    );
}

describe("a held schedule names the environment it runs in", () => {
  test("a held production schedule is critical, the same schedule in test is not", async () => {
    try {
      await runIn("prod");
      const live = await heldItem();
      expect(live.class).toBe("stopped");
      expect(live.subject?.environment).toBe("prod");
      expect(isCriticalPush(live)).toBe(true);

      await runIn("dev");
      const trial = await heldItem();
      expect(trial.class).toBe("stopped");
      expect(trial.subject?.environment).toBe("dev");
      expect(isCriticalPush(trial)).toBe(false);
    } finally {
      await runIn("prod");
    }
  });

  test("an auto-paused test schedule is stopped but not critical", async () => {
    const paused = {
      paused: true,
      paused_at: new Date("2026-11-20T08:00:00.000Z"),
      paused_reason: "repeated_failures" as const,
      paused_failure_class: "timed_out",
      paused_failure_count: 5,
    };
    const resumed = {
      paused: false,
      paused_at: null,
      paused_reason: null,
      paused_failure_class: null,
      paused_failure_count: null,
    };
    const scope = and(
      eq(workflowsSchedules.tenant_id, tenant_id),
      eq(workflowsSchedules.workflow_id, wf.held),
    );
    try {
      await testDb.db
        .update(workflowsSchedules)
        .set({ ...paused, execution_mode: "dev" })
        .where(scope);
      const trial = await heldItem();
      expect(trial.reason).toBe("schedule_auto_paused");
      expect(trial.subject?.environment).toBe("dev");
      expect(isCriticalPush(trial)).toBe(false);

      await testDb.db.update(workflowsSchedules).set({ execution_mode: "prod" }).where(scope);
      const live = await heldItem();
      expect(live.subject?.environment).toBe("prod");
      expect(isCriticalPush(live)).toBe(true);
    } finally {
      await testDb.db
        .update(workflowsSchedules)
        .set({ ...resumed, execution_mode: "prod" })
        .where(scope);
    }
  });
});
