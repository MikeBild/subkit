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

const AUTHORING_NOUN = "workflows?|pipelines?";

const CONNECTOR_OBJECT_REJECT = new RegExp(
  String.raw`\b(?:${AUTHORING_VERBS.join("|")})\b\s+(?:a|an|the|new|my|some|einen|eine|ein|neuen|neue|neues|den|die|das)?\s*connectors?\b`,
  "i",
);

const ENUMERATION_PREFIX_REJECT = new RegExp(
  String.raw`\b(?:list|show|search|find|zeige|liste|suche|finde|display|enumerate)\b.{0,40}\b(?:${AUTHORING_NOUN})\b`,
  "i",
);

const PROXIMITY_WINDOW = 20;

const VERB_TO_NOUN = new RegExp(
  String.raw`\b(?:${AUTHORING_VERBS.join("|")})\b[^.;!?\n]{0,${PROXIMITY_WINDOW}}\b(?:${AUTHORING_NOUN})\b`,
  "i",
);
const NOUN_TO_VERB = new RegExp(
  String.raw`\b(?:${AUTHORING_NOUN})\b[^.;!?\n]{0,${PROXIMITY_WINDOW}}\b(?:${AUTHORING_VERBS.join("|")})\b`,
  "i",
);

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

export function matchesPositiveWorkflowCreationPattern(text: string, pattern: RegExp): boolean {
  return hasUnnegatedMatch(text, pattern);
}

export function matchesWorkflowAuthoringPattern(text: string): boolean {
  if (CONNECTOR_OBJECT_REJECT.test(text)) return false;
  if (ENUMERATION_PREFIX_REJECT.test(text)) return false;
  return hasUnnegatedMatch(text, VERB_TO_NOUN) || hasUnnegatedMatch(text, NOUN_TO_VERB);
}

export function detectAuthoringIntent(message: string | null | undefined): boolean {
  if (!message) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  return matchesWorkflowAuthoringPattern(trimmed);
}
