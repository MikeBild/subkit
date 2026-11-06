import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import * as conversationsSvc from "../../conversations/service.ts";
import {
  createConversationWithTurn,
  respondElicitationForTest,
} from "../../conversations/tests/setup.ts";
import { auditLog, conversationElicitations, workflows } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;

const SLUG = "sk-cli-17-private-github-repos";

async function countAudit(action: string, resourceId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, resourceId),
        isNull(auditLog.reason),
      ),
    );
  return rows.length;
}

describe("journey: sk-cli prompt-driven authoring", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-17-prompt-driven");
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1+AC2: prompt drives canned loop, confirmation saves an inert draft and audit", async () => {
    const initial_message = `Create a new workflow named ${SLUG} in SubKit that lists my private GitHub repositories.`;

    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        initial_message,
        permission_mode: "ask",
      },
      ctx.db,
    );
    const conversation_id = outcome.conversation.id;

    const toolNames = outcome.result.events
      .filter(
        (e): e is Extract<typeof e, { type: "tool_call_start" }> => e.type === "tool_call_start",
      )
      .map((e) => e.tool);
    expect(toolNames).not.toContain("run_workflow");

    const [pending] = await ctx.db
      .select({ id: conversationElicitations.id, status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id))
      .limit(1);
    expect(pending).toBeDefined();
    expect(pending?.status).toBe("pending");

    await respondElicitationForTest(
      {
        tenant_id: ctx.tenantId,
        conversation_id,
        elicitation_id: pending!.id,
        actor_id: ctx.userId,
        output: { confirmed: true },
      },
      ctx.db,
    );

    const detail = await conversationsSvc.getConversation(ctx.tenantId, conversation_id, ctx.db);
    expect(detail?.conversation.status).toBe("active");
    const workflowId = detail?.conversation.target_workflow_id;
    expect(workflowId).toBeDefined();

    const [row] = await ctx.db
      .select({
        id: workflows.id,
        slug: workflows.slug,
        draft: workflows.draft_version_id,
        active: workflows.current_version_id,
      })
      .from(workflows)
      .where(and(eq(workflows.id, workflowId as string), eq(workflows.tenant_id, ctx.tenantId)))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.draft).toBeTruthy();
    expect(row?.active).toBeNull();
    expect(row?.id).toBe(workflowId as string);

    expect(await countAudit("approval.approved", pending!.id)).toBe(1);
    expect(await countAudit("conversation.committed", conversation_id)).toBe(0);
  });
});
