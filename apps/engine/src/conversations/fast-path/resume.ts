import { and, desc, eq } from "drizzle-orm";
import { conversationToolCalls } from "../../db/schema/index.ts";
import { authorizeWorkflowRun } from "../../execution/use-cases/run-workflow.ts";
import { logger } from "../../logging/index.ts";
import {
  approvalAuditResource,
  consumeApproval,
  grantApproval,
  recordApprovalApproved,
  recordApprovalUnfulfilled,
} from "../../tools/approval.ts";
import { resolveWorkflowByIdOrSlug } from "../../workflows/lookup.ts";
import { gateSurfaceFor, replayRefusal, resumableApprovalId } from "../core/fast-path.ts";
import { answerFastPath } from "./persist.ts";
import { denyRun, runAndAnswer } from "./run.ts";
import type { FastPathHit, FastPathParams } from "./types.ts";

async function pendingApprovalId(p: FastPathParams, now: number): Promise<string | null> {
  const recent = await p.db
    .select({
      id: conversationToolCalls.id,
      tool: conversationToolCalls.tool,
      output: conversationToolCalls.output,
      confirmation_data: conversationToolCalls.confirmation_data,
      created_at: conversationToolCalls.created_at,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, p.tenant_id),
        eq(conversationToolCalls.conversation_id, p.conversation_id),
        eq(conversationToolCalls.tool, "run_workflow"),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(1);
  return resumableApprovalId(recent[0], now);
}

async function grantByAffirmation(p: FastPathParams, approvalId: string): Promise<void> {
  if (p.answer_actor.kind === "human") {
    const granted = await grantApproval({
      db: p.db,
      approval_id: approvalId,
      tenant_id: p.tenant_id,
      granted_by_user_id: p.answer_actor.user_id,
      via: p.answer_actor.via,
    });
    if (!granted.ok) {
      logger.warn({
        module: "conversation",
        action: "fast_path.approval_grant_missed",
        msg: "a person affirmed the fast-path run but the grant did not land; the claim decides the outcome",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        approval_id: approvalId,
        user_id: p.answer_actor.user_id,
        error_code: granted.code,
      });
    }
    return;
  }
  logger.warn({
    module: "conversation",
    action: "fast_path.affirmation_not_human",
    msg: "a non-human actor affirmed a held fast-path run; nothing was granted and the claim will refuse unless a person granted it in the approval portal",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    approval_id: approvalId,
    relay_reason: p.answer_actor.reason,
  });
}

function replayError(
  p: FastPathParams,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  reply: string,
): Promise<FastPathHit> {
  return answerFastPath(p, {
    tool: "run_workflow",
    category: "tenant_write",
    input,
    output: { ok: false, ...output, skipped_llm: true },
    reply,
    outcome: "error",
  });
}

export async function resumePhase(p: FastPathParams, now: number): Promise<FastPathHit | null> {
  const approvalId = await pendingApprovalId(p, now);
  if (approvalId === null) return null;
  await grantByAffirmation(p, approvalId);
  const claim = await consumeApproval({
    db: p.db,
    principal: p.principal,
    approval_id: approvalId,
    tool: "run_workflow",
    surface: gateSurfaceFor(p.surface),
    via: "fast_path",
  });
  if (!claim.ok) {
    return replayError(p, {}, { error_code: claim.code, message: claim.message }, claim.message);
  }
  const replayArgs = claim.args;
  const slug = typeof replayArgs.workflow === "string" ? replayArgs.workflow : null;
  const resolved = slug
    ? await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, slug, { require_published: true })
    : null;
  const replayEnvironment = claim.execution_mode;
  if (!resolved?.current_version_id || !replayEnvironment) {
    const refusal = replayRefusal(Boolean(resolved?.current_version_id), slug);
    await recordApprovalUnfulfilled({
      db: p.db,
      principal: p.principal,
      claim,
      tool: "run_workflow",
      via: "fast_path",
      reason: refusal.reason,
    });
    return replayError(p, replayArgs, { error: refusal.reason }, refusal.reply);
  }
  const grant = await authorizeWorkflowRun(
    {
      principal: p.principal,
      workflow_id: resolved.id,
      workflow_slug: resolved.slug,
      via: "fast_path",
      tool: "run_workflow",
      approval: approvalAuditResource(claim),
    },
    { db: p.db },
  );
  if (grant.kind === "rejected") return denyRun(p, replayArgs, grant);
  const approvalRecorded = await recordApprovalApproved({
    db: p.db,
    principal: p.principal,
    claim,
    tool: "run_workflow",
    via: "fast_path",
  });
  if (!approvalRecorded) {
    return replayError(
      p,
      replayArgs,
      { error_code: "approval_audit_failed" },
      `The confirmation could not be recorded in the audit log; ${resolved.slug} was not run. Ask again to obtain a fresh confirmation.`,
    );
  }
  const hit = await runAndAnswer(p, resolved, replayArgs, grant, replayEnvironment);
  logger.info({
    module: "conversation",
    action: "conversation.fast_path",
    msg: "fast-path resumed run_workflow after confirmation",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    workflow_id: resolved.id,
  });
  return hit;
}
