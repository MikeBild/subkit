import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ScheduleCostProjectionSchema } from "../../api/operations/workflow-schedule-representation.ts";
import {
  executions,
  llmUsage,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { currentMonthBucket } from "../../llm/accounting/budget.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, createSecondaryTenant, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let otherTenantKey = "";

const NOW = new Date(getTestNow());
const MONTH_BUCKET = currentMonthBucket();

interface Seeded {
  workflowId: string;
  versionIds: string[];
}

async function seedWorkflow(slug: string, versions: number, current: number | null) {
  const [wf] = await srv.db
    .insert(workflows)
    .values({ tenant_id: srv.tenantId, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  const versionIds: string[] = [];
  for (let version = 1; version <= versions; version += 1) {
    const [row] = await srv.db
      .insert(workflowVersions)
      .values({ tenant_id: srv.tenantId, workflow_id: wf.id, version, dag: { steps: [] } })
      .returning();
    if (!row) throw new Error("seed workflow version failed");
    versionIds.push(row.id);
  }
  const currentId = current === null ? null : (versionIds[current - 1] ?? null);
  await srv.db
    .update(workflows)
    .set({ current_version_id: currentId })
    .where(eq(workflows.id, wf.id));
  return { workflowId: wf.id, versionIds } satisfies Seeded;
}

async function seedRun(
  seeded: Seeded,
  versionIndex: number,
  promptTokens: number,
  status: "succeeded" | "running" = "succeeded",
) {
  const [run] = await srv.db
    .insert(executions)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: seeded.workflowId,
      workflow_version_id: seeded.versionIds[versionIndex] ?? null,
      status,
      request_source: "scheduler",
      execution_mode: "prod",
      started_at: new Date(NOW.getTime() - 60_000),
      finished_at: status === "succeeded" ? NOW : null,
    })
    .returning();
  if (!run) throw new Error("seed execution failed");
  if (promptTokens > 0)
    await srv.db.insert(llmUsage).values({
      tenant_id: srv.tenantId,
      flow: "workflow_step",
      model: "claude-haiku-4-5",
      prompt_tokens: promptTokens,
      completion_tokens: promptTokens / 2,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: promptTokens + promptTokens / 2,
      latency_ms: 100,
      result: "success",
      month_bucket: MONTH_BUCKET,
      execution_id: run.id,
    });
  return run.id;
}

const get = (path: string, key = srv.apiKey) =>
  fetch(`${srv.baseUrl}${path}`, { headers: { authorization: `Bearer ${key}` } });

async function projection(workflowId: string, cron: string, timezone = "UTC") {
  const query = new URLSearchParams({ cron, timezone });
  const res = await get(`/v1/workflows/${workflowId}/schedule-cost?${query}`);
  expect(res.status).toBe(200);
  return ScheduleCostProjectionSchema.parse(await res.json());
}

async function runCost(executionId: string): Promise<number> {
  const res = await get(`/v1/executions/${executionId}/cost`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { llm: { cost: { amount: number } } }).llm.cost.amount;
}

beforeAll(async () => {
  srv = await createHttpTestServer("schedule-cost");
  otherTenantKey = (await createSecondaryTenant(srv, "schedule-cost")).admin.apiKey;
});

afterAll(async () => {
  await srv.cleanup();
});

describe("GET /v1/workflows/{id}/schedule-cost", () => {
  test("reports no estimate yet when the workflow has no finished run", async () => {
    const seeded = await seedWorkflow("cost-none", 1, 1);
    await seedRun(seeded, 0, 400, "running");
    const body = await projection(seeded.workflowId, "0 8 * * *");
    expect(body.state).toBe("no_history");
    expect(body.basis).toBeNull();
    expect(body.monthly_amount).toBeNull();
    expect(body.runs_per_month).toBe(30.42);
  });

  test("averages the run cost of the current version at current prices", async () => {
    const seeded = await seedWorkflow("cost-version", 2, 2);
    await seedRun(seeded, 0, 90_000);
    const priced = await seedRun(seeded, 1, 2_000);
    const free = await seedRun(seeded, 1, 0);
    const body = await projection(seeded.workflowId, "0 8 * * *", "Europe/Berlin");
    const expected = ((await runCost(priced)) + (await runCost(free))) / 2;
    expect(expected).toBeGreaterThan(0);
    expect(body.state).toBe("estimated");
    expect(body.basis).toBe("version");
    expect(body.runs_sampled).toBe(2);
    expect(body.per_run_amount).toBeCloseTo(expected, 6);
    expect(body.monthly_amount).toBeCloseTo(expected * 30.42, 4);
    expect(body.rates_basis).toBe("current");
  });

  test("falls back to other versions when the current version has not run yet", async () => {
    const seeded = await seedWorkflow("cost-fallback", 2, 2);
    const earlier = await seedRun(seeded, 0, 1_000);
    const body = await projection(seeded.workflowId, "every:86400");
    expect(body.basis).toBe("workflow");
    expect(body.runs_sampled).toBe(1);
    expect(body.per_run_amount).toBeCloseTo(await runCost(earlier), 6);
  });

  test("rejects a missing cron", async () => {
    const seeded = await seedWorkflow("cost-invalid", 1, 1);
    const res = await get(`/v1/workflows/${seeded.workflowId}/schedule-cost`);
    expect(res.status).toBe(400);
  });

  test("hides another tenant's workflow", async () => {
    const seeded = await seedWorkflow("cost-tenant", 1, 1);
    const res = await get(
      `/v1/workflows/${seeded.workflowId}/schedule-cost?cron=0+8+*+*+*`,
      otherTenantKey,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/schedules", () => {
  test("each schedule carries its monthly cost projection", async () => {
    const seeded = await seedWorkflow("cost-listed", 1, 1);
    const run = await seedRun(seeded, 0, 3_000);
    await srv.db.insert(workflowsSchedules).values({
      tenant_id: srv.tenantId,
      workflow_id: seeded.workflowId,
      cron: "0 8 * * 1",
      timezone: "UTC",
    });
    const res = await get(`/v1/schedules?workflow_id=${seeded.workflowId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedules: Array<{ cost_projection: unknown }> };
    expect(body.schedules).toHaveLength(1);
    const cost = ScheduleCostProjectionSchema.parse(body.schedules[0]?.cost_projection);
    expect(cost.state).toBe("estimated");
    expect([4.33, 4.42]).toContain(cost.runs_per_month ?? 0);
    expect(cost.monthly_amount).toBeCloseTo((await runCost(run)) * (cost.runs_per_month ?? 0), 4);
  });
});
