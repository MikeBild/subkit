// Pure helper: expand recent failing tool-call rows into per-turn
// `prior_failures` entries.
//
// Lives next to the authoring-critic module because critic rejections
// require special-cased expansion (each `repair` becomes its own
// `step_id:"critic"` row), but the function handles every error_code
// uniformly so it can replace the inline scan in `conversations/loop.ts`
// in one shot — and so a focused unit test can exercise the contract
// end-to-end without spinning the full loop.

import { logger } from "../../logging/logger.ts";
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
  /** True when at least one `author_workflow` row carried a
   *  `critic_rejection` advisory whose `repairs[]` survived schema
   *  validation. Caller flips `stepRouterSignals.priorCriticFail` to
   *  escalate the next turn.
   *
   *  A rejection with a malformed advisory does NOT flip the signal:
   *  the next turn would only see escalation with no actionable hint,
   *  which pushes the model to retry without context. Better to log
   *  the producer drift, drop the row entirely, and let the normal
   *  routing decide. */
  hadCriticReject: boolean;
}

const MAX_ENTRIES = 5;

/**
 * Expand recent failing tool-call output rows into `prior_failures`
 * entries the next conversation turn can fold into its prompt.
 *
 *   - a `critic_rejection` advisory (rides a SUCCESSFUL author_workflow
 *     result — the draft was stashed + repaired in-pipeline, so it is
 *     NOT an `error_code`) with non-empty, schema-valid `repairs[]` →
 *     one row per repair tagged `step_id:"critic"`; `hadCriticReject`
 *     flips so step-router escalates the next turn.
 *   - a `critic_rejection` advisory with malformed or empty `repairs[]`
 *     → row dropped, signal suppressed (producer drift / empty-but-valid
 *     case). Producer drift is logged.
 *   - any other `ok:false`/`error_code` row → a single row
 *     `${tool} failed (${code}): ${message} — try next: ...` keyed by
 *     the producing tool name.
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

    // Authoring-critic advisory. `author_workflow` succeeds (the draft
    // is stashed + repaired in-pipeline) yet still reports a detected
    // semantic drift as a `critic_rejection` advisory — NOT an
    // `error_code`, so it must be read BEFORE the ok:false/error_code
    // guard below (which would otherwise skip this successful row).
    if (output.critic_rejection !== undefined) {
      const parsed = CriticRejectedDetailsSchema.safeParse(output.critic_rejection);
      if (!parsed.success) {
        // Producer drift: a critic_rejection advisory with a malformed
        // shape. Drop the row AND suppress the signal: a bare
        // escalation with no repair hint just pushes the model to retry
        // without context, which makes the next turn worse not better.
        // Surface the producer drift in the log so the contract
        // divergence is visible in production.
        logger.warn({
          module: "conversations",
          action: "critic.details_malformed",
          msg: "critic_rejection advisory failed CriticRejectedDetailsSchema; row dropped + signal suppressed",
          error: parsed.error.issues.map((i) => i.path.join(".")).join(","),
        });
        continue;
      }
      const repairs = parsed.data.repairs;
      if (repairs.length === 0) {
        // Well-formed advisory but empty repairs[] — schema permits it.
        // No hint to inject; without a hint the escalation has no
        // content for the next turn, so suppress the signal too.
        continue;
      }
      hadCriticReject = true;
      for (const repair of repairs) {
        entries.push({ step_id: "critic", error: repair });
        if (entries.length >= MAX_ENTRIES) break;
      }
      continue;
    }

    if (output.ok !== false && typeof output.error_code !== "string") continue;
    const code = typeof output.error_code === "string" ? output.error_code : "tool_failed";
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
