// Instruction-grounded preview judge (Fix C, sessions 784c1b02 /
// cfcc2db9 post-mortem).
//
// A green dry-run is a STRUCTURAL signal — every step ran and returned
// something. It says nothing about whether the output satisfies the
// user's GOAL: the "Project: ()" preview was green and auto-committed
// while the project names the goal demanded were empty strings. This
// module closes that gap with ONE deterministic LLM call after a green
// preview and before the auto-commit:
//
//   judgePreview({goal, definition_summary, step_artifacts, …})
//     → { verdict: "passes" | "partial" | "failed", reason, missing }
//
// Contract:
//   - `passes` → commit exactly as today.
//   - `partial` / `failed` → the caller blocks the auto-commit and
//     surfaces the verdict + missing items for repair. The explicit
//     save path (`save_workflow_draft`, incl. `force_commit`) remains
//     the operator escape hatch — the judge only gates the AUTOMATIC
//     persist.
//   - infrastructure failure (provider error, quota, contract drift)
//     → typed `{verdict:"skipped", reason:"judge_unavailable"}`. The
//     judge must NEVER turn an infra blip into a blocked commit, and it
//     never throws.
//   - missing goal is the caller's skip (`reason:"no_goal"`); the
//     helper below exists so both skip shapes share one type.
//
// Circuit-breaker (anti-churn, P3): a miscalibrated judge must not
// become the next authoring deadlock. The caller tracks
// `blocks_since_commit` — a MONOTONIC per-draft counter that increments
// on every block REGARDLESS of fingerprint change and resets to 0 only
// when a workflow actually commits. After `JUDGE_BREAKER_MAX_BLOCKS`
// blocks the verdict degrades to advisory (attached + logged,
// non-blocking → auto-commit proceeds), so a model churning edits still
// converges. At/over the cap the dry_run result carries a terminal
// done-signal (tell the user what's missing and stop) instead of yet
// another silent requires_repair.
//
// Memoization (P3): the most recent judged verdict is cached against
// its definition fingerprint (`state.judge_breaker.last_verdict`). An
// unchanged re-preview (same fingerprint) reuses the cached verdict and
// SKIPS the judge LLM call entirely.
//
// Cost discipline: the call rides `invoke()` (flow "judge"), so it is
// tenant-budget-accounted and routed exactly like "repair", and the
// turn's abort signal is threaded into it (P1) so a wedged judge call
// can't outlive the turn.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Executor } from "../db/client.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import { detectNamedOutputFormat, outputMatchesFormat } from "./output-format.ts";
import { canonicalJson } from "./text-line-diff.ts";
import { truncateStepPreviewForLlm } from "./tools/truncate.ts";

/** Max consecutive judge blocks since the last commit before the
 *  verdict degrades to advisory (auto-commit proceeds). Counted
 *  per-draft, NOT per-fingerprint — an edit between blocks does not
 *  reset it (P3). */
export const JUDGE_BREAKER_MAX_BLOCKS = 2;

/** Total char budget for the step-artifacts block in the prompt. Each
 *  step preview is already clipped to ~1.5KB by
 *  `truncateStepPreviewForLlm`; the total keeps a many-step preview
 *  from dominating the judge prompt. */
const ARTIFACTS_TOTAL_BUDGET_CHARS = 6_000;

export const JudgeVerdictSchema = z.object({
  verdict: z.enum(["passes", "partial", "failed"]),
  reason: z.string().min(1).max(800),
  /** Concrete items the goal asks for that are absent/empty in the
   *  previewed output. Empty for a passing verdict. */
  missing: z.array(z.string().min(1).max(300)).max(12).default([]),
});

export type PreviewJudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export type PreviewJudgeOutcome =
  | { verdict: "passes" | "partial" | "failed"; reason: string; missing: string[] }
  | { verdict: "skipped"; reason: "no_goal" | "judge_unavailable" };

/** One step's evidence fed to the judge. Built from the dry-run step
 *  summaries; previews are pre-truncated by the builder below. */
export interface JudgeStepArtifact {
  step_id: string;
  kind: string;
  status: string;
  output_preview?: unknown;
  /**
   * Materialized-but-not-dispatched request from a hold-writes preview
   * (parallel packet). Read duck-typed off the step summary's
   * `request_meta.held_request` / held status marker when present —
   * the judge evaluates the would-be payload (e.g. the email HTML)
   * BEFORE anything is sent. No compile-time dependency on the
   * hold-writes types.
   */
  held_request?: unknown;
}

export interface JudgePreviewParams {
  /** The user's goal, verbatim. */
  goal: string;
  /** Compact definition summary — step ids / kinds / descriptions. */
  definition_summary: string;
  step_artifacts: JudgeStepArtifact[];
  /** The workflow's RESOLVED final output (post `output_transform` /
   *  response_filters) — what the caller actually receives. The format check
   *  evaluates THIS, not the step artifacts: a workflow can render a markdown
   *  table in an intermediate step that a later output_transform discards, so
   *  the steps can show the format while the final output does not. `null` /
   *  undefined for a hold-writes preview where no real final output exists →
   *  the check falls back to the last step artifact. */
  final_output?: unknown;
  tenant_id: string;
  db?: Executor;
  /** Turn/pipeline abort signal (P1) — threaded into the judge's
   *  `invoke()` so a wedged judge call is bounded by the turn. The 90s
   *  provider ceiling applies regardless. */
  signal?: AbortSignal;
}

/**
 * Stable whole-definition identity for the circuit-breaker:
 * sha256[:16] of the canonical JSON (key order can never flip the
 * hash). Same convention as `step-fingerprint.ts`, scoped to the full
 * definition because the judge evaluates the workflow's OUTPUT, not a
 * single step.
 */
export function workflowDefinitionFingerprint(definition: unknown): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex").slice(0, 16);
}

/** Compact `- <id> (<kind>): <description>` lines for the prompt. */
export function buildJudgeDefinitionSummary(steps: ReadonlyArray<Record<string, unknown>>): string {
  return steps
    .map((step) => {
      const id = typeof step.id === "string" ? step.id : "(no-id)";
      const kind = typeof step.kind === "string" ? step.kind : "unknown";
      const description =
        typeof step.description === "string" && step.description.length > 0
          ? `: ${step.description.slice(0, 160)}`
          : "";
      return `- ${id} (${kind})${description}`;
    })
    .join("\n");
}

interface JudgeSourceStep {
  step_key: string;
  kind: string;
  status: string;
  output_preview?: unknown;
  request_meta?: unknown;
}

/** Duck-typed read of a held/materialized request recorded by a
 *  hold-writes preview, without importing execution types. The engine
 *  records it at the TOP LEVEL of the step entry (`steps[].held_request`,
 *  paired with `held: true`); `request_meta.held_request` is tolerated
 *  as a secondary channel for callers that re-nest metadata. */
function readHeldRequest(step: JudgeSourceStep): unknown {
  const top = (step as unknown as Record<string, unknown>).held_request;
  if (top !== undefined && top !== null) return top;
  const meta = step.request_meta;
  if (meta && typeof meta === "object") {
    const held = (meta as Record<string, unknown>).held_request;
    if (held !== undefined && held !== null) return held;
  }
  return undefined;
}

/**
 * Assemble the judge's step artifacts from dry-run step summaries.
 * Transform outputs are prioritized (they ARE the shaped result the
 * user will see); each preview is clipped to the per-step LLM cap
 * (~1.5KB via `truncateStepPreviewForLlm`) and lower-priority entries
 * are dropped first once the total budget is exhausted.
 */
export function buildJudgeStepArtifacts(
  steps: ReadonlyArray<JudgeSourceStep>,
): JudgeStepArtifact[] {
  // Skipped steps carry no output and no held_request — feeding them to
  // the judge as "missing data" would cause it to flag the workflow as
  // incomplete (the A4 judge-loop root cause).
  const eligible = steps.filter((s) => s.status !== "skipped");
  const prioritized = [...eligible].sort((a, b) => {
    const score = (s: JudgeSourceStep): number =>
      s.kind === "transform" ? 0 : readHeldRequest(s) !== undefined ? 1 : 2;
    return score(a) - score(b);
  });
  const byPriority: Array<{ artifact: JudgeStepArtifact; size: number }> = [];
  let total = 0;
  for (const step of prioritized) {
    const artifact: JudgeStepArtifact = {
      step_id: step.step_key,
      kind: step.kind,
      status: step.status,
    };
    if (step.output_preview !== undefined && step.output_preview !== null) {
      artifact.output_preview = truncateStepPreviewForLlm(step.output_preview).data;
    }
    const held = readHeldRequest(step);
    if (held !== undefined) {
      artifact.held_request = truncateStepPreviewForLlm(held).data;
    }
    let size: number;
    try {
      size = JSON.stringify(artifact)?.length ?? 0;
    } catch {
      continue;
    }
    if (total + size > ARTIFACTS_TOTAL_BUDGET_CHARS && byPriority.length > 0) continue;
    byPriority.push({ artifact, size });
    total += size;
  }
  // Restore definition order for the prompt — priority only decided
  // which entries survive the budget, not how they read.
  const order = new Map(steps.map((s, i) => [s.step_key, i]));
  return byPriority
    .map((e) => e.artifact)
    .sort((a, b) => (order.get(a.step_id) ?? 0) - (order.get(b.step_id) ?? 0));
}

function renderArtifacts(artifacts: JudgeStepArtifact[]): string {
  try {
    return JSON.stringify(artifacts, null, 1) ?? "[]";
  } catch {
    return "(step artifacts not serialisable)";
  }
}

function buildJudgePrompt(params: JudgePreviewParams): string {
  return [
    "Judge whether a workflow's previewed output satisfies the user's goal.",
    "",
    "User goal (verbatim):",
    '"""',
    params.goal,
    '"""',
    "",
    "Workflow definition (step ids, kinds, descriptions):",
    params.definition_summary,
    "",
    "Recorded step outputs from the preview. Transform steps carry the shaped result the user will see; `held_request` entries are fully-materialized outbound payloads that have NOT been sent yet. Every entry is truncated:",
    "```json",
    renderArtifacts(params.step_artifacts),
    "```",
    "",
    "Verdict rules:",
    '- "passes": the output satisfies the goal. Minor cosmetic differences are fine — EXCEPT output format (see below).',
    '- "partial": the output mostly satisfies the goal, but something the goal explicitly asks for is missing or empty.',
    '- "failed": the output does not satisfy the goal.',
    '- `missing` lists each concrete item the goal asks for that is absent or empty in the output (e.g. "project names are empty strings", "droplet specs (CPU/memory/disk) absent"). Empty when the verdict is "passes".',
    "- Judge CONTENT, not cosmetic style. An empty value where the goal requires data is never a pass.",
    '- NAMED-FIELD COMPLETENESS: every field, column, or property the goal EXPLICITLY names must be present in the output. A table missing a column the goal listed, or an object missing a key the goal asked for, is at most "partial", never "passes" — list each absent named field in `missing`. Concretely: if the goal asks for a table with columns [Title, points, stars, language] and the output table\'s header row is only [Title, points], that is "partial" with missing [stars, language] — do NOT pass it just because the rows present look well-formed. (Only judge fields the goal actually names; do not invent requirements. An EMPTY result set — zero data rows — is exempt: there is no data for the columns to carry.)',
    '- CRITERIA/FILTER CONSISTENCY: if the goal restricts the result to a subset (a filter like "offline", "failed", "unpaid", "by <author>", "in <category>"), the output must not contain items whose own values VISIBLY VIOLATE that restriction — that means the filter was not applied → "failed". Concretely: goal "digest of OFFLINE (not connected) chargers" and an output row shows the charger as `connected`/`HEALTHY`/`active` → the offline filter was NOT applied → "failed", even if the table itself is well-formed. Judge only against restrictions the goal states and values visible in the output; an unverifiable count (the goal asks for N and fewer are shown, with no way to know how many exist) is NOT a violation on its own.',
    '- OUTPUT FORMAT IS PART OF THE GOAL when the goal names one. If the goal asks for "a markdown table", "CSV", "an HTML body", or "a bulleted list", the rendered output MUST be in that exact format (a markdown table needs a header row, a `| --- |` separator, and one row per record). Correct data returned in the wrong shape (e.g. a JSON array when a markdown table was asked for) is "partial", NOT "passes" — list the missing format in `missing`.',
    "",
    "Return ONLY the JSON object { verdict, reason, missing }.",
  ].join("\n");
}

function coerceToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * The rendered output the format check evaluates, coerced to a string.
 *
 * Prefers the workflow's RESOLVED final output (`params.final_output`, post
 * output_transform / response_filters) — that is what the caller actually
 * receives. This matters because a workflow can render a markdown table in an
 * intermediate `render` step that a later output_transform then discards: the
 * step artifacts would show the format while the final output does not, and
 * the goal ("return a markdown table") is about the final output. Falls back
 * to the last step artifact only when no final output exists (a hold-writes
 * preview). A structured (object) output is JSON-stringified, so it correctly
 * fails a "markdown table" / "CSV" check rather than slipping through.
 */
function extractRenderedOutput(params: JudgePreviewParams): {
  rendered: string;
  source: "final_output" | "step_artifacts";
} {
  if (params.final_output !== undefined && params.final_output !== null) {
    return { rendered: coerceToString(params.final_output), source: "final_output" };
  }
  const last = params.step_artifacts[params.step_artifacts.length - 1];
  return { rendered: coerceToString(last?.output_preview), source: "step_artifacts" };
}

/**
 * Run the judge. Never throws. Infrastructure failures (provider
 * error, quota exhaustion, contract drift) return the typed
 * `{verdict:"skipped", reason:"judge_unavailable"}` outcome with a
 * `judge.unavailable` warn log — the commit proceeds exactly as today.
 */
export async function judgePreview(params: JudgePreviewParams): Promise<PreviewJudgeOutcome> {
  try {
    const result = await invoke(
      {
        flow: "judge",
        tenant_id: params.tenant_id,
        user_turns: [{ role: "user", content: buildJudgePrompt(params) }],
        schema: JudgeVerdictSchema,
        ...(params.signal ? { signal: params.signal } : {}),
      },
      params.db,
    );
    const parsed = JudgeVerdictSchema.safeParse(result.object);
    if (!parsed.success) {
      logger.warn({
        module: "conversations",
        action: "judge.unavailable",
        msg: "preview judge returned no structured {verdict, reason, missing} object — skipping (commit proceeds)",
        tenant_id: params.tenant_id,
      });
      return { verdict: "skipped", reason: "judge_unavailable" };
    }
    // Deterministic format-fidelity guard. When the goal NAMES a concrete
    // output format and the judge would otherwise pass, verify the rendered
    // output actually carries that format's structural signature. A miss
    // downgrades passes→partial so it flows through the existing block path
    // (never silent) and feeds `missing` into the repair loop. Gated on the
    // goal naming a format, so plain-data goals are untouched (no false
    // blocks). The LLM rubric alone is unreliable here — this is the hard,
    // unit-testable guard.
    if (parsed.data.verdict === "passes") {
      const fmt = detectNamedOutputFormat(params.goal);
      if (fmt) {
        const { rendered, source } = extractRenderedOutput(params);
        const check = outputMatchesFormat(fmt, rendered);
        // Always log the format-check decision (greppable diagnosis of this
        // exact failure class): the named format, whether the FINAL output
        // matched, which corpus was checked (final_output vs the step-artifact
        // fallback), and which checks failed on a miss.
        logger.info({
          module: "conversations",
          action: "preview_judge.format_check",
          msg: "goal names an output format — checked the final output for that format",
          tenant_id: params.tenant_id,
          named_format: fmt,
          checked_source: source,
          matched: check.ok,
          ...(check.ok ? {} : { failed_checks: check.missing }),
        });
        if (!check.ok) {
          logger.warn({
            module: "conversations",
            action: "preview_judge.format_mismatch",
            msg: "goal names an output format but the previewed output is not rendered as that format — verdict downgraded passes→partial",
            tenant_id: params.tenant_id,
            named_format: fmt,
            failed_checks: check.missing,
          });
          return {
            verdict: "partial",
            reason: `The goal asks for output as a ${fmt.replace("_", " ")}, but the previewed output is not rendered in that format.`,
            missing: check.missing,
          };
        }
      }
    }
    return {
      verdict: parsed.data.verdict,
      reason: parsed.data.reason,
      missing: parsed.data.missing,
    };
  } catch (err) {
    logger.warn({
      module: "conversations",
      action: "judge.unavailable",
      msg: "preview judge LLM call failed — skipping (commit proceeds)",
      tenant_id: params.tenant_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { verdict: "skipped", reason: "judge_unavailable" };
  }
}
