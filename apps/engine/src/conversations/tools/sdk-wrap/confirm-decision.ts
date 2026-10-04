import type { ToolModeRule, ToolPolicyMode } from "../../tool-policies.ts";
import type { ToolCategory, ToolContext } from "../index.ts";

export interface DecideConfirmInput {
  resolvedMode: ToolPolicyMode;
  priorApproval: boolean;
  category: ToolCategory;
  tool: string;
  surface?: ToolContext["surface"];
  resolverRule?: ToolModeRule;
}

export interface ConfirmDecision {
  pause: boolean;
  reason: "mode_not_confirm_before_execution" | "prior_approval_present" | "confirm_required";
}

export function decideConfirm(input: DecideConfirmInput): ConfirmDecision {
  if (input.resolvedMode !== "confirm_before_execution") {
    return { pause: false, reason: "mode_not_confirm_before_execution" };
  }
  if (input.priorApproval) {
    return { pause: false, reason: "prior_approval_present" };
  }
  return { pause: true, reason: "confirm_required" };
}
