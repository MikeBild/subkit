// Shared intent-detection regexes for the conversation pipeline.
//
// Both the fast-path matcher (`fast-path.ts`) and the LLM-path
// authoring-mode bias (`loop.ts`) need to recognise the same run-verb
// shape. Hoisting them here keeps the two surfaces aligned and lets
// `loop.ts` import from a peer file rather than reaching into
// `fast-path.ts` internals.

/**
 * Anchored to the start of the trimmed message so a run command
 * embedded mid-sentence ("if today is friday, run X") does NOT match —
 * that's the LLM-mediated branch. Covers bilingual verbs incl. the
 * German separable shape `führe foo aus`.
 */
export const RUN_VERB_RE =
  /^(run|execute|starte|f[uü]hre)\s+(?:die\s+|the\s+)?(?:workflow\s+)?([a-z0-9_][a-z0-9_-]*)(?:\s+aus)?\s*$/i;

/**
 * `inspect execution <uuid>` — anchored, accepts en + de verbs. Used by
 * the fast-path read-side renderer.
 */
export const INSPECT_EXEC_RE =
  /^(inspect|show|zeige)\s+(?:the\s+|die\s+)?execution\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;

/**
 * Closed list of affirmation tokens (en + de). Used by the fast-path
 * confirmation-resume branch to recognise an operator approving the
 * pending workflow run from the prior turn. Shared here so the LLM path
 * can opt into the same set (e.g. prose-confirmation dedupe) without
 * the two surfaces drifting. Tokens outside the set fall through to
 * the LLM, which handles fuzzier shapes.
 */
export const AFFIRM_RE =
  /^(yes|yep|yeah|y|ok|okay|ack|approve|approved|do it|go|run it|sí|si|ja|jo|los|bestätigt|confirm)\.?!?$/i;
