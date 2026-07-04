// Authoring-intent detection — seeds the first step on the right model
// AND is the single source of truth for "user wants to start a new
// workflow" pattern matching (also consumed by
// `conversations/intent-detector.ts`).
//
// The conversation loop resolves the per-turn model via
// `effectiveModel = p.model_override ?? route.primary`. The tenant
// default (memory: 2026-05-22) is Haiku 4.5 for cost. Haiku is fine for
// enumeration / read-heavy turns, but on a workflow-authoring turn it
// loops on the authoring guardrails — the production logs from
// 2026-05-23 c322e0ca + the 04:37-04:39 incident show
// `build a workflow called X` repeatedly choosing `run_workflow`
// instead of `build_workflow` / `propose_step` / `save_workflow_draft`.
//
// The step-router's existing `model_swapped` ladder only fires on
// *later* steps (repair signal, hard stage, etc). We need the *first*
// step to run on the documented authoring-quality default — Sonnet 4.6
// — so the model picks the right tool the first time round. This
// detector is the deterministic seed for that decision.
//
// Kept intentionally as a pure regex pass: no LLM classifier, no
// network, no DB. Easy to unit-test, cheap to call once per turn.

/** Opus 4.8 — authoring-quality seed for the FIRST step of an
 *  authoring turn. Raised from Sonnet 4.6 after the publish-ready-essays
 *  incident: even Sonnet-seeded authoring turns (the user message
 *  contained `build_workflow`, so `detectAuthoringIntent` matched and
 *  Sonnet was selected) repeatedly chose `run_workflow` instead of
 *  `build_workflow`, looping on the principal/input guardrails until the
 *  caps stopped the turn. Opus follows the explicit "call build_workflow,
 *  not run_workflow" instruction reliably. This model is paid only on
 *  authoring-intent turns (infrequent), so the tenant's cheap default
 *  still covers enumeration / read / execute turns. Single string literal
 *  so the source-of-truth lives next to the detector that needs it;
 *  `claude-opus-4-8` is the top of the step-router escalation ladder, so a
 *  hard-turn escalation from this seed is a genuine no-op (already top)
 *  rather than the dead 4-7→4-7 it used to be. */
export const AUTHORING_INITIAL_MODEL = "claude-opus-4-8";

// English + German authoring verbs the user actually types when
// starting a workflow build. Verbs are anchored with `\b` so substrings
// like "rebuild" don't false-positive. The full alternation lives on
// one regex source so a single match decides the case.
//
// This list is the UNION of the verbs that used to live in two places
// (this file and `conversations/intent-detector.ts`'s
// `NEW_WORKFLOW_PATTERNS`); `intent-detector.ts` now imports
// `WORKFLOW_AUTHORING_PATTERN` below instead of maintaining its own.
const AUTHORING_VERBS = [
  "build",
  "create",
  "make",
  "start",
  "generate",
  "design",
  "author",
  "erstelle",
  "erstell",
  "erstellen",
  "baue",
  "bau",
  "bauen",
  "mache",
  "starte",
  "erzeuge",
  "erzeugen",
] as const;

// Noun the verb must be aimed at — `workflow` and `pipeline`, singular
// or plural. Matches the existing `intent-detector.ts` style
// (`workflows?|pipelines?`) instead of the long enumeration the
// previous version of this file used.
const AUTHORING_NOUN = "workflows?|pipelines?";

// Connector-object reject — when the authoring verb is followed by a
// connector noun BEFORE the workflow noun, the verb's object is the
// connector, not the workflow. Drops false-positives like:
//   "build a connector for the daily-report workflow"
//   "create a new connector that feeds the invoices workflow"
// Anchored to the same proximity window so a connector noun anywhere
// between the verb and the workflow noun rejects the match.
const CONNECTOR_OBJECT_REJECT = new RegExp(
  String.raw`\b(?:${AUTHORING_VERBS.join("|")})\b\s+(?:a|an|the|new|my|some|einen|eine|ein|neuen|neue|neues|den|die|das)?\s*connectors?\b`,
  "i",
);

// Enumeration-prefix reject — when an enumeration verb precedes the
// workflow noun (the user is listing / showing / searching workflows,
// possibly filtered by a relative clause that mentions "build"), the
// noun→verb direction must NOT match because the user's intent is
// enumeration, not authoring. Drops phrases like:
//   "list my workflows that build X"
//   "search workflows that build invoices"
//   "show workflows I want to build"
// The verb→noun direction is unaffected because in those phrases the
// authoring verb sits AFTER the workflow noun.
const ENUMERATION_PREFIX_REJECT = new RegExp(
  String.raw`\b(?:list|show|search|find|zeige|liste|suche|finde|display|enumerate)\b.{0,40}\b(?:${AUTHORING_NOUN})\b`,
  "i",
);

// Proximity window between verb and noun — shortened from 40 to 20
// characters. Legitimate phrases ("build a workflow called X",
// "erstelle einen neuen workflow", "create a new pipeline") fit; long
// enumeration phrases with intervening clauses ("list my workflows
// that build X", "search workflows that build invoices") miss because
// the workflow noun precedes the verb at a wider gap than 20.
const PROXIMITY_WINDOW = 20;

// One regex per direction (verb→noun, noun→verb) so a sentence like
// "build me a workflow" and "a workflow I want to build" both match.
// The detector is intentionally narrow: it requires both a verb and
// the workflow noun within a short window. Phrases like "list
// workflows", "run workflow X", "delete the workflow" do not contain
// any of the authoring verbs and therefore do not match.
const VERB_TO_NOUN = new RegExp(
  String.raw`\b(?:${AUTHORING_VERBS.join("|")})\b.{0,${PROXIMITY_WINDOW}}\b(?:${AUTHORING_NOUN})\b`,
  "i",
);
const NOUN_TO_VERB = new RegExp(
  String.raw`\b(?:${AUTHORING_NOUN})\b.{0,${PROXIMITY_WINDOW}}\b(?:${AUTHORING_VERBS.join("|")})\b`,
  "i",
);

/**
 * Canonical "user wants to author a new workflow" pattern. Exported so
 * `conversations/intent-detector.ts` can reuse it for its
 * `startNewWorkflow` signal instead of maintaining a parallel list of
 * verbs that drifts (this consolidation closes SHOULD-FIX 4 from the
 * 6.0.3 hotfix review). Matches when either direction (verb→noun or
 * noun→verb) hits AND the connector-object reject does not.
 */
export function matchesWorkflowAuthoringPattern(text: string): boolean {
  if (CONNECTOR_OBJECT_REJECT.test(text)) return false;
  if (ENUMERATION_PREFIX_REJECT.test(text)) return false;
  return VERB_TO_NOUN.test(text) || NOUN_TO_VERB.test(text);
}

/**
 * Detect whether the user's most recent message expresses authoring
 * intent for a workflow. Pure, deterministic, dependency-free. Returns
 * `false` for empty / whitespace-only / null input and for the common
 * read / execute phrases ("list workflows", "run workflow X", "delete
 * the workflow"). Returns `true` when an authoring verb sits within a
 * short window of the workflow noun in either order AND no connector
 * noun intervenes between the verb and the workflow noun.
 */
export function detectAuthoringIntent(message: string | null | undefined): boolean {
  if (!message) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  return matchesWorkflowAuthoringPattern(trimmed);
}

/**
 * Decide which model the conversation loop should seed for the FIRST
 * step of a turn. Precedence (highest first):
 *   1. Explicit per-conversation override (`p.model_override`, sourced
 *      from `conversations.model`) — always wins. The operator picked
 *      this model deliberately; we never second-guess it.
 *   2. Authoring-intent seed — Sonnet 4.6 when `detectAuthoringIntent`
 *      flags the user's message, regardless of how cheap the tenant
 *      default is. This trades a small Sonnet cost for not looping on
 *      Haiku authoring guardrails (production-observed 04:37-04:39).
 *   3. Tenant default (`route.primary`) — the resolved
 *      `tenant_llm_settings` / config / `DEFAULT_PRIMARY` chain.
 *
 * Returning a single decision struct keeps the resolution testable
 * without running the full conversation loop.
 */
export interface InitialModelDecision {
  /** The model id the loop should resolve and pass to streamText. */
  modelId: string;
  /** True when the authoring-intent branch picked the model. */
  authoringSeeded: boolean;
}

export function resolveInitialModel(params: {
  modelOverride: string | null | undefined;
  tenantDefault: string;
  recentUserMessage: string | null | undefined;
}): InitialModelDecision {
  if (params.modelOverride != null) {
    return { modelId: params.modelOverride, authoringSeeded: false };
  }
  if (detectAuthoringIntent(params.recentUserMessage)) {
    return { modelId: AUTHORING_INITIAL_MODEL, authoringSeeded: true };
  }
  return { modelId: params.tenantDefault, authoringSeeded: false };
}
