// The confirm boundary is independent of transport and catalogue category.
// The resolver has already inspected the actual input and the operator's mode.
// A read-visible connector tool can still carry a dangerous request, and an MCP
// hint cannot substitute for a durable, matching human decision.

import type { ToolModeRule, ToolPolicyMode } from "../../tool-policies.ts";
import type { ToolCategory, ToolContext } from "../index.ts";

export interface DecideConfirmInput {
  resolvedMode: ToolPolicyMode;
  /** Server-verified, fresh approval matching the operation being executed. */
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
  // Autonomous preparation is resolved to no_confirm upstream. Post-execution
  // review, when explicitly configured, is handled downstream.
  if (input.resolvedMode !== "confirm_before_execution") {
    return { pause: false, reason: "mode_not_confirm_before_execution" };
  }
  if (input.priorApproval) {
    return { pause: false, reason: "prior_approval_present" };
  }
  return { pause: true, reason: "confirm_required" };
}
