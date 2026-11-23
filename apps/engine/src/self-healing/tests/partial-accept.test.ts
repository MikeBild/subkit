import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import {
  executionSteps,
  patchCandidates,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { readPatchInteractionLog } from "../candidate-admin.ts";
import {
  approvePatchCandidate,
  PatchDecisionError,
  rejectPatchCandidate,
} from "../candidate-decision.ts";
import { readPatchSelection } from "../candidate-readiness.ts";
import { dryRunPatchCandidate, previewPatchCandidate } from "../candidate-review.ts";
import { createSelfHealingCtx, SEED_STEP_ID, type SelfHealingTestCtx } from "./setup.ts";

const ACTOR = "10000000-0000-4000-8000-000000000001";
const SHAPE_STEP_ID = "shape";
const TWO_LINES = '{\n  "id": data.id,\n  "owner": data.id\n}';

let ctx: SelfHealingTestCtx;
let shapeStepId: string;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("partial_accept");
  const [step] = await ctx.testDb.db
    .insert(executionSteps)
    .values({
      tenant_id: ctx.tenant_id,
      execution_id: ctx.execution_id,
      step_key: SHAPE_STEP_ID,
      step_index: 1,
      kind: "transform",
      status: "failed",
    })
    .returning();
  if (!step) throw new Error("seed transform step failed");
  shapeStepId = step.id;
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function currentSteps(): Promise<Record<string, unknown>[]> {
  const [row] = await ctx.testDb.db
    .select({ dag: workflowVersions.dag })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, ctx.workflow_id)));
  const steps = (row?.dag as { steps?: Record<string, unknown>[] } | undefined)?.steps ?? [];
  return steps;
}

async function currentExpression(): Promise<unknown> {
  return (await currentSteps()).find((entry) => entry.id === SHAPE_STEP_ID)?.expression;
}

async function seedCandidate(): Promise<string> {
  const db = ctx.testDb.db;
  const [workflow] = await db
    .select({ current: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, ctx.workflow_id)));
  if (!workflow?.current) throw new Error("workflow has no current version");
  const request = (await currentSteps()).find((entry) => entry.id === SEED_STEP_ID);
  if (!request) throw new Error("seed step missing");
  await db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Workflow partial_accept",
        steps: [request, { id: SHAPE_STEP_ID, kind: "transform", expression: TWO_LINES }],
      },
    })
    .where(
      and(eq(workflowVersions.tenant_id, ctx.tenant_id), eq(workflowVersions.id, workflow.current)),
    );
  const [row] = await db
    .insert(patchCandidates)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      connector_id: ctx.connector_id,
      classification: "safe",
      status: "proposed",
      fixture_id: ctx.fixture_id,
      diff: {
        drift_diff: "kind: schema_diff\nwidened: data.id",
        step_id: shapeStepId,
        proposal: {
          classification: "safe",
          kind: "update_field_path",
          description: "Follow the renamed field",
          patch: { path: "data.id", value: "data.result.id" },
          reasoning: "the response moved the id under result",
        },
      },
    })
    .returning();
  if (!row) throw new Error("candidate insert failed");
  return row.id;
}

async function candidateRow(id: string) {
  const [row] = await ctx.testDb.db
    .select()
    .from(patchCandidates)
    .where(and(eq(patchCandidates.tenant_id, ctx.tenant_id), eq(patchCandidates.id, id)));
  if (!row) throw new Error("candidate missing");
  return row;
}

function actor(candidate_id: string) {
  return {
    tenant_id: ctx.tenant_id,
    candidate_id,
    actor_id: ACTOR,
    actor_type: "user" as const,
  };
}

async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PatchDecisionError) return error.code;
    throw error;
  }
  return "not_refused";
}

describe("accepting a part of a repair", () => {
  test("the preview lists one operation per changed line", async () => {
    const id = await seedCandidate();
    const preview = await previewPatchCandidate(ctx.tenant_id, id, ctx.testDb.db);
    expect(preview?.changed_paths).toEqual(["expression"]);
    expect(
      preview?.operations.map((operation) => [operation.path, operation.line, operation.after]),
    ).toEqual([
      ["expression", 2, '  "id": data.result.id,'],
      ["expression", 3, '  "owner": data.result.id'],
    ]);
    expect(preview?.accepted_operations).toBeNull();
  });

  test("dry run of a part, then approval of exactly that part, changes only that part", async () => {
    const db = ctx.testDb.db;
    const id = await seedCandidate();
    const preview = await previewPatchCandidate(ctx.tenant_id, id, db);

    const tested = await dryRunPatchCandidate({ ...actor(id), accepted_operations: [0] }, db);
    if (tested.status !== "ran") throw new Error(`dry run did not run: ${tested.status}`);
    expect(tested.ok).toBe(true);
    expect(tested.value_preview).toEqual({ id: 42 });
    expect(tested.accepted_operations).toEqual([0]);
    expect(tested.review_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(tested.review_digest).not.toBe(preview?.review_digest);
    expect(await candidateRow(id)).toMatchObject({
      status: "proposed",
      accepted_operations: [0],
      accepted_digest: tested.review_digest,
    });
    expect(await currentExpression()).toBe(TWO_LINES);

    const versionId = await approvePatchCandidate(
      {
        ...actor(id),
        accepted_operations: [0],
        expected_review_digest: tested.review_digest ?? "",
      },
      db,
    );
    expect(versionId).toBeTruthy();
    expect(await currentExpression()).toBe('{\n  "id": data.result.id,\n  "owner": data.id\n}');
    expect(await candidateRow(id)).toMatchObject({
      status: "applied",
      accepted_operations: [0],
      accepted_digest: tested.review_digest,
    });

    const [approved] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "patch_candidate.approved"),
          eq(auditLog.resource_id, id),
        ),
      );
    expect(approved?.metadata).toMatchObject({
      accepted_operations: [0],
      declined_operations: [1],
      operation_count: 2,
    });

    const log = await readPatchInteractionLog(db, ctx.tenant_id, id);
    expect(log.map((entry) => [entry.event, entry.ok, entry.accepted_operations])).toEqual([
      ["tested", true, [0]],
      ["accepted_partly", null, [0]],
    ]);
    expect(log[1]?.declined_operations).toEqual([1]);
    expect(log[1]?.actor_id).toBe(ACTOR);
  });

  test("a digest that covers another part is refused and nothing changes", async () => {
    const db = ctx.testDb.db;
    const id = await seedCandidate();
    const tested = await dryRunPatchCandidate({ ...actor(id), accepted_operations: [0] }, db);
    if (tested.status !== "ran") throw new Error(`dry run did not run: ${tested.status}`);
    const digest = tested.review_digest ?? "";

    expect(
      await refusal(
        approvePatchCandidate(
          { ...actor(id), accepted_operations: [1], expected_review_digest: digest },
          db,
        ),
      ),
    ).toBe("review_changed");
    expect(
      await refusal(approvePatchCandidate({ ...actor(id), expected_review_digest: digest }, db)),
    ).toBe("review_changed");
    expect((await candidateRow(id)).status).toBe("proposed");
    expect(await currentExpression()).toBe(TWO_LINES);
  });

  test("a part that was never tested is refused, also when another part was", async () => {
    const db = ctx.testDb.db;
    const id = await seedCandidate();
    const untested = await readPatchSelection(ctx.tenant_id, await candidateRow(id), db, [1]);
    const digest = untested.readiness.review_digest ?? "";
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    expect(
      await refusal(
        approvePatchCandidate(
          { ...actor(id), accepted_operations: [1], expected_review_digest: digest },
          db,
        ),
      ),
    ).toBe("dry_run_required");
    await dryRunPatchCandidate({ ...actor(id), accepted_operations: [0] }, db);
    expect(
      await refusal(
        approvePatchCandidate(
          { ...actor(id), accepted_operations: [1], expected_review_digest: digest },
          db,
        ),
      ),
    ).toBe("dry_run_required");
    expect(
      await refusal(approvePatchCandidate({ ...actor(id), accepted_operations: [1] }, db)),
    ).toBe("dry_run_required");
    expect((await candidateRow(id)).status).toBe("proposed");
  });

  test("an unknown operation index is refused by dry run and approval", async () => {
    const db = ctx.testDb.db;
    const id = await seedCandidate();
    expect(await dryRunPatchCandidate({ ...actor(id), accepted_operations: [7] }, db)).toEqual({
      status: "invalid_selection",
      reason: "accepted_operations_invalid",
    });
    expect(
      await refusal(approvePatchCandidate({ ...actor(id), accepted_operations: [7] }, db)),
    ).toBe("accepted_operations_invalid");
    expect((await candidateRow(id)).accepted_operations).toBeNull();
  });

  test("the whole repair still applies with the preview digest and clears a tested part", async () => {
    const db = ctx.testDb.db;
    const id = await seedCandidate();
    const preview = await previewPatchCandidate(ctx.tenant_id, id, db);
    await dryRunPatchCandidate({ ...actor(id), accepted_operations: [1] }, db);
    const whole = await dryRunPatchCandidate(actor(id), db);
    if (whole.status !== "ran") throw new Error(`dry run did not run: ${whole.status}`);
    expect(whole.accepted_operations).toBeNull();
    expect(whole.review_digest).toBe(preview?.review_digest ?? null);

    await approvePatchCandidate(
      { ...actor(id), expected_review_digest: preview?.review_digest ?? "" },
      db,
    );
    expect(await currentExpression()).toBe(
      '{\n  "id": data.result.id,\n  "owner": data.result.id\n}',
    );
    expect(await candidateRow(id)).toMatchObject({
      status: "applied",
      accepted_operations: null,
      accepted_digest: null,
    });
    const log = await readPatchInteractionLog(db, ctx.tenant_id, id);
    expect(log.map((entry) => entry.event)).toEqual(["tested", "tested", "accepted"]);
  });

  test("a declined repair shows up in the interaction log with its reason", async () => {
    const db = ctx.testDb.db;
    const id = await seedCandidate();
    await rejectPatchCandidate({ ...actor(id), reason: "keep the old field" }, db);
    expect(await readPatchInteractionLog(db, ctx.tenant_id, id)).toMatchObject([
      { event: "declined", reason: "keep the old field", actor_type: "user" },
    ]);
  });
});
