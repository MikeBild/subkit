// The ONE confirm-gate decision. Pure, deterministic, no I/O.
//
// Several surfaces used to each hand-roll their own "does this tool call
// need a human confirm before it runs?" logic, and they drifted:
//
//   - the conversation loop gate (`tools/sdk-wrap/invoke.ts`)
//   - the save-workflow prior-approval backstop (`persistence/commit-workflow.ts`)
//
// Drift between them is a SECURITY bug: a write that pauses on one
// surface but slips through on another. This function is the single
// deterministic rule all pre-execution gates evaluate, keyed only on
// DURABLE state the caller already resolved:
//
//   - `resolvedMode`  — the resolved `ToolPolicyMode` from `resolveToolMode`.
//   - `priorApproval` — a durable, matching operator approval exists
//                       (for the save path, `findPriorSaveWorkflowApproval`
//                       within the freshness window; the single source of
//                       truth shared with the commit-workflow backstop).
//   - `category`      — the tool's registry category.
//   - `tool`          — the wrapped tool's name; keys the enumerated
//                       MCP-collapse set.
//   - `surface`       — the surface the TURN runs on (`ToolContext.surface`),
//                       threaded from the caller. Only `"mcp"` changes the
//                       verdict, and only for enumerated tools.
//   - `resolverRule`  — the `ToolModeRule` branch `decideToolMode` enforced.
//
// There is deliberately NO model-suppliable input. A boolean the model can
// place in its own tool call is not an approval — it is a hole with a name.
// The gate pauses; the operator answers the `ask_user_confirm` it raises; the
// HARNESS then claims the single-use approval the gate minted and performs the
// call (`persistence/auto-persist.ts`). No wrapped tool publishes a confirm
// marker in its schema.
//
// Rule (bias to PAUSE on any ambiguity — a write must never slip
// through unconfirmed):
//   - tenant_read                              → never pause (reads auto-run).
//   - mode ≠ confirm_before_execution          → never pause (policy says so).
//   - fresh matching priorApproval present     → proceed (durable approval).
//   - MCP surface + enumerated collapsible tool
//     resolved by a STATIC default rule
//     (tool_default / category_default)        → proceed (client dialog gate).
//   - otherwise                                → PAUSE.

import {
  MCP_TURN_COLLAPSIBLE_WRITE_TOOLS,
  type ToolModeRule,
  type ToolPolicyMode,
} from "../../tool-policies.ts";
import type { ToolCategory, ToolContext } from "../index.ts";

export interface DecideConfirmInput {
  /** Resolved execution mode from `resolveToolMode`. */
  resolvedMode: ToolPolicyMode;
  /**
   * A durable, matching operator approval already exists — for the save
   * path this is `findPriorSaveWorkflowApproval` within the freshness
   * window, the SAME predicate `commitWorkflowAtomic` authorizes on, so
   * the pre-confirm gate and the commit backstop can never disagree.
   */
  priorApproval: boolean;
  /** The tool's registry category. */
  category: ToolCategory;
  /** The wrapped tool's name — keys the enumerated MCP-collapse set. */
  tool: string;
  /** Surface the turn runs on, threaded from `ToolContext.surface`. */
  surface?: ToolContext["surface"];
  /** The `ToolModeRule` branch `decideToolMode` enforced for this call. */
  resolverRule?: ToolModeRule;
}

export interface ConfirmDecision {
  /** True → hold the write and raise a confirmation; false → let it run. */
  pause: boolean;
  /** Machine-readable reason, emitted into the forensic gate log. */
  reason:
    | "tenant_read_autoruns"
    | "mode_not_confirm_before_execution"
    | "prior_approval_present"
    | "mcp_client_dialog_gate"
    | "confirm_required";
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
  // A durable, fresh, matching approval exists — the commit backstop
  // would accept it, so a pre-confirm here would be redundant.
  if (input.priorApproval) {
    return { pause: false, reason: "prior_approval_present" };
  }
  // MCP-origin turn + enumerated additive/reversible write: the CLIENT's
  // destructiveHint dialog on the outer `conversation_*` call was the human
  // gate — it blocked the whole turn before it reached the engine. A server
  // pause on this path mints an approval no human can reach: the approval
  // URL is discarded by the worker and the model is forbidden to resolve
  // the elicitation itself, so the "gate" is a dead end, not a gate.
  // The collapse applies ONLY when the confirm came from a STATIC default
  // (`tool_default` / `category_default`) — the rules a client dialog can
  // meaningfully stand in for. Every other resolver rule pauses:
  //   - `inline_credential`: the MCP user never saw the staged secret —
  //     the client dialog approved the turn, not the credential.
  //   - `computed_from_input`: the tool's own policy inspected THIS call's
  //     payload and demanded a confirm (e.g. run_workflow with
  //     execute_writes:true, or a prod run) — a per-call danger the outer
  //     turn dialog knows nothing about.
  //   - `conversation_override` / `permission_mode`: an operator or client
  //     explicitly asked for confirms — honour the ask.
  // Only the enumerated additive/reversible tools collapse
  // (`MCP_TURN_COLLAPSIBLE_WRITE_TOOLS`); destructive writes keep the
  // pause deliberately, dead end and all — safer parked than executed.
  if (
    input.surface === "mcp" &&
    (input.resolverRule === "tool_default" || input.resolverRule === "category_default") &&
    MCP_TURN_COLLAPSIBLE_WRITE_TOOLS.has(input.tool)
  ) {
    return { pause: false, reason: "mcp_client_dialog_gate" };
  }
  // No durable approval and the policy demands confirmation: PAUSE. This is the
  // security-critical fall-through — never proceed here.
  return { pause: true, reason: "confirm_required" };
}
