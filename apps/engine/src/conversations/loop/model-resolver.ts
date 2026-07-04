// SDK language-model resolution. The mock provider returns a fresh
// `MockLanguageModelV3` that reads from the shared plan-cursor
// singleton; real providers go through the provider registry (A1) so
// the `anthropic:` prefix is stripped natively.

import { resolveLanguageModel as resolveSdkModel } from "../../llm/core/invoke.ts";
import { createMockLanguageModel } from "../../llm/mock-stream.ts";
import type { LlmProviderKind } from "../../llm/types.ts";

/**
 * Per-turn step ceiling — the model gets at most this many SDK steps.
 *
 * Applied uniformly to every turn (`loop.ts`: `budget = p.step_budget ??
 * DEFAULT_BUDGET`; no caller sets `step_budget`, so this single global is
 * the cap for authoring AND non-authoring turns alike). Lowered 50 → 24:
 * an authoring turn (ground → author_workflow → dry_run_workflow → a
 * couple of repairs) fits comfortably inside 24, while 50 let the
 * build→dry_run→judge→edit churn run unbounded WITHIN one turn before any
 * stop condition fired. 24 does not starve legitimate non-authoring
 * multi-step turns: read/enumerate fan-outs are mostly single steps, and
 * the per-tool loop-breaker (`MAX_TURN_LOOP_WARNINGS = 2`) already caps
 * degenerate identical-call repeats far below 24. The no-progress
 * repair stop (`noProgressRepairStopCondition`) is the semantic belt that
 * halts a stalled authoring loop even earlier; this budget is the
 * absolute backstop.
 */
export const DEFAULT_BUDGET = 24;

/**
 * Hard cap on `experimental_repairToolCall` invocations per turn.
 * Beyond this the model is in a degenerate state and additional repair
 * calls just burn budget — surface the failure to the loop so the next
 * turn's prepareStep can escalate.
 */
export const MAX_REPAIRS_PER_TURN = 2;

/**
 * Provider tag the loop carries through `RunLoopParams.model`. `"mock"`
 * is the in-process test provider; the rest are forwarded to the SDK
 * registry. Pinning the union here (rather than `string`) means a
 * future SDK rename cannot silently land via the previous `as any`
 * cast.
 */
export type LoopProviderKind = LlmProviderKind | "mock";

export async function resolveLanguageModel(
  provider: LoopProviderKind,
  modelId: string,
  tenantId?: string,
) {
  if (provider === "mock") return createMockLanguageModel(modelId);
  return await resolveSdkModel(provider, modelId, tenantId);
}
