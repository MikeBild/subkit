import type { TranslationKey } from "@/lib/i18n";

export interface WorkflowStarters {
  webhook: boolean;
  schedule: boolean;
}

export function removalConsequenceKeys(
  removal: "delete" | "disable",
  starters: WorkflowStarters,
): TranslationKey[] {
  if (removal === "disable")
    return [
      "workflowPage.disableConsequence.base",
      ...(starters.webhook ? (["workflowPage.disableConsequence.webhook"] as const) : []),
      ...(starters.schedule ? (["workflowPage.disableConsequence.schedule"] as const) : []),
    ];
  return [
    ...(starters.webhook ? (["workflowPage.deleteConsequence.webhook"] as const) : []),
    ...(starters.schedule ? (["workflowPage.deleteConsequence.schedule"] as const) : []),
    "workflowPage.deleteConsequence.base",
  ];
}
