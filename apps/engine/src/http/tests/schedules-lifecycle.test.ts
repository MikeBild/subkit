// Schedule lifecycle over the HTTP surface.
//
//   * POST /v1/schedules creates — and upserts on (tenant, workflow),
//     preserving the one-schedule-per-workflow invariant.
//   * PUT /v1/schedules/:id patches cron / paused; DELETE removes.
//   * Archiving a workflow tears down its schedule rows (same contract
//     as delete) — an archived workflow must not keep live-looking
//     bindings that only a reconciler filter stops from firing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, workflowsSchedules } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("schedules_lifecycle");
});

afterAll(async () => {
  await ctx.cleanup();
});

const headers = (): Record<string, string> => ({
  authorization: `Bearer ${ctx.apiKey}`,
  "content-type": "application/json",
});

async function createWorkflow(name: string): Promise<{ id: string }> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name,
      steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
    }),
  });
  if (!res.ok) throw new Error(`workflow create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string };
}

describe("schedules HTTP write surface", () => {
  test("POST creates, re-POST upserts (one schedule per workflow)", async () => {
    const wf = await createWorkflow("sched-upsert");
    const objectInput = { items: [1, 2, 3, 4, 5], mode: "catalog" };
    const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workflow_id: wf.id,
        cron: "0 8 * * *",
        timezone: "Europe/Berlin",
        input: objectInput,
      }),
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as {
      id: string;
      cron: string;
      workflow_slug: string;
      execution_mode: string;
      input: unknown;
      upsert_status: string;
    };
    expect(row.cron).toBe("0 8 * * *");
    expect(row.workflow_slug).toContain("sched-upsert");
    expect(row.execution_mode).toBe("prod");
    expect(row.input).toEqual(objectInput);
    expect(row.upsert_status).toBe("created");

    const list = await fetch(`${ctx.baseUrl}/v1/schedules?workflow_id=${wf.id}`, {
      headers: headers(),
    });
    const catalog = (await list.json()) as { schedules: Array<{ input: unknown }> };
    expect(catalog.schedules[0]?.input).toEqual(objectInput);

    const replayWorkflow = await createWorkflow("sched-upsert-replay");
    const replay = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workflow_id: replayWorkflow.id,
        cron: "0 8 * * *",
        input: catalog.schedules[0]?.input,
      }),
    });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { input: unknown }).input).toEqual(objectInput);

    const again = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workflow_id: wf.id,
        cron: "30 9 * * *",
        execution_mode: "dev",
        input: "scalar-input",
      }),
    });
    expect(again.status).toBe(200);
    const row2 = (await again.json()) as {
      id: string;
      cron: string;
      execution_mode: string;
      input: unknown;
      upsert_status: string;
    };
    expect(row2.id).toBe(row.id); // upsert, not a second fire time
    expect(row2.cron).toBe("30 9 * * *");
    expect(row2.execution_mode).toBe("dev");
    expect(row2.input).toBe("scalar-input");
    expect(row2.upsert_status).toBe("updated");

    const rows = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.workflow_id, wf.id));
    expect(rows.length).toBe(1);

    const audits = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.resource_type, "schedule"), eq(auditLog.resource_id, row.id)));
    expect(audits.map((entry) => entry.action)).toEqual(["schedule.created", "schedule.updated"]);
  });

  test("schedule input round-trips null and arrays through write and catalog responses", async () => {
    const wf = await createWorkflow("sched-json-roundtrip");
    const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 8 * * *", input: [1, "two"] }),
    });
    const row = (await created.json()) as { id: string; input: unknown };
    expect(row.input).toEqual([1, "two"]);

    const updated = await fetch(`${ctx.baseUrl}/v1/schedules/${row.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ input: null }),
    });
    expect(((await updated.json()) as { input: unknown }).input).toBeNull();

    const list = await fetch(`${ctx.baseUrl}/v1/schedules?workflow_id=${wf.id}`, {
      headers: headers(),
    });
    expect(
      ((await list.json()) as { schedules: Array<{ input: unknown }> }).schedules[0]?.input,
    ).toBeNull();
  });

  test("POST with invalid cron is 400, unknown workflow is 404", async () => {
    const wf = await createWorkflow("sched-invalid");
    const bad = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "not a cron" }),
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workflow_id: randomUUID(), // allow-random: nonexistent id for the 404 case
        cron: "0 8 * * *",
      }),
    });
    expect(missing.status).toBe(404);
  });

  test("PUT patches cron and paused; unknown id is 404", async () => {
    const wf = await createWorkflow("sched-update");
    const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 8 * * *" }),
    });
    const row = (await created.json()) as { id: string };

    const updated = await fetch(`${ctx.baseUrl}/v1/schedules/${row.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ cron: "0 20 * * *", execution_mode: "dev", paused: true }),
    });
    expect(updated.status).toBe(200);
    const view = (await updated.json()) as {
      cron: string;
      execution_mode: string;
      paused: boolean;
    };
    expect(view.cron).toBe("0 20 * * *");
    expect(view.execution_mode).toBe("dev");
    expect(view.paused).toBe(true);

    const missing = await fetch(
      `${ctx.baseUrl}/v1/schedules/${randomUUID()}`, // allow-random: nonexistent id for the 404 case
      { method: "PUT", headers: headers(), body: JSON.stringify({ paused: false }) },
    );
    expect(missing.status).toBe(404);
  });

  test("DELETE removes the row; second DELETE is 404", async () => {
    const wf = await createWorkflow("sched-delete");
    const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 8 * * *" }),
    });
    const row = (await created.json()) as { id: string };

    const del = await fetch(`${ctx.baseUrl}/v1/schedules/${row.id}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);

    const again = await fetch(`${ctx.baseUrl}/v1/schedules/${row.id}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(again.status).toBe(404);
  });
});

describe("archive tears down schedule bindings", () => {
  test("PATCH metadata lifecycle=archived deletes schedule rows and audits the unbind", async () => {
    const wf = await createWorkflow("sched-archive");
    const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 8 * * *" }),
    });
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as { id: string };

    const archived = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/metadata`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ lifecycle: "archived" }),
    });
    expect(archived.status).toBe(200);

    const rows = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.workflow_id, wf.id));
    expect(rows.length).toBe(0);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "schedule.trigger.unbound"), eq(auditLog.resource_id, schedule.id)),
      );
    expect(audits.length).toBe(1);

    // The list surface agrees — nothing live-looking remains.
    const list = await fetch(`${ctx.baseUrl}/v1/schedules?workflow_id=${wf.id}`, {
      headers: headers(),
    });
    expect(((await list.json()) as { total: number }).total).toBe(0);
  });
});

test("persisted admission holds are readable and suppressed for paused schedules", async () => {
  const wf = await createWorkflow("held-http");
  const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ workflow_id: wf.id, cron: "* * * * *" }),
  });
  expect(created.status).toBe(201);
  const row = (await created.json()) as { id: string; admission_hold: unknown };
  expect(row.admission_hold).toBeNull();
  const hold = {
    reason_code: "execution_authority_required" as const,
    observed_at: "2026-09-15T03:00:00.000Z",
  };
  await ctx.testDb.db
    .update(workflowsSchedules)
    .set({ admission_hold: hold })
    .where(and(eq(workflowsSchedules.tenant_id, ctx.tenantId), eq(workflowsSchedules.id, row.id)));
  const read = async () =>
    (await (
      await fetch(`${ctx.baseUrl}/v1/schedules?workflow_id=${wf.id}`, { headers: headers() })
    ).json()) as { schedules: Array<{ admission_hold: unknown }> };
  expect((await read()).schedules[0]?.admission_hold).toEqual(hold);
  const paused = await fetch(`${ctx.baseUrl}/v1/schedules/${row.id}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ paused: true }),
  });
  expect(paused.status).toBe(200);
  expect((await read()).schedules[0]?.admission_hold).toBeNull();
});

test("a held schedule reports the prepared version waiting beside the running one", async () => {
  // Three production workflows were blocked at once with the repair already
  // saved as a draft. The decision surface could not see it, so the only offer
  // it could make was to approve the running version — the very version that
  // could not be bound. This is the field that lets the reader be told the
  // truth: something is prepared, and putting it into service is the next step.
  const wf = await createWorkflow("prepared-http");
  const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ workflow_id: wf.id, cron: "* * * * *" }),
  });
  expect(created.status).toBe(201);
  expect(
    ((await created.json()) as { prepared_version_id: unknown }).prepared_version_id,
  ).toBeNull();
  const read = async () =>
    (await (
      await fetch(`${ctx.baseUrl}/v1/schedules?workflow_id=${wf.id}`, { headers: headers() })
    ).json()) as { schedules: Array<{ prepared_version_id: string | null }> };
  // Activation clears the draft pointer, so a workflow with nothing waiting
  // must not claim one — otherwise every row would carry the notice.
  expect((await read()).schedules[0]?.prepared_version_id).toBeNull();
  const draft = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/draft`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      expected_draft_version_id: null,
      definition: {
        name: "prepared-http",
        steps: [{ kind: "transform", id: "out", expression: "return { ok: 2 };" }],
      },
    }),
  });
  expect(draft.status).toBe(200);
  const saved = (await draft.json()) as { version_id: string };
  expect((await read()).schedules[0]?.prepared_version_id).toBe(saved.version_id);
});
