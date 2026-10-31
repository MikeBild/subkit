import {
  matchesPositiveWorkflowCreationPattern,
  matchesWorkflowAuthoringPattern,
} from "./loop/authoring-intent.ts";
import type { AuthoringSummary, ConversationPermissionMode } from "./types.ts";

export interface DetectedIntent {
  forceTool?: string;
  requestExternalAction?: boolean;
  requestExternalRead?: boolean;
  startNewWorkflow?: boolean;
  forceNoTools?: boolean;
  suppressExecution?: boolean;
  suppressLiveExecution?: boolean;
  reason: string;
}

const RUN_WORKFLOW_PATTERNS = [
  /\b(führe|starte|run|execute|dispatch|trigger)\s.+?\b(workflow|tool|pipeline|aus)/i,
  /\bausf[üu]hren\b/i,
];

const EXTERNAL_ACTION_PATTERN =
  /\b(?:sende|schicke|übermittle|übertrage|melde|send|submit)\b.{0,120}\b(?:problem|fehler|anfrage|bericht|report|ticket|daten|informationen|das|dieses|this)\b.{0,80}\b(?:an|to|via|über)\b/i;

const REPORT_PROBLEM_PATTERN =
  /\b(?:melde|report)\b.{0,60}\b(?:problem|fehler|störung|bug|issue|error)\b(?!\s+(?:nicht|niemals|not|never)\b)|(?<!\bkein(?:e|en)?\s)\b(?:problem|fehler|störung|bug|issue)\b.{0,40}\bmelden\b/i;

const EXTERNAL_READ_PATTERN =
  /\b(?:wie\s+steht|status(?:\s+von)?|stand\s+(?:meiner|meines|der|des)|what\s+is\s+the\s+status|check\s+(?:the\s+)?status|show\s+(?:the\s+)?status)\b.{0,120}\b(?:anfrage|ticket|fall|vorgang|auftrag|bestellung|case|report|request|order)\b/i;

const NEGATED_RUN_PATTERNS = [
  /\b(?:führe|fuehre)\b.{0,80}\b(?:nicht|niemals|keinesfalls)\b.{0,24}\baus\b/i,
  /\b(?:führe|fuehre|starte)\b.{0,80}\b(?:keinen?|keine|keins)\b.{0,48}\b(?:neuen?\s+)?(?:lauf|workflow|tool|pipeline)\b.{0,24}\b(?:aus|starten)\b/i,
  /\b(?:nicht|niemals|keinesfalls)\b.{0,32}\b(?:ausführen|ausfuehren|starten|triggern|dispatchen|runnen)\b/i,
  /\b(?:do\s+not|don't|never|must\s+not)\b.{0,32}\b(?:run|execute|dispatch|trigger|start)\b/i,
];

const NEGATED_PREVIEW_PATTERNS = [
  /\b(?:keinen?|kein)\s+(?:test|probe|trocken)[-\s]?(?:lauf|run|durchlauf)\b/i,
  /\b(?:keinen?|kein)\s+(?:dry[-\s]?run|testlauf|probelauf)\b/i,
  /\bno\s+(?:dry[-\s]?runs?|test\s+runs?|previews?)\b/i,
  /\b(?:do\s+not|don't|never|must\s+not)\s+(?:test|dry[-\s]?run|preview)\b/i,
  /\b(?:nicht|niemals|keinesfalls)\s+(?:testen|probelaufen)\b/i,
];

const NEGATED_LIVE_PATTERNS = [
  /\b(?:keine|ohne)\b.{0,16}\blive[-\s]?(?:wirkungen?|effekte?|aktionen?|l[äa]ufe?|runs?|schreibvorg[äa]nge?)\b/i,
  /\bnichts\b.{0,16}\blive\b/i,
  /(?:^|[.;,:!]\s*|\b(?:und|aber|bitte|noch)\s+)(?:nicht|niemals|keinesfalls)\s+(?:\w+\s+)?aktivieren\b/i,
  /\baktiviere\b.{0,40}\bnicht\b/i,
  /\bno\s+live\s+(?:effects?|runs?|actions?|writes?)\b/i,
  /\b(?:do\s+not|don't|never|must\s+not)\b.{0,16}\bactivate\b/i,
];

const NEW_WORKFLOW_MODIFIER_PATTERN =
  /\b(neu(?:en|es|e)?|another|new)\b.{0,20}\b(workflows?|pipelines?)\b(?![-\s]*(?:version|revision|definition|configuration|config|konfiguration)\b)/i;

const ENUMERATION_PATTERNS = [
  /\b(welche|which|list|show|zeige?|gib|wie\s*viele|how many|number of|anzahl)\b.*\b(workflows?|connectors?|integrations?)\b/i,
  /\b(workflows?|connectors?|integrations?)\b.*\b(habe ich|do i have|listen?|available|vorhanden|insgesamt)/i,
];

const WORKFLOW_NOUN_RE = /\bworkflows?\b/i;
const CONNECTOR_NOUN_RE = /\b(?:connectors?|integrations?)\b/i;

export interface EnumerationCoverage {
  workflows_complete: boolean;
  connectors_complete: boolean;
  names_existing_workflow?: boolean;
}

const COUNT_RE = /\b(?:wie\s*viele|how\s+many|anzahl|insgesamt|number\s+of)\b/i;
const LIST_VERB_RE = /\b(?:welche|which|list|listen?|show|zeige?|gib|nenne?)\b/i;

function isCountOnly(text: string): boolean {
  return COUNT_RE.test(text) && !LIST_VERB_RE.test(text);
}

export function matchesEnumerationIntent(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  return !!trimmed && ENUMERATION_PATTERNS.some((p) => p.test(trimmed));
}

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

export const NO_SNAPSHOT_COVERAGE: EnumerationCoverage = {
  workflows_complete: false,
  connectors_complete: false,
};

export function detectUserIntent(
  latestUserText: string | null | undefined,
  coverage: EnumerationCoverage = FULL_COVERAGE,
): DetectedIntent {
  if (!latestUserText) return { reason: "no_user_text" };
  const text = latestUserText.trim();
  if (!text) return { reason: "empty_user_text" };

  const authoringSignal =
    matchesWorkflowAuthoringPattern(text) ||
    matchesPositiveWorkflowCreationPattern(text, NEW_WORKFLOW_MODIFIER_PATTERN);
  const externalRead = EXTERNAL_READ_PATTERN.exec(text);
  const externalReadClause = externalRead
    ? text.slice(externalRead.index).split(/[.!?;]/, 1)[0]
    : "";
  const requestsExternalRead =
    externalRead !== null &&
    !/\b(?:nicht|niemals|keinesfalls|kein(?:e|en|em|er|es)?|don't|do\s+not|never)\b/i.test(
      externalReadClause ?? "",
    );
  if (
    [...NEGATED_RUN_PATTERNS, ...NEGATED_PREVIEW_PATTERNS].some((pattern) => pattern.test(text))
  ) {
    if (requestsExternalRead) {
      return {
        requestExternalRead: true,
        suppressExecution: true,
        suppressLiveExecution: true,
        reason: "external_read_with_no_run_intent",
      };
    }
    return authoringSignal
      ? {
          startNewWorkflow: true,
          suppressExecution: true,
          suppressLiveExecution: true,
          reason: "authoring_intent_over_ambiguous_run",
        }
      : { suppressExecution: true, suppressLiveExecution: true, reason: "explicit_no_run_intent" };
  }
  if (NEGATED_LIVE_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      ...detectRemainingIntent(text, authoringSignal, coverage),
      suppressLiveExecution: true,
    };
  }
  for (const pattern of RUN_WORKFLOW_PATTERNS) {
    if (pattern.test(text)) {
      if (authoringSignal) {
        return { startNewWorkflow: true, reason: "authoring_intent_over_ambiguous_run" };
      }
      return { forceTool: "run_workflow", reason: "explicit_run_intent" };
    }
  }
  const remaining = detectRemainingIntent(text, authoringSignal, coverage);
  const externalAction = EXTERNAL_ACTION_PATTERN.exec(text) ?? REPORT_PROBLEM_PATTERN.exec(text);
  if (
    externalAction &&
    !/\b(?:nicht|niemals|keinesfalls|kein(?:e|en|em|er|es)?)\b/i.test(externalAction[0])
  ) {
    return { ...remaining, requestExternalAction: true };
  }
  return requestsExternalRead ? { ...remaining, requestExternalRead: true } : remaining;
}

function detectRemainingIntent(
  text: string,
  authoringSignal: boolean,
  coverage: EnumerationCoverage,
): DetectedIntent {
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

export function resolvePreferredTool(
  intent: Pick<DetectedIntent, "forceTool">,
  stateDrivenTool: string | null,
  hasTool: (name: string) => boolean,
): string | null {
  if (intent.forceTool && hasTool(intent.forceTool)) return intent.forceTool;
  if (stateDrivenTool && hasTool(stateDrivenTool)) return stateDrivenTool;
  return null;
}

export function turnToolChoice(
  preferredTool: string | null,
  forceNoTools: boolean,
): { type: "tool"; toolName: string } | "none" | "auto" {
  if (preferredTool) return { type: "tool", toolName: preferredTool };
  return forceNoTools ? "none" : "auto";
}

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
  if (text.length > 60) return null;
  for (const p of APPROVE_PATTERNS) if (p.test(text)) return "approve";
  for (const p of REJECT_PATTERNS) if (p.test(text)) return "reject";
  return null;
}

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
