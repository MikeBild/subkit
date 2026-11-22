import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { createApiKeyProvider } from "../../auth/providers/api-key.ts";
import { loadDraft } from "../../conversations/draft.ts";
import { renderAuthoringContextBlock } from "../../conversations/loop/authoring-context-block.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { inspectExecutionTool } from "../../conversations/tools/inspect-execution.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import { apiKeys, executionSteps, executions, roles, users } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { seedWorkflow } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let growthId = "";
let triageId = "";
let growthFailedRun = "";
let growthNewerRun = "";
let triageNewestRun = "";

async function seedSlugWorkflow(slug: string): Promise<string> {
  const { workflow } = await seedWorkflow(srv.db, {
    tenant_id: srv.tenantId,
    slug,
    name: slug,
    dag: {
      name: slug,
      slug,
      steps: [{ id: "t1", kind: "transform", language: "javascript", expression: "return 1;" }],
    },
  });
  return workflow.id;
}

async function seedRun(
  workflowId: string,
  status: "succeeded" | "failed",
  at: string,
): Promise<string> {
  const [row] = await srv.db
    .insert(executions)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: workflowId,
      status,
      source_kind: "saved",
      request_source: "test",
      execution_mode: "prod",
      created_at: new Date(at),
      finished_at: new Date(at),
    })
    .returning();
  if (!row) throw new Error("seed execution failed");
  return row.id;
}

function create(body: Record<string, unknown>) {
  return fetch(`${srv.baseUrl}/v1/conversations`, {
    method: "POST",
    headers: { authorization: `Bearer ${srv.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function toolContextFor(conversationId: string, workflowId: string | null) {
  const principal = await createApiKeyProvider({ db: srv.db }).resolve(
    new Request(`${srv.baseUrl}/v1/conversations/${conversationId}`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    }),
  );
  if (!principal) throw new Error("fixture API key did not resolve its principal");
  let draft: DraftDocument = await loadDraft(srv.tenantId, conversationId, srv.db);
  const ctx: ToolContext = {
    db: srv.db,
    tenant_id: srv.tenantId,
    conversation_id: conversationId,
    actor_id: principal.id,
    principal,
    connector_id: null,
    workflow_id: workflowId,
    engineClient: new EngineClient({ tenant_id: srv.tenantId, actor_id: principal.id, db: srv.db }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
  return { ctx, draft: () => draft };
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-run-focus");
  growthId = await seedSlugWorkflow("mission-control-growth-weekly");
  triageId = await seedSlugWorkflow("uptime-finding-triage");
  growthFailedRun = await seedRun(growthId, "failed", "2026-09-01T08:00:00.000Z");
  growthNewerRun = await seedRun(growthId, "succeeded", "2026-09-02T08:00:00.000Z");
  triageNewestRun = await seedRun(triageId, "failed", "2026-09-03T08:00:00.000Z");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("POST /v1/conversations with the run it is about", () => {
  test("run inspection without authenticated tool identity fails before changing the draft", async () => {
    const response = await create({ workflow_id: growthId, execution_id: growthFailedRun });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { conversation: { id: string } };
    const { ctx, draft } = await toolContextFor(created.conversation.id, growthId);
    const before = structuredClone(draft());
    const result = await inspectExecutionTool.execute({ ...ctx, principal: null }, {});
    expect(result).toEqual({ ok: false, data: { error_code: "principal_required" } });
    expect(draft()).toEqual(before);
  });

  test("keeps the workflow binding and 'this run' is the run the chat was opened for", async () => {
    const res = await create({ workflow_id: growthId, execution_id: growthFailedRun });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      conversation: { id: string; target_workflow_id: string | null };
    };
    expect(created.conversation.target_workflow_id).toBe(growthId);

    const fetched = await fetch(`${srv.baseUrl}/v1/conversations/${created.conversation.id}`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    const detail = (await fetched.json()) as {
      conversation: { target_workflow_id: string };
      resume_summary?: { stage: string; focused_run: { execution_id: string } | null };
    };
    expect(detail.conversation.target_workflow_id).toBe(growthId);
    expect(detail.resume_summary?.stage).toBe("run_focus");
    expect(detail.resume_summary?.focused_run?.execution_id).toBe(growthFailedRun);

    const { ctx, draft } = await toolContextFor(created.conversation.id, growthId);
    const block = renderAuthoringContextBlock({ draft: draft() });
    expect(block).toContain(
      `This run: execution ${growthFailedRun} of workflow mission-control-growth-weekly (${growthId})`,
    );

    const result = await inspectExecutionTool.execute(ctx, {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      inspected: { execution_id: string; workflow_slug: string; selected_by: string };
    };
    expect(data.inspected).toMatchObject({
      execution_id: growthFailedRun,
      workflow_slug: "mission-control-growth-weekly",
      selected_by: "conversation_run",
    });
  });

  test("a workflow-only chat inspects that workflow's newest run, never another workflow's", async () => {
    const res = await create({ workflow_id: growthId });
    const created = (await res.json()) as { conversation: { id: string } };
    const { ctx } = await toolContextFor(created.conversation.id, growthId);
    const result = await inspectExecutionTool.execute(ctx, {});
    expect(result.ok).toBe(true);
    const data = result.data as { inspected: { execution_id: string; selected_by: string } };
    expect(data.inspected.execution_id).toBe(growthNewerRun);
    expect(data.inspected.execution_id).not.toBe(triageNewestRun);
    expect(data.inspected.selected_by).toBe("bound_workflow_latest");
  });

  test("the run alone binds its workflow", async () => {
    const res = await create({ execution_id: triageNewestRun });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      conversation: { target_workflow_id: string | null };
    };
    expect(created.conversation.target_workflow_id).toBe(triageId);
  });

  test("a run of another workflow is refused, an unknown run is 404", async () => {
    const mismatch = await create({ workflow_id: growthId, execution_id: triageNewestRun });
    expect(mismatch.status).toBe(400);
    const missing = await create({
      workflow_id: growthId,
      execution_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing.status).toBe(404);
  });
});

describe("POST /v1/conversations · the run needs execution:read", () => {
  async function keyWithoutExecutionRead(): Promise<string> {
    const [role] = await srv.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(isNull(roles.tenant_id), eq(roles.name, "portal_token_user")))
      .limit(1);
    if (!role) throw new Error("portal_token_user role not seeded");
    const [user] = await srv.db
      .insert(users)
      .values({ tenant_id: srv.tenantId, email: "no-runs@run-focus.local", role_id: role.id })
      .returning();
    if (!user) throw new Error("seed user failed");
    const token = "wf_live_runfocusnoexecutionread0000";
    await srv.db.insert(apiKeys).values({
      tenant_id: srv.tenantId,
      user_id: user.id,
      prefix: token.slice(0, 12),
      token_sha256: createHash("sha256").update(token).digest("hex"),
      scopes: ["*"],
    });
    return token;
  }

  test("a principal who may not read runs cannot open a chat about one, known or unknown", async () => {
    const token = await keyWithoutExecutionRead();
    const asLimited = (body: Record<string, unknown>) =>
      fetch(`${srv.baseUrl}/v1/conversations`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await asLimited({ execution_id: growthFailedRun })).status).toBe(403);
    expect((await asLimited({ execution_id: "00000000-0000-4000-8000-000000000000" })).status).toBe(
      403,
    );
    expect((await asLimited({ workflow_id: growthId })).status).toBe(201);
  });
});

describe("POST /v1/conversations · the run's warnings are counted", () => {
  test("the focused run carries the warnings its steps recorded", async () => {
    const run = await seedRun(growthId, "succeeded", "2026-09-04T08:00:00.000Z");
    await srv.db.insert(executionSteps).values([
      {
        tenant_id: srv.tenantId,
        execution_id: run,
        step_key: "fetch",
        step_index: 0,
        kind: "request",
        status: "succeeded",
        output_preview: {
          value: { ok: true },
          warnings: [{ code: "unresolved_identifier", identifier: "input.date" }],
        },
      },
      {
        tenant_id: srv.tenantId,
        execution_id: run,
        step_key: "send",
        step_index: 1,
        kind: "request",
        status: "succeeded",
        output_preview: { value: null },
        request_meta: { extras: { held: true } },
      },
    ]);
    const res = await create({ execution_id: run });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { conversation: { id: string } };
    const draft = await loadDraft(srv.tenantId, created.conversation.id, srv.db);
    expect(draft.state?.latest_execution?.warnings_count).toBe(2);
  });
});
