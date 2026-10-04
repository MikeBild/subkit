import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import {
  apiKeys,
  auditLog,
  conversationElicitations,
  toolApprovals,
} from "../../db/schema/index.ts";
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

function testPrincipal(): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  };
}

async function approvalIdForElicitation(elicitationId: string): Promise<string> {
  const [row] = await ctx.testDb.db
    .select({ input: conversationElicitations.input })
    .from(conversationElicitations)
    .where(eq(conversationElicitations.id, elicitationId))
    .limit(1);
  const input = row?.input as
    | { commit_intent?: { payload?: { approval_id?: string } } }
    | undefined;
  const approvalId = input?.commit_intent?.payload?.approval_id;
  if (!approvalId) {
    throw new Error("elicitation carries no commit_intent.payload.approval_id");
  }
  return approvalId;
}

async function getApproval(approvalId: string) {
  const [row] = await ctx.testDb.db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, ctx.tenant_id), eq(toolApprovals.id, approvalId)))
    .limit(1);
  return row ?? null;
}

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
    getMockProvider().setConversePlan(conversation.conversation.id, [
      { tool: "list_workflows", args: {} },
      { tool: "delete_workflow", args: { slug: workflow.slug } },
    ]);

    const first = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.conversation.id,
        actor_id: ctx.user_id,
        principal: testPrincipal(),
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

    const approvalId = await approvalIdForElicitation(first.result.pending_elicitation_id!);
    const mintedApproval = await getApproval(approvalId);
    expect(mintedApproval).not.toBeNull();
    expect(mintedApproval?.tool).toBe("delete_workflow");
    expect(mintedApproval?.surface).toBe("chat");
    expect(mintedApproval?.granted_at).toBeNull();
    expect(mintedApproval?.consumed_at).toBeNull();

    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.conversation.id,
        elicitation_id: first.result.pending_elicitation_id!,
        actor_id: ctx.user_id,
        principal: testPrincipal(),
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    expect(resumed.result.status).toBe("active");
    const resumedCalls = resumed.result.events.filter((e) => e.type === "tool_call_start");
    expect(resumedCalls.map((e) => (e.type === "tool_call_start" ? e.tool : ""))).toEqual([]);
    const deletedWorkflow = await ctx.testDb.db
      .select({ id: auditLog.resource_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "workflow.deleted"), eq(auditLog.resource_id, workflow.id)));
    expect(deletedWorkflow).toHaveLength(1);
    expect(await countAudit("conversation.delete_workflow", workflow.id)).toBe(1);

    const claimedApproval = await getApproval(approvalId);
    expect(claimedApproval?.granted_at).not.toBeNull();
    expect(claimedApproval?.consumed_at).not.toBeNull();
    expect(await countAudit(AuditAction.APPROVAL_APPROVED, approvalId)).toBe(1);
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
        principal: testPrincipal(),
        message: "revoke that api key",
      },
      ctx.testDb.db,
    );
    expect(first.result.status).toBe("awaiting_input");
    expect(first.result.pending_elicitation_id).toBeTruthy();

    const approvalId = await approvalIdForElicitation(first.result.pending_elicitation_id!);
    const mintedApproval = await getApproval(approvalId);
    expect(mintedApproval).not.toBeNull();
    expect(mintedApproval?.tool).toBe("revoke_api_key");
    expect(mintedApproval?.surface).toBe("chat");
    expect(mintedApproval?.granted_at).toBeNull();
    expect(mintedApproval?.consumed_at).toBeNull();

    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.conversation.id,
        elicitation_id: first.result.pending_elicitation_id!,
        actor_id: ctx.user_id,
        principal: testPrincipal(),
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    expect(resumed.result.status).toBe("active");
    expect(await countAudit("api_key.revoked", apiKey!.id)).toBe(1);
    expect(await countAudit("conversation.revoke_api_key", apiKey!.id)).toBe(1);

    const claimedApproval = await getApproval(approvalId);
    expect(claimedApproval?.granted_at).not.toBeNull();
    expect(claimedApproval?.consumed_at).not.toBeNull();
    expect(await countAudit(AuditAction.APPROVAL_APPROVED, approvalId)).toBe(1);
  });

  test("a universal-carrier confirm surfaces the approval portal link when a public base URL is set", async () => {
    const prevBaseUrl = getConfig().server.public_base_url;
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    try {
      const [apiKey] = await ctx.testDb.db
        .insert(apiKeys)
        .values({
          tenant_id: ctx.tenant_id,
          user_id: ctx.user_id,
          prefix: "sk_link_surface",
          token_sha256: "sha256-link-surface",
          scopes: [],
        })
        .returning();
      const conversation = await createConversationWithTurn(
        { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
        ctx.testDb.db,
      );
      getMockProvider().setConversePlan(conversation.conversation.id, [
        { tool: "revoke_api_key", args: { id: apiKey!.id } },
      ]);

      const first = await appendMessageWithTurn(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: conversation.conversation.id,
          actor_id: ctx.user_id,
          principal: testPrincipal(),
          message: "revoke that api key",
        },
        ctx.testDb.db,
      );
      expect(first.result.status).toBe("awaiting_input");
      const elicitationId = first.result.pending_elicitation_id!;
      expect(elicitationId).toBeTruthy();

      const [row] = await ctx.testDb.db
        .select({ input: conversationElicitations.input })
        .from(conversationElicitations)
        .where(eq(conversationElicitations.id, elicitationId))
        .limit(1);
      const input = row?.input as { approval_url?: string; commit_intent?: { kind?: string } };
      expect(input?.commit_intent?.kind).toBe("execute_confirmed_tool_call");
      expect(input?.approval_url).toContain("/v1/tool-approvals/decide");
      expect(input?.approval_url).toContain("grant=skag_");
    } finally {
      await setConfigKey("server.public_base_url", prevBaseUrl ?? "", { force: true });
    }
  });
});
