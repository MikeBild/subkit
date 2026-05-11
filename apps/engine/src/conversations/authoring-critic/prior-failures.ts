// Pure helper: expand recent failing tool-call rows into per-turn
// `prior_failures` entries.
//
// Lives next to the authoring-critic module because critic rejections
// require special-cased expansion (each `repair` becomes its own
// `step_id:"critic"` row), but the function handles every error_code
// uniformly so it can replace the inline scan in `conversations/loop.ts`
// in one shot — and so a focused unit test can exercise the contract
// end-to-end without spinning the full loop.

import { CriticRejectedDetailsSchema } from "./types.ts";

export interface RecentToolCallRow {
  tool: string;
  output: unknown;
}

export interface PriorFailure {
  step_id: string;
  error: string;
}

export interface ExpandResult {
  entries: PriorFailure[];
  /** True when at least one critic_rejected row was seen — caller flips
   *  `stepRouterSignals.priorCriticFail` to escalate the next turn. */
  hadCriticReject: boolean;
}

const MAX_ENTRIES = 5;

/**
 * Expand recent failing tool-call output rows into `prior_failures`
 * entries the next conversation turn can fold into its prompt.
 *
 *   - `error_code === "critic_rejected"` → one row per `details.repairs[i]`
 *     tagged `step_id:"critic"`. Verdict shape is validated against
 *     `CriticRejectedDetailsSchema`; malformed details produce no rows
 *     (the rejection itself is dropped silently rather than re-surfacing
 *     a garbled hint).
 *   - any other `ok:false`/`error_code` row → a single row
 *     `${tool} failed (${code}): ${message} — try next: ...` keyed by the
 *     producing tool name.
 *
 * Capped at MAX_ENTRIES so the prompt budget cannot blow up from a
 * conversation that has been flailing for a while.
 */
export function expandPriorFailuresFromToolCalls(
  rows: ReadonlyArray<RecentToolCallRow>,
): ExpandResult {
  const entries: PriorFailure[] = [];
  let hadCriticReject = false;
  for (const row of rows) {
    if (entries.length >= MAX_ENTRIES) break;
    const output = row.output as Record<string, unknown> | null;
    if (!output || typeof output !== "object") continue;
    if (output.ok !== false && typeof output.error_code !== "string") continue;
    const code = typeof output.error_code === "string" ? output.error_code : "tool_failed";
    if (code === "critic_rejected") {
      hadCriticReject = true;
      const parsed = CriticRejectedDetailsSchema.safeParse(output.details);
      const repairs = parsed.success ? parsed.data.repairs : [];
      for (const repair of repairs) {
        entries.push({ step_id: "critic", error: repair });
        if (entries.length >= MAX_ENTRIES) break;
      }
      continue;
    }
    const nbaRaw = output.next_best_actions;
    const nba = Array.isArray(nbaRaw)
      ? nbaRaw.filter((x): x is string => typeof x === "string")
      : [];
    const message =
      typeof output.message === "string"
        ? output.message
        : typeof (output as { error?: unknown }).error === "string"
          ? (output as { error: string }).error
          : "";
    const nbaSuffix = nba.length > 0 ? ` — try next: ${nba.join(", ")}` : "";
    entries.push({
      step_id: row.tool,
      error: `${row.tool} failed (${code}): ${message}${nbaSuffix}`,
    });
  }
  return { entries, hadCriticReject };
}
