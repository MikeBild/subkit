// Pure helpers the conversation loop uses for stream-level stop
// conditions and post-turn fallbacks. Kept in their own module so they
// can be unit-tested without spinning the DB / provider stack.

import type { TurnEvent } from "./types.ts";

/**
 * Stop the stream when the per-turn loop-warning budget is exhausted —
 * the per-tool loop-breaker in sdk-wrap sets `reason: "turn_loop_budget_exhausted"`
 * on its wrapped result once `signals.totalLoopWarnings` crosses the
 * turn-level cap. Without this, the model keeps getting re-driven into
 * the same short-circuit and burns the entire step budget with nothing
 * to show for it (observed in session 4e6696e3: 20 rounds, 1.1 M tokens,
 * empty output).
 */
export const turnLoopBudgetStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<{
    toolResults: ReadonlyArray<{ output?: unknown }>;
  }>;
}): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((result) => {
    const output = result.output;
    if (!output || typeof output !== "object") return false;
    const data = (output as { data?: unknown }).data;
    if (!data || typeof data !== "object") return false;
    return (data as { reason?: unknown }).reason === "turn_loop_budget_exhausted";
  });
};

/** Tag for WHY `synthesizeFallbackMessage` produced output, so the
 *  conversation loop can log it accurately and operators can
 *  distinguish a benign next-prompt synthesis from an emergency
 *  loop-budget short-circuit.
 */
export type FallbackSynthesisReason =
  | "next_prompt_from_tool"
  | "loop_warnings_no_signal"
  | "tool_results_summary";

function pickFreshestNextPrompt(events: ReadonlyArray<TurnEvent>): string | null {
  const latestEvent = [...events].reverse().find((ev) => ev.type === "tool_result");
  if (!latestEvent || latestEvent.type !== "tool_result") return null;
  const out = latestEvent.output;
  if (!out || typeof out !== "object") return null;
  const o = out as Record<string, unknown>;
  const looksOk = o.ok !== false && o.error === undefined && o.error_code === undefined;
  if (!looksOk) return null;
  return typeof o.next_prompt === "string" && o.next_prompt.length > 0 ? o.next_prompt : null;
}

/** Companion to `synthesizeFallbackMessage` — returns the same text
 *  the message would have, paired with the reason tag, so the
 *  conversation loop can emit a structured log distinguishing a
 *  benign next-prompt synthesis from an emergency loop-budget
 *  short-circuit. Returns null when the message would also be null.
 */
export function classifyFallbackSynthesis(params: {
  events: ReadonlyArray<TurnEvent>;
  loopWarnings: number;
}): { text: string; reason: FallbackSynthesisReason } | null {
  const nextPrompt = pickFreshestNextPrompt(params.events);
  if (nextPrompt) return { text: nextPrompt, reason: "next_prompt_from_tool" };
  const text = synthesizeFallbackMessage(params);
  if (text === null) return null;
  const hasToolResult = params.events.some((ev) => ev.type === "tool_result");
  return {
    text,
    reason: hasToolResult ? "tool_results_summary" : "loop_warnings_no_signal",
  };
}

/**
 * Build a short fallback message from collected `tool_result` events
 * when the turn finished without the model producing any text. Walks
 * the events, picks the last output per tool name, and renders a
 * one-line summary per tool.
 *
 * Output is English. The model is responsible for any locale-aware
 * surface text in the regular path; the fallback is a backstop and
 * stays in one canonical language so observability + test-snapshot
 * matchers don't drift across tenants.
 *
 * Returns null when there is no meaningful signal — callers then
 * decide between a generic apology line and silence. An empty
 * assistant text is always worse than a synthesised paragraph, so the
 * loop should prefer this over rendering `""`.
 */
export function synthesizeFallbackMessage(params: {
  events: ReadonlyArray<TurnEvent>;
  loopWarnings: number;
}): string | null {
  // Walk every `tool_result` to collect (a) the most recent output per
  // tool and (b) per-tool counts + success/error tallies. The header
  // varies based on whether the loop guard fired AND whether the
  // calls actually succeeded — a turn where 5 run_workflow calls all
  // succeeded should not say "I stopped this turn early" (session
  // d34e5858 regression: misleading fallback after a parallel-tool
  // fan-out where every execution actually succeeded).
  const latestPerTool = new Map<string, Record<string, unknown>>();
  const callsPerTool = new Map<string, number>();
  let totalCalls = 0;
  let successCalls = 0;
  for (const ev of params.events) {
    if (ev.type !== "tool_result") continue;
    const output = ev.output;
    if (!output || typeof output !== "object") continue;
    latestPerTool.set(ev.tool, output as Record<string, unknown>);
    callsPerTool.set(ev.tool, (callsPerTool.get(ev.tool) ?? 0) + 1);
    totalCalls += 1;
    const out = output as { error?: unknown; status?: unknown };
    const looksError =
      typeof out.error === "string" ||
      out.status === "failed" ||
      (out as { ok?: unknown }).ok === false;
    if (!looksError) successCalls += 1;
  }
  // Never-silent guard. If we have any tool result with a `next_prompt`
  // and the model emitted no text, synthesise a one-liner so the user
  // is never staring at a blank turn after a successful tool fired.
  // Pre-fix the probe-success path produced no model text and no
  // fallback (the lifecycle envelope didn't match any of the recognised
  // shapes), so the user saw silence and asked "what's now?" (session
  // 0ac7593c). Even when the regular fallback would produce something,
  // a `next_prompt` from the freshest tool gives the most actionable
  // line — preferred.
  const nextPrompt = pickFreshestNextPrompt(params.events);
  if (nextPrompt) return nextPrompt;
  if (latestPerTool.size === 0) {
    return params.loopWarnings > 0
      ? "I kept hitting the same call and stopped the turn before burning more tokens. Try rephrasing or tell me what to do next."
      : null;
  }
  const lines: string[] = [];
  for (const [tool, output] of latestPerTool) {
    const callCount = callsPerTool.get(tool) ?? 1;
    // Only annotate the call count when the loop guard fired — that is
    // when the operator needs to see "this tool ran N times". In normal
    // multi-tool summaries the per-line shape stays `- tool: descr`.
    const suffix = params.loopWarnings > 0 && callCount > 1 ? ` (called ${callCount}×)` : "";
    lines.push(`- ${tool}: ${describeToolOutput(output)}${suffix}`);
  }
  // Pick the header that matches the actual turn shape:
  //   - loop fired AND every call succeeded AND there were multiple
  //     calls of the same tool → "ran the same tool N×". This is the
  //     parallel-fan-out case (session d34e5858: five succeeding
  //     run_workflow calls in one turn) — saying "I stopped early" is
  //     misleading because every call actually completed.
  //   - loop fired in any other shape → the original "stopped early"
  //     message. Single-call short-circuits, error retries, etc.
  //   - loop did not fire → plain summary header.
  const sameToolFanOut =
    params.loopWarnings > 0 &&
    successCalls === totalCalls &&
    totalCalls > 1 &&
    [...callsPerTool.values()].some((n) => n > 1);
  let header: string;
  if (sameToolFanOut) {
    header = `I ran the same tool ${totalCalls} times in this turn (all succeeded). Here is what came back:`;
  } else if (params.loopWarnings > 0) {
    header =
      "I stopped this turn early because the model kept repeating the same call. Here is what I already gathered:";
  } else {
    header = "Summary of the latest tool results:";
  }
  return `${header}\n${lines.join("\n")}`;
}

// Translate a `lifecycle_state` enum value to a user-facing verb. Pre-fix
// the fallback rendered the raw token (`workflow_validated`,
// `connector_probed`) which read as internal jargon. The mapping covers
// the known authoring transitions; unknown values fall through to a
// trimmed, humanised version of the token itself.
function humaniseLifecycleState(state: string): string {
  const map: Record<string, string> = {
    none: "drafting",
    connector_targeted: "drafting",
    connector_inspected: "inspected",
    connector_validated: "ready",
    connector_authenticated: "authenticated",
    connector_probed: "probe ok",
    connector_probe_failed: "probe failed",
    connector_probe_blocked: "needs more info",
    connector_persisted: "saved",
    workflow_targeted: "drafting",
    workflow_inspected: "inspected",
    workflow_validated: "ready",
    workflow_previewed: "previewed",
    workflow_persisted: "committed",
    workflow_executed: "ran",
    workflow_diagnosed: "diagnosed",
  };
  return map[state] ?? state.replace(/_/g, " ");
}

function looksLikeLifecyclePayload(output: Record<string, unknown>): boolean {
  return (
    typeof output.lifecycle_state === "string" &&
    typeof output.mode === "string" &&
    typeof output.stage === "string" &&
    "resource_kind" in output
  );
}

function describeToolOutput(output: Record<string, unknown>): string {
  // Loop-abort envelope that carries the IDENTICAL call's earlier success:
  // describe the finished run, not the abort. Pre-fix the abort envelope
  // replaced the success in `latestPerTool` and the user read
  // "status=succeeded · no output" for a run whose data existed all along.
  if (
    (output.reason === "tool_loop_detected" || output.reason === "turn_loop_budget_exhausted") &&
    output.prior_success_output !== undefined &&
    output.prior_success_output !== null &&
    typeof output.prior_success_output === "object"
  ) {
    return `already succeeded this turn — ${describeToolOutput(
      output.prior_success_output as Record<string, unknown>,
    )}`;
  }
  // Auto-act envelopes carry an explicit `auto_saved` / `auto_committed`
  // flag. Surface that as the headline so the user sees "saved" / "committed"
  // before any list / lifecycle / fields fallback — task #4 result.
  if (output.auto_saved === true) {
    const next =
      typeof output.next_prompt === "string" ? output.next_prompt : "ready for the next step";
    return `saved · ${next}`;
  }
  if (output.auto_committed === true) {
    const next =
      typeof output.next_prompt === "string" ? output.next_prompt : "ready for the next step";
    return `committed · ${next}`;
  }
  const candidateKeys = [
    "workflows",
    "connectors",
    "skills",
    "executions",
    "items",
    "hits",
    "results",
  ];
  for (const key of candidateKeys) {
    const value = output[key];
    if (Array.isArray(value)) return `${value.length} entries`;
  }
  // run_workflow / dry_run_workflow lifecycle payload — surface the
  // actual outcome instead of falling through to the generic
  // "fields: mode, stage, lifecycle_state, …" list (session 86de186b
  // continuation: when the loop-breaker fired 5× the operator saw
  // "fields: mode, stage, …" with no actual workflow output, no
  // status, no warning text — useless).
  const status = typeof output.status === "string" ? output.status : null;
  const requiresRepair = output.requires_repair === true;
  const warnings = Array.isArray(output.warnings) ? (output.warnings as unknown[]) : null;
  const warningsCount = warnings?.length ?? 0;
  const wfOutput = output.output;
  if (status === "succeeded" || status === "partial_success" || status === "failed") {
    const parts: string[] = [`status=${status}`];
    if (requiresRepair) parts.push("requires_repair");
    if (warningsCount > 0) parts.push(`${warningsCount} warning${warningsCount === 1 ? "" : "s"}`);
    if (typeof output.warning_summary === "string") {
      parts.push(String(output.warning_summary).slice(0, 200));
    }
    if (Array.isArray(wfOutput)) parts.push(`output: ${wfOutput.length} rows`);
    else if (wfOutput && typeof wfOutput === "object") {
      // A pre-sampled output carries REAL rows — show them, not just key
      // names. The fallback is often the only text the user sees on a
      // tool-only turn; "output: org, count, repos" answers nothing while
      // the actual top rows sit one field away.
      if (output.output_sampled === true) {
        let snippet = "";
        try {
          snippet = JSON.stringify(wfOutput) ?? "";
        } catch {
          snippet = "";
        }
        if (snippet.length > 0) {
          parts.push(
            `output (sampled): ${snippet.length > 1200 ? `${snippet.slice(0, 1200)}…` : snippet}`,
          );
        }
      } else {
        const keys = Object.keys(wfOutput as Record<string, unknown>).filter(
          (k) => !k.startsWith("_"),
        );
        parts.push(
          keys.length > 0 ? `output: ${keys.slice(0, 5).join(", ")}` : "output: structured",
        );
      }
    } else if (wfOutput === null || wfOutput === undefined) {
      // A big result gets stripped from the LLM-facing envelope by the
      // outer 8KB truncate pass — that is NOT "no output". Saying so sent
      // production operators chasing phantom failures while their 95-row
      // result sat behind the raw_ref. Point at the retrieval path.
      if (output._truncated === true || typeof output._raw_ref === "string") {
        parts.push(
          typeof output._raw_ref === "string"
            ? `output too large for chat — fetch it with get_raw_result(ref="${output._raw_ref}")`
            : "output too large for chat — run diagnose_latest_execution or inspect_execution_step to see it",
        );
      } else {
        parts.push("no output");
      }
    }
    return parts.join(" · ");
  }
  // Lifecycle envelope (build*Payload from authoring-contract.ts) —
  // covers connector + workflow draft tools. Pre-fix this fell through
  // to the generic key-enumeration line and surfaced as
  // "fields: mode, stage, lifecycle_state, resource_kind, resource_id"
  // (session 0ac7593c). Translate to a humane one-liner anchored on
  // the lifecycle_state and the next recommended action.
  if (looksLikeLifecyclePayload(output)) {
    const kind = (output.resource_kind as string | null) ?? "draft";
    const id = (output.resource_id as string | null) ?? "draft";
    const state = humaniseLifecycleState(output.lifecycle_state as string);
    const nextActions = Array.isArray(output.next_best_actions)
      ? (output.next_best_actions as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const nextPrompt =
      typeof output.next_prompt === "string" && output.next_prompt.length > 0
        ? output.next_prompt
        : null;
    const nextHint = nextPrompt ?? nextActions[0] ?? null;
    return nextHint ? `${kind} ${id}: ${state} · next: ${nextHint}` : `${kind} ${id}: ${state}`;
  }
  if (output._truncated && typeof output._note === "string") return String(output._note);
  if (typeof output._truncation_note === "string") return String(output._truncation_note);
  if (typeof output.error === "string") return `error: ${output.error.slice(0, 160)}`;
  if (typeof output.error_code === "string") return `error_code: ${String(output.error_code)}`;
  if (typeof output.reason === "string") return `note: ${String(output.reason)}`;
  if (typeof output.message === "string") return String(output.message).slice(0, 160);
  // Last resort — enumerate domain keys but defensively strip any
  // underscore-prefixed envelope keys so internal markers
  // (`_truncated`, `_truncation_note`, future additions) never reach
  // the user. Lifecycle envelopes are handled above; this fallback is
  // only hit for tools whose output is neither a list, a status payload,
  // nor a lifecycle envelope (e.g. `whoami`, ad-hoc admin tools).
  const keys = Object.keys(output).filter((k) => !k.startsWith("_"));
  return keys.length > 0 ? `fields: ${keys.slice(0, 5).join(", ")}` : "no structured output";
}
