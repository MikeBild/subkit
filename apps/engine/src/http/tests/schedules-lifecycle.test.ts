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
    const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 8 * * *", timezone: "Europe/Berlin" }),
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: string; cron: string; workflow_slug: string };
    expect(row.cron).toBe("0 8 * * *");
    expect(row.workflow_slug).toContain("sched-upsert");

    const again = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "30 9 * * *" }),
    });
    expect(again.status).toBe(201);
    const row2 = (await again.json()) as { id: string; cron: string };
    expect(row2.id).toBe(row.id); // upsert, not a second fire time
    expect(row2.cron).toBe("30 9 * * *");

    const rows = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.workflow_id, wf.id));
    expect(rows.length).toBe(1);
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
      body: JSON.stringify({ cron: "0 20 * * *", paused: true }),
    });
    expect(updated.status).toBe(200);
    const view = (await updated.json()) as { cron: string; paused: boolean };
    expect(view.cron).toBe("0 20 * * *");
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
