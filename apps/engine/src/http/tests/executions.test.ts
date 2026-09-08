import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("executions");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedWorkflow(slug = "http-run-input"): Promise<string> {
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      name: "HTTP Run Input",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("seed workflow failed");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: "HTTP Run Input",
        slug,
        input_schema: {
          type: "object",
          required: ["date"],
          properties: {
            date: { type: "string" },
          },
        },
        steps: [
          {
            kind: "transform",
            id: "shape",
            expression: "return input.input.date;",
            language: "javascript",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("seed workflow version failed");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return workflow.id;
}

describe("http executions route", () => {
  test("normalizes a structured string payload before running the saved workflow", async () => {
    const workflowId = await seedWorkflow();
    const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        input: '{"date":"tomorrow +1"}',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      execution_id: string;
      status: string;
      output: unknown;
    };
    expect(body.execution_id).toBeTruthy();
    expect(body.status).toBe("succeeded");
    expect(body.output).toBe("tomorrow +1");
  });
});

describe("idempotency key on the saved-workflow trigger", () => {
  // seedWorkflow() carries a fixed slug and the active-slug index is unique
  // per tenant, so seed once for this block and share the id.
  let workflowId = "";
  beforeAll(async () => {
    workflowId = await seedWorkflow("http-run-idempotency");
  });
  // The capability matrix said "partial" here for as long as the generic
  // trigger path accepted no key; two builders in Track 0.1 quoted that row
  // as their reason to keep a hand-rolled ledger. This pins the row's new
  // answer: the same key in one tenant yields one run, and the second call
  // says so instead of starting anything.
  async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        execution_id: string;
        status: string;
        output?: unknown;
        idempotent_replay?: boolean;
      },
    };
  }

  test("a repeated key returns the first run and starts nothing", async () => {
    const key = "slot:2026-09-03T07";
    const first = await post({
      source: "saved",
      workflow_id: workflowId,
      input: { date: "one" },
      idempotency_key: key,
    });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("succeeded");
    expect(first.body.idempotent_replay).toBeUndefined();

    const second = await post({
      source: "saved",
      workflow_id: workflowId,
      input: { date: "one" },
      idempotency_key: key,
    });
    expect(second.status).toBe(200);
    expect(second.body.execution_id).toBe(first.body.execution_id);
    expect(second.body.status).toBe("succeeded");
    expect(second.body.idempotent_replay).toBe(true);
    // Nothing ran the second time: the replay carries no output of its own.
    expect(second.body.output).toBeUndefined();
    const changed = await post({
      source: "saved",
      workflow_id: workflowId,
      input: { date: "two" },
      idempotency_key: key,
    });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: "execution_boundary_mismatch" });

    const rows = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.idempotency_key, key)));
    expect(rows).toHaveLength(1);
  });

  test("the Idempotency-Key header works like the body field", async () => {
    const key = "hdr:2026-09-03T08";
    const first = await post(
      { source: "saved", workflow_id: workflowId, input: { date: "h1" } },
      { "Idempotency-Key": key },
    );
    const second = await post(
      { source: "saved", workflow_id: workflowId, input: { date: "h1" } },
      { "Idempotency-Key": key },
    );
    expect(second.body.execution_id).toBe(first.body.execution_id);
    expect(second.body.idempotent_replay).toBe(true);
    const changed = await post(
      { source: "saved", workflow_id: workflowId, input: { date: "h2" } },
      { "Idempotency-Key": key },
    );
    expect(changed.status).toBe(409);
  });

  test("different keys are different runs, and no key is never deduplicated", async () => {
    const a = await post({
      source: "saved",
      workflow_id: workflowId,
      input: { date: "a" },
      idempotency_key: "k:a",
    });
    const b = await post({
      source: "saved",
      workflow_id: workflowId,
      input: { date: "b" },
      idempotency_key: "k:b",
    });
    expect(a.body.execution_id).not.toBe(b.body.execution_id);
    const c1 = await post({ source: "saved", workflow_id: workflowId, input: { date: "c" } });
    const c2 = await post({ source: "saved", workflow_id: workflowId, input: { date: "c" } });
    expect(c1.body.execution_id).not.toBe(c2.body.execution_id);
    expect(c2.body.idempotent_replay).toBeUndefined();
  });

  test("two concurrent calls with the same key still yield one run", async () => {
    // The check-then-insert window is closed by the partial unique index;
    // whichever call loses the insert is answered with the winner's run.
    const key = "race:2026-09-03T09";
    const body = {
      source: "saved",
      workflow_id: workflowId,
      input: { date: "r" },
      idempotency_key: key,
    };
    const results = await Promise.all([post(body), post(body), post(body)]);
    const ids = new Set(results.map((r) => r.body.execution_id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body.idempotent_replay === true).length).toBeGreaterThanOrEqual(
      1,
    );
    const rows = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.idempotency_key, key)));
    expect(rows).toHaveLength(1);
  });

  test("an over-long key is refused before anything runs", async () => {
    const r = await post({
      source: "saved",
      workflow_id: workflowId,
      input: { date: "x" },
      idempotency_key: "k".repeat(201),
    });
    expect(r.status).toBe(400);
  });
});
