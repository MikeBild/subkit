// Deterministic stage-gating of the micro-authoring tools (Fix A).
//
// `propose_step` and `update_param` refuse with a typed
// `authoring_stage_violation` ONLY while the draft is in its INITIAL
// stage — defined as "this draft has never had a recorded preview AND
// carries no recorded-eval/judge findings". The moment a preview or
// findings exist, both tools unlock unconditionally: repair + tweak
// flows are untouched (including "change the limit to 5" on a
// committed workflow, which always has preview history in the
// conversation that committed it).
//
// Why an in-tool early check instead of the `tool-policies.ts`
// prerequisite seam: the policy resolver (`resolveToolMode`,
// `prerequisites`) is pure over `(tool, input, overrides)` and runs in
// `sdk-wrap` BEFORE the tool executes — it has no draft access, and its
// prerequisite vocabulary is "skill slugs", not draft evidence.
// Threading the draft through it would widen a deliberately pure seam
// for two callers. The tools already own draft-aware refusals
// (`buildGateError`); the stage gate is one more, sharing this single
// predicate so gate and tests cannot drift.
//
// Deadlock-impossibility by construction: the refusal's
// `next_best_actions` are exactly `GATE_RECOMMENDED_ACTIONS`
// (`author_workflow`, `build_workflow`, `dry_run_workflow`,
// `edit_workflow_patch`) — none of which is ever stage-gated — and
// following any of them produces the unlock evidence:
//   - `author_workflow` / `build_workflow` emit a complete draft whose
//     recorded-eval findings (when present) ride the persisted tool
//     output (read back here),
//   - `dry_run_workflow` records `latest_preview` (even a failed
//     preview is recorded evidence),
//   - `edit_workflow_patch` is the whole-definition repair path and is
//     never gated at all.
// The deadlock test asserts GATED_TOOLS ∩ GATE_RECOMMENDED_ACTIONS = ∅.

import { and, desc, eq, inArray } from "drizzle-orm";
import { conversationToolCalls } from "../../db/schema/index.ts";
import type { DraftDocument } from "../types.ts";
import { buildGateError } from "./authoring-contract.ts";
import type { ToolContext, ToolResult } from "./index.ts";

/** The micro-tools subject to initial-stage gating. */
export const GATED_TOOLS: ReadonlyArray<string> = ["propose_step", "update_param"];

/** The refusal's recommended next actions. NONE of these may ever be
 *  stage-gated — the deadlock-impossibility test pins this. */
export const GATE_RECOMMENDED_ACTIONS: ReadonlyArray<string> = [
  "author_workflow",
  "build_workflow",
  "dry_run_workflow",
  "edit_workflow_patch",
];

/** Tools whose persisted outputs may carry a `recorded_eval` report —
 *  findings there count as unlock evidence even before any preview. */
const RECORDED_EVAL_CARRIERS: ReadonlyArray<string> = [
  "author_workflow",
  "build_workflow",
  "edit_workflow_patch",
];

/** How many recent tool-call rows to scan for recorded-eval findings.
 *  Mirrors the bounded window `build_workflow` uses for its critic
 *  anti-loop check. */
const FINDINGS_SCAN_LIMIT = 16;

/** Pure half of the predicate: evidence readable off the draft alone.
 *  A recorded preview (even a failed one) or any judge state means the
 *  draft has left its initial stage. */
export function draftHasStageEvidence(draft: DraftDocument): boolean {
  if (draft.latest_preview !== null && draft.latest_preview !== undefined) return true;
  if (draft.state?.judge_breaker) return true;
  return false;
}

function outputCarriesRecordedEvalFindings(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const data = (output as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const recordedEval = (data as { recorded_eval?: unknown }).recorded_eval;
  if (!recordedEval || typeof recordedEval !== "object") return false;
  return (recordedEval as { ok?: unknown }).ok === false;
}

/**
 * Evaluate the initial-stage gate for one micro-tool call.
 *
 * Returns `null` when the call may proceed; otherwise the typed
 * `authoring_stage_violation` refusal. Reads only existing state: the
 * draft (`latest_preview`, judge breaker) and — only when the draft
 * check alone would gate — the conversation's recent persisted tool
 * outputs for recorded-eval findings.
 */
export async function evaluateAuthoringStageGate(
  ctx: ToolContext,
  tool: string,
): Promise<ToolResult | null> {
  // Self-scoping: only the declared micro-tools are ever gated. This
  // makes the deadlock-impossibility property mechanical — a future
  // caller wiring the gate into one of the RECOMMENDED actions gets a
  // no-op instead of a circular refusal.
  if (!GATED_TOOLS.includes(tool)) return null;
  const draft = ctx.getDraft();
  if (draftHasStageEvidence(draft)) return null;

  // No preview/judge evidence on the draft — check whether a one-shot
  // build already surfaced recorded-eval findings this conversation
  // (the model may legitimately need update_param to apply a proposed
  // repair before the first preview).
  try {
    const rows = await ctx.db
      .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, ctx.tenant_id),
          eq(conversationToolCalls.conversation_id, ctx.conversation_id),
          inArray(conversationToolCalls.tool, [...RECORDED_EVAL_CARRIERS]),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(FINDINGS_SCAN_LIMIT);
    for (const row of rows) {
      if (outputCarriesRecordedEvalFindings(row.output)) return null;
    }
  } catch {
    // Best-effort: a DB blip must never wedge the micro-tools shut
    // harder than the draft evidence alone justifies — fail OPEN.
    return null;
  }

  return {
    ok: false,
    data: buildGateError(draft, {
      error_code: "authoring_stage_violation",
      message:
        `\`${tool}\` is a repair-stage tool — it applies a specific finding to an already-designed draft. ` +
        "This draft is still in its initial stage (no recorded preview, no recorded-eval findings). " +
        "Design once and emit once instead: call `author_workflow` with the user's goal (one call returns a complete, evaluated draft), " +
        "then `dry_run_workflow` to record a preview. Both unlock this tool.",
      recommended_mode: "workflow",
      next_best_actions: [...GATE_RECOMMENDED_ACTIONS],
      extra: {
        gated_tool: tool,
        unlocks_when: [
          "a recorded preview exists (dry_run_workflow — even a failed preview counts)",
          "recorded-eval or judge findings exist (author_workflow / build_workflow / edit_workflow_patch results)",
        ],
      },
    }),
  };
}
