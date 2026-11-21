import type { SpendReading } from "../llm/accounting/spend.ts";
import { spendAttention, spendChoiceDue } from "../llm/core/spend-budget.ts";
import type { Candidate } from "./attention-readers.ts";
import type { AttentionAction } from "./core/attention.ts";

export const SPEND_HREF = {
  raise: "/cockpit/settings?area=usage&spend=raise",
  continue: "/cockpit/settings?area=usage&spend=continue",
  usage: "/cockpit/settings?area=usage",
} as const;

export const SPEND_ADMIN_PERMISSION = "identity:write";

function usd(amount: number): string {
  return `${amount.toFixed(2)} USD`;
}

function choiceCandidate(id: string): Candidate {
  return {
    source: "budget",
    item: {
      id,
      class: "decide",
      severity: "notice",
      kind: "spend_limit_unset",
      subject: null,
      reason: "spend_limit_unset",
      trigger: null,
      cause_class: null,
      counts: {},
      since: null,
      deadline: null,
      detail: "This workspace has no monthly AI budget yet.",
      actions: [
        { verb: "open", href: SPEND_HREF.usage, primary: true, permission: SPEND_ADMIN_PERMISSION },
      ],
    },
  };
}

export function spendCandidates(reading: SpendReading): Candidate[] {
  const choice = spendChoiceDue(reading.chosen);
  const due = spendAttention(reading);
  const asked = choice ? [choiceCandidate(choice.id)] : [];
  if (!due || reading.limit_usd === null) return asked;
  const reached = due.kind === "reached";
  const actions: AttentionAction[] = reached
    ? [
        {
          verb: "open",
          href: SPEND_HREF.raise,
          primary: true,
          permission: SPEND_ADMIN_PERMISSION,
        },
        {
          verb: "open",
          href: SPEND_HREF.continue,
          primary: false,
          permission: SPEND_ADMIN_PERMISSION,
        },
      ]
    : [{ verb: "open", href: SPEND_HREF.usage, primary: true, permission: "stats:read" }];
  return [
    ...asked,
    {
      source: "budget",
      item: {
        id: due.id,
        class: reached ? "stopped" : "decide",
        severity: reached ? "critical" : "notice",
        kind: reached ? "spend_limit" : "spend_warning",
        subject: null,
        reason: reached ? "spend_limit_reached" : "spend_warning",
        trigger: null,
        cause_class: null,
        counts: {},
        since: null,
        deadline: null,
        detail: `${usd(reading.spent_usd)} of ${usd(reading.limit_usd)} spent this month.`,
        actions,
      },
    },
  ];
}
