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

const CONNECTOR_VERBS = [
  ...AUTHORING_VERBS,
  "add",
  "set\\s+up",
  "connect",
  "wire\\s+up",
  "hook\\s+up",
  "lege",
  "anlegen",
  "richte",
  "einrichten",
  "verbinde",
  "anbinden",
] as const;

const CONNECTOR_NOUN = String.raw`connectors?|integrations?|konnektoren?|integrationen?|mcp[\s-]?servers?`;

const ONBOARDING_REQUEST = /\bonboarding\b/i;

const CONNECTOR_ENUMERATION_REJECT = new RegExp(
  String.raw`\b(?:list|show|search|find|zeige|liste|suche|finde|display|enumerate|welche|which)\b.{0,40}\b(?:${CONNECTOR_NOUN})\b`,
  "i",
);

const CONNECTOR_VERB_TO_NOUN = new RegExp(
  String.raw`\b(?:${CONNECTOR_VERBS.join("|")})\b[^.;!?\n]{0,${PROXIMITY_WINDOW}}\b(?:${CONNECTOR_NOUN})\b`,
  "i",
);
const CONNECTOR_NOUN_TO_VERB = new RegExp(
  String.raw`\b(?:${CONNECTOR_NOUN})\b[^.;!?\n]{0,${PROXIMITY_WINDOW}}\b(?:${CONNECTOR_VERBS.join("|")})\b`,
  "i",
);

export function detectConnectorAuthoringIntent(message: string | null | undefined): boolean {
  const trimmed = message?.trim();
  if (!trimmed) return false;
  if (CONNECTOR_ENUMERATION_REJECT.test(trimmed)) return false;
  return (
    hasUnnegatedMatch(trimmed, ONBOARDING_REQUEST) ||
    hasUnnegatedMatch(trimmed, CONNECTOR_VERB_TO_NOUN) ||
    hasUnnegatedMatch(trimmed, CONNECTOR_NOUN_TO_VERB)
  );
}

const REPAIR_VERBS = [
  "repair",
  "fix",
  "debug",
  "diagnose",
  "troubleshoot",
  "reparier(?:e|en|t)?",
  "behebe",
  "beheben",
  "diagnostizier(?:e|en)?",
  "untersuche",
] as const;

const RUN_NOUN = String.raw`workflows?|pipelines?|runs?|executions?|steps?|lauf|läufe|laufs|ausführung(?:en)?|schritte?s?`;

const REPAIR_VERB_TO_NOUN = new RegExp(
  String.raw`\b(?:${REPAIR_VERBS.join("|")})\b[^.;!?\n]{0,${PROXIMITY_WINDOW}}(?<![\p{L}])(?:${RUN_NOUN})(?![\p{L}])`,
  "iu",
);
const REPAIR_NOUN_TO_VERB = new RegExp(
  String.raw`(?<![\p{L}])(?:${RUN_NOUN})(?![\p{L}])[^.;!?\n]{0,${PROXIMITY_WINDOW}}\b(?:${REPAIR_VERBS.join("|")})\b`,
  "iu",
);
const FAILURE_QUESTION = new RegExp(
  String.raw`\b(?:why|warum|wieso|weshalb)\b[^.;!?\n]{0,60}?(?<![\p{L}])(?:${RUN_NOUN})(?![\p{L}])[^.;!?\n]{0,60}?(?<![\p{L}])(?:fail(?:s|ed|ing)?|fehlgeschlagen|gescheitert|abgebrochen|broke|broken|kaputt)(?![\p{L}])`,
  "iu",
);

export function detectRepairIntent(message: string | null | undefined): boolean {
  const trimmed = message?.trim();
  if (!trimmed) return false;
  return (
    hasUnnegatedMatch(trimmed, REPAIR_VERB_TO_NOUN) ||
    hasUnnegatedMatch(trimmed, REPAIR_NOUN_TO_VERB) ||
    FAILURE_QUESTION.test(trimmed)
  );
}
