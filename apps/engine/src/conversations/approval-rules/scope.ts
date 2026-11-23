import { createHash } from "node:crypto";
import type { ToolApprovalContentClass, ToolApprovalRuleScope } from "../../db/schema/index.ts";
import type { BoundAction } from "../instruction-cover/bound-action.ts";
import { normalizeForQuote } from "../instruction-cover/normalize.ts";
import { ruleEligible } from "./core/rule-scope.ts";

export const RULE_LIFETIME_DAYS = 90;
export const RULE_DAILY_LIMIT = 20;

export function scopeHash(scope: ToolApprovalRuleScope): string {
  return createHash("sha256")
    .update(JSON.stringify([scope.tool, scope.verb, scope.account, scope.target, scope.recipients]))
    .digest("hex");
}

export function contentHash(fields: readonly string[]): string | null {
  const normalized = fields.map((field) => normalizeForQuote(field)).filter((f) => f.length > 0);
  if (normalized.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function scopeCovers(rule: ToolApprovalRuleScope, action: BoundAction): boolean {
  if (!ruleEligible(action)) return false;
  if (rule.tool !== action.tool || rule.verb !== action.verb) return false;
  if (rule.account !== action.account || rule.target !== action.target) return false;
  if (rule.recipients.length === 0) return action.recipients.length === 0;
  if (action.recipients.length === 0) return false;
  const allowed = new Set(rule.recipients);
  return action.recipients.every((recipient) => allowed.has(recipient));
}

export interface RuleLimits {
  readonly content_class: ToolApprovalContentClass;
  readonly content_hash: string | null;
  readonly expires_at: Date | null;
  readonly daily_limit: number;
  readonly uses_day: string | null;
  readonly uses_on_day: number;
}

export interface RuleContent {
  readonly hash: string | null;
  readonly given: boolean;
}

export type RuleRefusal = "rule_expired" | "rule_daily_limit" | "rule_content";

export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function usesToday(rule: Pick<RuleLimits, "uses_day" | "uses_on_day">, now: Date): number {
  return rule.uses_day === usageDay(now) ? rule.uses_on_day : 0;
}

export function ruleExpiry(from: Date): Date {
  return new Date(from.getTime() + RULE_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
}

export function ruleRefusal(rule: RuleLimits, content: RuleContent, now: Date): RuleRefusal | null {
  if (rule.expires_at === null || rule.expires_at.getTime() <= now.getTime()) return "rule_expired";
  if (usesToday(rule, now) >= rule.daily_limit) return "rule_daily_limit";
  if (content.hash === null) return null;
  if (rule.content_class === "no_content") return "rule_content";
  if (rule.content_class === "same_content") {
    return rule.content_hash === content.hash ? null : "rule_content";
  }
  return content.given ? null : "rule_content";
}
