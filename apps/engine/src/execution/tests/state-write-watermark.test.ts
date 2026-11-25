import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog } from "../../db/schema/index.ts";
import { readWorkflowState, writeWorkflowState } from "../../workflow-state/index.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let nextPage: unknown = { object: "list", data: [] };
const requestedUrls: string[] = [];

beforeAll(async () => {
  ctx = await createEngineCtx("state-watermark");
  mock = await createMockServer((req, res) => {
    requestedUrls.push(req.url ?? "");
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(nextPage));
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function watermarkWorkflow(slug: string) {
  return createWorkflowRow(ctx, {
    name: slug,
    slug,
    steps: [
      {
        id: "list_new",
        kind: "request",
        method: "GET",
        url: `${mock.baseUrl}/charges`,
        side_effects: "read",
        max_retries: 0,
        query: { limit: 100, ending_before: "${state.last_synced_charge_id}" },
        state_read: {
          key: "last_synced_charge_id",
          into_var: "last_synced_charge_id",
          default_value: null,
        },
        state_write: { key: "last_synced_charge_id", value_path: "data.0.id" },
      },
    ],
  });
}

async function runOnce(workflow_id: string, page: unknown) {
  nextPage = page;
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: {},
  });
  expect(result.status).toBe("succeeded");
  return result;
}

async function lastStateWriteAudit(workflow_id: string) {
  const [row] = await ctx.testDb.db
    .select({ result: auditLog.result, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, AuditAction.STATE_WRITE),
        eq(auditLog.resource_id, workflow_id),
      ),
    )
    .orderBy(desc(auditLog.ts))
    .limit(1);
  return row;
}

test("a non-empty page writes the newest id", async () => {
  const { workflow_id } = await watermarkWorkflow("watermark-advance");
  await runOnce(workflow_id, { object: "list", data: [{ id: "ch_2" }, { id: "ch_1" }] });
  const state = await readWorkflowState(
    ctx.testDb.db,
    ctx.tenantId,
    workflow_id,
    "last_synced_charge_id",
  );
  expect(state?.value).toBe("ch_2");
  expect((await lastStateWriteAudit(workflow_id))?.metadata).toMatchObject({
    value_kind: "string",
  });
});

test("an empty page keeps the previous watermark and audits the skip", async () => {
  const { workflow_id } = await watermarkWorkflow("watermark-empty");
  await writeWorkflowState(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id,
    key: "last_synced_charge_id",
    value: "ch_prev",
  });
  const execution = await runOnce(workflow_id, { object: "list", data: [] });
  const state = await readWorkflowState(
    ctx.testDb.db,
    ctx.tenantId,
    workflow_id,
    "last_synced_charge_id",
  );
  expect(state?.value).toBe("ch_prev");
  const audit = await lastStateWriteAudit(workflow_id);
  expect(audit?.result).toBe("success");
  expect(audit?.metadata).toMatchObject({
    execution_id: execution.execution_id,
    key: "last_synced_charge_id",
    value_path: "data.0.id",
    value_kind: "skipped",
  });
});

test("an explicit null at the path still overwrites the watermark", async () => {
  const { workflow_id } = await watermarkWorkflow("watermark-null");
  await writeWorkflowState(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id,
    key: "last_synced_charge_id",
    value: "ch_prev",
  });
  await runOnce(workflow_id, { object: "list", data: [{ id: null }] });
  const state = await readWorkflowState(
    ctx.testDb.db,
    ctx.tenantId,
    workflow_id,
    "last_synced_charge_id",
  );
  expect(state).toBeDefined();
  expect(state?.value).toBeNull();
});

test("the cursor is omitted until a watermark exists and survives an empty page", async () => {
  const { workflow_id } = await watermarkWorkflow("watermark-cursor");
  requestedUrls.length = 0;
  await runOnce(workflow_id, { object: "list", data: [{ id: "ch_2" }, { id: "ch_1" }] });
  await runOnce(workflow_id, { object: "list", data: [] });
  await runOnce(workflow_id, { object: "list", data: [] });
  expect(requestedUrls).toEqual([
    "/charges?limit=100",
    "/charges?limit=100&ending_before=ch_2",
    "/charges?limit=100&ending_before=ch_2",
  ]);
});
