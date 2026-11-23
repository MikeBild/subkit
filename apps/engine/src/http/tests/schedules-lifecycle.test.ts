import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
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

async function createWorkflow(
  name: string,
  input_schema?: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name,
      steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
      ...(input_schema ? { input_schema } : {}),
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
    expect(row.execution_mode).toBe("dev");
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
    expect(row2.id).toBe(row.id);
    expect(row2.cron).toBe("30 9 * * *");
    expect(row2.execution_mode).toBe("dev");
    expect(row2.input).toBe("scalar-input");
    expect(row2.upsert_status).toBe("updated");

    const retained = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 10 * * *" }),
    });
    expect(retained.status).toBe(200);
    expect(((await retained.json()) as { input: unknown }).input).toBe("scalar-input");

    const rows = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.workflow_id, wf.id));
    expect(rows.length).toBe(1);

    const audits = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.resource_type, "schedule"), eq(auditLog.resource_id, row.id)));
    expect(audits.map((entry) => entry.action)).toEqual([
      "schedule.created",
      "schedule.updated",
      "schedule.updated",
    ]);
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

  test("schedule writes reject input that does not match the active workflow", async () => {
    const wf = await createWorkflow("sched-input-contract", {
      type: "object",
      required: ["account_id"],
      properties: { account_id: { type: "string" } },
    });
    const invalid = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 8 * * *", input: {} }),
    });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as {
      details?: { issues?: Array<{ path: string; message: string }> };
    };
    expect(body.details?.issues?.[0]?.path).toBe("$input/account_id");
    const schedules = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.workflow_id, wf.id));
    expect(schedules).toHaveLength(0);
  });

  async function addVersion(
    workflow_id: string,
    input_schema: Record<string, unknown>,
    activate: boolean,
  ): Promise<string> {
    const [current] = await ctx.db
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, workflow_id));
    const [version] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id,
        version: 2,
        dag: { ...(current?.dag as Record<string, unknown>), input_schema },
      })
      .returning({ id: workflowVersions.id });
    if (!version) throw new Error("version insert failed");
    await ctx.db
      .update(workflows)
      .set(activate ? { current_version_id: version.id } : { draft_version_id: version.id })
      .where(eq(workflows.id, workflow_id));
    return version.id;
  }

  const sinceContract = {
    type: "object",
    required: ["since"],
    properties: { since: { type: "string" } },
    additionalProperties: false,
  };

  test("a schedule kept across a new version names the field the active version needs", async () => {
    const wf = await createWorkflow("sched-input-v2", {
      type: "object",
      properties: { account_id: { type: "string" } },
    });
    const first = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workflow_id: wf.id,
        cron: "0 8 * * *",
        input: { account_id: "a-1" },
      }),
    });
    expect(first.status).toBe(201);
    await addVersion(wf.id, sinceContract, true);
    const again = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 9 * * *" }),
    });
    expect(again.status).toBe(400);
    const body = (await again.json()) as { message: string; details?: Record<string, unknown> };
    expect(body.message).toContain("(version 2)");
    expect(body.message).toContain("$input/since: must have required property 'since'");
    expect(body.message).toContain("$input/account_id: must NOT have additional properties");
    expect(body.message).toContain("kept from the existing schedule");
    expect(body.details).toMatchObject({ checked_version: 2, kept_existing_input: true });
  });

  test("input written for a prepared version says that version is not active yet", async () => {
    const wf = await createWorkflow("sched-input-prepared", {
      type: "object",
      required: ["account_id"],
      properties: { account_id: { type: "string" } },
    });
    const prepared = await addVersion(wf.id, sinceContract, false);
    const res = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workflow_id: wf.id,
        cron: "0 8 * * *",
        input: { since: "2026-11-01" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string; details?: Record<string, unknown> };
    expect(body.message).toContain("(version 1)");
    expect(body.message).toContain("$input/account_id");
    expect(body.message).toContain("matches the prepared version 2, which is not active yet");
    expect(body.details).toMatchObject({ prepared_version_id: prepared, prepared_version: 2 });
  });

  test("schedule updates and resume keep an invalid persisted input held for correction", async () => {
    const wf = await createWorkflow("sched-input-resume", {
      type: "object",
      required: ["account_id"],
      properties: { account_id: { type: "string" } },
    });
    const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workflow_id: wf.id,
        cron: "0 8 * * *",
        paused: true,
        input: { account_id: "account-1" },
      }),
    });
    const schedule = (await created.json()) as { id: string };
    await ctx.db
      .update(workflowsSchedules)
      .set({ input: {} })
      .where(eq(workflowsSchedules.id, schedule.id));
    const resumed = await fetch(`${ctx.baseUrl}/v1/schedules/${schedule.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ paused: false }),
    });
    expect(resumed.status).toBe(400);
    const [stored] = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.id, schedule.id));
    expect(stored?.paused).toBe(true);
    expect(stored?.input).toEqual({});
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

    const list = await fetch(`${ctx.baseUrl}/v1/schedules?workflow_id=${wf.id}`, {
      headers: headers(),
    });
    expect(((await list.json()) as { total: number }).total).toBe(0);
  });

  test("reactivating binds the running version's own schedule again", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        name: "sched-reactivate",
        steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
        trigger: { kind: "schedule", cron: "0 7 * * *", timezone: "UTC" },
      }),
    });
    expect(res.ok).toBe(true);
    const wf = (await res.json()) as { id: string };
    const rowsOf = () =>
      ctx.db.select().from(workflowsSchedules).where(eq(workflowsSchedules.workflow_id, wf.id));
    expect((await rowsOf()).length).toBe(1);

    const patch = (lifecycle: "active" | "archived") =>
      fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/metadata`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ lifecycle }),
      });
    expect((await patch("archived")).status).toBe(200);
    expect((await rowsOf()).length).toBe(0);
    expect((await patch("active")).status).toBe(200);
    const rebound = await rowsOf();
    expect(rebound.length).toBe(1);
    expect(rebound[0]?.cron).toBe("0 7 * * *");
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
