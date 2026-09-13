// User story: as an operator typing into the sk-cli prompt (the same
// surface claude.ai drives via MCP), I send a natural-language
// authoring request and the engine produces an inert workflow draft
// without me touching workflow-shaped APIs by hand.
//
// This journey is the deterministic counterpart to the live browser
// verification under `reference_claude_ai_browser_verification_flow.md`
// and `scripts/verify-cli-authoring.sh`. The live test guards the
// behavior end-to-end against a real LLM; this journey guards the same
// behavior in CI via the mock provider's canned plan, so we catch the
// regression class (run_workflow-in-idle loops, broken commit gates,
// missing audit rows) on every push.
//
// Acceptance criteria:
//
//   AC1. Sending the canonical authoring prompt drives the conversation
//        through the canned inner loop and lands the elicitation row
//        the operator has to confirm.
//   AC2. Confirming the elicitation saves the draft: conversation
//        status returns to `active`, a `workflows` row has a draft version
//        and no active version, and the canonical approval audit row is emitted.
//   AC3. The tool-call sequence never includes `run_workflow` — the
//        whole point of the 6.0.3 step-router fix is that an authoring
//        loop on a not-yet-persisted draft cannot reach the execution
//        tool.

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

const SLUG = "sk-cli-13-private-github-repos";

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
    ctx = await createJourneyCtx("sk-cli-13-prompt-driven");
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1+AC2: prompt drives canned loop, confirmation saves an inert draft and audit", async () => {
    // The exact prompt the operator types — matches the regex wired in
    // apps/engine/src/conversations/service/create.ts that seeds the
    // canned `cannedListPrivateGithubReposPlan`.
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

    // AC3: the inner-loop tool sequence must not contain run_workflow.
    // The canned plan also never proposes it, but assert anyway to
    // catch a future drift in the plan or in the step router.
    const toolNames = outcome.result.events
      .filter(
        (e): e is Extract<typeof e, { type: "tool_call_start" }> => e.type === "tool_call_start",
      )
      .map((e) => e.tool);
    expect(toolNames).not.toContain("run_workflow");

    // AC1: the canned plan ends in `ask_user_confirm` (kind = save_workflow_draft)
    // which the loop renders as an elicitation row awaiting operator
    // confirmation.
    const [pending] = await ctx.db
      .select({ id: conversationElicitations.id, status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id))
      .limit(1);
    expect(pending).toBeDefined();
    expect(pending?.status).toBe("pending");

    // AC2: confirm → inert draft → workflow row + audit row.
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
    // The canned plan doesn't currently override the slug; the engine
    // derives it from the conversation summary. We just assert the row
    // exists and has the workflow id the conversation points at — the
    // strict slug-equality assertion belongs in a mock-provider unit
    // test, not the journey.
    expect(row?.id).toBe(workflowId as string);

    expect(await countAudit("approval.approved", pending!.id)).toBe(1);
    expect(await countAudit("conversation.committed", conversation_id)).toBe(0);
  });
});
