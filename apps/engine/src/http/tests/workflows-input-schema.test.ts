// Integration tests for `GET /v1/workflows/:id/input-schema` and the
// schema fields surfaced on `GET /v1/workflows/:id`. Reference impl
// exposes `inputSchema` / `outputSchema` on `GET /tools/:id` directly;
// subkit's MCP layer surfaced these but the bare HTTP route did not.
// These tests pin the public-facing shape so non-MCP HTTP callers can
// discover a workflow's I/O without round-tripping through MCP.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflowsSchedules } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("workflows_input_schema");
});

afterAll(async () => {
  await ctx.cleanup();
});

const headers = (apiKey: string): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
});

async function createWorkflow(body: Record<string, unknown>): Promise<{
  id: string;
}> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: headers(ctx.apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`workflow create failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

describe("GET /v1/workflows/:id (schema fields)", () => {
  test("surfaces input_schema / output_schema on the GET response", async () => {
    const wf = await createWorkflow({
      name: "echo",
      input_schema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      output_schema: {
        type: "object",
        properties: { echoed: { type: "string" } },
      },
      steps: [
        {
          kind: "transform",
          id: "out",
          expression: "return { echoed: input.input.msg };",
        },
      ],
    });

    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.input_schema).toMatchObject({
      type: "object",
      required: ["msg"],
    });
    expect(body.output_schema).toMatchObject({ type: "object" });
  });
});

describe("GET /v1/workflows/:id/input-schema", () => {
  test("returns 'declared' source when input_schema is present", async () => {
    const wf = await createWorkflow({
      name: "declared-input-schema",
      input_schema: {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
      },
      steps: [{ kind: "transform", id: "out", expression: "return { y: input.input.x * 2 };" }],
    });

    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/input-schema`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; schema: unknown };
    expect(body.source).toBe("declared");
    expect(body.schema).toMatchObject({ required: ["x"] });
  });

  test("synthesizes the schema from $input.X references when input_schema is omitted", async () => {
    const wf = await createWorkflow({
      name: "synth-input-schema",
      // No input_schema declared — but the transform references $input.user_id.
      steps: [
        {
          kind: "transform",
          id: "out",
          expression: "return { id: input.input.user_id };",
        },
      ],
    });

    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/input-schema`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      schema: { properties?: Record<string, unknown> } | null;
    };
    expect(body.source).toBe("synthesized");
    expect(body.schema?.properties).toBeDefined();
    expect(Object.keys(body.schema?.properties ?? {})).toContain("user_id");
  });

  test("returns source='none' when no inputs are referenced anywhere", async () => {
    const wf = await createWorkflow({
      name: "no-input-references",
      steps: [{ kind: "transform", id: "constant", expression: "return 42;" }],
    });

    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/input-schema`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; schema: unknown };
    expect(body.source).toBe("none");
    expect(body.schema).toBeNull();
  });

  test("404s for an unknown workflow id", async () => {
    const res = await fetch(
      `${ctx.baseUrl}/v1/workflows/00000000-0000-0000-0000-000000000000/input-schema`,
      { headers: { authorization: `Bearer ${ctx.apiKey}` } },
    );
    expect(res.status).toBe(404);
  });

  test("requires authentication", async () => {
    const wf = await createWorkflow({
      name: "auth-check",
      steps: [{ kind: "transform", id: "out", expression: "return 1;" }],
    });
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/input-schema`);
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/workflows (definition fields are not silently dropped)", () => {
  // Regression: the create/update CreateBody schema was a partial copy of
  // the WorkflowDef that omitted `trigger` + `output_transform`, so a
  // `schedule` trigger submitted over HTTP (and via the `sk` CLI on top of
  // it) was stripped before save — no schedule ever bound (trigger-on-save
  // is the only binding path). Now CreateBody preserves them end to end.
  test("a schedule trigger binds a workflows_schedules row", async () => {
    const wf = await createWorkflow({
      name: "scheduled-fields-check",
      trigger: { kind: "schedule", cron: "7 8 * * *", tz: "Europe/Berlin" },
      steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
    });

    const rows = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.workflow_id, wf.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cron).toBe("7 8 * * *");
    expect(rows[0]?.timezone).toBe("Europe/Berlin");
    expect(rows[0]?.paused).toBe(false);

    // GET surfaces the trigger (symmetric with the create body) so the
    // `sk` CLI banner + non-MCP callers can read it back.
    const get = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(get.status).toBe(200);
    const got = (await get.json()) as { trigger?: { kind?: string; cron?: string } };
    expect(got.trigger?.kind).toBe("schedule");
    expect(got.trigger?.cron).toBe("7 8 * * *");
  });

  test("output_transform round-trips through create → GET", async () => {
    const wf = await createWorkflow({
      name: "output-transform-check",
      output_transform: '{ "ok": true }',
      steps: [{ kind: "transform", id: "out", expression: "return 1;" }],
    });

    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Pre-fix this was stripped by CreateBody → serialized as null.
    expect(body.output_transform).toBe('{ "ok": true }');
  });

  test("PUT preserves an existing trigger when the body omits trigger", async () => {
    const wf = await createWorkflow({
      name: "scheduled-put-preserve",
      trigger: { kind: "schedule", cron: "11 9 * * *", tz: "Europe/Berlin" },
      steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
    });

    const put = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}`, {
      method: "PUT",
      headers: headers(ctx.apiKey),
      body: JSON.stringify({
        name: "scheduled-put-preserve",
        steps: [{ kind: "transform", id: "out", expression: 'return { ok: "updated" };' }],
      }),
    });
    expect(put.status).toBe(200);
    const updated = (await put.json()) as { trigger?: { kind?: string; cron?: string } };
    expect(updated.trigger?.kind).toBe("schedule");
    expect(updated.trigger?.cron).toBe("11 9 * * *");

    const rows = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.workflow_id, wf.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cron).toBe("11 9 * * *");
    expect(rows[0]?.timezone).toBe("Europe/Berlin");
  });
});
