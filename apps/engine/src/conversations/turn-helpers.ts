import { isAutomationReviewCard } from "./loop/stop-conditions.ts";
import type { DraftDocument, TurnEvent } from "./types.ts";

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

export type FallbackSynthesisReason =
  | "next_prompt_from_tool"
  | "loop_warnings_no_signal"
  | "tool_results_summary";

function resultRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isFailedToolResult(value: unknown): boolean {
  const record = resultRecord(value);
  if (!record) return false;
  if (
    record.ok === false ||
    typeof record.error_code === "string" ||
    typeof record.error === "string" ||
    record.status === "failed"
  ) {
    return true;
  }
  return isFailedToolResult(record.data);
}

function holdsWrites(value: unknown): boolean {
  const record = resultRecord(value);
  if (!record) return false;
  return record.writes_held === true || holdsWrites(record.data);
}

function workflowId(value: unknown): string | null {
  const record = resultRecord(value);
  if (!record) return null;
  if (typeof record.workflow_id === "string") return record.workflow_id;
  return workflowId(record.data);
}

function workflowVersionId(value: unknown): string | null {
  const record = resultRecord(value);
  if (!record) return null;
  if (typeof record.workflow_version_id === "string") return record.workflow_version_id;
  return workflowVersionId(record.data);
}

function workflowRunKey(value: unknown): string {
  return `${workflowId(value) ?? "current"}:${workflowVersionId(value) ?? "current"}`;
}

function successfulRun(value: unknown): boolean {
  const record = resultRecord(value);
  if (!record || holdsWrites(record) || isFailedToolResult(record)) return false;
  return record.status === "succeeded" || successfulRun(record.data);
}

export function completionEvidenceGuard(
  events: ReadonlyArray<TurnEvent>,
  draft?: DraftDocument | null,
): string | null {
  const successfulSaves = new Set<string>();
  const successfulRuns = new Set<string>();
  for (const event of [...events].reverse()) {
    if (event.type !== "tool_result") continue;
    if (event.tool === "save_workflow_draft") {
      const key = workflowId(event.output) ?? "current";
      if (!isFailedToolResult(event.output)) {
        successfulSaves.add(key);
        continue;
      }
      if (successfulSaves.has(key)) continue;
      if (isFailedToolResult(event.output)) {
        return "The workflow draft was not saved. The saved version changed or could not be updated; local changes remain available for review.";
      }
    }
    if (holdsWrites(event.output)) {
      const key = workflowRunKey(event.output);
      if (!successfulRuns.has(key)) {
        return "Some actions were held. This is not a complete live test; the held action still needs the required permission or an explicit live-run decision.";
      }
      continue;
    }
    if (
      (event.tool === "run_workflow" || event.tool.startsWith("wf_")) &&
      successfulRun(event.output)
    ) {
      successfulRuns.add(workflowRunKey(event.output));
    }
  }
  const saveError = draft?.state?.latest_workflow_save_error;
  if (
    saveError?.code === "draft_conflict" &&
    saveError.mutation_seq === draft?.state?.workflow_mutation_seq
  ) {
    return "The workflow draft was not saved. The saved version changed; local changes remain available for review.";
  }
  return null;
}

function pickFreshestNextPrompt(events: ReadonlyArray<TurnEvent>): string | null {
  const latestEvent = [...events].reverse().find((ev) => ev.type === "tool_result");
  if (latestEvent?.type !== "tool_result") return null;
  const out = latestEvent.output;
  if (!out || typeof out !== "object") return null;
  const o = out as Record<string, unknown>;
  const looksOk = o.ok !== false && o.error === undefined && o.error_code === undefined;
  if (!looksOk) return null;
  return typeof o.next_prompt === "string" && o.next_prompt.length > 0 ? o.next_prompt : null;
}

function abstentionMessage(latest: TurnEvent | undefined): string | null {
  if (latest?.type !== "tool_result" || latest.tool !== "cannot_help") return null;
  const output = resultRecord(latest.output);
  if (!output || output.abstained !== true) return null;
  const reason = typeof output.reason === "string" ? output.reason.trim() : "";
  if (!reason) return null;
  const alternative =
    typeof output.suggest_alternative === "string" ? output.suggest_alternative.trim() : "";
  return alternative ? `${reason}\n\n${alternative}` : reason;
}

export function classifyFallbackSynthesis(params: {
  events: ReadonlyArray<TurnEvent>;
  loopWarnings: number;
}): { text: string; reason: FallbackSynthesisReason } | null {
  const latest = params.events.filter((event) => event.type === "tool_result").at(-1);
  if (
    latest?.type === "tool_result" &&
    latest.tool === "review_workflow_automation" &&
    isAutomationReviewCard(latest.output)
  )
    return null;
  const nextPrompt = pickFreshestNextPrompt(params.events);
  if (nextPrompt) return { text: nextPrompt, reason: "next_prompt_from_tool" };
  const abstention = abstentionMessage(latest);
  if (abstention) return { text: abstention, reason: "tool_results_summary" };
  const text = synthesizeFallbackMessage(params);
  if (text === null) return null;
  const hasToolResult = params.events.some((ev) => ev.type === "tool_result");
  return {
    text,
    reason: hasToolResult ? "tool_results_summary" : "loop_warnings_no_signal",
  };
}

export function synthesizeFallbackMessage(params: {
  events: ReadonlyArray<TurnEvent>;
  loopWarnings: number;
}): string | null {
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
    const out = output as { error?: unknown; status?: unknown; error_code?: unknown };
    const looksError =
      typeof out.error === "string" ||
      typeof out.error_code === "string" ||
      out.status === "failed" ||
      (out as { ok?: unknown }).ok === false;
    if (!looksError) successCalls += 1;
  }
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
    const suffix = params.loopWarnings > 0 && callCount > 1 ? ` (called ${callCount}×)` : "";
    lines.push(`- ${tool}: ${describeToolOutput(output)}${suffix}`);
  }
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

function describeErrorEnvelope(output: Record<string, unknown>): string {
  const data =
    output.data && typeof output.data === "object" && !Array.isArray(output.data)
      ? (output.data as Record<string, unknown>)
      : null;
  const readText = (key: string): string | null => {
    const v = output[key] ?? data?.[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const readList = (key: string): string[] | null => {
    const v = output[key] ?? data?.[key];
    if (!Array.isArray(v)) return null;
    const items = v.filter((x): x is string => typeof x === "string");
    return items.length > 0 ? items : null;
  };
  const prose =
    readText("hint") ??
    readText("message") ??
    readText("error") ??
    `the call failed (${String(output.error_code).replace(/_/g, " ")})`;
  const parts = [prose.slice(0, 300)];
  const missing = readList("missing");
  if (missing) parts.push(`missing: ${missing.join(", ")}`);
  const expected = readList("expected_fields");
  if (expected) parts.push(`expected fields: ${expected.join(", ")}`);
  const setup = readText("setup_instructions");
  if (setup) parts.push(`setup: ${setup.slice(0, 200)}`);
  return parts.join(" · ");
}

function describeToolOutput(output: Record<string, unknown>): string {
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
    "matches",
  ];
  for (const key of candidateKeys) {
    const value = output[key];
    if (Array.isArray(value)) {
      const total = typeof output.total === "number" ? output.total : null;
      if (total !== null && total !== value.length) return `${value.length} of ${total} entries`;
      return `${value.length} entries`;
    }
  }
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
  if (typeof output.error_code === "string") return describeErrorEnvelope(output);
  if (typeof output.error === "string") return `error: ${output.error.slice(0, 160)}`;
  if (typeof output.reason === "string") return `note: ${String(output.reason)}`;
  if (typeof output.message === "string") return String(output.message).slice(0, 160);
  const keys = Object.keys(output).filter((k) => !k.startsWith("_"));
  return keys.length > 0 ? `fields: ${keys.slice(0, 5).join(", ")}` : "no structured output";
}
