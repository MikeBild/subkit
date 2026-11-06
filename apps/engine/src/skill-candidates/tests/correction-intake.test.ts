import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  conversations,
  conversationToolCalls,
  executionSteps,
  executions,
  intakeItemEvidence,
  intakeItems,
  knowledgeSources,
  skills,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  createDeterministicClock,
  FROZEN_NOW,
  installClock,
  restoreClock,
} from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import { updateWorkflow } from "../../workflows/service.ts";
import { CORRECTION_AGENT, collectCorrectionIntake } from "../correction-intake.ts";
import { changedStepSummary, detectCorrectionPatterns } from "../detectors/correction-pattern.ts";
import { runPatternAnalysis } from "../service.ts";

const uuid = createDeterministicUuidFactory(0xc0a1a7);

const skip = process.env.REQUIRES_PG === "0";
const RECENT = new Date(FROZEN_NOW - 24 * 60 * 60 * 1000);
const STALE = new Date(FROZEN_NOW - 40 * 24 * 60 * 60 * 1000);

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;
let workflowId: string;
let otherWorkflowId: string;

async function seedWorkflow(tenant_id: string, slug: string, name: string): Promise<string> {
  const [row] = await testDb.db
    .insert(workflows)
    .values({ tenant_id, slug, name, lifecycle: "draft" })
    .returning({ id: workflows.id });
  if (!row) throw new Error("workflow seed failed");
  return row.id;
}

async function seedJudgeCall(
  tenant_id: string,
  target_workflow_id: string | null,
  judge: { verdict: string; reason: string; missing: string[] },
  at: Date = RECENT,
): Promise<string> {
  const [conversation] = await testDb.db
    .insert(conversations)
    .values({ tenant_id, target_workflow_id, status: "active" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation seed failed");
  await testDb.db.insert(conversationToolCalls).values({
    tenant_id,
    conversation_id: conversation.id,
    tool: "dry_run_workflow",
    input: {},
    output: { ok: false, judge },
    created_at: at,
  });
  return conversation.id;
}

async function seedTransformFailure(
  tenant_id: string,
  workflow_id: string,
  code: string,
  at: Date = RECENT,
): Promise<string> {
  const [execution] = await testDb.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      status: "failed",
      request_source: "api",
      execution_mode: "prod",
      started_at: at,
    })
    .returning({ id: executions.id });
  if (!execution) throw new Error("execution seed failed");
  await testDb.db.insert(executionSteps).values({
    tenant_id,
    execution_id: execution.id,
    step_key: "shape_rows",
    kind: "transform",
    status: "failed",
    error: { code, message: "TypeError: rows.map is not a function" },
    started_at: at,
  });
  return execution.id;
}

async function seedDraftSave(
  tenant_id: string,
  workflow_id: string,
  p: { version: number; request_source: string; actor_type: string; at: Date; steps: unknown[] },
): Promise<string> {
  await testDb.db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id, version: p.version, dag: { steps: p.steps } });
  const id = uuid();
  await testDb.db.insert(auditLog).values({
    id,
    ts: p.at,
    tenant_id,
    actor_type: p.actor_type,
    actor_id: uuid(),
    action: "workflow.updated",
    resource_type: "workflow",
    resource_id: workflow_id,
    result: "success",
    metadata: { kind: "draft", version: p.version, request_source: p.request_source },
  });
  return id;
}

async function itemsOf(tenant_id: string) {
  return testDb.db.select().from(intakeItems).where(eq(intakeItems.tenant_id, tenant_id));
}

async function evidenceOf(tenant_id: string, item_id: string) {
  return testDb.db
    .select()
    .from(intakeItemEvidence)
    .where(
      and(eq(intakeItemEvidence.tenant_id, tenant_id), eq(intakeItemEvidence.item_id, item_id)),
    );
}

async function collectedAudits(tenant_id: string) {
  return testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "intake_item.collected")));
}

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("correction_intake");
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
  restoreClock(null);
}, 30_000);

beforeEach(async () => {
  if (skip) return;
  installClock(createDeterministicClock(FROZEN_NOW));
  const suffix = uuid().slice(0, 8);
  tenantId = (
    await seedTenant(testDb.db, { slug: `corr-a-${suffix}`, display_name: `corr-a-${suffix}` })
  ).id;
  otherTenantId = (
    await seedTenant(testDb.db, { slug: `corr-b-${suffix}`, display_name: `corr-b-${suffix}` })
  ).id;
  workflowId = await seedWorkflow(tenantId, "orders-digest", "Orders digest");
  otherWorkflowId = await seedWorkflow(otherTenantId, "orders-digest", "Orders digest");
});

afterEach(() => {
  restoreClock(null);
});

describe.skipIf(skip)("collectCorrectionIntake", () => {
  test("a partial judge verdict collects one intake item with provenance and tenant_id", async () => {
    const conversationId = await seedJudgeCall(tenantId, workflowId, {
      verdict: "partial",
      reason: "the table lacks the total column",
      missing: ["total"],
    });

    const report = await collectCorrectionIntake(tenantId, testDb.db);

    expect(report.collected).toBe(1);
    const [item, ...rest] = await itemsOf(tenantId);
    expect(rest).toHaveLength(0);
    expect(item?.tenant_id).toBe(tenantId);
    expect(item?.state).toBe("collected");
    expect(item?.collected_by_type).toBe("system_account");
    expect(item?.title).toBe("Preview judge rated 'Orders digest' partial");
    expect(item?.original_snapshot).toMatchObject({
      origin: "session",
      agent: CORRECTION_AGENT,
      session_id: `conversation:${conversationId}`,
      scope: "workflow",
      workflow_id: workflowId,
      tags: ["correction:judge_verdict"],
    });
    const evidence = await evidenceOf(tenantId, item?.id ?? "");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.excerpt).toContain("missing: total");
    expect(evidence[0]?.excerpt).toContain(`conversation=${conversationId}`);
    const audits = await collectedAudits(tenantId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ agent: CORRECTION_AGENT });
    expect(
      await testDb.db
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.tenant_id, tenantId)),
    ).toHaveLength(0);
    expect(
      await testDb.db.select().from(skills).where(eq(skills.tenant_id, tenantId)),
    ).toHaveLength(0);
  });

  test("passing verdicts and stale verdicts collect nothing", async () => {
    await seedJudgeCall(tenantId, workflowId, { verdict: "passes", reason: "ok", missing: [] });
    await seedJudgeCall(
      tenantId,
      workflowId,
      { verdict: "failed", reason: "x", missing: [] },
      STALE,
    );

    const report = await collectCorrectionIntake(tenantId, testDb.db);

    expect(report.observed).toBe(0);
    expect(await itemsOf(tenantId)).toHaveLength(0);
  });

  test("repeated failures append evidence to one item and a rerun changes nothing", async () => {
    await seedJudgeCall(tenantId, workflowId, { verdict: "failed", reason: "empty", missing: [] });
    await seedJudgeCall(tenantId, workflowId, { verdict: "failed", reason: "empty", missing: [] });
    await seedTransformFailure(tenantId, workflowId, "sandbox_runtime");
    await seedTransformFailure(tenantId, workflowId, "sandbox_runtime");

    const first = await collectCorrectionIntake(tenantId, testDb.db);
    const second = await collectCorrectionIntake(tenantId, testDb.db);

    expect(first.collected).toBe(2);
    expect(first.evidence_appended).toBe(2);
    expect(second).toMatchObject({ collected: 0, evidence_appended: 0 });
    const items = await itemsOf(tenantId);
    expect(items.map((item) => item.title).sort()).toEqual([
      "Preview judge rated 'Orders digest' failed",
      "Transform step 'shape_rows' fails at runtime in 'Orders digest' (sandbox_runtime)",
    ]);
    for (const item of items) expect(await evidenceOf(tenantId, item.id)).toHaveLength(2);
    expect(await collectedAudits(tenantId)).toHaveLength(2);
  });

  test("a transform runtime error collects the code without the error message", async () => {
    const executionId = await seedTransformFailure(tenantId, workflowId, "sandbox_runtime");

    await collectCorrectionIntake(tenantId, testDb.db);

    const [item] = await itemsOf(tenantId);
    expect(item?.original_snapshot).toMatchObject({
      session_id: `execution:${executionId}`,
      tags: ["correction:transform_error"],
    });
    const [evidence] = await evidenceOf(tenantId, item?.id ?? "");
    expect(evidence?.excerpt).toContain("code=sandbox_runtime");
    expect(evidence?.excerpt).not.toContain("rows.map");
  });

  test("a person's edit after an authoring save collects the changed steps", async () => {
    await seedDraftSave(tenantId, workflowId, {
      version: 1,
      request_source: "tool-chain",
      actor_type: "user",
      at: new Date(RECENT.getTime() - 60_000),
      steps: [
        { id: "fetch", kind: "request", path: "/orders" },
        { id: "shape", kind: "transform", expression: "return input.rows;" },
      ],
    });
    const auditId = await seedDraftSave(tenantId, workflowId, {
      version: 2,
      request_source: "api",
      actor_type: "user",
      at: RECENT,
      steps: [
        { id: "fetch", kind: "request", path: "/orders" },
        { id: "shape", kind: "transform", expression: "return input.items;" },
        { id: "notify", kind: "request", path: "/notify" },
      ],
    });
    await seedDraftSave(tenantId, workflowId, {
      version: 3,
      request_source: "api",
      actor_type: "user",
      at: new Date(RECENT.getTime() + 60_000),
      steps: [{ id: "fetch", kind: "request", path: "/orders" }],
    });

    const report = await collectCorrectionIntake(tenantId, testDb.db);

    expect(report.observed).toBe(1);
    const [item] = await itemsOf(tenantId);
    expect(item?.title).toBe("Person corrected 'Orders digest' after an authoring save");
    expect(item?.original_snapshot).toMatchObject({ session_id: `audit:${auditId}` });
    const [evidence] = await evidenceOf(tenantId, item?.id ?? "");
    expect(evidence?.excerpt).toContain("versions=1->2");
    expect(evidence?.excerpt).toContain("changed: shape (transform)");
    expect(evidence?.excerpt).toContain("added: notify (request)");
    expect(evidence?.excerpt).not.toContain("input.items");
  });

  test("a person's workflow update after an authoring draft save is collected", async () => {
    const person = uuid();
    const saved = await saveWorkflowDraft(
      {
        tenant_id: tenantId,
        def: {
          name: "Invoice export",
          steps: [{ id: "shape", kind: "transform", expression: "return input;" }],
        },
        actor_id: person,
        actor_type: "user",
        request_source: "tool-chain",
      },
      testDb.db,
    );
    if (!saved.draft) throw new Error(`draft save failed: ${JSON.stringify(saved)}`);
    const updated = await updateWorkflow(
      {
        tenant_id: tenantId,
        id: saved.draft.workflow_id,
        def: {
          name: "Invoice export",
          steps: [{ id: "shape", kind: "transform", expression: "return input.items;" }],
        },
        actor_id: person,
        actor_type: "user",
      },
      testDb.db,
    );
    if ("errors" in updated) throw new Error(`update failed: ${updated.errors?.join("; ")}`);

    await collectCorrectionIntake(tenantId, testDb.db);

    const [item, ...rest] = await itemsOf(tenantId);
    expect(rest).toHaveLength(0);
    expect(item?.title).toBe("Person corrected 'Invoice export' after an authoring save");
    const [evidence] = await evidenceOf(tenantId, item?.id ?? "");
    expect(evidence?.excerpt).toContain("changed: shape (transform)");
  });

  test("the scheduled pattern analysis collects corrections", async () => {
    await seedJudgeCall(tenantId, workflowId, { verdict: "failed", reason: "empty", missing: [] });

    await runPatternAnalysis({ tenant_id: tenantId }, testDb.db);

    const items = await itemsOf(tenantId);
    expect(items).toHaveLength(1);
    expect(items[0]?.original_snapshot).toMatchObject({ agent: CORRECTION_AGENT });
  });

  test("another tenant's corrections never reach this tenant's intake", async () => {
    await seedJudgeCall(otherTenantId, otherWorkflowId, {
      verdict: "partial",
      reason: "missing",
      missing: ["total"],
    });
    await seedTransformFailure(otherTenantId, otherWorkflowId, "sandbox_runtime");

    const report = await collectCorrectionIntake(tenantId, testDb.db);

    expect(report.observed).toBe(0);
    expect(await itemsOf(tenantId)).toHaveLength(0);
    expect(await itemsOf(otherTenantId)).toHaveLength(0);
  });

  test("secrets are scrubbed and key-material references are dropped", async () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
    await seedJudgeCall(tenantId, workflowId, {
      verdict: "partial",
      reason: `the header used ${secret}`,
      missing: [],
    });
    const other = await seedWorkflow(tenantId, "keys", "Keys");
    await seedJudgeCall(tenantId, other, {
      verdict: "failed",
      reason: "read ~/.ssh/id_rsa first",
      missing: [],
    });

    const report = await collectCorrectionIntake(tenantId, testDb.db);

    expect(report).toMatchObject({ collected: 1, dropped: 1 });
    const [item] = await itemsOf(tenantId);
    const [evidence] = await evidenceOf(tenantId, item?.id ?? "");
    expect(evidence?.excerpt).not.toContain(secret);
  });

  test("a burst of distinct corrections is collected in bounded passes", async () => {
    for (let i = 0; i < 23; i++) {
      const id = await seedWorkflow(tenantId, `burst-${i}`, `Burst ${i}`);
      await seedJudgeCall(tenantId, id, { verdict: "failed", reason: "empty", missing: [] });
    }

    const first = await collectCorrectionIntake(tenantId, testDb.db);
    const second = await collectCorrectionIntake(tenantId, testDb.db);

    expect(first).toMatchObject({ collected: 20, deferred: 3 });
    expect(second).toMatchObject({ collected: 3, deferred: 0 });
    expect(await itemsOf(tenantId)).toHaveLength(23);
  });
});

describe.skipIf(skip)("detectCorrectionPatterns under a flood of older rows", () => {
  const FLOOD = 2_100;
  const floodAt = (i: number) => new Date(RECENT.getTime() - (FLOOD - i) * 60_000);

  async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
    for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500));
  }

  test("a newer judge verdict is seen behind many older verdicts", async () => {
    const [conversation] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, target_workflow_id: workflowId, status: "active" })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error("conversation seed failed");
    await insertChunked(
      Array.from({ length: 600 }, (_, i) => ({
        tenant_id: tenantId,
        conversation_id: conversation.id,
        tool: "dry_run_workflow",
        input: {},
        output: { ok: false, judge: { verdict: "failed", reason: "empty", missing: [] } },
        created_at: floodAt(i),
      })),
      (chunk) => testDb.db.insert(conversationToolCalls).values(chunk),
    );
    const fresh = await seedWorkflow(tenantId, "fresh", "Fresh report");
    const freshConversation = await seedJudgeCall(tenantId, fresh, {
      verdict: "partial",
      reason: "missing total",
      missing: ["total"],
    });

    const observations = await detectCorrectionPatterns(tenantId, testDb.db);

    expect(observations.map((o) => o.occurrence_id)).toContain(`conversation:${freshConversation}`);
  });

  test("a newer transform error is seen behind a flood of older failures", async () => {
    const executionIds = await testDb.db
      .insert(executions)
      .values(
        Array.from({ length: 600 }, (_, i) => ({
          tenant_id: tenantId,
          workflow_id: workflowId,
          status: "failed" as const,
          request_source: "api",
          execution_mode: "prod" as const,
          started_at: floodAt(i),
        })),
      )
      .returning({ id: executions.id, started_at: executions.started_at });
    await insertChunked(executionIds, (chunk) =>
      testDb.db.insert(executionSteps).values(
        chunk.map((row) => ({
          tenant_id: tenantId,
          execution_id: row.id,
          step_key: "shape_rows",
          kind: "transform" as const,
          status: "failed" as const,
          error: { code: "sandbox_runtime" },
          started_at: row.started_at,
        })),
      ),
    );
    const fresh = await seedWorkflow(tenantId, "fresh", "Fresh report");
    const freshExecution = await seedTransformFailure(tenantId, fresh, "sandbox_timeout");

    const observations = await detectCorrectionPatterns(tenantId, testDb.db);

    expect(observations.map((o) => o.occurrence_id)).toContain(`execution:${freshExecution}`);
  });

  test("a person's correction on a late-sorting workflow is seen behind many draft saves", async () => {
    const early = "00000000-0000-4000-8000-000000000001";
    const late = "ffffffff-ffff-4fff-bfff-fffffffffff1";
    await testDb.db.insert(workflows).values([
      { id: early, tenant_id: tenantId, slug: "early", name: "Early", lifecycle: "draft" },
      { id: late, tenant_id: tenantId, slug: "late", name: "Late", lifecycle: "draft" },
    ]);
    await insertChunked(
      Array.from({ length: FLOOD }, (_, i) => ({
        id: uuid(),
        ts: floodAt(i),
        tenant_id: tenantId,
        actor_type: "user",
        actor_id: uuid(),
        action: "workflow.updated",
        resource_type: "workflow",
        resource_id: early,
        result: "success",
        metadata: { kind: "draft", version: i + 1, request_source: "api" },
      })),
      (chunk) => testDb.db.insert(auditLog).values(chunk),
    );
    await seedDraftSave(tenantId, late, {
      version: 1,
      request_source: "tool-chain",
      actor_type: "user",
      at: new Date(RECENT.getTime() - 60_000),
      steps: [{ id: "shape", kind: "transform", expression: "return input;" }],
    });
    const auditId = await seedDraftSave(tenantId, late, {
      version: 2,
      request_source: "api",
      actor_type: "user",
      at: RECENT,
      steps: [{ id: "shape", kind: "transform", expression: "return input.items;" }],
    });

    const observations = await detectCorrectionPatterns(tenantId, testDb.db);

    const edit = observations.find((o) => o.occurrence_id === `audit:${auditId}`);
    expect(edit?.excerpt).toContain("versions=1->2");
    expect(edit?.excerpt).toContain("changed: shape (transform)");
  });
});

describe("changedStepSummary", () => {
  test("names changed, added and removed steps by id and kind only", () => {
    expect(
      changedStepSummary(
        {
          steps: [
            { id: "a", kind: "request", path: "/x" },
            { id: "b", kind: "transform" },
          ],
        },
        {
          steps: [
            { id: "a", kind: "request", path: "/y" },
            { id: "c", kind: "branch" },
          ],
        },
      ),
    ).toEqual(["changed: a (request)", "added: c (branch)", "removed: b (transform)"]);
  });
});
