// Authoring-intent detection — the single source of truth for "user
// wants to start a new workflow" pattern matching (consumed by
// `conversations/intent-detector.ts` for its `startNewWorkflow` signal).
//
// This file used to ALSO pick a model. It exported an
// `AUTHORING_INITIAL_MODEL` literal that the loop seeded whenever the
// pattern matched, overriding `llm.model` / `llm.fallback_model`
// silently and unconditionally. It was introduced alongside a real bug
// fix: the first turn of `conversation_start("build a workflow ...")`
// repeatedly fired `run_workflow{}` on a not-yet-persisted draft until
// loop detection stopped it. That commit shipped TWO remedies — the
// structural one (drop `requires_persisted_workflow` tools from the
// palette while nothing is persisted) and a stronger seed model.
//
// The structural remedy is the one that holds. It now gates on live
// draft state rather than stage (`llm/core/step-router.ts`), so
// `run_workflow` is not in the palette to be mis-picked at all. The seed
// meanwhile got ratcheted sonnet-4-6 → opus-4-7 → opus-4-8 and turned
// into the most expensive path in the system: measured on production, a
// quarter of all conversations tripped it, and it carried roughly four
// fifths of the month's LLM spend for a fifth of the calls — to prevent
// a tool choice that is already structurally impossible.
//
// So the model decision lives where it is configured, and nowhere else:
// `llm.model` / `llm.fallback_model`, plus the per-conversation
// override. A turn that genuinely needs a stronger model still gets one
// through the step-router, but only on earned evidence (`prior_critic_fail`,
// repair, hard stage) rather than on a word pattern in the user's message.
//
// Kept intentionally as a pure regex pass: no LLM classifier, no
// network, no DB. Easy to unit-test, cheap to call once per turn.

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
  String.raw`\b(?:${AUTHORING_VERBS.join("|")})\b[^.;!?\n]{0,${PROXIMITY_WINDOW}}\b(?:${AUTHORING_NOUN})\b`,
  "i",
);
const NOUN_TO_VERB = new RegExp(
  String.raw`\b(?:${AUTHORING_NOUN})\b[^.;!?\n]{0,${PROXIMITY_WINDOW}}\b(?:${AUTHORING_VERBS.join("|")})\b`,
  "i",
);

// Creation intent is polarity-sensitive. A raw regex hit in
// "do not create a new workflow" or "keinen neuen Workflow erzeugen" is
// evidence for the opposite action and must never detach a conversation from
// its explicitly selected saved workflow. Keep this deterministic and local
// to the matched clause: a negation before a semicolon/full stop must not
// suppress a later positive request ("do not edit X; create a new workflow").
const AUTHORING_NEGATION =
  /\b(?:do\s+not|don't|never|must\s+not|should\s+not|shouldn't|cannot|can't|without|nicht|niemals|keinesfalls|ohne|kein(?:e|en|em|er|es)?)\b/i;
const NON_NEGATING_IDIOMS = /\b(?:not\s+only|nicht\s+nur)\b/gi;

function hasUnnegatedMatch(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? 0;
    const clauseStart = Math.max(
      text.lastIndexOf(";", index - 1),
      text.lastIndexOf(".", index - 1),
      text.lastIndexOf("!", index - 1),
      text.lastIndexOf("?", index - 1),
      text.lastIndexOf("\n", index - 1),
    );
    const prefix = text.slice(Math.max(clauseStart + 1, index - 48), index);
    const candidate = text.slice(index, index + match[0].length);
    const polarityWindow = `${prefix}${candidate}`.replace(NON_NEGATING_IDIOMS, "");
    if (!AUTHORING_NEGATION.test(polarityWindow)) return true;
  }
  return false;
}

/**
 * Apply the same clause-local polarity rule to supplemental new-artifact
 * patterns owned by the top-level intent detector (for example noun-only
 * "another workflow" phrasing). This keeps all paths that can set
 * `startNewWorkflow` on the same negation semantics.
 */
export function matchesPositiveWorkflowCreationPattern(text: string, pattern: RegExp): boolean {
  return hasUnnegatedMatch(text, pattern);
}

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
  return hasUnnegatedMatch(text, VERB_TO_NOUN) || hasUnnegatedMatch(text, NOUN_TO_VERB);
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
