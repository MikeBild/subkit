// Stop-condition predicates passed to `streamText({ stopWhen: [...] })`
// in the conversation tool-use loop. Pure functions over the
// step.toolResults array — no shared state with the surrounding
// orchestrator. Extracted so the loop's runtime semantics ("when does
// the SDK stop calling the model") can be inspected and unit-tested
// independently of the loop body.
//
// Typed `ReadonlyArray<...>` against the SDK's StopCondition generic
// because our concrete tool map and the SDK's variadic ToolSet do not
// reconcile at the type level; the runtime contract is the predicate
// shape, not the SDK's generic ToolSet parameterisation.

interface StepShapeWithToolName {
  toolResults: ReadonlyArray<{ toolName: string; output?: unknown }>;
}

interface StepShape {
  toolResults: ReadonlyArray<{ output?: unknown }>;
}

/**
 * Consecutive identical-blocking `dry_run_workflow` results that stop the
 * turn. A preview that keeps coming back `requires_repair` with the SAME
 * unmet signal (same judge `missing` set / same blocking warning set) is
 * not making progress — re-driving the build→dry_run→edit loop another
 * time will produce the same verdict. After this many in a row the turn
 * stops so the assistant can surface the verdict to the user instead of
 * burning the rest of the step budget on churn.
 *
 * A dry_run whose blocking set SHRINKS or CHANGES is progress and resets
 * the streak — only a STALLED identical repeat counts toward the cap.
 */
export const MAX_STALLED_REPAIR_PREVIEWS = 3;

/**
 * Stop after a step that invoked `save_workflow_draft` and produced a
 * `committed_workflow_id` — the loop is done the moment the workflow
 * row is persisted.
 */
export const committedStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<StepShapeWithToolName>;
}): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((r) => {
    if (r.toolName !== "save_workflow_draft") return false;
    const output = r.output;
    return (
      !!output &&
      typeof output === "object" &&
      "committed_workflow_id" in (output as Record<string, unknown>) &&
      typeof (output as { committed_workflow_id?: unknown }).committed_workflow_id === "string"
    );
  });
};

/**
 * Stop after any tool returns a pause payload. Required for
 * policy-gated confirm-before-execution flows where the wrapper emits
 * an `ask_user_confirm` elicitation without the model explicitly
 * calling `ask_user_confirm` as a tool in the same step.
 */
export const pausedStopCondition = ({ steps }: { steps: ReadonlyArray<StepShape> }): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((result) => {
    const output = result.output;
    return !!output && typeof output === "object" && "pause" in (output as Record<string, unknown>);
  });
};

// The dry_run_workflow result envelope nests its lifecycle payload under
// `data` (see buildLifecyclePayload). The blocking signals we key on
// (`requires_repair`, `classification`, `judge.missing`, `warnings`) all
// live there.
function dryRunData(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== "object") return null;
  const data = (output as { data?: unknown }).data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  // Some envelopes carry the lifecycle fields at the top level (no `data`
  // wrapper). Fall back so the detection is robust to either shape.
  return output as Record<string, unknown>;
}

// True when a dry_run_workflow result is in the repair-blocked state —
// either the structural `requires_repair` flag or the judge's
// `needs_repair` classification. P3 (parallel) may reword the terminal
// verdict; both signals exist regardless of its exact wording, so we
// detect on the generic pair rather than any one phrasing.
function isRepairBlocked(data: Record<string, unknown>): boolean {
  return data.requires_repair === true || data.classification === "needs_repair";
}

// A stable fingerprint of WHAT is unmet — keyed on the semantic blocking
// set (judge `missing` items + blocking warning codes), NOT on tool args
// or free-text summary. A repeat with the same fingerprint is a stalled
// loop; a shrinking/changing fingerprint is progress.
//
// Returns null when the result is not repair-blocked (so it cannot
// contribute to a stall streak).
function blockingFingerprint(output: unknown): string | null {
  const data = dryRunData(output);
  if (!data || !isRepairBlocked(data)) return null;

  const parts: string[] = [];

  // Judge verdict + sorted missing-set — the primary "goal not satisfied"
  // signal. Sorting makes the set order-independent so a reordered but
  // identical missing-set still matches.
  const judge = data.judge;
  if (judge && typeof judge === "object") {
    const j = judge as { verdict?: unknown; missing?: unknown };
    if (typeof j.verdict === "string") parts.push(`verdict:${j.verdict}`);
    if (Array.isArray(j.missing)) {
      const missing = j.missing
        .filter((m): m is string => typeof m === "string")
        .slice()
        .sort();
      parts.push(`missing:[${missing.join("|")}]`);
    }
  }

  // Blocking warning codes — the structural-repair signal (compile_error,
  // transform_empty_extraction, loop_over_unresolved, …). Same set, same
  // stall. We key on the warning `code` (stable) not the message text.
  const warnings = data.warnings;
  if (Array.isArray(warnings)) {
    const codes = warnings
      .map((w) => (w && typeof w === "object" ? (w as { code?: unknown }).code : undefined))
      .filter((c): c is string => typeof c === "string")
      .slice()
      .sort();
    if (codes.length > 0) parts.push(`warnings:[${codes.join("|")}]`);
  }

  // A repair-blocked result with no extractable judge/warning detail still
  // counts as a stall if it repeats — fall back to a constant marker so
  // identical bare `requires_repair` envelopes can converge.
  return parts.length > 0 ? parts.join(";") : "requires_repair";
}

/**
 * Stop the turn when `dry_run_workflow` keeps returning the SAME blocking
 * verdict in a row — N consecutive repair-blocked previews carrying the
 * same unmet-item fingerprint (same judge `missing` set / same blocking
 * warning codes). The model is re-driving build→dry_run→edit without
 * converging; stopping lets the assistant surface the verdict to the user
 * instead of burning the rest of the step budget.
 *
 * Progress is never falsely stopped: a dry_run whose missing-set shrinks
 * or changes produces a different fingerprint and resets the streak. A
 * green preview (no `requires_repair`) is not repair-blocked, yields a
 * null fingerprint, and also resets the streak.
 *
 * Detection walks the trailing dry_run_workflow results across the turn's
 * steps (each step may run several tools; we look only at the
 * dry_run_workflow outputs, in order) and counts the final run of
 * identical fingerprints.
 */
export const noProgressRepairStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<StepShapeWithToolName>;
}): boolean => {
  // Collect dry_run_workflow fingerprints in chronological order across
  // all steps. A null fingerprint (not repair-blocked: green preview, or
  // a non-blocking warning) breaks any stall streak — record it as a
  // sentinel so the trailing-run count restarts.
  const fingerprints: Array<string | null> = [];
  for (const step of steps) {
    for (const r of step.toolResults) {
      if (r.toolName !== "dry_run_workflow") continue;
      fingerprints.push(blockingFingerprint(r.output));
    }
  }
  if (fingerprints.length < MAX_STALLED_REPAIR_PREVIEWS) return false;

  // Count the trailing run of an identical, non-null fingerprint.
  const last = fingerprints[fingerprints.length - 1];
  if (last == null) return false;
  let run = 0;
  for (let i = fingerprints.length - 1; i >= 0; i--) {
    if (fingerprints[i] === last) run++;
    else break;
  }
  return run >= MAX_STALLED_REPAIR_PREVIEWS;
};
