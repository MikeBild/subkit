import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { users, workflowsSchedules } from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
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

describe("GET /v1/workflows/:id/input-schema permission", () => {
  async function restrictedCaller(): Promise<{ id: string; key: string }> {
    const [user] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "input-schema-restricted@test.local",
        role_id: await emptyRoleId(ctx.db, ctx.tenantId),
      })
      .returning();
    if (!user) throw new Error("restricted user insert returned no row");
    const key = `wf_live_${createDeterministicHexFactory(0x15_c4)(16)}`;
    await ctx.testDb.pool.query(
      "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [
        ctx.tenantId,
        user.id,
        key.slice(0, 12),
        createHash("sha256").update(key).digest("hex"),
        JSON.stringify(["*"]),
      ],
    );
    return { id: user.id, key };
  }

  test("needs workflow:read or workflow:run on that workflow", async () => {
    const granted = await createWorkflow({
      name: "input-schema-granted",
      steps: [{ kind: "transform", id: "out", expression: "return { city: input.input.city };" }],
    });
    const other = await createWorkflow({
      name: "input-schema-other",
      steps: [{ kind: "transform", id: "out", expression: "return 1;" }],
    });
    const caller = await restrictedCaller();
    const schemaOf = (id: string) =>
      fetch(`${ctx.baseUrl}/v1/workflows/${id}/input-schema`, {
        headers: { authorization: `Bearer ${caller.key}` },
      });

    expect((await schemaOf(granted.id)).status).toBe(403);

    const grant = await fetch(`${ctx.baseUrl}/v1/rbac/grants`, {
      method: "POST",
      headers: headers(ctx.apiKey),
      body: JSON.stringify({
        subject_type: "user",
        subject_id: caller.id,
        resource_type: "workflow",
        resource_id: granted.id,
        permission: "workflow:run",
      }),
    });
    expect(grant.status).toBe(201);

    const allowed = await schemaOf(granted.id);
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { source: string }).source).toBe("synthesized");
    expect((await schemaOf(other.id)).status).toBe(403);
  });
});

describe("POST /v1/workflows (definition fields are not silently dropped)", () => {
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
