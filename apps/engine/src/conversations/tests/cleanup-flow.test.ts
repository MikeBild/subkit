import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { createWorkflow } from "../../workflows/service.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
  respondElicitationForTest,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("cleanup_flow");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedWorkflow(name: string, slug: string) {
  const result = await createWorkflow(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      def: {
        name,
        slug,
        steps: [{ id: "wait-1", kind: "wait", duration_ms: 1 }],
      },
    },
    ctx.testDb.db,
  );
  if ("errors" in result) throw new Error(result.errors.join(", "));
  return result.workflow;
}

async function countAudit(action: string, resourceId: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenant_id),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, resourceId),
      ),
    );
  return rows.length;
}

describe("cleanup write tools in the conversation loop", () => {
  test("delete_workflow goes through confirm-before-execution and then deletes", async () => {
    const workflow = await seedWorkflow("Delete Me", "delete-me");
    const conversation = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    // Two steps, not three: the model NEVER re-issues a gated write. Its call
    // pauses on the policy gate's ask_user_confirm, and the HARNESS performs
    // the delete when the operator answers (auto-persist's
    // `execute_confirmed_tool_call` claims the approval the gate minted).
    getMockProvider().setConversePlan(conversation.conversation.id, [
      { tool: "list_workflows", args: {} },
      { tool: "delete_workflow", args: { slug: workflow.slug } },
    ]);

    const first = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.conversation.id,
        actor_id: ctx.user_id,
        message: "delete delete-me",
      },
      ctx.testDb.db,
    );
    expect(first.result.status).toBe("awaiting_input");
    expect(first.result.pending_elicitation_id).toBeTruthy();
    const firstCalls = first.result.events.filter((e) => e.type === "tool_call_start");
    expect(firstCalls.map((e) => (e.type === "tool_call_start" ? e.tool : ""))).toEqual([
      "list_workflows",
      "delete_workflow",
    ]);
    expect(await countAudit("workflow.deleted", workflow.id)).toBe(0);

    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.conversation.id,
        elicitation_id: first.result.pending_elicitation_id!,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    expect(resumed.result.status).toBe("active");
    // The model issued NO tool call on the resume turn — the harness had
    // already performed the delete before the LLM was re-entered.
    const resumedCalls = resumed.result.events.filter((e) => e.type === "tool_call_start");
    expect(resumedCalls.map((e) => (e.type === "tool_call_start" ? e.tool : ""))).toEqual([]);
    const deletedWorkflow = await ctx.testDb.db
      .select({ id: auditLog.resource_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "workflow.deleted"), eq(auditLog.resource_id, workflow.id)));
    expect(deletedWorkflow).toHaveLength(1);
    expect(await countAudit("conversation.delete_workflow", workflow.id)).toBe(1);
  });

  test("revoke_api_key goes through confirm-before-execution and then revokes", async () => {
    const [apiKey] = await ctx.testDb.db
      .insert(apiKeys)
      .values({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        prefix: "sk_cleanup_flow",
        token_sha256: "sha256-cleanup-flow",
        scopes: [],
      })
      .returning();
    const conversation = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    getMockProvider().setConversePlan(conversation.conversation.id, [
      { tool: "list_api_keys", args: {} },
      { tool: "revoke_api_key", args: { id: apiKey!.id } },
    ]);

    const first = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.conversation.id,
        actor_id: ctx.user_id,
        message: "revoke that api key",
      },
      ctx.testDb.db,
    );
    expect(first.result.status).toBe("awaiting_input");
    expect(first.result.pending_elicitation_id).toBeTruthy();

    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.conversation.id,
        elicitation_id: first.result.pending_elicitation_id!,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    expect(resumed.result.status).toBe("active");
    expect(await countAudit("api_key.revoked", apiKey!.id)).toBe(1);
    expect(await countAudit("conversation.revoke_api_key", apiKey!.id)).toBe(1);
  });
});
