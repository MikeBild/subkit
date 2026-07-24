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

// The chat harness only mints a claimable approval when a REAL principal is
// resolvable (`ctx.principal ?? resolveConversationPrincipal(...)` in
// `sdk-wrap/invoke.ts`); every production HTTP route always threads one
// through from `requireAuth`. Mirror that here — the same admin principal on
// both the pausing turn (mints the approval) and the resume (grants + claims
// it), exactly like `run-workflow-tool.test.ts`.
function testPrincipal(): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  };
}

/** Read the single-use `approval_id` a policy-gated `ask_user_confirm`
 *  minted into `commit_intent.payload` — the same handle
 *  `execute_confirmed_tool_call` claims in `auto-persist.ts`. */
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

    // The gate minted a claimable-once-a-human-decides approval — UNGRANTED,
    // exactly like the MCP `wf_<slug>` confirm loop (`wf-confirm-loop.test.ts`).
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

    // The operator's answer (a human, chat surface) is what granted it —
    // never the model — and the harness's own claim burned the handle.
    const claimedApproval = await getApproval(approvalId);
    expect(claimedApproval?.granted_at).not.toBeNull();
    expect(claimedApproval?.consumed_at).not.toBeNull();
    // The deeper tool-approval lifecycle row (`conversation_tool_call`,
    // keyed on the approval id) is distinct from the unconditional
    // elicitation-resolution log sharing the same action name — this one
    // only exists because the harness actually claimed and ran the write.
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

    // `revoke_api_key` has no shape-specific commit_intent carrier
    // (`mapToolToCommitIntentKind` only covers save/delete/create_api_key/
    // run_workflow/update_*), so it always takes the universal
    // `execute_confirmed_tool_call` path: a real, principal-bound approval was
    // minted — UNGRANTED — for this call.
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

    // The operator's chat answer granted the approval, and the harness's
    // claim (`execute_confirmed_tool_call` in auto-persist.ts) burned it and
    // then ran `revoke_api_key` with the replayed args.
    const claimedApproval = await getApproval(approvalId);
    expect(claimedApproval?.granted_at).not.toBeNull();
    expect(claimedApproval?.consumed_at).not.toBeNull();
    expect(await countAudit(AuditAction.APPROVAL_APPROVED, approvalId)).toBe(1);
  });

  test("a universal-carrier confirm surfaces the approval portal link when a public base URL is set", async () => {
    // The out-of-band approval link is the ONLY channel a UI-less MCP client
    // has to answer a policy confirmation. It is minted only when the engine
    // has a public base URL; set one for this case and restore it after so the
    // rest of the suite keeps its default.
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

      // The link lands on the elicitation input, so it flows out on the
      // `elicit_request` frame the client renders (and routes url-mode delivery).
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
