import type { ToolResult, ToolResultPause } from "../tools/index.ts";
import { GENERIC_TOOL_FAILURE_CODE } from "../tools/result-payload.ts";
import { MAX_TURN_LOOP_WARNINGS } from "../tools/sdk-wrap/state.ts";

export const REPEAT_THRESHOLD = 3;

export const REPEAT_EXEMPT_TOOLS = new Set<string>([
  "dry_run_workflow",
  "dry_run_step",
  "dry_run_transform",
  "validate_connector_draft",
  "inspect_workflow_draft",
  "inspect_workflow",
  "inspect_connector_draft",
  "inspect_authoring_context",
  "inspect_execution_step",
  "list_skills",
  "load_skill",
  "search_docs",
  "search_knowledge",
]);

export interface CircuitBlock {
  budgetReached: boolean;
  circuitReason: string;
  eventMessage: string;
  data: Record<string, unknown>;
}

export interface ArgsRepeatVerdict {
  isReadOnly: boolean;
  repeatCount: number;
  toolArgsRepeat: { hash: string; count: number } | null;
  priorSuccess: unknown;
  repeatsSuccessfulExecution: boolean;
  tripped: boolean;
}

export interface FailureSignature {
  reason: string;
  shape: string;
}

export function isCircuitExempt(tool: string): boolean {
  return (
    tool.startsWith("ask_user_") ||
    tool.startsWith("inspect_") ||
    tool === "diagnose_latest_execution"
  );
}

export function turnBudgetReached(totalLoopWarnings: number): boolean {
  return totalLoopWarnings >= MAX_TURN_LOOP_WARNINGS;
}

export function consecutiveFailuresBlock(
  consecutiveFailures: number,
  totalLoopWarnings: number,
  alternatives: string,
): CircuitBlock {
  const budgetReached = turnBudgetReached(totalLoopWarnings);
  if (budgetReached) {
    return {
      budgetReached,
      circuitReason: "turn_loop_budget_exhausted",
      eventMessage: `tool.consecutive_failures_block: ${consecutiveFailures} failed tool calls in a row; turn-level loop budget exhausted (${totalLoopWarnings}) — ending turn`,
      data: {
        error_code: "turn_loop_budget_exhausted",
        message: `this turn failed ${consecutiveFailures} tool calls in a row and exceeded the loop-warning budget — stop, summarise what you already know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).`,
        reason: "turn_loop_budget_exhausted",
        consecutive_failures: consecutiveFailures,
        next_best_actions: ["ask_user_choice", "ask_user_text"],
      },
    };
  }
  return {
    budgetReached,
    circuitReason: "consecutive_failures_cap",
    eventMessage: `tool.consecutive_failures_block: ${consecutiveFailures} failed tool calls in a row — emit ask_user_choice / ask_user_text instead of retrying.`,
    data: {
      error_code: "consecutive_failures_cap",
      message: `${consecutiveFailures} tool calls have failed in a row — stop patching and emit ask_user_choice with the recommended_options below (or derive your own from the most recent failure). The cap resets on the first successful tool call.${alternatives}`,
      reason: "consecutive_failures_cap",
      consecutive_failures: consecutiveFailures,
      recommended_options: [
        {
          value: "restart_simple",
          label: "Abandon the current draft and start over with a simpler design",
        },
        {
          value: "inspect_failures",
          label: "Show me the recent error traces before I decide",
        },
        { value: "abort", label: "Stop here — I'll come back to this later" },
      ],
      next_best_actions: ["ask_user_choice", "ask_user_text", "inspect_workflow"],
    },
  };
}

export function errorCodeRepeatBlock(
  tool: string,
  streak: { code: string; count: number },
  totalLoopWarnings: number,
): CircuitBlock {
  const budgetReached = turnBudgetReached(totalLoopWarnings);
  const reason = budgetReached ? "turn_loop_budget_exhausted" : "tool_error_repeat";
  return {
    budgetReached,
    circuitReason: budgetReached ? "turn_loop_budget_exhausted" : "error_code_repeat",
    eventMessage: `tool.error_code_repeat_block: ${tool} returned \`${streak.code}\` ${streak.count}× this turn — different args, same refusal. Stop retrying; emit ask_user_choice / ask_user_text describing the blocker and offering a path forward.`,
    data: {
      error_code: reason,
      message: budgetReached
        ? `this turn keeps hitting the same blocker (${streak.code}) — stop, summarise what you know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).`
        : `${tool} has failed with \`${streak.code}\` ${streak.count}× in this turn — the args changed but the blocker did not. Stop retrying and ask the user via ask_user_choice / ask_user_text, or change approach entirely.`,
      reason,
      tool,
      repeated_error_code: streak.code,
      repeat_count: streak.count,
      next_best_actions: ["ask_user_choice", "ask_user_text", "inspect_workflow"],
    },
  };
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${v.map(stableStringify).join(",")}]`;
  }
  const record = v as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

export function argsHashOf(args: unknown): string {
  try {
    return stableStringify(args);
  } catch {
    return "";
  }
}

export function decideArgsRepeat(input: {
  inner: { name: string; category: string };
  argsHash: string;
  toolArgsRepeat: { hash: string; count: number } | undefined;
  lastExecutionSuccess: { tool: string; args_hash: string; output: unknown } | null;
}): ArgsRepeatVerdict {
  const { inner, argsHash } = input;
  const isReadOnly = inner.category === "tenant_read" || REPEAT_EXEMPT_TOOLS.has(inner.name);
  let repeatCount = 0;
  let toolArgsRepeat: { hash: string; count: number } | null = null;
  if (!isReadOnly && argsHash) {
    repeatCount = input.toolArgsRepeat?.hash === argsHash ? input.toolArgsRepeat.count + 1 : 1;
    toolArgsRepeat = { hash: argsHash, count: repeatCount };
  }
  const last = input.lastExecutionSuccess;
  const priorSuccess =
    last && last.tool === inner.name && last.args_hash === argsHash ? last.output : undefined;
  const repeatsSuccessfulExecution = priorSuccess !== undefined && repeatCount >= 2;
  const tripped = !isReadOnly && (repeatCount >= REPEAT_THRESHOLD || repeatsSuccessfulExecution);
  return {
    isReadOnly,
    repeatCount,
    toolArgsRepeat,
    priorSuccess,
    repeatsSuccessfulExecution,
    tripped,
  };
}

export function loopDetectedBlock(
  tool: string,
  verdict: ArgsRepeatVerdict,
  totalLoopWarnings: number,
): CircuitBlock {
  const budgetReached = turnBudgetReached(totalLoopWarnings);
  const reason = budgetReached ? "turn_loop_budget_exhausted" : "tool_loop_detected";
  const { repeatCount, priorSuccess } = verdict;
  return {
    budgetReached,
    circuitReason: reason,
    eventMessage: budgetReached
      ? `tool.loop_detected: ${tool} repeated identical args ${repeatCount}×; turn-level loop budget exhausted (${totalLoopWarnings}) — ending turn`
      : verdict.repeatsSuccessfulExecution
        ? `tool.loop_detected: ${tool} already succeeded with identical args this turn — present the prior_success_output instead of running it again`
        : `tool.loop_detected: ${tool} called with identical args ${repeatCount}× in a row — change approach or ask the user`,
    data: {
      error_code: reason,
      message: priorSuccess
        ? `${tool} already succeeded with these exact args this turn — its result is attached as prior_success_output. Present THAT result to the user; do NOT run it again.`
        : budgetReached
          ? `this turn called tools ${totalLoopWarnings}× past the loop-warning budget — stop, summarise what you already know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).`
          : `${tool} has been called with identical args ${repeatCount}× in a row in this turn — change the args or stop and ask the user via ask_user_choice / ask_user_text. Do NOT retry with the SAME shape.`,
      reason,
      tool,
      repeat_count: repeatCount,
      ...(priorSuccess !== undefined ? { prior_success_output: priorSuccess } : {}),
      next_best_actions: ["ask_user_choice", "ask_user_text", "diagnose_latest_execution"],
    },
  };
}

export function policyEnvironmentOf(args: Record<string, unknown>): string | undefined {
  return typeof args.environment === "string" ? args.environment : undefined;
}

export function executionModeFor(environment: string | undefined): "prod" | "dev" | null {
  return environment === "prod" || environment === "dev" ? environment : null;
}

export function duplicatePendingOutput(
  existing: { elicitation_id: string; tool_name: string } | undefined,
): Record<string, unknown> {
  return {
    error: "duplicate_pending_elicitation_in_turn",
    error_code: "duplicate_pending_elicitation_in_turn",
    message:
      "Another tool call in this turn already staged an ask_user_confirm. Wait for the user to resolve that one, then re-issue this call after the user confirms.",
    next_best_actions: [],
    existing_elicitation_id: existing?.elicitation_id,
    existing_tool: existing?.tool_name,
  };
}

export function gateFailureData(
  gate: { kind: "approval_failed" } | { kind: "unavailable"; reason: string },
  tool: string,
): Record<string, unknown> {
  if (gate.kind === "approval_failed") {
    return {
      error_code: "approval_request_failed",
      message: `${tool} requires the operator's confirmation, and the engine could not open one. Nothing ran. Tell the user, and retry only if they ask again.`,
      reason: "approval_request_failed",
      next_best_actions: [],
    };
  }
  return {
    error_code: "not_available_on_surface",
    message: gate.reason,
    reason: "not_available_on_surface",
    next_best_actions: [],
  };
}

export function confirmQuestion(
  tool: string,
  dependents: ReadonlyArray<{ slug: string }>,
  effectDescription: string | null,
): string {
  if (dependents.length > 0) {
    return `Deleting this connector will break ${dependents.length} live workflow${dependents.length === 1 ? "" : "s"} (${dependents.map((w) => w.slug).join(", ")}). Proceed anyway?`;
  }
  if (effectDescription !== null) return `${effectDescription} — approve this call?`;
  return `Policy requires confirmation before running ${tool}. Proceed?`;
}

export function policyPauseNote(
  tool: string,
  hasCommitIntent: boolean,
  approvalUrl: string | null | undefined,
): string {
  if (!hasCommitIntent) {
    return `policy_confirm_required — nothing ran, and this turn has no way to release ${tool}: no approval handle could be opened for it. Tell the user the action must be performed from an authenticated session.`;
  }
  const link = approvalUrl
    ? ` Present this approval link to the operator verbatim, on its own line, as a bare URL — opening it in a browser IS the authorization (single-use link, no sign-in): ${approvalUrl} Once they decide there, the engine resolves this pause and carries out ${tool} on its own, then reports back — so hand over the link and wait rather than asking them to repeat their answer to you.`
    : "";
  return `policy_confirm_required — nothing ran. The operator must answer the emitted ask_user_confirm; the engine performs ${tool} itself once they approve. You do NOT re-issue this call, and you cannot approve on their behalf.${link}`;
}

export function committedWorkflowIdFromResult(result: ToolResult): string | null {
  const workflowId = result.committed_workflow_id;
  if (typeof workflowId !== "string") return null;
  const data = "data" in result ? result.data : undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.already_persisted === true || record.version_changed === false) return null;
  }
  return workflowId;
}

export function failureSignature(payload: unknown): FailureSignature {
  const errObj = (payload ?? {}) as Record<string, unknown>;
  const reason =
    typeof errObj.reason === "string"
      ? errObj.reason
      : typeof errObj.error_code === "string" && errObj.error_code !== GENERIC_TOOL_FAILURE_CODE
        ? errObj.error_code
        : "";
  const err =
    typeof errObj.error === "string"
      ? errObj.error
      : typeof errObj.message === "string"
        ? errObj.message
        : Array.isArray(errObj.errors)
          ? JSON.stringify(errObj.errors)
          : "";
  return { reason, shape: `${reason}|${err.slice(0, 120)}` };
}

export function validationErrorsOf(payload: unknown): unknown[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const errors = (payload as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors : null;
}

export function nextErrorCodeStreak(
  prior: { code: string; count: number } | undefined,
  code: string,
): { code: string; count: number } {
  return { code, count: prior?.code === code ? prior.count + 1 : 1 };
}

export function nextFingerprintStreak(
  prior: { hash: string; count: number } | undefined,
  hash: string,
): { hash: string; count: number } {
  return { hash, count: prior?.hash === hash ? prior.count + 1 : 1 };
}

export function tracksExecutionSuccess(tool: string): boolean {
  return tool === "run_workflow" || tool.startsWith("wf_");
}

export function pauseInputPayload(pause: ToolResultPause): unknown {
  if (pause.input !== undefined) return pause.input;
  return {
    ...(pause.kind !== undefined ? { kind: pause.kind } : {}),
    ...(pause.diff !== undefined ? { diff: pause.diff } : {}),
    ...(pause.target !== undefined ? { target: pause.target } : {}),
  };
}
