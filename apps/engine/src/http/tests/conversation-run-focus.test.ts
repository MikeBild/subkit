import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loadDraft } from "../../conversations/draft.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { inspectExecutionTool } from "../../conversations/tools/inspect-execution.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import { executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { renderAuthoringContextBlock } from "../../llm/core/authoring-context-block.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let growthId = "";
let triageId = "";
let growthFailedRun = "";
let growthNewerRun = "";
let triageNewestRun = "";

async function seedWorkflow(slug: string): Promise<string> {
  const [wf] = await srv.db
    .insert(workflows)
    .values({ tenant_id: srv.tenantId, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  const [version] = await srv.db
    .insert(workflowVersions)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        steps: [{ id: "t1", kind: "transform", language: "javascript", expression: "return 1;" }],
      },
    })
    .returning();
  if (!version) throw new Error("seed version failed");
  await srv.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, wf.id));
  return wf.id;
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
  let draft: DraftDocument = await loadDraft(srv.tenantId, conversationId, srv.db);
  const ctx: ToolContext = {
    db: srv.db,
    tenant_id: srv.tenantId,
    conversation_id: conversationId,
    actor_id: null,
    connector_id: null,
    workflow_id: workflowId,
    engineClient: new EngineClient({ tenant_id: srv.tenantId, actor_id: null, db: srv.db }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
  return { ctx, draft: () => draft };
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-run-focus");
  growthId = await seedWorkflow("mission-control-growth-weekly");
  triageId = await seedWorkflow("watchkit-finding-triage");
  growthFailedRun = await seedRun(growthId, "failed", "2026-09-01T08:00:00.000Z");
  growthNewerRun = await seedRun(growthId, "succeeded", "2026-09-02T08:00:00.000Z");
  triageNewestRun = await seedRun(triageId, "failed", "2026-09-03T08:00:00.000Z");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("POST /v1/conversations with the run it is about", () => {
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
    const detail = (await fetched.json()) as { conversation: { target_workflow_id: string } };
    expect(detail.conversation.target_workflow_id).toBe(growthId);

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
