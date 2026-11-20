import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Executor } from "../../db/client.ts";
import {
  type ToolApprovalRuleRow,
  type ToolApprovalRuleState,
  toolApprovalRules,
} from "../../db/schema/index.ts";
import type { BoundAction } from "../instruction-cover/bound-action.ts";
import {
  type RuleContent,
  type RuleRefusal,
  ruleEligible,
  ruleExpiry,
  ruleRefusal,
  scopeCovers,
  scopeHash,
  scopeOf,
  usageDay,
} from "./scope.ts";

export const OFFER_AFTER_APPROVALS = 2;
const MAX_ACTIVE_RULES_READ = 200;

export interface RuleOwner {
  readonly tenant_id: string;
  readonly user_id: string;
}

export interface NotedApproval {
  readonly rule_id: string;
  readonly offered: boolean;
  readonly state: ToolApprovalRuleState;
}

export async function noteApprovedAction(
  db: Executor,
  owner: RuleOwner,
  action: BoundAction,
  content_hash: string | null = null,
): Promise<NotedApproval | null> {
  if (!ruleEligible(action)) return null;
  const scope = scopeOf(action);
  const hash = scopeHash(scope);
  const [row] = await db
    .insert(toolApprovalRules)
    .values({
      tenant_id: owner.tenant_id,
      user_id: owner.user_id,
      tool: action.tool,
      scope_hash: hash,
      scope,
      content_class: content_hash === null ? "no_content" : "same_content",
      content_hash,
    })
    .onConflictDoUpdate({
      target: [
        toolApprovalRules.tenant_id,
        toolApprovalRules.user_id,
        toolApprovalRules.scope_hash,
      ],
      set: {
        approvals_count: sql`${toolApprovalRules.approvals_count} + 1`,
        content_class: sql`CASE WHEN ${toolApprovalRules.state} = 'observed' AND ${toolApprovalRules.content_hash} IS DISTINCT FROM ${content_hash} THEN 'person_given' ELSE ${toolApprovalRules.content_class} END`,
        updated_at: sql`now()`,
      },
    })
    .returning();
  if (!row) return null;
  if (row.state !== "observed" || row.approvals_count < OFFER_AFTER_APPROVALS) {
    return { rule_id: row.id, offered: false, state: row.state };
  }
  const offered = await db
    .update(toolApprovalRules)
    .set({ state: "offered", offered_at: sql`now()`, updated_at: sql`now()` })
    .where(
      and(
        eq(toolApprovalRules.id, row.id),
        eq(toolApprovalRules.tenant_id, owner.tenant_id),
        eq(toolApprovalRules.state, "observed"),
      ),
    )
    .returning({ id: toolApprovalRules.id });
  return offered.length > 0
    ? { rule_id: row.id, offered: true, state: "offered" }
    : { rule_id: row.id, offered: false, state: row.state };
}

export type RuleMatch =
  | { readonly rule: ToolApprovalRuleRow; readonly refusal: null }
  | { readonly rule: null; readonly refusal: RuleRefusal | null };

export async function findCoveringRule(
  db: Executor,
  owner: RuleOwner,
  action: BoundAction,
  content: RuleContent = { hash: null, given: false },
  now: Date = new Date(),
): Promise<RuleMatch> {
  if (!ruleEligible(action)) return { rule: null, refusal: null };
  const rows = await db
    .select()
    .from(toolApprovalRules)
    .where(
      and(
        eq(toolApprovalRules.tenant_id, owner.tenant_id),
        eq(toolApprovalRules.user_id, owner.user_id),
        eq(toolApprovalRules.tool, action.tool),
        eq(toolApprovalRules.state, "active"),
      ),
    )
    .limit(MAX_ACTIVE_RULES_READ);
  let refusal: RuleRefusal | null = null;
  for (const row of rows) {
    if (!scopeCovers(row.scope, action)) continue;
    const refused = ruleRefusal(row, content, now);
    if (refused === null) return { rule: row, refusal: null };
    refusal ??= refused;
  }
  return { rule: null, refusal };
}

export async function markRuleUsed(
  db: Executor,
  tenant_id: string,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  const day = usageDay(now);
  const today = sql`CASE WHEN ${toolApprovalRules.uses_day} = ${day}::date THEN ${toolApprovalRules.uses_on_day} ELSE 0 END`;
  const claimed = await db
    .update(toolApprovalRules)
    .set({
      use_count: sql`${toolApprovalRules.use_count} + 1`,
      uses_on_day: sql`${today} + 1`,
      uses_day: day,
      last_used_at: now,
    })
    .where(
      and(
        eq(toolApprovalRules.id, id),
        eq(toolApprovalRules.tenant_id, tenant_id),
        eq(toolApprovalRules.state, "active"),
        sql`${toolApprovalRules.expires_at} > ${now.toISOString()}::timestamptz`,
        sql`${today} < ${toolApprovalRules.daily_limit}`,
      ),
    )
    .returning({ id: toolApprovalRules.id });
  return claimed.length > 0;
}

export async function listRules(
  db: Executor,
  owner: RuleOwner,
  states: readonly ToolApprovalRuleState[] = ["offered", "active"],
): Promise<ToolApprovalRuleRow[]> {
  return db
    .select()
    .from(toolApprovalRules)
    .where(
      and(
        eq(toolApprovalRules.tenant_id, owner.tenant_id),
        eq(toolApprovalRules.user_id, owner.user_id),
        inArray(toolApprovalRules.state, [...states]),
      ),
    )
    .orderBy(desc(toolApprovalRules.updated_at))
    .limit(500);
}

export async function getRule(
  db: Executor,
  owner: RuleOwner,
  id: string,
): Promise<ToolApprovalRuleRow | null> {
  const [row] = await db
    .select()
    .from(toolApprovalRules)
    .where(
      and(
        eq(toolApprovalRules.id, id),
        eq(toolApprovalRules.tenant_id, owner.tenant_id),
        eq(toolApprovalRules.user_id, owner.user_id),
      ),
    )
    .limit(1);
  return row ?? null;
}

const TRANSITIONS = {
  accept: {
    from: "offered",
    to: "active",
    action: AuditAction.TOOL_APPROVAL_RULE_CREATED,
  },
  dismiss: {
    from: "offered",
    to: "dismissed",
    action: AuditAction.TOOL_APPROVAL_RULE_DISMISSED,
  },
  revoke: {
    from: "active",
    to: "revoked",
    action: AuditAction.TOOL_APPROVAL_RULE_REVOKED,
  },
  renew: {
    from: "active",
    to: "active",
    action: AuditAction.TOOL_APPROVAL_RULE_RENEWED,
  },
} as const;

export type RuleDecision = keyof typeof TRANSITIONS;

export type RuleTransitionResult =
  | { ok: true; rule: ToolApprovalRuleRow }
  | { ok: false; code: "not_found" | "wrong_state"; state?: ToolApprovalRuleState };

export async function decideRule(
  db: Executor,
  owner: RuleOwner,
  id: string,
  decision: RuleDecision,
  now: Date = new Date(),
): Promise<RuleTransitionResult> {
  const transition = TRANSITIONS[decision];
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(toolApprovalRules)
      .where(
        and(
          eq(toolApprovalRules.id, id),
          eq(toolApprovalRules.tenant_id, owner.tenant_id),
          eq(toolApprovalRules.user_id, owner.user_id),
        ),
      )
      .for("update")
      .limit(1);
    if (!before) return { ok: false as const, code: "not_found" as const };
    if (before.state !== transition.from) {
      return { ok: false as const, code: "wrong_state" as const, state: before.state };
    }
    const [rule] = await tx
      .update(toolApprovalRules)
      .set({
        state: transition.to,
        decided_at: decision === "revoke" || decision === "renew" ? before.decided_at : now,
        ...(decision === "revoke" ? { revoked_at: now } : {}),
        ...(decision === "accept" || decision === "renew" ? { expires_at: ruleExpiry(now) } : {}),
        updated_at: sql`now()`,
      })
      .where(and(eq(toolApprovalRules.id, id), eq(toolApprovalRules.tenant_id, owner.tenant_id)))
      .returning();
    if (!rule) return { ok: false as const, code: "not_found" as const };
    await auditAwait(
      {
        tenant_id: owner.tenant_id,
        actor_type: "user",
        actor_id: owner.user_id,
        action: transition.action,
        resource_type: "tool_approval_rule",
        resource_id: rule.id,
        result: "success",
        before: { state: before.state },
        after: { state: rule.state },
        metadata: {
          tool: rule.tool,
          verb: rule.scope.verb,
          target: rule.scope.target,
          account: rule.scope.account,
          recipient_count: rule.scope.recipients.length,
          approvals_count: rule.approvals_count,
          content_class: rule.content_class,
          daily_limit: rule.daily_limit,
          expires_at: rule.expires_at ? rule.expires_at.toISOString() : null,
        },
      },
      tx,
    );
    return { ok: true as const, rule };
  });
}
