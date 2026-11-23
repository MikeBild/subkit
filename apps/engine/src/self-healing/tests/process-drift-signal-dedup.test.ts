import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { patchCandidates, workflowVersions } from "../../db/schema/index.ts";
import { getLatestShape } from "../../schema-versions/index.ts";
import { approvePatchCandidate } from "../candidate-decision.ts";
import { analyzeStepFailure } from "../drift-detector.ts";
import { processDriftSignal } from "../service.ts";
import { signalFingerprint } from "../terminal-dedup.ts";
import {
  createSelfHealingCtx,
  resetSeedDag,
  type SelfHealingTestCtx,
  setAutohealPolicy,
} from "./setup.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("dedup");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function buildSignal() {
  const db = ctx.testDb.db;
  const lastShape = await getLatestShape(
    {
      tenant_id: ctx.tenant_id,
      connector_id: ctx.connector_id,
      endpoint_key: ctx.endpoint_key,
    },
    db,
  );
  const snapshot = {
    id: ctx.step_id,
    kind: "request" as const,
    status: "failed",
    error: {
      kind: "http",
      status: 404,
      body: { error: { code: "not_found", detail: "User not found" } },
    },
    request_meta: null,
    output_preview: { data: { id: 1 } },
  };
  const signal = analyzeStepFailure(snapshot, lastShape);
  if (!signal) throw new Error("expected drift signal");
  return { signal, snapshot };
}

function proactiveCtx(allowAutoApply: boolean) {
  return {
    signalCtx: {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      execution_id: ctx.execution_id,
      step_id: ctx.step_id,
      connector_id: ctx.connector_id,
      endpoint_key: ctx.endpoint_key,
      actor_id: null,
      source: "proactive_scheduler" as const,
      repair_input: {
        failing_step_id: `proactive:test:${ctx.step_id}`,
        response: { data: { id: 1 } },
      },
    },
    options: { allowAutoApply },
  };
}

async function endpointCandidateCount(): Promise<number> {
  const rows = await ctx.testDb.db
    .select()
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, ctx.tenant_id),
        eq(patchCandidates.workflow_id, ctx.workflow_id),
        eq(patchCandidates.connector_id, ctx.connector_id),
        eq(patchCandidates.endpoint_key, ctx.endpoint_key),
      ),
    );
  return rows.length;
}

async function versionCount(): Promise<number> {
  const rows = await ctx.testDb.db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
  return rows.length;
}

describe("processDriftSignal — proactive endpoint dedup", () => {
  let firstCandidateId: string;

  test("first proactive scan (operator-invoked) parks one candidate stamped with the endpoint", async () => {
    const { signal } = await buildSignal();
    const { signalCtx, options } = proactiveCtx(false);

    const result = await processDriftSignal(signal, signalCtx, options, ctx.testDb.db);
    firstCandidateId = result.candidate_id;

    expect(result.status).toBe("proposed");
    expect(result.classification).toBe("safe");
    expect(await endpointCandidateCount()).toBe(1);

    const [row] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, result.candidate_id));
    expect(row?.connector_id).toBe(ctx.connector_id);
    expect(row?.endpoint_key).toBe(ctx.endpoint_key);
  });

  test("a second proactive scan refreshes the proposed candidate — no duplicate row, no LLM re-run", async () => {
    const { signal } = await buildSignal();
    const { signalCtx, options } = proactiveCtx(false);

    const before = await endpointCandidateCount();
    const result = await processDriftSignal(signal, signalCtx, options, ctx.testDb.db);

    expect(result.candidate_id).toBe(firstCandidateId);
    expect(result.status).toBe("proposed");
    expect(await endpointCandidateCount()).toBe(before);
  });

  test("the scheduler tick never applies a safe patch that no fixture run has proven", async () => {
    await setAutohealPolicy(ctx, "safe-patches");
    const { signal } = await buildSignal();
    const { signalCtx, options } = proactiveCtx(true);

    const versionsBefore = await versionCount();
    const result = await processDriftSignal(signal, signalCtx, options, ctx.testDb.db);

    expect(result.candidate_id).toBe(firstCandidateId);
    expect(result.status).toBe("proposed");
    expect(result.auto_applied).toBe(false);
    expect(await endpointCandidateCount()).toBe(1);
    expect(await versionCount()).toBe(versionsBefore);

    const [row] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, firstCandidateId));
    expect(row?.status).toBe("proposed");
  });

  test("once applied, further scans skip the endpoint — no re-apply, no version churn", async () => {
    await approvePatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: firstCandidateId, actor_id: null },
      ctx.testDb.db,
    );
    const { signal } = await buildSignal();
    const { signalCtx, options } = proactiveCtx(true);

    const versionsBefore = await versionCount();
    const result = await processDriftSignal(signal, signalCtx, options, ctx.testDb.db);

    expect(result.candidate_id).toBe(firstCandidateId);
    expect(result.status).toBe("applied");
    expect(result.auto_applied).toBe(false);
    expect(await endpointCandidateCount()).toBe(1);
    expect(await versionCount()).toBe(versionsBefore);
  });
});

describe("processDriftSignal — new drift on a healed endpoint is NOT masked", () => {
  test("a DIFFERENT drift shape after a patch is applied proposes a fresh candidate, not skipped", async () => {
    const local = await createSelfHealingCtx("t10-new-drift");
    try {
      const db = local.testDb.db;
      const lastShape = await getLatestShape(
        {
          tenant_id: local.tenant_id,
          connector_id: local.connector_id,
          endpoint_key: local.endpoint_key,
        },
        db,
      );
      const signalCtx = {
        tenant_id: local.tenant_id,
        workflow_id: local.workflow_id,
        execution_id: local.execution_id,
        step_id: local.step_id,
        connector_id: local.connector_id,
        endpoint_key: local.endpoint_key,
        actor_id: null,
        source: "proactive_scheduler" as const,
        repair_input: {
          failing_step_id: `proactive:test:${local.step_id}`,
          response: { data: { id: 1 } },
        },
      };
      const mkSignal = (body: unknown) => {
        const signal = analyzeStepFailure(
          {
            id: local.step_id,
            kind: "request" as const,
            status: "failed",
            error: { kind: "http", status: 404, body },
            request_meta: null,
            output_preview: { data: { id: 1 } },
          },
          lastShape,
        );
        if (!signal) throw new Error("expected drift signal");
        return signal;
      };

      const driftA = mkSignal({ error: { code: "not_found", detail: "User not found" } });
      const driftB = mkSignal({ message: "gone", retry_after: 30, details: ["a", "b"] });
      expect(signalFingerprint(driftA)).not.toBe(signalFingerprint(driftB));

      await setAutohealPolicy(local, "safe-patches");
      const a = await processDriftSignal(driftA, signalCtx, { allowAutoApply: true }, db);
      expect(a.status).toBe("proposed");
      expect(a.auto_applied).toBe(false);
      await approvePatchCandidate(
        { tenant_id: local.tenant_id, candidate_id: a.candidate_id, actor_id: null },
        db,
      );

      const countAfterA = await (async () => {
        const rows = await db
          .select()
          .from(patchCandidates)
          .where(
            and(
              eq(patchCandidates.tenant_id, local.tenant_id),
              eq(patchCandidates.endpoint_key, local.endpoint_key),
            ),
          );
        return rows.length;
      })();
      expect(countAfterA).toBe(1);

      await resetSeedDag(local);
      const b = await processDriftSignal(driftB, signalCtx, { allowAutoApply: false }, db);
      expect(b.candidate_id).not.toBe(a.candidate_id);
      expect(b.status).toBe("proposed");

      const rowsAfterB = await db
        .select()
        .from(patchCandidates)
        .where(
          and(
            eq(patchCandidates.tenant_id, local.tenant_id),
            eq(patchCandidates.endpoint_key, local.endpoint_key),
          ),
        );
      expect(rowsAfterB.length).toBe(2);

      const aAgain = await processDriftSignal(driftA, signalCtx, { allowAutoApply: true }, db);
      expect(aAgain.candidate_id).toBe(a.candidate_id);
      expect(aAgain.auto_applied).toBe(false);
      const rowsFinal = await db
        .select()
        .from(patchCandidates)
        .where(
          and(
            eq(patchCandidates.tenant_id, local.tenant_id),
            eq(patchCandidates.endpoint_key, local.endpoint_key),
          ),
        );
      expect(rowsFinal.length).toBe(2);
    } finally {
      await local.cleanup();
    }
  });
});

describe("processDriftSignal — terminal proactive endpoint dedup", () => {
  test("rejected candidate suppresses the same proactive drift fingerprint without a duplicate", async () => {
    const local = await createSelfHealingCtx("terminal-dedup");
    try {
      const db = local.testDb.db;
      const lastShape = await getLatestShape(
        {
          tenant_id: local.tenant_id,
          connector_id: local.connector_id,
          endpoint_key: local.endpoint_key,
        },
        db,
      );
      const snapshot = {
        id: local.step_id,
        kind: "request" as const,
        status: "failed",
        error: {
          kind: "http",
          status: 404,
          body: { error: { code: "not_found", detail: "User not found" } },
        },
        request_meta: null,
        output_preview: { data: { id: 1 } },
      };
      const signal = analyzeStepFailure(snapshot, lastShape);
      if (!signal) throw new Error("expected drift signal");
      const signalCtx = {
        tenant_id: local.tenant_id,
        workflow_id: local.workflow_id,
        execution_id: local.execution_id,
        step_id: local.step_id,
        connector_id: local.connector_id,
        endpoint_key: local.endpoint_key,
        actor_id: null,
        source: "proactive_scheduler" as const,
        repair_input: {
          failing_step_id: `proactive:test:${local.step_id}`,
          response: { data: { id: 1 } },
        },
      };

      const first = await processDriftSignal(signal, signalCtx, { allowAutoApply: false }, db);
      await db
        .update(patchCandidates)
        .set({ status: "rejected" })
        .where(eq(patchCandidates.id, first.candidate_id));

      const second = await processDriftSignal(signal, signalCtx, { allowAutoApply: true }, db);

      expect(second.candidate_id).toBe(first.candidate_id);
      expect(second.status).toBe("rejected");
      expect(second.auto_applied).toBe(false);

      const rows = await db
        .select()
        .from(patchCandidates)
        .where(
          and(
            eq(patchCandidates.tenant_id, local.tenant_id),
            eq(patchCandidates.workflow_id, local.workflow_id),
            eq(patchCandidates.connector_id, local.connector_id),
            eq(patchCandidates.endpoint_key, local.endpoint_key),
          ),
        );
      expect(rows.length).toBe(1);
    } finally {
      await local.cleanup();
    }
  });
});

test("workflow-scoped observations deduplicate without an endpoint anchor", async () => {
  const { signalCtx, options } = proactiveCtx(false);
  const workflowContext = { ...signalCtx, connector_id: null, endpoint_key: null };
  const signal = {
    kind: "jsonata_path_miss" as const,
    expression: "data.id",
    missing_path: "data.id",
    prior_value: 1,
  };
  const first = await processDriftSignal(signal, workflowContext, options, ctx.testDb.db);
  const repeated = await processDriftSignal(
    { ...signal, prior_value: 2 },
    workflowContext,
    options,
    ctx.testDb.db,
  );
  expect(first.created).toBe(true);
  expect(repeated.created).toBe(false);
  expect(repeated.candidate_id).toBe(first.candidate_id);
  const changed = await processDriftSignal(
    { ...signal, missing_path: "data.other" },
    workflowContext,
    options,
    ctx.testDb.db,
  );
  expect(changed.created).toBe(true);
  expect(changed.candidate_id).not.toBe(first.candidate_id);
});
