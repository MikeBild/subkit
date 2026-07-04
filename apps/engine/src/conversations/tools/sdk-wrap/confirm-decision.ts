// The ONE confirm-gate decision. Pure, deterministic, no I/O.
//
// Three surfaces used to each hand-roll their own "does this tool call
// need a human confirm before it runs?" logic, and they drifted:
//
//   - the conversation loop gate (`tools/sdk-wrap/invoke.ts`)
//   - the MCP-direct tenant gate (`mcp/capabilities/policy-gate.ts`)
//   - the save-workflow prior-approval backstop (`persistence/commit-workflow.ts`)
//
// Drift between them is a SECURITY bug: a write that pauses on one
// surface but slips through on another. This function is the single
// deterministic rule all pre-execution gates evaluate, keyed only on
// DURABLE state the caller already resolved:
//
//   - `resolvedMode`  — the resolved `ToolPolicyMode` from `resolveToolMode`.
//   - `policyMarker`  — the operator-confirmation marker is present
//                       (`__policy_confirmed` in the args, or
//                       `_meta.sk_confirm` on the MCP transport).
//   - `priorApproval` — a durable, matching operator approval exists
//                       (for the save path, `findPriorSaveWorkflowApproval`
//                       within the freshness window; the single source of
//                       truth shared with the commit-workflow backstop).
//   - `category`      — the tool's registry category.
//
// Rule (bias to PAUSE on any ambiguity — a write must never slip
// through unconfirmed):
//   - tenant_read                              → never pause (reads auto-run).
//   - mode ≠ confirm_before_execution          → never pause (policy says so).
//   - policyMarker present                     → proceed (operator confirmed).
//   - fresh matching priorApproval present     → proceed (durable approval).
//   - otherwise                                → PAUSE.

import type { ToolPolicyMode } from "../../tool-policies.ts";
import type { ToolCategory } from "../index.ts";

export interface DecideConfirmInput {
  /** Resolved execution mode from `resolveToolMode`. */
  resolvedMode: ToolPolicyMode;
  /**
   * The operator-confirmation marker is present on this call:
   * `__policy_confirmed: true` in the args (both surfaces) or
   * `_meta.sk_confirm: true` on the MCP transport.
   */
  policyMarker: boolean;
  /**
   * A durable, matching operator approval already exists — for the save
   * path this is `findPriorSaveWorkflowApproval` within the freshness
   * window, the SAME predicate `commitWorkflowAtomic` authorizes on, so
   * the pre-confirm gate and the commit backstop can never disagree.
   */
  priorApproval: boolean;
  /** The tool's registry category. */
  category: ToolCategory;
}

export interface ConfirmDecision {
  /** True → hold the write and raise a confirmation; false → let it run. */
  pause: boolean;
  /** Machine-readable reason, emitted into the forensic gate log. */
  reason: string;
}

/**
 * The single deterministic pre-execution confirm decision. See the file
 * header for the rule. Deliberately biased to PAUSE: every branch that
 * proceeds is an explicit, durable authorization; the fall-through
 * pauses.
 */
export function decideConfirm(input: DecideConfirmInput): ConfirmDecision {
  // Reads are idempotent and carry no side effect — they auto-run on
  // every surface regardless of resolved mode.
  if (input.category === "tenant_read") {
    return { pause: false, reason: "tenant_read_autoruns" };
  }
  // Only `confirm_before_execution` gates a write BEFORE it runs. Other
  // modes (`no_confirm`, `confirm_after_execution`) never pre-pause —
  // post-execution review is handled downstream, after the tool ran.
  if (input.resolvedMode !== "confirm_before_execution") {
    return { pause: false, reason: "mode_not_confirm_before_execution" };
  }
  // Operator already confirmed this exact call (marker re-issued by the
  // client / model after a resolved confirm, or set on the MCP transport).
  if (input.policyMarker) {
    return { pause: false, reason: "policy_marker_present" };
  }
  // A durable, fresh, matching approval exists — the commit backstop
  // would accept it, so a pre-confirm here would be redundant.
  if (input.priorApproval) {
    return { pause: false, reason: "prior_approval_present" };
  }
  // No marker, no durable approval, and the policy demands confirmation:
  // PAUSE. This is the security-critical fall-through — never proceed here.
  return { pause: true, reason: "confirm_required" };
}
