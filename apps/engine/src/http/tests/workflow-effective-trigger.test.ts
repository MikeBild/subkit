import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { workflows, workflowsSchedules } from "../../db/schema/index.ts";
import { inspectScheduleAutomation } from "../../scheduler/automation-status.ts";
import { getSchedule } from "../../scheduler/repo.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let target: Db | null = null;
let queryCount = 0;
const COUNTED = new Set(["select", "selectDistinct", "selectDistinctOn", "execute", "$count"]);
const countingDb = new Proxy({} as Db, {
  get(_t, prop) {
    if (!target) throw new Error("counting db used before the test db exists");
    const value = Reflect.get(target, prop, target) as unknown;
    if (prop === "query") queryCount += 1;
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (typeof prop === "string" && COUNTED.has(prop)) queryCount += 1;
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
});

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("effective_trigger", { appOptions: { db: countingDb } });
  target = ctx.db;
});

afterAll(async () => {
  await ctx.cleanup();
});

const headers = (): Record<string, string> => ({
  authorization: `Bearer ${ctx.apiKey}`,
  "content-type": "application/json",
});

interface WorkflowBody {
  id: string;
  trigger: unknown;
  schedule: {
    id: string;
    cron: string;
    paused: boolean;
    state: string;
    next_fire_at: string | null;
  } | null;
  webhooks_active: number;
  effective_trigger: { kind: string; source: string; state: string };
}

async function createWorkflow(name: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name,
      steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
      ...extra,
    }),
  });
  if (!res.ok) throw new Error(`workflow create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as WorkflowBody;
}

async function getWorkflow(id: string): Promise<WorkflowBody> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}`, { headers: headers() });
  expect(res.status).toBe(200);
  return (await res.json()) as WorkflowBody;
}

async function listWorkflows(query: string): Promise<WorkflowBody[]> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows?${query}`, { headers: headers() });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: WorkflowBody[] }).items;
}

async function bindSchedule(workflowId: string, cron = "7 * * * *"): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/v1/schedules`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ workflow_id: workflowId, cron }),
  });
  if (res.status !== 201) throw new Error(`schedule create failed: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

describe("effective trigger on the workflow representation", () => {
  test("a schedule bound without a definition trigger is the effective trigger", async () => {
    const wf = await createWorkflow("et-bound");
    expect(wf.effective_trigger).toEqual({ kind: "request", source: "default", state: "active" });
    await bindSchedule(wf.id);

    const detail = await getWorkflow(wf.id);
    expect(detail.trigger).toBeNull();
    expect(detail.effective_trigger).toEqual({
      kind: "schedule",
      source: "binding",
      state: "active",
    });
    expect(detail.schedule?.cron).toBe("7 * * * *");
    expect(detail.schedule?.next_fire_at).not.toBeNull();

    const listed = (await listWorkflows("limit=200")).find((w) => w.id === wf.id);
    expect(listed?.effective_trigger.kind).toBe("schedule");
    expect(listed?.schedule?.cron).toBe("7 * * * *");
  });

  test("a paused row reports paused and no next fire", async () => {
    const wf = await createWorkflow("et-paused");
    const scheduleId = await bindSchedule(wf.id);
    const res = await fetch(`${ctx.baseUrl}/v1/schedules/${scheduleId}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(200);
    const detail = await getWorkflow(wf.id);
    expect(detail.effective_trigger).toEqual({
      kind: "schedule",
      source: "binding",
      state: "paused",
    });
    expect(detail.schedule?.paused).toBe(true);
    expect(detail.schedule?.next_fire_at).toBeNull();
  });

  test("an admission-held row reports held and no next fire", async () => {
    const wf = await createWorkflow("et-held");
    const scheduleId = await bindSchedule(wf.id);
    await ctx.db
      .update(workflowsSchedules)
      .set({
        admission_hold: {
          reason_code: "execution_authority_required",
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      })
      .where(
        and(eq(workflowsSchedules.tenant_id, ctx.tenantId), eq(workflowsSchedules.id, scheduleId)),
      );
    const detail = await getWorkflow(wf.id);
    expect(detail.effective_trigger.state).toBe("held");
    expect(detail.schedule?.next_fire_at).toBeNull();
  });

  test("a schedule on a draft workflow does not fire, and agrees with the automation status", async () => {
    const wf = await createWorkflow("et-draft");
    const scheduleId = await bindSchedule(wf.id);
    await ctx.db
      .update(workflows)
      .set({ lifecycle: "draft" })
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, wf.id)));
    const detail = await getWorkflow(wf.id);
    expect(detail.effective_trigger).toEqual({
      kind: "schedule",
      source: "binding",
      state: "activation_required",
    });
    expect(detail.schedule?.state).toBe("activation_required");
    expect(detail.schedule?.next_fire_at).toBeNull();
    const row = await getSchedule(ctx.db, ctx.tenantId, scheduleId);
    if (!row) throw new Error("schedule row missing");
    expect((await inspectScheduleAutomation(row, ctx.db)).state).toBe("activation_required");
  });

  test("an archived workflow cannot be scheduled", async () => {
    const wf = await createWorkflow("et-archived");
    const patched = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/metadata`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ lifecycle: "archived" }),
    });
    expect(patched.status).toBe(200);
    const res = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "7 * * * *" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message?: string }).message ?? "").toContain("archived");
  });

  test("an active every:N schedule has a next fire", async () => {
    const wf = await createWorkflow("et-every");
    await bindSchedule(wf.id, "every:30");
    const detail = await getWorkflow(wf.id);
    expect(detail.effective_trigger.state).toBe("active");
    expect(detail.schedule?.next_fire_at).not.toBeNull();
  });

  test("a declared schedule without a bound row is declared_unbound", async () => {
    const wf = await createWorkflow("et-unbound", {
      trigger: { kind: "schedule", cron: "0 6 * * *", tz: "UTC" },
    });
    expect(wf.effective_trigger.source).toBe("binding");
    await ctx.db
      .delete(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, ctx.tenantId),
          eq(workflowsSchedules.workflow_id, wf.id),
        ),
      );
    const detail = await getWorkflow(wf.id);
    expect(detail.trigger).toMatchObject({ kind: "schedule" });
    expect(detail.schedule).toBeNull();
    expect(detail.effective_trigger).toEqual({
      kind: "schedule",
      source: "definition",
      state: "declared_unbound",
    });
  });

  test("the list reads bindings in a constant number of queries (no N+1)", async () => {
    for (let i = 0; i < 50; i++) {
      const wf = await createWorkflow(`et-page-${String(i).padStart(2, "0")}`);
      await bindSchedule(wf.id);
    }
    await listWorkflows("limit=1");

    queryCount = 0;
    const one = await listWorkflows("limit=1");
    const forOne = queryCount;

    queryCount = 0;
    const fifty = await listWorkflows("limit=50");
    const forFifty = queryCount;

    expect(one).toHaveLength(1);
    expect(fifty).toHaveLength(50);
    expect(fifty.filter((w) => w.effective_trigger.kind === "schedule").length).toBeGreaterThan(40);
    expect(forOne).toBeGreaterThan(0);
    expect(forFifty).toBe(forOne);
  });
});

test("one HTTP list keeps mixed schedule bindings attached to their own workflows", async () => {
  const active = await createWorkflow("batch-trigger-active");
  const paused = await createWorkflow("batch-trigger-paused");
  const draft = await createWorkflow("batch-trigger-draft");
  await bindSchedule(active.id, "11 * * * *");
  const pausedSchedule = await bindSchedule(paused.id, "22 * * * *");
  await bindSchedule(draft.id, "33 * * * *");
  const pausedResponse = await fetch(`${ctx.baseUrl}/v1/schedules/${pausedSchedule}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ paused: true }),
  });
  expect(pausedResponse.status).toBe(200);
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "draft" })
    .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, draft.id)));
  const listed = await listWorkflows("limit=200");
  for (const [workflow, cron, state] of [
    [active, "11 * * * *", "active"],
    [paused, "22 * * * *", "paused"],
    [draft, "33 * * * *", "activation_required"],
  ] as const) {
    const row = listed.find((item) => item.id === workflow.id);
    expect(row?.effective_trigger).toEqual({ kind: "schedule", source: "binding", state });
    expect(row?.schedule?.cron).toBe(cron);
    if (state === "active") expect(row?.schedule?.next_fire_at).toBeTruthy();
    else expect(row?.schedule?.next_fire_at).toBeNull();
  }
});
