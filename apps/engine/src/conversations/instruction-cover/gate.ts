import { sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationToolCalls } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { PermissionMode, ToolModeRule } from "../../tools/types.ts";
import { contentHash, type RuleRefusal } from "../approval-rules/scope.ts";
import { findCoveringRule, markRuleUsed } from "../approval-rules/store.ts";
import { type BoundAction, COVERABLE_NATIVE_TOOLS, describeBoundAction } from "./bound-action.ts";
import { checkContent, collectContent, fullContent } from "./content.ts";
import { type CoverRefusal, decideInstructionCover } from "./decide.ts";
import { connectorTemplateSlug, loadCoverEvidence } from "./evidence.ts";
import { groundArguments, NO_EVIDENCE } from "./grounding.ts";
import { ownWords } from "./own-words.ts";
import { interactivePersonRefusal } from "./session.ts";
import { spokenFacts } from "./spoken.ts";

export interface BoundActionView {
  readonly verb: string;
  readonly effect_class: string;
  readonly target: string | null;
  readonly account: string | null;
  readonly recipients: readonly string[];
  readonly content_summary: string | null;
  readonly content: string | null;
}

export type AskReason = CoverRefusal | RuleRefusal | "mode" | "no_browser_session";

export interface PolicyRecord {
  readonly ran_without_asking: boolean;
  readonly rule: "user_instruction" | "standing_rule" | null;
  readonly bound_action: BoundActionView;
  readonly because: { readonly quote: string; readonly message_id: string | null } | null;
  readonly rule_id: string | null;
  readonly ask_reason: AskReason | null;
  readonly ask_detail?: string | null;
  readonly message_id?: string | null;
  readonly signature?: string;
}

export interface PersonCover {
  readonly instruction_covered: boolean;
  readonly rule_covered: boolean;
  readonly record: PolicyRecord | null;
}

export const NO_PERSON_COVER: PersonCover = {
  instruction_covered: false,
  rule_covered: false,
  record: null,
};

export function isCoverCandidate(tool: string): boolean {
  return tool === "call_connector" || COVERABLE_NATIVE_TOOLS.has(tool);
}

export function boundActionView(
  action: BoundAction,
  args: Record<string, unknown> = {},
): BoundActionView {
  return {
    content: fullContent(collectContent(action.tool, args)),
    verb: action.verb,
    effect_class: action.effect_class,
    target: action.target,
    account: action.account,
    recipients: action.recipients,
    content_summary: action.content_summary,
  };
}

export function describeForCard(tool: string, args: Record<string, unknown>): BoundActionView {
  const facts = spokenFacts([], new Date(0), "UTC");
  const grounded = groundArguments(tool, args, {
    window: facts,
    addressees: facts,
    evidence: NO_EVIDENCE,
    now: new Date(0),
    timezone: "UTC",
  });
  return boundActionView(describeBoundAction(tool, args, grounded.recipients), args);
}

export interface PersonCoverInput {
  readonly db: Db;
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly principal: ResolvedPrincipal | null;
  readonly surface: string | null | undefined;
  readonly permission_mode: PermissionMode | null;
  readonly task_run: boolean;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly because: string | null;
  readonly now?: Date;
}

export async function resolvePersonCover(input: PersonCoverInput): Promise<PersonCover> {
  const { permission_mode, principal, tool, args } = input;
  if (!isCoverCandidate(tool)) return NO_PERSON_COVER;
  const card = describeForCard(tool, args);
  const asking = (
    ask_reason: PolicyRecord["ask_reason"],
    ask_detail: string | null = null,
  ): PersonCover => ({
    instruction_covered: false,
    rule_covered: false,
    record: {
      ran_without_asking: false,
      rule: null,
      bound_action: card,
      because: null,
      rule_id: null,
      ask_reason,
      ask_detail,
    },
  });
  if (permission_mode !== "auto" && permission_mode !== "ask") return asking("mode");
  const session = interactivePersonRefusal({
    principal,
    surface: input.surface,
    task_run: input.task_run,
  });
  if (session !== null || principal === null) {
    return asking(
      session === "task_run" || session === "no_person" ? "mode" : "no_browser_session",
    );
  }
  try {
    const now = input.now ?? new Date();
    const template = await connectorTemplateSlug(input.db, input.tenant_id, args);
    const hints = { template };
    const evidence = await loadCoverEvidence(input.db, input.tenant_id, input.conversation_id);
    const latest = evidence.segments.findLast((segment) => segment.kind === "message") ?? null;
    const fields = collectContent(tool, args);
    const facts = spokenFacts(
      evidence.segments.map((segment) =>
        segment.kind === "message" ? ownWords(segment.text) : segment.text,
      ),
      now,
      evidence.timezone,
    );
    const match = await findCoveringRule(
      input.db,
      { tenant_id: input.tenant_id, user_id: principal.id },
      describeBoundAction(tool, args, card.recipients, hints),
      {
        hash: contentHash(fields),
        given: fields.length > 0 && checkContent(fields, facts, evidence.shown).ok,
      },
      now,
    );
    if (match.rule) {
      return {
        instruction_covered: false,
        rule_covered: true,
        record: {
          ran_without_asking: true,
          rule: "standing_rule",
          bound_action: card,
          because: null,
          rule_id: match.rule.id,
          ask_reason: null,
          message_id: latest?.id ?? null,
        },
      };
    }
    if (permission_mode !== "auto") return asking(match.refusal ?? "mode");
    const decision = decideInstructionCover({
      tool,
      args,
      quote: input.because,
      segments: evidence.segments,
      outputs: evidence.outputs,
      shown: evidence.shown,
      hints,
      used_signatures: evidence.used_signatures,
      now,
      timezone: evidence.timezone,
    });
    if (!decision.covered) {
      return decision.reason === "no_quote" && match.refusal
        ? asking(match.refusal)
        : asking(decision.reason, decision.detail ?? null);
    }
    return {
      instruction_covered: true,
      rule_covered: false,
      record: {
        ran_without_asking: true,
        rule: "user_instruction",
        bound_action: boundActionView(decision.action, args),
        because: decision.because,
        rule_id: null,
        ask_reason: null,
        message_id: decision.because.message_id,
        signature: decision.signature,
      },
    };
  } catch (error) {
    logger.warn({
      module: "conversation_tool",
      action: "person_cover.unresolved",
      msg: "could not establish whether the person's words or a rule cover the action; the question stays",
      tenant_id: input.tenant_id,
      conversation_id: input.conversation_id,
      tool,
      error: error instanceof Error ? error.message : String(error),
    });
    return asking("undecidable");
  }
}

export async function recordPersonCover(p: {
  readonly db: Db;
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly tool_call_id: string;
  readonly tool: string;
  readonly actor_id: string | null;
  readonly cover: PersonCover;
  readonly resolved_rule: ToolModeRule | "held_writes";
  readonly proceeded: boolean;
}): Promise<PolicyRecord | null> {
  const planned = p.cover.record;
  if (!planned) return null;
  const ran =
    p.proceeded &&
    planned.rule !== null &&
    p.resolved_rule === planned.rule &&
    planned.ran_without_asking;
  const record: PolicyRecord = ran
    ? planned
    : {
        ran_without_asking: false,
        rule: null,
        bound_action: planned.bound_action,
        because: null,
        rule_id: null,
        ask_reason: planned.ask_reason ?? "mode",
      };
  await p.db
    .update(conversationToolCalls)
    .set({
      confirmation_data: sql`COALESCE(${conversationToolCalls.confirmation_data}, '{}'::jsonb) || ${JSON.stringify(
        { policy: record },
      )}::jsonb`,
    })
    .where(
      sql`${conversationToolCalls.id} = ${p.tool_call_id} AND ${conversationToolCalls.tenant_id} = ${p.tenant_id}`,
    );
  if (!ran || record.rule === null) return record;
  if (record.rule_id && !(await markRuleUsed(p.db, p.tenant_id, record.rule_id))) {
    throw new Error("the approval rule expired or reached its daily limit");
  }
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "user",
      actor_id: p.actor_id,
      action: AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      reason: record.rule,
      metadata: {
        tool: p.tool,
        conversation_id: p.conversation_id,
        tool_call_id: p.tool_call_id,
        resolver_reason: record.rule,
        verb: record.bound_action.verb,
        effect_class: record.bound_action.effect_class,
        target: record.bound_action.target,
        account: record.bound_action.account,
        recipients: record.bound_action.recipients,
        content_summary: record.bound_action.content_summary,
        message_id: record.because?.message_id ?? record.message_id ?? null,
        ...(record.because ? { because: record.because.quote } : {}),
        ...(record.rule_id ? { rule_id: record.rule_id } : {}),
      },
    },
    p.db,
  );
  return record;
}
