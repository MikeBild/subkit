import { sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationToolCalls } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { AnswerActor } from "../answer-actor.ts";
import { describeBoundAction } from "../instruction-cover/bound-action.ts";
import { collectContent } from "../instruction-cover/content.ts";
import { connectorTemplateSlug } from "../instruction-cover/evidence.ts";
import { describeForCard, isCoverCandidate } from "../instruction-cover/gate.ts";
import { contentHash, scopeOf } from "./scope.ts";
import { noteApprovedAction } from "./store.ts";

export async function noteApprovalForRuleOffer(p: {
  readonly db: Db;
  readonly tenant_id: string;
  readonly approver: ResolvedPrincipal;
  readonly answer_actor: AnswerActor;
  readonly unattended: boolean;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly tool_call_id: string | null;
}): Promise<void> {
  if (p.unattended || p.approver.kind !== "user" || p.answer_actor.kind !== "human") return;
  if (p.answer_actor.user_id !== p.approver.id || !isCoverCandidate(p.tool)) return;
  try {
    const card = describeForCard(p.tool, p.args);
    const action = describeBoundAction(p.tool, p.args, card.recipients, {
      template: await connectorTemplateSlug(p.db, p.tenant_id, p.args),
    });
    const noted = await noteApprovedAction(
      p.db,
      { tenant_id: p.tenant_id, user_id: p.approver.id },
      action,
      contentHash(collectContent(p.tool, p.args)),
    );
    if (!noted?.offered || !p.tool_call_id) return;
    const offer = { rule_id: noted.rule_id, ...scopeOf(action) };
    await p.db
      .update(conversationToolCalls)
      .set({
        confirmation_data: sql`COALESCE(${conversationToolCalls.confirmation_data}, '{}'::jsonb) || ${JSON.stringify(
          { rule_offer: offer },
        )}::jsonb`,
      })
      .where(
        sql`${conversationToolCalls.id} = ${p.tool_call_id} AND ${conversationToolCalls.tenant_id} = ${p.tenant_id}`,
      );
  } catch (error) {
    logger.warn({
      module: "conversation_tool",
      action: "approval_rule.offer_failed",
      msg: "could not note an approval for a later rule offer; the approval itself is unaffected",
      tenant_id: p.tenant_id,
      tool: p.tool,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
