// Integration test B.1 — listWorkflowsUsingConnector + dispatchDeleteConnector
// dependency backstop.
//
// Coverage:
//   - seed a connector + a live workflow whose current-version DAG has a step
//     with connector_id = that connector.
//   - listWorkflowsUsingConnector → returns the workflow.
//   - dispatchDeleteConnector without confirm_orphan → ok:false
//     error_code=connector_has_dependents with dependents listed.
//   - dispatchDeleteConnector with confirm_orphan:true → delete proceeds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { connectors } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { listWorkflowsUsingConnector } from "../../workflows/connector-refs.ts";
import { createWorkflow } from "../../workflows/service.ts";
import { dispatchDeleteConnector } from "../persistence/auto-persist/dispatch.ts";
import { createConversation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { CommitIntent } from "../tools/ask-user/commit-intent.ts";
import type { DraftDocument } from "../types.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("conn_deps");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedConnector(slug: string): Promise<string> {
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.example.test",
      config: {},
    })
    .returning();
  if (!c) throw new Error("seed connector failed");
  return c.id;
}

async function seedWorkflowWithConnector(slug: string, connectorId: string): Promise<string> {
  const result = await createWorkflow(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      def: {
        name: slug,
        slug,
        steps: [
          {
            id: "call-api",
            kind: "request",
            connector_id: connectorId,
            method: "GET",
            path: "/data",
          },
        ],
      },
    },
    ctx.testDb.db,
  );
  if (!result.workflow) throw new Error(`seed workflow failed: ${JSON.stringify(result.errors)}`);
  return result.workflow.id;
}

async function makeToolCtx() {
  const created = await createConversation(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, title: "dep-test" },
    ctx.testDb.db,
  );
  let draft: DraftDocument = { workflow: { name: "", steps: [] } };
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  };
}

describe("listWorkflowsUsingConnector", () => {
  test("returns the workflow whose DAG step binds the connector", async () => {
    const connectorId = await seedConnector("dep-check-api");
    const workflowId = await seedWorkflowWithConnector("dep-check-wf", connectorId);

    const deps = await listWorkflowsUsingConnector(ctx.tenant_id, connectorId, ctx.testDb.db);
    expect(deps.some((d) => d.id === workflowId)).toBe(true);
  });

  test("returns empty array when the connector is not referenced in any DAG", async () => {
    const unrelatedId = await seedConnector("unrelated-api");
    const deps = await listWorkflowsUsingConnector(ctx.tenant_id, unrelatedId, ctx.testDb.db);
    expect(deps).toHaveLength(0);
  });

  test("tenant isolation: returns empty for the correct connector_id but wrong tenant", async () => {
    const connectorId = await seedConnector("tenant-iso-api");
    await seedWorkflowWithConnector("tenant-iso-wf", connectorId);

    const deps = await listWorkflowsUsingConnector(
      "00000000-0000-0000-0000-000000000000", // wrong tenant
      connectorId,
      ctx.testDb.db,
    );
    expect(deps).toHaveLength(0);
  });
});

describe("dispatchDeleteConnector — dependency backstop", () => {
  test("without confirm_orphan → ok:false error_code=connector_has_dependents with dependents", async () => {
    const connectorId = await seedConnector("delete-dep-api");
    await seedWorkflowWithConnector("delete-dep-wf", connectorId);

    const toolCtx = await makeToolCtx();
    const intent: CommitIntent = {
      kind: "delete_connector",
      payload: { id: connectorId },
      description: "delete connector",
    };
    const result = await dispatchDeleteConnector(toolCtx, intent);

    expect(result.ok).toBe(false);
    const err = result as { error_code?: string; data?: { dependents?: unknown[] } };
    expect(err.error_code).toBe("connector_has_dependents");
    expect(Array.isArray(err.data?.dependents)).toBe(true);
    expect((err.data!.dependents as unknown[]).length).toBeGreaterThan(0);
  });

  test("with confirm_orphan:true → delete proceeds and connector row is gone", async () => {
    const connectorId = await seedConnector("delete-orphan-api");
    await seedWorkflowWithConnector("delete-orphan-wf", connectorId);

    const toolCtx = await makeToolCtx();
    const intent: CommitIntent = {
      kind: "delete_connector",
      payload: { id: connectorId, confirm_orphan: true },
      description: "delete connector with orphan confirm",
    };
    const result = await dispatchDeleteConnector(toolCtx, intent);

    expect(result.ok).toBe(true);

    // Connector row is soft-deleted (deleted_at IS NOT NULL).
    const remaining = await ctx.testDb.db
      .select({ deleted_at: connectors.deleted_at })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.deleted_at).not.toBeNull();
  });

  test("without any dependent workflows → delete proceeds immediately", async () => {
    const connectorId = await seedConnector("delete-nodep-api");
    // No workflow seeded — no dependents.

    const toolCtx = await makeToolCtx();
    const intent: CommitIntent = {
      kind: "delete_connector",
      payload: { id: connectorId },
      description: "delete connector no deps",
    };
    const result = await dispatchDeleteConnector(toolCtx, intent);

    expect(result.ok).toBe(true);
  });

  test("tenant isolation: deleting a connector from the wrong tenant → connector_not_found", async () => {
    // RBAC (connector:delete) is enforced upstream in deleteConnectorTool;
    // this pins that the dispatch backstop is tenant-scoped — a wrong-tenant
    // delete neither surfaces the connector's dependents nor deletes the row.
    const connectorId = await seedConnector("dep-cross-tenant-api");
    await seedWorkflowWithConnector("dep-cross-tenant-wf", connectorId);

    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, title: "cross-tenant-del" },
      ctx.testDb.db,
    );
    let draft: DraftDocument = { workflow: { name: "", steps: [] } };
    const wrongTenant = "00000000-0000-0000-0000-000000000000";
    const fakeTenantCtx = {
      db: ctx.testDb.db,
      tenant_id: wrongTenant,
      conversation_id: created.conversation.id,
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      permission_mode: null,
      engineClient: new EngineClient({
        tenant_id: wrongTenant,
        actor_id: ctx.user_id,
        actor_type: "user",
        db: ctx.testDb.db,
      }),
      getDraft: () => draft,
      setDraft: async (next: DraftDocument) => {
        draft = next;
      },
    };
    const intent: CommitIntent = {
      kind: "delete_connector",
      payload: { id: connectorId },
      description: "cross-tenant delete",
    };
    const result = await dispatchDeleteConnector(fakeTenantCtx, intent);
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("connector_not_found");

    // The connector in the real tenant must remain live (not soft-deleted).
    const stillLive = await ctx.testDb.db
      .select({ deleted_at: connectors.deleted_at })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(stillLive[0]?.deleted_at).toBeNull();
  });
});
