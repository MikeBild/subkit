import type { StripAction, StripKind } from "@shared/workflow-strip.ts";
import type { TranslationKey } from "@/lib/i18n";

export * from "@shared/workflow-strip.ts";

export const STRIP_STATE_KEYS: Record<StripKind, TranslationKey> = {
  loading: "workflowStrip.state.loading",
  failed: "workflowStrip.state.failed",
  invalid: "automation.state.invalid",
  disabled: "workflowStrip.state.disabled",
  empty: "workflowStrip.state.empty",
  paused: "workflowStrip.state.paused",
  stopped: "workflowStrip.state.stopped",
  repair: "automation.state.repair",
  unapproved: "workflowStrip.state.unapproved",
  apply: "workflowStrip.state.grant",
  grant: "workflowStrip.state.grant",
  unknown: "automation.state.unknown",
  connector: "workflowStrip.state.connector",
  failing: "workflowStrip.state.failing",
  expiring: "workflowStrip.state.expiring",
  repairPrepared: "workflowStrip.state.repairPrepared",
  approved: "workflowStrip.state.running",
  manual: "workflowStrip.state.running",
};

export function stripActionKey(action: StripAction): TranslationKey {
  switch (action.kind) {
    case "retry":
      return "pattern.retry";
    case "chat":
      return "remedy.chat";
    case "enable":
      return "workflowStrip.action.enable";
    case "resume":
      return "automation.action.resume";
    case "approve":
      if (action.via === "limits") return "authorityProposals.action.open";
      return action.via === "extend" ? "workflowStrip.action.extend" : "workflowStrip.action.grant";
    case "recheck":
      return "automation.action.recheck";
    case "connector":
      return "workflowStrip.action.connector";
    case "cause":
      return "workflowStrip.action.cause";
    case "review":
      return "remedy.reviewRepair";
    case "addStep":
      return "workflowStrip.action.addStep";
  }
}
