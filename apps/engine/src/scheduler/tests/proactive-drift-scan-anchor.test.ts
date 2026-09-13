// The definition anchor must survive the hop from the scanner to the row.
//
// A proactive drift signal has no failing execution row: `workflow_step_id`
// is the only anchor its candidate will ever carry. The scanner sets it and
// the service persists it, but the scheduler runner in between rebuilds the
// context field by field — and a field it forgets is a candidate that can be
// neither previewed nor applied, which is how a review queue fills up with
// entries that look empty and never move.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";

import { patchCandidates, schemaVersions } from "../../db/schema/index.ts";
import { driftSignalContext } from "../../self-healing/proactive-scanner.ts";
import {
  createSelfHealingCtx,
  SEED_STEP_ID,
  type SelfHealingTestCtx,
} from "../../self-healing/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { runProactiveDriftScanForTenant } from "../proactive-drift-scan-runner.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("drift_anchor");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("proactive drift scan", () => {
  test("carries the definition anchor into the candidate it creates", async () => {
    const endpoint_key = "GET /users/1";
    const now = getTestNow();
    const older = new Date(now - 60_000);
    await ctx.testDb.db.insert(schemaVersions).values({
      tenant_id: ctx.tenant_id,
      connector_id: ctx.connector_id,
      endpoint_key,
      workflow_id: ctx.workflow_id,
      step_id: SEED_STEP_ID,
      schema: { type: "object", properties: { data: { type: "object", properties: {} } } },
      seen_at: older,
    });
    await ctx.testDb.db.insert(schemaVersions).values({
      tenant_id: ctx.tenant_id,
      connector_id: ctx.connector_id,
      endpoint_key,
      workflow_id: ctx.workflow_id,
      step_id: SEED_STEP_ID,
      schema: { type: "object", properties: { data: { type: "string" } } },
      seen_at: new Date(now),
    });

    await runProactiveDriftScanForTenant(ctx.tenant_id, new Date(now), ctx.testDb.db);

    const rows = await ctx.testDb.db
      .select({ diff: patchCandidates.diff })
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, ctx.tenant_id),
          eq(patchCandidates.workflow_id, ctx.workflow_id),
        ),
      )
      .orderBy(desc(patchCandidates.created_at))
      .limit(1);
    const diff = rows[0]?.diff as Record<string, unknown> | undefined;
    expect(diff).toBeDefined();
    // No execution row for a proactive signal — so this anchor is the whole
    // link between the candidate and the step it proposes to change.
    expect(diff?.step_id).toBeNull();
    expect(diff?.workflow_step_id).toBe(SEED_STEP_ID);
  }, 90_000);

  test("the shared translation carries every anchor a caller may hold", () => {
    // Both scan callers — the scheduler runner and the operator HTTP route —
    // build their process context here. Rebuilding it by hand is what dropped
    // the anchor twice, so the translation is what the test pins.
    const context = driftSignalContext(
      {
        tenant_id: "t",
        workflow_id: "w",
        execution_id: null,
        step_id: null,
        workflow_step_id: SEED_STEP_ID,
        connector_id: "c",
        endpoint_key: "GET /users/1",
        repair_input: { failing_step_id: "proactive:schema_diff" },
      },
      { actor_id: null, source: "proactive_admin", scan_id: "s" },
    );
    expect(context.workflow_step_id).toBe(SEED_STEP_ID);
    expect(context.connector_id).toBe("c");
    expect(context.endpoint_key).toBe("GET /users/1");
    expect(context.repair_input.failing_step_id).toBe("proactive:schema_diff");
  });

  test("a signal without a definition anchor omits the field rather than nulling it", () => {
    const context = driftSignalContext(
      {
        tenant_id: "t",
        workflow_id: "w",
        execution_id: null,
        step_id: null,
        repair_input: { failing_step_id: "proactive:stdlib" },
      },
      { actor_id: null, source: "proactive_scheduler", scan_id: "s" },
    );
    expect("workflow_step_id" in context).toBe(false);
  });
});
