import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflows, workflowsSchedules, workflowVersions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("schedules_input");
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

describe("schedule input validation", () => {
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

  test("pausing a schedule whose input the active version outgrew stays paused until resume", async () => {
    const wf = await createWorkflow("sched-input-pause", {
      type: "object",
      properties: { account_id: { type: "string" } },
    });
    const created = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow_id: wf.id, cron: "0 8 * * *", input: {} }),
    });
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as { id: string };
    await addVersion(wf.id, sinceContract, true);
    await ctx.db
      .update(workflowsSchedules)
      .set({
        admission_hold: {
          reason_code: "input_required",
          observed_at: new Date(Date.UTC(2026, 10, 1)).toISOString(),
        },
      })
      .where(eq(workflowsSchedules.id, schedule.id));
    const readRow = async () =>
      (
        await ctx.db.select().from(workflowsSchedules).where(eq(workflowsSchedules.id, schedule.id))
      )[0];
    const put = (body: Record<string, unknown>) =>
      fetch(`${ctx.baseUrl}/v1/schedules/${schedule.id}`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(body),
      });

    expect((await put({ paused: true })).status).toBe(200);
    const paused = await readRow();
    expect(paused?.paused).toBe(true);
    expect(paused?.admission_hold?.reason_code).toBe("input_required");

    expect((await put({ input: { since: "2026-11-01" } })).status).toBe(200);
    const corrected = await readRow();
    expect(corrected?.paused).toBe(true);
    expect(corrected?.input).toEqual({ since: "2026-11-01" });
    expect(corrected?.admission_hold).toBeNull();
    expect(corrected?.input_error).toBeNull();

    expect((await put({ paused: false })).status).toBe(200);
    expect((await readRow())?.paused).toBe(false);
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
});
