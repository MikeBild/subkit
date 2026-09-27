// What starts a workflow, as the HTTP surface reports it.
//
// A schedule created through `POST /v1/schedules` exists only as a
// `workflows_schedules` row; the definition keeps no trigger. The workflow
// representation used to echo the definition alone (`trigger: null`), so a
// workflow firing every hour was listed as "on request". These tests pin the
// bound row as the answer, the paused/held/declared-but-unbound states, and
// that reading the bindings costs the same number of queries for a page of 1
// and a page of 50.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { workflowsSchedules } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

// Counts every query the app issues through its db handle. The app is built
// before the test db exists, so the proxy resolves its target lazily.
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

  test("a declared schedule without a bound row is declared_unbound", async () => {
    const wf = await createWorkflow("et-unbound", {
      trigger: { kind: "schedule", cron: "0 6 * * *", tz: "UTC" },
    });
    // The save path binds the declared schedule; removing the row leaves the
    // declaration with nothing that fires it.
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
    // Warm-up: middleware caches (auth, config) must not skew the comparison.
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
