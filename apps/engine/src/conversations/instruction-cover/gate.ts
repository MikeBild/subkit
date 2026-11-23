import { ownWords } from "@shared/own-words.ts";
import { sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationToolCalls } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import type { ToolModeRule } from "../../tools/types.ts";
import { contentHash, type RuleRefusal } from "../approval-rules/scope.ts";
import { findCoveringRule, markRuleUsed } from "../approval-rules/store.ts";
import { type BoundAction, COVERABLE_NATIVE_TOOLS, describeBoundAction } from "./bound-action.ts";
import { checkContent, collectContent, fullContent } from "./content.ts";
import type { CoverRefusal } from "./decide.ts";
import {
  connectorTemplateSlug,
  loadCoverEvidence,
  loadJobSignatures,
  loadTaskRunFacts,
} from "./evidence.ts";
import { groundArguments, NO_EVIDENCE } from "./grounding.ts";
import {
  chatJob,
  chatRequest,
  decideJobStep,
  type JobAskReason,
  type JobRefusal,
  type JobRequest,
  type JobState,
  taskJob,
  taskRequest,
} from "./job.ts";
import { interactivePersonRefusal } from "./session.ts";
import { type SpokenFacts, spokenFacts } from "./spoken.ts";

export interface BoundActionView {
  readonly verb: string;
  readonly effect_class: string;
  readonly target: string | null;
  readonly account: string | null;
  readonly recipients: readonly string[];
  readonly content_summary: string | null;
  readonly content: string | null;
}

export type AskReason =
  | CoverRefusal
  | JobAskReason
  | JobRefusal
  | RuleRefusal
  | "ask_before_writing"
  | "no_person"
  | "write_gate"
  | "no_browser_session";

export interface PolicyRecord {
  readonly ran_without_asking: boolean;
  readonly rule: "user_instruction" | "standing_rule" | null;
  readonly bound_action: BoundActionView;
  readonly because: { readonly quote: string; readonly message_id: string | null } | null;
  readonly rule_id: string | null;
  readonly rule_quote?: string | null;
  readonly ask_reason: AskReason | null;
  readonly ask_detail?: string | null;
  readonly message_id?: string | null;
  readonly signature?: string;
  readonly job_id?: string;
}

export interface PersonCover {
  readonly instruction_covered: boolean;
  readonly rule_covered: boolean;
  readonly record: PolicyRecord | null;
  readonly covered_digest?: string;
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
  readonly ask_before_writing: boolean;
  readonly task_run: boolean;
  readonly task_run_id?: string | null;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly because: string | null;
  readonly now: Date;
}

export interface CoverJob {
  readonly request: JobRequest;
  readonly job: JobState;
  readonly facts: SpokenFacts;
  readonly message_id: string | null;
}

export async function chatCoverJob(input: PersonCoverInput): Promise<CoverJob> {
  const { now } = input;
  const evidence = await loadCoverEvidence(input.db, input.tenant_id, input.conversation_id);
  return {
    request: chatRequest(evidence.segments, evidence.shown, evidence.timezone),
    job: chatJob({
      anchor_id: evidence.anchor?.id ?? input.conversation_id,
      anchor_at: evidence.anchor?.at ?? now,
      outputs: evidence.outputs,
      used_signatures: evidence.used_signatures,
    }),
    facts: spokenFacts(
      evidence.segments.map((segment) =>
        segment.kind === "message" ? ownWords(segment.text) : segment.text,
      ),
      now,
      evidence.timezone,
    ),
    message_id: evidence.anchor?.id ?? null,
  };
}

export async function taskCoverJob(
  input: PersonCoverInput,
  principal: ResolvedPrincipal,
): Promise<CoverJob | null> {
  const task_run_id = input.task_run_id ?? null;
  if (!task_run_id) return null;
  const source = principal.auth_source;
  if (source?.kind !== "task_run" || source.task_run_id !== task_run_id) return null;
  const task = await loadTaskRunFacts(input.db, input.tenant_id, task_run_id);
  if (!task || task.owner_id !== principal.id) return null;
  const evidence = await loadCoverEvidence(input.db, input.tenant_id, input.conversation_id);
  const request = taskRequest(task, evidence.timezone);
  return {
    request,
    job: taskJob(task, {
      outputs: evidence.outputs,
      used_signatures: await loadJobSignatures(
        input.db,
        input.tenant_id,
        input.conversation_id,
        task_run_id,
      ),
    }),
    facts: spokenFacts(
      request.segments.map((segment) => segment.text),
      input.now,
      evidence.timezone,
    ),
    message_id: null,
  };
}

export async function resolvePersonCover(input: PersonCoverInput): Promise<PersonCover> {
  const { ask_before_writing, principal, tool, args } = input;
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
  const session = input.task_run
    ? null
    : interactivePersonRefusal({ principal, surface: input.surface, task_run: false });
  if (session !== null || principal === null) {
    return asking(
      session === "task_run" || session === "no_person" || principal === null
        ? "no_person"
        : "no_browser_session",
    );
  }
  try {
    const covering = input.task_run
      ? await taskCoverJob(input, principal)
      : await chatCoverJob(input);
    if (!covering) return asking("write_gate");
    const { request, job } = covering;
    const template = await connectorTemplateSlug(input.db, input.tenant_id, args);
    const hints = { template };
    const fields = collectContent(tool, args);
    const match = request.by_person
      ? await findCoveringRule(
          input.db,
          { tenant_id: input.tenant_id, user_id: principal.id },
          describeBoundAction(tool, args, card.recipients, hints),
          {
            hash: contentHash(fields),
            given: fields.length > 0 && checkContent(fields, covering.facts, request.shown).ok,
          },
          input.now,
        )
      : { rule: null, refusal: null };
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
          ...(match.rule.source_quote ? { rule_quote: match.rule.source_quote } : {}),
          ask_reason: null,
          message_id: covering.message_id,
          job_id: job.id,
        },
      };
    }
    if (ask_before_writing) return asking(match.refusal ?? "ask_before_writing");
    const decision = decideJobStep(
      request,
      job,
      { kind: "tool", job_id: job.id, tool, args, quote: input.because, hints },
      input.now,
    );
    if (decision.decision !== "covered") {
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
        bound_action: decision.action ? boundActionView(decision.action, args) : card,
        because: decision.because,
        rule_id: null,
        ask_reason: null,
        message_id: decision.because?.message_id ?? covering.message_id,
        ...(decision.signature ? { signature: decision.signature } : {}),
        job_id: job.id,
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
        ask_reason: planned.ask_reason ?? "write_gate",
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
        ...(record.rule_quote ? { rule_quote: record.rule_quote } : {}),
        ...(record.job_id ? { job_id: record.job_id } : {}),
      },
    },
    p.db,
  );
  return record;
}
