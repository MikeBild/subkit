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
   * already in the prompt.
   */
  forceNoTools?: boolean;
  /** Human-readable reason — useful for logs / telemetry. */
  reason: string;
}

const RUN_WORKFLOW_PATTERNS = [
  /\b(führe|starte|run|execute|dispatch|trigger)\s.+?\b(workflow|tool|pipeline|aus)/i,
  /\bausf[üu]hren\b/i,
  /\bworkflow\s+.*\b(running|run)\b/i,
];

const NEW_WORKFLOW_PATTERNS = [
  /\b(create|build|make|author|start)\b.{0,40}\b(a|an|another|new)?\s*\b(workflow|pipeline)\b/i,
  /\b(erstelle|baue|mache|starte)\b.{0,40}\b(workflow)\b/i,
  /\b(neu(?:en|es|e)?|another|new)\b.{0,24}\b(workflow|pipeline)\b/i,
];

/**
 * Enumeration phrases — the TENANT SNAPSHOT already lists workflows,
 * connectors, and executions. Pre-fix the detector forced
 * `list_workflows` here, which meant the model had no chance to use
 * the snapshot and would always spin list_* calls. Now we only signal
 * "answer from prompt" and let the caller pin toolChoice accordingly.
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
// codebase. Do NOT strip this in a rename pass — the engine's
// terminology gate (scripts/terminology.banned.txt) bans generic
// workflow-execution umbrella terms
// outright but permits `integration` precisely because of this user-
// facing case.
const ENUMERATION_PATTERNS = [
  /\b(welche|which|list|show|zeige?|gib|wieviele|how many|anzahl)\b.*\b(workflows?|connectors?|integrations?)\b/i,
  /\b(workflows?|connectors?|integrations?)\b.*\b(habe ich|do i have|listen?|available|vorhanden|insgesamt)/i,
];

const COMMIT_DRAFT_PATTERNS = [
  /\b(speichere|save|commit|persist|bewahre)\b.*\b(workflow|draft|änderungen?)/i,
];

/** Parse the most recent user text for a strong tool intent. Returns
 *  a bare reason when no forceTool match was found. */
export function detectUserIntent(latestUserText: string | null | undefined): DetectedIntent {
  if (!latestUserText) return { reason: "no_user_text" };
  const text = latestUserText.trim();
  if (!text) return { reason: "empty_user_text" };

  for (const pattern of RUN_WORKFLOW_PATTERNS) {
    if (pattern.test(text)) {
      return { forceTool: "run_workflow", reason: "explicit_run_intent" };
    }
  }
  for (const pattern of NEW_WORKFLOW_PATTERNS) {
    if (pattern.test(text)) {
      return { startNewWorkflow: true, reason: "explicit_new_workflow_intent" };
    }
  }
  for (const pattern of ENUMERATION_PATTERNS) {
    if (pattern.test(text)) {
      return { forceNoTools: true, reason: "enumeration_answer_from_snapshot" };
    }
  }
  for (const pattern of COMMIT_DRAFT_PATTERNS) {
    if (pattern.test(text)) {
      return { forceTool: "commit_draft", reason: "explicit_commit_intent" };
    }
  }

  return { reason: "no_strong_intent" };
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
  if (suggested === "commit_draft" || suggested === "save_connector_draft") {
    return suggested;
  }
  return null;
}
