// Detect explicit user intent from the latest user message so the
// conversation loop can steer the LLM via `tool_choice` instead of
// relying on `toolChoice="auto"` and hoping the model picks the right
// tool. The screenshot bug where the assistant said "Der Workflow
// filtert bereits korrekt" without ever running the workflow is
// exactly the failure mode this guards against.
//
// The detector is intentionally conservative: it matches only strong
// signals (explicit verbs like "ausführen" / "run" / "execute") so
// false-positives don't hijack benign messages. When no strong signal
// is present, the caller falls back to `toolChoice="auto"`.

import {
  matchesPositiveWorkflowCreationPattern,
  matchesWorkflowAuthoringPattern,
} from "./loop/authoring-intent.ts";
import type { AuthoringSummary, ConversationPermissionMode } from "./types.ts";

export interface DetectedIntent {
  /** The tool the user most likely wants the model to call. Empty when
   *  no strong intent was detected. */
  forceTool?: string;
  /**
   * When true, the caller should detach the conversation from the
   * currently selected saved workflow before authoring. This covers
   * explicit "create a workflow" / "another workflow" phrasing so a
   * fresh workflow draft does not inherit an old save target.
   */
  startNewWorkflow?: boolean;
  /**
   * When true, the caller should set `toolChoice: "none"` for the
   * first LLM call of this turn. Matches enumeration phrasing where
   * the TENANT SNAPSHOT block already has the answer; forcing
   * no-tools is the only reliable way to stop Sonnet-class models
   * from reflexively calling `list_workflows` even when the data is
   * already in the prompt. Set only when the snapshot lists EVERY row of
   * the kinds asked about; a trimmed snapshot forces the list tool instead.
   */
  forceNoTools?: boolean;
  /**
   * The user explicitly prohibited execution in this turn. The loop removes
   * saved-workflow execution tools even when a persisted workflow is bound,
   * so the model cannot turn an edit-only request into a run.
   */
  suppressExecution?: boolean;
  /** Human-readable reason — useful for logs / telemetry. */
  reason: string;
}

// Strong run-intent signals — both verb-anchored: an explicit execution verb
// adjacent to a workflow/pipeline noun. A previous third pattern
// (`/\bworkflow\s+.*\b(running|run)\b/i`) bridged "workflow" to "run" across an
// arbitrary `.*` span, so it matched the NEGATION "workflow … do NOT run"
// identically to a command — a core driver of the build-new hijack. It is
// removed: the verb→noun matcher covers every genuine imperative, and the
// execution-tool gate (default-deny, in authoring-palette.ts) is the structural
// backstop rather than an ever-wider regex.
const RUN_WORKFLOW_PATTERNS = [
  /\b(führe|starte|run|execute|dispatch|trigger)\s.+?\b(workflow|tool|pipeline|aus)/i,
  /\bausf[üu]hren\b/i,
];

// Explicit no-run language has to win before positive run matching. German
// separable verbs put the negation between both halves ("führe ihn nicht
// aus"), while English places it before the verb ("do not run it"). Keep the
// windows bounded so an unrelated "nicht" earlier in a long request does not
// disable an intentional run later in the message.
const NEGATED_RUN_PATTERNS = [
  /\b(?:führe|fuehre)\b.{0,80}\b(?:nicht|niemals|keinesfalls)\b.{0,24}\baus\b/i,
  /\b(?:nicht|niemals|keinesfalls)\b.{0,32}\b(?:ausführen|ausfuehren|starten|triggern|dispatchen|runnen)\b/i,
  /\b(?:do\s+not|don't|never|must\s+not)\b.{0,32}\b(?:run|execute|dispatch|trigger|start)\b/i,
];

// "neu(en|es|e) workflow" / "another workflow" / "new pipeline" —
// noun-modifier-only phrases the canonical authoring detector
// intentionally does NOT match (no authoring verb required, so it can
// also fire on "I want a new workflow" without `build|create|...`).
//
// Artifact identity matters here: "new workflow version/configuration" is
// an in-place edit of the selected workflow, not a request for a new workflow
// row. The negative suffix guard keeps those version/configuration nouns from
// detaching a conversation from its explicit `workflow_id`. This is a safety
// boundary, not only a language tweak: detaching replaces the hydrated draft
// with `new-workflow`, so the next save could otherwise target an empty/new
// artifact instead of the requested existing workflow.
// Kept here as a supplemental signal alongside the canonical pattern
// imported from `loop/authoring-intent.ts`.
const NEW_WORKFLOW_MODIFIER_PATTERN =
  /\b(neu(?:en|es|e)?|another|new)\b.{0,20}\b(workflows?|pipelines?)\b(?![-\s]*(?:version|revision|definition|configuration|config|konfiguration)\b)/i;

/**
 * Enumeration phrases — the TENANT SNAPSHOT already lists workflows,
 * connectors, and executions. Forcing `list_workflows` here would mean
 * the model had no chance to use the snapshot and would always spin
 * list_* calls. Instead we only signal "answer from prompt" and let the
 * caller pin toolChoice accordingly.
 */
// Enumeration patterns — only for resources covered by the TENANT
// SNAPSHOT (workflows + connectors). Executions are intentionally
// excluded because they are not in the snapshot and the model must
// call list_executions to answer accurately.
//
// `integrations?` is kept here for USER UTTERANCES only: many users
// still type "show my integrations" when they mean connectors. The
// regex matches their intent so they hit the snapshot path; it does
// NOT mean the entity is called "integration" anywhere in the
// codebase — the domain term is "connector". Do NOT strip this in a
// rename pass: it is the one place the legacy user-facing word is
// deliberately matched, precisely to route it onto the connector path.
const ENUMERATION_PATTERNS = [
  /\b(welche|which|list|show|zeige?|gib|wie\s*viele|how many|number of|anzahl)\b.*\b(workflows?|connectors?|integrations?)\b/i,
  /\b(workflows?|connectors?|integrations?)\b.*\b(habe ich|do i have|listen?|available|vorhanden|insgesamt)/i,
];

const WORKFLOW_NOUN_RE = /\bworkflows?\b/i;
const CONNECTOR_NOUN_RE = /\b(?:connectors?|integrations?)\b/i;

/**
 * Which kinds the TENANT SNAPSHOT lists completely this turn — the loop reads
 * it from `loadSnapshotCoverage` (`llm/core/tenant-summary.ts`). Mirrors
 * `SnapshotCoverage` structurally so the detector stays free of DB imports.
 */
export interface EnumerationCoverage {
  workflows_complete: boolean;
  connectors_complete: boolean;
  /**
   * The question names a workflow slug that exists in this tenant — it is
   * about that workflow, not an enumeration of the catalog.
   */
  names_existing_workflow?: boolean;
}

// Count wording. A count is answered by the snapshot's exact totals and
// category counts even when its rows are trimmed; a list verb beside it
// ("wie viele … und welche") still asks for the rows.
const COUNT_RE = /\b(?:wie\s*viele|how\s+many|anzahl|insgesamt|number\s+of)\b/i;
const LIST_VERB_RE = /\b(?:welche|which|list|listen?|show|zeige?|gib|nenne?)\b/i;

function isCountOnly(text: string): boolean {
  return COUNT_RE.test(text) && !LIST_VERB_RE.test(text);
}

/** True when the text is an enumeration question the snapshot could answer. */
export function matchesEnumerationIntent(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  return !!trimmed && ENUMERATION_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Enumeration steering. `toolChoice: "none"` stays for a snapshot that lists
 * every row of each kind asked about — that pin is what stopped the
 * reflexive list_* loop and its 1M-token empty turns. A TRIMMED kind is only
 * a page: withholding tools there forced an answer from the first 40 rows,
 * and the model denied workflows past the cap. So a trimmed kind forces its
 * list tool for the first step instead (the router releases it afterwards).
 *
 * Two questions look like enumerations and are not:
 * - one that names an existing workflow is about that workflow ("how many
 *   steps does customer-sync have") — no pin either way, the model picks;
 * - a count ("wie viele Workflows habe ich") needs no rows: the snapshot's
 *   totals and category counts are exact even when its rows are trimmed.
 * The named workflow is checked first: "wie viele Schritte hat
 * customer-sync" is count wording the snapshot cannot answer, and a
 * no-tools pin holds for the whole turn.
 */
function enumerationIntent(text: string, coverage: EnumerationCoverage): DetectedIntent {
  if (coverage.names_existing_workflow === true) {
    return { reason: "enumeration_names_workflow" };
  }
  if (isCountOnly(text)) {
    return { forceNoTools: true, reason: "enumeration_count_from_snapshot" };
  }
  const asksWorkflows = WORKFLOW_NOUN_RE.test(text);
  const asksConnectors = CONNECTOR_NOUN_RE.test(text);
  if (asksWorkflows && !coverage.workflows_complete) {
    return { forceTool: "list_workflows", reason: "enumeration_snapshot_trimmed" };
  }
  if (asksConnectors && !coverage.connectors_complete) {
    return { forceTool: "list_connectors", reason: "enumeration_snapshot_trimmed" };
  }
  return { forceNoTools: true, reason: "enumeration_answer_from_snapshot" };
}

const COMMIT_DRAFT_PATTERNS = [
  /\b(speichere|save|commit|persist|bewahre)\b.*\b(workflow|draft|änderungen?)/i,
];

// "Multi-artifact" intent — the user asked for BOTH a connector AND a
// workflow in one breath ("create a connector and a workflow ..."). When
// the harness auto-persists the connector, the model often emits a
// "Now let's build the workflow" closing sentence and ends the turn,
// leaving the user to retype "yes" to continue. The step-router uses
// this signal to force tool-calling on the step right after a
// successful save_connector_draft auto-persist so the model proceeds
// instead of hanging on the promise.
const MULTI_ARTIFACT_PATTERNS = [
  /\bconnectors?\b.{0,80}\b(and|und|plus|sowie|together with)\b.{0,40}\bworkflows?\b/i,
  /\bworkflows?\b.{0,80}\b(and|und|plus|sowie|together with)\b.{0,40}\bconnectors?\b/i,
];

export function detectMultiArtifactIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return MULTI_ARTIFACT_PATTERNS.some((p) => p.test(trimmed));
}

const FULL_COVERAGE: EnumerationCoverage = { workflows_complete: true, connectors_complete: true };

/** Parse the most recent user text for a strong tool intent. Returns
 *  a bare reason when no forceTool match was found. `coverage` only matters
 *  for enumeration questions; the converse loop always passes the live one. */
export function detectUserIntent(
  latestUserText: string | null | undefined,
  coverage: EnumerationCoverage = FULL_COVERAGE,
): DetectedIntent {
  if (!latestUserText) return { reason: "no_user_text" };
  const text = latestUserText.trim();
  if (!text) return { reason: "empty_user_text" };

  // Compute the authoring signal up front so a co-present build-new request can
  // never be overridden by an ambiguous run token. The canonical authoring
  // pattern from `loop/authoring-intent.ts` keeps verbs + tightening (proximity
  // window, connector-object reject) in one place; the supplemental modifier
  // pattern still fires for noun-modifier phrasings without an authoring verb.
  const authoringSignal =
    matchesWorkflowAuthoringPattern(text) ||
    matchesPositiveWorkflowCreationPattern(text, NEW_WORKFLOW_MODIFIER_PATTERN);
  if (NEGATED_RUN_PATTERNS.some((pattern) => pattern.test(text))) {
    return authoringSignal
      ? {
          startNewWorkflow: true,
          suppressExecution: true,
          reason: "authoring_intent_over_ambiguous_run",
        }
      : { suppressExecution: true, reason: "explicit_no_run_intent" };
  }
  for (const pattern of RUN_WORKFLOW_PATTERNS) {
    if (pattern.test(text)) {
      // A co-present build-new signal means the matched "run" is part of an
      // authoring request — typically a NEGATED "do NOT run the existing one"
      // or a descriptive mention, not a command. Authoring wins; run-intent is
      // not promoted to a forced tool. (When NO signal is present the
      // execution-tool gate still default-denies a lookalike run.)
      if (authoringSignal) {
        return { startNewWorkflow: true, reason: "authoring_intent_over_ambiguous_run" };
      }
      return { forceTool: "run_workflow", reason: "explicit_run_intent" };
    }
  }
  if (authoringSignal) {
    return { startNewWorkflow: true, reason: "explicit_new_workflow_intent" };
  }
  if (matchesEnumerationIntent(text)) return enumerationIntent(text, coverage);
  for (const pattern of COMMIT_DRAFT_PATTERNS) {
    if (pattern.test(text)) {
      return { forceTool: "save_workflow_draft", reason: "explicit_commit_intent" };
    }
  }

  return { reason: "no_strong_intent" };
}

/**
 * The tool the turn's first step is pinned to: the detected intent's, else
 * the state-driven follow-up — each only when the palette carries it this
 * turn. A tool missing from the palette (RBAC, surface, stage) is not forced:
 * the AI SDK would reject the call, so the turn falls back to `"auto"`.
 */
export function resolvePreferredTool(
  intent: Pick<DetectedIntent, "forceTool">,
  stateDrivenTool: string | null,
  hasTool: (name: string) => boolean,
): string | null {
  if (intent.forceTool && hasTool(intent.forceTool)) return intent.forceTool;
  if (stateDrivenTool && hasTool(stateDrivenTool)) return stateDrivenTool;
  return null;
}

/** The stream-level `toolChoice` for the turn's first step. */
export function turnToolChoice(
  preferredTool: string | null,
  forceNoTools: boolean,
): { type: "tool"; toolName: string } | "none" | "auto" {
  if (preferredTool) return { type: "tool", toolName: preferredTool };
  return forceNoTools ? "none" : "auto";
}

/** Envelope-resolver: when a pending confirm is open, parse the user's
 *  reply as an approval or rejection so "approve" / "reject" typed in
 *  chat auto-resolves the dialog instead of opening a fresh LLM turn.
 *
 *  Returns null when the text does not match a resolution verb — the
 *  envelope stays open and the next LLM turn runs normally. */
export type EnvelopeResolution = "approve" | "reject" | null;

const APPROVE_PATTERNS = [
  /^(approve|ok|okay|yes|ja|yep|yeah|sure|bestätigt?|bestätige|freigegeben|freigabe|confirm)\b/i,
  /^(ausführen|run it|execute|mach|los)\b/i,
];

const REJECT_PATTERNS = [/^(reject|no|nein|cancel|abbrechen|stop|halt|nicht|skip)\b/i];

export function detectEnvelopeResolution(userText: string | null | undefined): EnvelopeResolution {
  if (!userText) return null;
  const text = userText.trim();
  if (!text) return null;
  if (text.length > 60) return null; // a long message is not a one-word ack
  for (const p of APPROVE_PATTERNS) if (p.test(text)) return "approve";
  for (const p of REJECT_PATTERNS) if (p.test(text)) return "reject";
  return null;
}

/**
 * State-driven follow-up intent for ready save paths. In auto mode a
 * short approval like "yes" should reuse the draft's structured next
 * tool instead of relying on the model to remember which save action
 * it just offered.
 */
export function inferStateDrivenFollowUpTool(params: {
  latestUserText: string | null | undefined;
  permission_mode: ConversationPermissionMode | null;
  summary: AuthoringSummary | null | undefined;
}): string | null {
  if (params.permission_mode !== "auto") return null;
  if (detectEnvelopeResolution(params.latestUserText) !== "approve") return null;
  const suggested = params.summary?.next_suggested_tool ?? null;
  if (suggested === "save_workflow_draft" || suggested === "save_connector_draft") {
    return suggested;
  }
  return null;
}
