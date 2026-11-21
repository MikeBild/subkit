import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { createElicitation } from "../../conversations/elicitations.ts";
import * as conversationsSvc from "../../conversations/service.ts";
import {
  createConversationWithTurn,
  respondElicitationForTest,
} from "../../conversations/tests/setup.ts";
import { auditLog, conversationElicitations, workflows } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

describe("a person reviews, approves or rejects a chat draft from the sk CLI", () => {
  describe("the draft diff is shown", () => {
    let ctx: JourneyCtx;

    let conversationId = "";
    let elicitationId = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("sk-cli-07-approval-diff");
      const outcome = await conversationsSvc.createConversation(
        {
          tenant_id: ctx.tenantId,
          actor_id: ctx.userId,
        },
        ctx.db,
      );
      conversationId = outcome.conversation.id;

      const elicitation = await createElicitation(
        {
          tenant_id: ctx.tenantId,
          conversation_id: conversationId,
          tool_call_id: null,
          tool_name: "ask_user_confirm",
          summary: "commit 2-step workflow",
          input: {
            question: "Commit this workflow?",
            kind: "save_workflow_draft",
            summary: "commit 2-step workflow",
            diff: {
              name: "invoice-digest",
              slug: "invoice-digest",
              description: "Fetch overnight invoices and summarize",
              steps: [
                {
                  id: "fetch",
                  kind: "request",
                  connector_id: "00000000-0000-0000-0000-000000000001",
                  path: "/v1/invoices?since=yesterday",
                },
                {
                  id: "summarize",
                  kind: "transform",
                  language: "javascript",
                  expression: "return input.scope.fetch.data.items;",
                },
              ],
            },
          },
          actor_id: ctx.userId,
        },
        ctx.db,
      );
      elicitationId = elicitation.id;
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: elicitation row persists the structured diff", async () => {
      const [row] = await ctx.db
        .select()
        .from(conversationElicitations)
        .where(eq(conversationElicitations.id, elicitationId))
        .limit(1);
      expect(row).toBeDefined();
      const input = row?.input as { diff?: { name?: string; steps?: unknown[] } } | null;
      expect(input?.diff?.name).toBe("invoice-digest");
      expect(Array.isArray(input?.diff?.steps)).toBe(true);
      expect(input?.diff?.steps?.length).toBe(2);
    });

    test("AC2: SSE stream replays the elicit_request frame with diff", async () => {
      const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/stream`, {
        headers: { accept: "text/event-stream" },
      });
      expect(res.status).toBe(200);
      const text = await res.text();

      const frames = text.split("\n\n").filter((chunk) => chunk.includes("event: elicit_request"));
      expect(frames.length).toBeGreaterThanOrEqual(1);
      const dataLine = (frames[0] ?? "").split("\n").find((line) => line.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse((dataLine ?? "data: {}").slice(6)) as {
        elicitation_id: string;
        tool_name: string;
        input?: { kind?: string; diff?: { name?: string; steps?: unknown[] } };
      };
      expect(payload.elicitation_id).toBe(elicitationId);
      expect(payload.tool_name).toBe("ask_user_confirm");
      expect(payload.input?.kind).toBe("save_workflow_draft");
      expect(payload.input?.diff?.name).toBe("invoice-digest");
      expect(payload.input?.diff?.steps?.length).toBe(2);
    });
  });

  describe("approve or reject with a reason", () => {
    let ctx: JourneyCtx;

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

    beforeAll(async () => {
      ctx = await createJourneyCtx("sk-cli-12-approval");
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    async function newCommitConversation(): Promise<{
      conversationId: string;
      elicitationId: string;
    }> {
      const outcome = await createConversationWithTurn(
        {
          permission_mode: "ask",
          tenant_id: ctx.tenantId,
          actor_id: ctx.userId,
          initial_message: "Create a workflow to list users from jsonplaceholder",
        },
        ctx.db,
      );
      const convoId = outcome.conversation.id;
      const [elicit] = await ctx.db
        .select({ id: conversationElicitations.id })
        .from(conversationElicitations)
        .where(eq(conversationElicitations.conversation_id, convoId))
        .limit(1);
      if (!elicit) throw new Error("expected an elicitation to be queued by the mock provider");
      return { conversationId: convoId, elicitationId: elicit.id };
    }

    test("AC1: manual confirmation saves an inert workflow draft with an approval audit", async () => {
      const { conversationId, elicitationId } = await newCommitConversation();

      const res = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
        { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
      );
      expect(res.status).toBe(200);

      const detail = await conversationsSvc.getConversation(ctx.tenantId, conversationId, ctx.db);
      expect(detail?.conversation.status).toBe("active");
      const workflowId = detail?.conversation.target_workflow_id;
      expect(workflowId).toBeTruthy();

      const [row] = await ctx.db
        .select({
          id: workflows.id,
          draft: workflows.draft_version_id,
          active: workflows.current_version_id,
        })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId as string), eq(workflows.tenant_id, ctx.tenantId)))
        .limit(1);
      expect(row).toBeDefined();
      expect(row?.draft).toBeTruthy();
      expect(row?.active).toBeNull();

      expect(await countAudit("approval.approved", elicitationId)).toBe(1);
      expect(await countAudit("conversation.committed", conversationId)).toBe(0);
    });

    test("AC2: reject records the reason and does not commit", async () => {
      const { conversationId, elicitationId } = await newCommitConversation();

      const res = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
        {
          method: "POST",
          body: JSON.stringify({
            output: { confirmed: false },
            reason: "step 1 missing connector_id",
          }),
        },
      );
      expect(res.status).toBe(200);

      expect(await countAudit("conversation.committed", conversationId)).toBe(0);

      const [row] = await ctx.db
        .select({
          reason: conversationElicitations.decision_reason,
          output: conversationElicitations.output,
        })
        .from(conversationElicitations)
        .where(eq(conversationElicitations.id, elicitationId))
        .limit(1);
      expect(row?.reason).toBe("step 1 missing connector_id");
      expect((row!.output as { confirmed?: boolean } | null)?.confirmed).toBe(false);
    });

    test("AC3: responding to an unknown elicitation returns 4xx/5xx", async () => {
      const { conversationId } = await newCommitConversation();
      const nonExistent = "00000000-0000-0000-0000-000000000000";
      const res = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${nonExistent}/respond`,
        { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
      );
      expect([400, 404, 500]).toContain(res.status);
    });
  });

  describe("authoring from a prompt", () => {
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
});
