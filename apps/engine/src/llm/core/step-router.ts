// step-router — prepareStep decisions for the converse loop.
//
// Default decision: pass through. Keep the model the loop already
// resolved, keep the full tool palette, do not touch system or
// providerOptions. The router only ever *upgrades* (escalates to a
// stronger model class, enables extended thinking) when a hard-step
// signal fires; it never downgrades.
//
// Wired into `streamText({ prepareStep })` in conversations/loop.ts.

import type { LanguageModel, ModelMessage } from "ai";
import type { AuthoringStage } from "../../conversations/types.ts";

/** Signals the loop computes per turn and threads into every prepareStep call. */
export interface StepRouterSignals {
  /** Active authoring stage (idle / discover / propose / commit / execute / etc). */
  stage?: AuthoringStage;
  /** Set by the loop after a tool-call repair fired in the prior step. */
  hadRepairThisTurn?: boolean;
  /** Set when the intent detector flagged a strong run-intent verb. */
  strongRunIntent?: boolean;
  /** Set after a critic verdict: "fail" earlier in this conversation. */
  priorCriticFail?: boolean;
  /** Manual one-tier-up bump from caller. */
  escalate?: boolean;
  /** Manual jump-to-top-tier from caller. */
  escalateMax?: boolean;
}

export interface StepRouterParams {
  stepNumber: number;
  steps: ReadonlyArray<unknown>;
  messages: ReadonlyArray<ModelMessage>;
  /** The model the loop already resolved (tenant default). */
  model: LanguageModel;
  signals: StepRouterSignals;
}

/**
 * Decision returned to the AI SDK's `prepareStep`. Every field is
 * optional; omitted fields mean "use what the loop already configured".
 *
 * Provider options are kept open-ended on purpose — extended thinking
 * lives there for Anthropic-class models, and other providers will
 * grow analogous knobs.
 */
export interface StepDecision {
  model?: LanguageModel;
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK ToolChoice is generic over the variadic tool set.
  toolChoice?: any;
  activeTools?: string[];
  system?: string;
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK providerOptions is provider-specific JSON.
  providerOptions?: Record<string, any>;
}

/**
 * No-op default. Step 2 fills in escalation rules; Step 1 wires the
 * call site in loop.ts. Until then, returning undefined keeps the
 * loop's existing per-step model and full palette.
 */
export function prepareStep(_params: StepRouterParams): StepDecision | undefined {
  return undefined;
}
