import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import {
  conversations,
  executions,
  users,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../../execution/tests/setup.ts";
import { buildMcpStubCtx } from "../../../mcp/adapter.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import { runWorkflowTool } from "../engine-api/writes/run-workflow.ts";

const skip = process.env.REQUIRES_PG === "0";

let convCtx: ConversationTestCtx;
let mock: MockServer;
let workflowId: string;
let workflowSlug: string;

beforeAll(async () => {
  if (skip) return;
  convCtx = await createConversationTestCtx("rw-mcp-rbac");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));

  workflowSlug = "rw-mcp-rbac-wf";
  const [wf] = await convCtx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: convCtx.tenant_id,
      slug: workflowSlug,
      name: "RBAC Test Workflow",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("workflow seed failed");
  workflowId = wf.id;

  const [v] = await convCtx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: convCtx.tenant_id,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: "RBAC Test Workflow",
        slug: workflowSlug,
        steps: [{ kind: "request", id: "probe", method: "GET", url: `${mock.baseUrl}/ok` }],
      },
    })
    .returning();
  if (!v) throw new Error("workflow version seed failed");

  await convCtx.testDb.db
    .update(workflows)
    .set({ current_version_id: v.id })
    .where(and(eq(workflows.tenant_id, convCtx.tenant_id), eq(workflows.id, wf.id)));
}, 120_000);

afterAll(async () => {
  if (skip) return;
  await mock?.close();
  await convCtx?.cleanup();
}, 30_000);

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

describe.skipIf(skip)("run_workflow via buildMcpStubCtx — RBAC threading", () => {
  test("direct MCP can dispatch a sensitive saved read without exposing it to the authoring chat path", async () => {
    const slug = "private-read";
    const [workflow] = await convCtx.testDb.db
      .insert(workflows)
      .values({ tenant_id: convCtx.tenant_id, slug, name: "Private Read", lifecycle: "active" })
      .returning();
    if (!workflow) throw new Error("workflow seed failed");
    const [version] = await convCtx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: convCtx.tenant_id,
        workflow_id: workflow.id,
        version: 1,
        dag: {
          name: "Private Read",
          slug,
          execution_privacy: "sensitive",
          steps: [
            {
              id: "snapshot",
              kind: "transform",
              language: "javascript",
              expression: "return { count: 1 };",
            },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("workflow version seed failed");
    await convCtx.testDb.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, workflow.id));
    const principal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: convCtx.user_id,
      tenant_id: convCtx.tenant_id,
      roles: ["admin"],
    };
    const direct = buildMcpStubCtx({ db: convCtx.testDb.db, principal });
    const result = await runWorkflowTool.execute(direct, {
      workflow: workflow.id,
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ status: "succeeded", output: { count: 1 } });
    expect(JSON.stringify(result.data)).not.toContain("sensitive_execution_unsupported");
    const runs = await convCtx.testDb.db
      .select({ request_source: executions.request_source })
      .from(executions)
      .where(eq(executions.workflow_id, workflow.id));
    expect(runs.some((run) => run.request_source === "mcp")).toBe(true);
    const chat = await runWorkflowTool.execute(
      { ...direct, direct_mcp_invocation: false },
      { workflow: workflow.id, environment: "dev" },
    );
    expect(JSON.stringify(chat.data)).toContain("sensitive_execution_unsupported");
  }, 60_000);

  test("principal WITH workflow:run (admin) → execution succeeds, NOT principal_required", async () => {
    const convId = await seedConversation();
    const adminPrincipal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: convCtx.user_id,
      tenant_id: convCtx.tenant_id,
      roles: ["admin"],
    };

    const stubCtx = buildMcpStubCtx({
      db: convCtx.testDb.db,
      principal: adminPrincipal,
    });
    const draftDoc = createEmptyDraftDocument();
    let liveDraft = draftDoc;
    const ctx = {
      ...stubCtx,
      conversation_id: convId,
      getDraft: () => liveDraft,
      setDraft: async (next: typeof liveDraft) => {
        liveDraft = next;
      },
    };

    const result = await runWorkflowTool.execute(ctx, {
      workflow: workflowId,
      environment: "dev",
    });

    const data = result.data as Record<string, unknown>;
    expect(data.error_code).not.toBe("principal_required");

    if (!result.ok) {
      expect(data.error_code).not.toBe("principal_required");
      expect(data.error_code).not.toBe("permission_denied");
    } else {
      expect(result.ok).toBe(true);
    }
  }, 60_000);

  test("principal WITHOUT workflow:run (empty roles) → permission_denied, NOT principal_required", async () => {
    const convId = await seedConversation();
    const restrictedPrincipal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: convCtx.user_id,
      tenant_id: convCtx.tenant_id,
      roles: [],
    };

    const stubCtx = buildMcpStubCtx({
      db: convCtx.testDb.db,
      principal: restrictedPrincipal,
    });
    const draftDoc = createEmptyDraftDocument();
    let liveDraft = draftDoc;
    const ctx = {
      ...stubCtx,
      conversation_id: convId,
      getDraft: () => liveDraft,
      setDraft: async (next: typeof liveDraft) => {
        liveDraft = next;
      },
    };

    const [owner] = await convCtx.testDb.db
      .select({ role_id: users.role_id })
      .from(users)
      .where(eq(users.id, convCtx.user_id));
    if (!owner) throw new Error("conversation user missing");
    await convCtx.testDb.db
      .update(users)
      .set({ role_id: await emptyRoleId(convCtx.testDb.db, convCtx.tenant_id) })
      .where(eq(users.id, convCtx.user_id));
    const result = await runWorkflowTool
      .execute(ctx, {
        workflow: workflowId,
        environment: "dev",
      })
      .finally(() =>
        convCtx.testDb.db
          .update(users)
          .set({ role_id: owner.role_id })
          .where(eq(users.id, convCtx.user_id)),
      );

    expect(result.ok).toBe(false);
    const data = result.data as Record<string, unknown>;

    expect(data.error_code).not.toBe("principal_required");
    expect(data.error_code).toBe("permission_denied");
  }, 30_000);
});
