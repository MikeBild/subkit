import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, patchCandidates } from "../../db/schema/index.ts";
import { LlmGenerationAborted } from "../../llm/errors.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { getLatestShape } from "../../schema-versions/service.ts";
import { analyzeStepFailure } from "../drift-detector.ts";
import { NOT_REPAIRABLE_NEXT_STEP, NOT_REPAIRABLE_REASON } from "../persist-candidate.ts";
import { processDriftSignal } from "../service.ts";
import { createSelfHealingCtx, type SelfHealingTestCtx } from "./setup.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("not_repairable");
});

afterEach(() => {
  getMockProvider().generateOverrides = {};
});

afterAll(async () => {
  await ctx.cleanup();
});

async function buildSignal() {
  const lastShape = await getLatestShape(
    { tenant_id: ctx.tenant_id, connector_id: ctx.connector_id, endpoint_key: ctx.endpoint_key },
    ctx.testDb.db,
  );
  const signal = analyzeStepFailure(
    {
      id: ctx.step_id,
      kind: "request" as const,
      status: "failed",
      error: { kind: "http", status: 404, body: { error: { code: "not_found" } } },
      request_meta: null,
      output_preview: { data: { id: 1 } },
    },
    lastShape,
  );
  if (!signal) throw new Error("expected drift signal");
  return signal;
}

const signalCtx = () => ({
  tenant_id: ctx.tenant_id,
  workflow_id: ctx.workflow_id,
  execution_id: ctx.execution_id,
  step_id: ctx.step_id,
  connector_id: ctx.connector_id,
  endpoint_key: ctx.endpoint_key,
  actor_id: null,
  source: "proactive_scheduler" as const,
  repair_input: { failing_step_id: `proactive:test:${ctx.step_id}` },
});

function repairCalls(): number {
  return getMockProvider().calls.filter((c) => c.flow === "repair").length;
}

describe("processDriftSignal — repair model aborts", () => {
  test("an abort is stored as a reviewable not-repairable finding and the same drift is not sent to the model again", async () => {
    getMockProvider().generateOverrides.repair = () => {
      throw new LlmGenerationAborted({
        reason: "the old field path of the failing step is unknown",
        needs: [],
      });
    };
    const signal = await buildSignal();
    const before = repairCalls();

    const first = await processDriftSignal(
      signal,
      signalCtx(),
      { allowAutoApply: true },
      ctx.testDb.db,
    );

    expect(first.status).toBe("inapplicable");
    expect(first.created).toBe(false);
    expect(first.auto_applied).toBe(false);
    expect(repairCalls()).toBe(before + 1);

    const [row] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, first.candidate_id));
    expect(row?.status).toBe("inapplicable");
    expect(row?.closed_reason).toBe(NOT_REPAIRABLE_REASON);
    expect(row?.closed_against_version_id).toBeTruthy();
    const diff = row?.diff as {
      drift_signal?: unknown;
      not_repairable?: { reason: string; next_step: string };
    };
    expect(diff.drift_signal).toEqual(signal);
    expect(diff.not_repairable?.reason).toBe("the old field path of the failing step is unknown");
    expect(diff.not_repairable?.next_step).toBe(NOT_REPAIRABLE_NEXT_STEP);

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, first.candidate_id)),
      );
    expect(audits.map((a) => a.reason)).toContain(NOT_REPAIRABLE_REASON);

    const second = await processDriftSignal(
      signal,
      signalCtx(),
      { allowAutoApply: true },
      ctx.testDb.db,
    );
    expect(second.candidate_id).toBe(first.candidate_id);
    expect(second.status).toBe("inapplicable");
    expect(repairCalls()).toBe(before + 1);
  });
});
