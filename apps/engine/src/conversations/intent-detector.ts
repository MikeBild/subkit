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

export interface DetectedIntent {
  /** The tool the user most likely wants the model to call. Empty when
   *  no strong intent was detected. */
  forceTool?: string;
  /** Human-readable reason — useful for logs / telemetry. */
  reason: string;
}

const RUN_WORKFLOW_PATTERNS = [
  /\b(führe|starte|run|execute|dispatch|trigger)\s.+?\b(workflow|tool|pipeline|aus)/i,
  /\bausf[üu]hren\b/i,
  /\bworkflow\s+.*\b(running|run)\b/i,
];

const LIST_WORKFLOWS_PATTERNS = [
  /\b(welche|which|list|show|zeige?|gib)\b.*\bworkflows?\b/i,
  /\bworkflows?\b.*\b(habe ich|do i have|listen?|available|vorhanden)/i,
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
  for (const pattern of LIST_WORKFLOWS_PATTERNS) {
    if (pattern.test(text)) {
      return { forceTool: "list_workflows", reason: "explicit_list_intent" };
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
