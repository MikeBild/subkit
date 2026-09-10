// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of tested workflow definitions, not template literals.
//
// run_workflow hold-writes integration tests.
//
// Proves the core guarantee and the opt-in across A + B scenarios:
//
//   A. Default (hold_writes): a POST step in a saved workflow run via
//      run_workflow in dev is HELD (no real dispatch); result envelope
//      carries writes_held:true + held_step_ids; audit row metadata has
//      execute_writes:false.
//
//   B. execute_writes:true is only a request: without local authority,
//      the same write remains held and its actual held state is audited.
//
//   Negative: wrong-tenant principal → cross-tenant isolation at the
//   workflow lookup layer means the wrong tenant sees workflow_not_found.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { auditLog, conversations, workflows, workflowVersions } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../../execution/tests/setup.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import { runWorkflowTool } from "../generated/writes/run-workflow.ts";
import type { ToolContext } from "../index.ts";

// Requires a real Postgres database — set REQUIRES_PG=0 to skip.
const skip = process.env.REQUIRES_PG === "0";

let convCtx: ConversationTestCtx;
let mock: MockServer;
const hits: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  if (skip) return;
  convCtx = await createConversationTestCtx("rw-hold-writes");
  mock = await createMockServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.url?.startsWith("/data")) {
      return jsonResponse(res, 200, { email: "user@example.com", name: "Test User" });
    }
    return jsonResponse(res, 200, { delivered: true });
  });
}, 120_000);

afterAll(async () => {
  if (skip) return;
  await mock?.close();
  await convCtx?.cleanup();
}, 30_000);

/** Build a minimal ResolvedPrincipal that passes workflow:run RBAC.
 *  The 'admin' role (seeded by createTestDb via seedBuiltinRolesAndPermissions)
 *  grants all permissions including workflow:run. */
function makePrincipal(tenant_id: string, actor_id: string): ResolvedPrincipal {
  return {
    provider: "api_key",
    kind: "user",
    id: actor_id,
    tenant_id,
    roles: ["admin"],
  };
}

/** Seed a conversation row so run_workflow can bind to it. */
async function seedConversation(): Promise<string> {
  const [row] = await convCtx.testDb.db
    .insert(conversations)
    .values({
      tenant_id: convCtx.tenant_id,
      status: "active",
      draft: createEmptyDraftDocument(),
    })
    .returning();
  if (!row) throw new Error("conversation seed failed");
  return row.id;
}

/** Seed a two-step workflow (GET + POST) under the conversation tenant. */
async function seedTwoStepWorkflow(slug: string): Promise<string> {
  const [wf] = await convCtx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: convCtx.tenant_id,
      slug,
      name: slug,
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error(`workflow seed failed for ${slug}`);

  const [v] = await convCtx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: convCtx.tenant_id,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: slug,
        steps: [
          {
            kind: "request",
            id: "fetch_data",
            method: "GET",
            url: `${mock.baseUrl}/data`,
          },
          {
            kind: "request",
            id: "send_email",
            method: "POST",
            url: `${mock.baseUrl}/send`,
            body: { to: "${scope.fetch_data.data.email}" },
          },
        ],
      },
    })
    .returning();
  if (!v) throw new Error(`workflow version seed failed for ${slug}`);

  await convCtx.testDb.db
    .update(workflows)
    .set({ current_version_id: v.id })
    .where(and(eq(workflows.tenant_id, convCtx.tenant_id), eq(workflows.id, wf.id)));

  return wf.id;
}

/** Build a ToolContext for run_workflow calls under the conversation tenant. */
function makeCtx(opts: { conversation_id: string; principal: ResolvedPrincipal }): ToolContext {
  const draftDoc = createEmptyDraftDocument();
  return {
    db: convCtx.testDb.db,
    tenant_id: convCtx.tenant_id,
    conversation_id: opts.conversation_id,
    actor_id: convCtx.user_id,
    connector_id: null,
    workflow_id: null,
    principal: opts.principal,
    engineClient: new EngineClient({
      tenant_id: convCtx.tenant_id,
      actor_id: convCtx.user_id,
      db: convCtx.testDb.db,
    }),
    getDraft: () => draftDoc,
    setDraft: async () => {},
    onLog: () => {},
  } as unknown as ToolContext;
}

/** Query the most recent conversation.run_workflow audit row for the tenant. */
async function latestRunWorkflowAuditRow() {
  const rows = await convCtx.testDb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, convCtx.tenant_id),
        eq(auditLog.action, "conversation.run_workflow"),
      ),
    )
    .orderBy(desc(auditLog.ts))
    .limit(1);
  return rows[0] ?? null;
}

describe.skipIf(skip)("run_workflow (A: default holds write steps, does not dispatch)", () => {
  test("write step is held, GET runs live, envelope has writes_held + held_step_ids, audit execute_writes:false", async () => {
    hits.length = 0;
    const workflow_id = await seedTwoStepWorkflow("rw-hold-default");
    const conversation_id = await seedConversation();
    const principal = makePrincipal(convCtx.tenant_id, convCtx.user_id);
    const toolCtx = makeCtx({ conversation_id, principal });

    // Run WITHOUT execute_writes — hold-writes is the default.
    const result = await runWorkflowTool.execute(toolCtx, {
      workflow: workflow_id,
      environment: "dev",
      // execute_writes omitted → hold-writes mode
    });

    // Read step must have executed live; write step must NOT have hit the server.
    expect(hits.filter((h) => h.url.startsWith("/data"))).toHaveLength(1);
    expect(hits.filter((h) => h.url.startsWith("/send"))).toHaveLength(0);

    // Envelope must carry the hold signals.
    const data = result.data as Record<string, unknown>;
    expect(data.writes_held).toBe(true);
    expect(Array.isArray(data.held_step_ids)).toBe(true);
    const heldIds = data.held_step_ids as string[];
    expect(heldIds).toContain("send_email");
    expect(typeof data.writes_held_note).toBe("string");

    // Audit row must record execute_writes:false and held_step_ids.
    const auditRow = await latestRunWorkflowAuditRow();
    expect(auditRow).not.toBeNull();
    const meta = auditRow?.metadata as Record<string, unknown>;
    expect(meta?.execute_writes).toBe(false);
    expect(Array.isArray(meta?.held_step_ids)).toBe(true);
    expect((meta!.held_step_ids as string[]).includes("send_email")).toBe(true);
  }, 60_000);
});

describe.skipIf(skip)("run_workflow (B: execute_writes:true cannot grant authority)", () => {
  test("execute_writes:true — POST remains held without authority and audit reflects no writes", async () => {
    hits.length = 0;
    const workflow_id = await seedTwoStepWorkflow("rw-execute-writes-true");
    const conversation_id = await seedConversation();
    const principal = makePrincipal(convCtx.tenant_id, convCtx.user_id);
    const toolCtx = makeCtx({ conversation_id, principal });

    // The live-run preference is not a version-bound grant.
    const result = await runWorkflowTool.execute(toolCtx, {
      workflow: workflow_id,
      environment: "dev",
      execute_writes: true,
    });

    // Preparation reads run; unapproved writes do not.
    expect(hits.filter((h) => h.url.startsWith("/data"))).toHaveLength(1);
    expect(hits.filter((h) => h.url.startsWith("/send"))).toHaveLength(0);

    // Hold signals remain explicit in the envelope.
    const data = result.data as Record<string, unknown>;
    expect(data.writes_held).toBe(true);
    expect(data.held_step_ids).toContain("send_email");
    expect(typeof data.writes_held_note).toBe("string");

    // Audit records actual behavior, not the requested flag.
    const auditRow = await latestRunWorkflowAuditRow();
    expect(auditRow).not.toBeNull();
    const meta = auditRow?.metadata as Record<string, unknown>;
    expect(meta?.execute_writes).toBe(false);
    expect(meta?.held_step_ids).toContain("send_email");
  }, 60_000);
});

describe.skipIf(skip)("run_workflow (negative: wrong-tenant isolation at lookup layer)", () => {
  test("wrong-tenant ToolContext cannot see the correct-tenant workflow (workflow_not_found)", async () => {
    const workflow_id = await seedTwoStepWorkflow("rw-tenant-guard");
    const conversation_id = await seedConversation();

    // A ToolContext with a completely different tenant_id — the workflow
    // row belongs to convCtx.tenant_id, so the cross-tenant lookup
    // must return nothing.
    const wrongTenantId = "00000000-dead-beef-cafe-000000000002";
    const wrongActorId = "00000000-dead-beef-cafe-000000000001";
    const wrongPrincipal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: wrongActorId,
      tenant_id: wrongTenantId,
      roles: ["admin"],
    };
    const draftDoc = createEmptyDraftDocument();
    const wrongCtx: ToolContext = {
      db: convCtx.testDb.db,
      // Wrong tenant — the workflow lookup is tenant-scoped and will find nothing.
      tenant_id: wrongTenantId,
      conversation_id,
      actor_id: wrongActorId,
      connector_id: null,
      workflow_id: null,
      principal: wrongPrincipal,
      engineClient: new EngineClient({
        tenant_id: wrongTenantId,
        actor_id: wrongActorId,
        db: convCtx.testDb.db,
      }),
      getDraft: () => draftDoc,
      setDraft: async () => {},
      onLog: () => {},
    } as unknown as ToolContext;

    const result = await runWorkflowTool.execute(wrongCtx, {
      workflow: workflow_id,
      environment: "dev",
    });

    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string };
    // Cross-tenant isolation: the lookup is tenant-scoped, so the wrong tenant
    // sees workflow_not_found rather than a permission error.
    expect(data.error_code).toBe("workflow_not_found");
  }, 60_000);
});
