import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  tenants,
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
import { CORRECTION_AGENT, collectCorrectionIntake } from "../correction-intake.ts";
import { changedStepSummary } from "../detectors/correction-pattern.ts";

const skip = process.env.REQUIRES_PG === "0";
const RECENT = new Date(FROZEN_NOW - 24 * 60 * 60 * 1000);
const STALE = new Date(FROZEN_NOW - 40 * 24 * 60 * 60 * 1000);

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;
let workflowId: string;
let otherWorkflowId: string;

async function seedTenant(slug: string): Promise<string> {
  const [row] = await testDb.db
    .insert(tenants)
    .values({ slug, display_name: slug })
    .returning({ id: tenants.id });
  if (!row) throw new Error("tenant seed failed");
  return row.id;
}

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
  const id = randomUUID();
  await testDb.db.insert(auditLog).values({
    id,
    ts: p.at,
    tenant_id,
    actor_type: p.actor_type,
    actor_id: randomUUID(),
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
  const suffix = randomUUID().slice(0, 8);
  tenantId = await seedTenant(`corr-a-${suffix}`);
  otherTenantId = await seedTenant(`corr-b-${suffix}`);
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
