import type { BoundAction } from "../../instruction-cover/bound-action.ts";
import { isNeverCovered } from "../../instruction-cover/core/never-covered.ts";

export const MAX_RULE_RECIPIENTS = 20;

export interface RuleScope {
  tool: string;
  target: string | null;
  account: string | null;
  recipients: string[];
  verb: string;
}

export function ruleEligible(action: BoundAction): boolean {
  return (
    !isNeverCovered(action) &&
    action.target !== null &&
    action.recipients.length <= MAX_RULE_RECIPIENTS
  );
}

export function scopeOf(action: BoundAction): RuleScope {
  return {
    tool: action.tool,
    verb: action.verb,
    account: action.account,
    target: action.target,
    recipients: [...new Set(action.recipients)].sort(),
  };
}
