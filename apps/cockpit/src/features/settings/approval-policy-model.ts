import type { ApprovalPolicy, WorkflowApprovals } from "@/api/approval-policy";
import { needsTwoApprovers } from "@/features/operations";
import type { TranslationKey } from "@/lib/i18n";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const POLICY_PERMISSION = "rbac:write";

export interface PolicyView {
  on: boolean;
  disabled: boolean;
  hint: string;
}

export function policyView(
  policy: Pick<ApprovalPolicy, "workflow_approvals" | "eligible_approvers">,
  permissions: readonly string[],
  busy: boolean,
  t: Translate,
): PolicyView {
  const on = policy.workflow_approvals === "pair";
  return {
    on,
    disabled: busy || !permissions.includes(POLICY_PERMISSION),
    hint: t(on ? "approvalPolicy.on" : "approvalPolicy.off", {
      count: policy.eligible_approvers,
    }),
  };
}

export function nextPolicy(on: boolean): WorkflowApprovals {
  return on ? "pair" : "single";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function policyErrorRows(error: unknown, t: Translate): [string, string][] {
  if (!needsTwoApprovers(error)) return [];
  const details = record(record(error).details);
  const eligible = details.eligible_approvers ?? details.eligible;
  return [
    [t("approvalPolicy.eligible"), typeof eligible === "number" ? String(eligible) : "–"],
    [t("approvalPolicy.needed"), "2"],
  ];
}
