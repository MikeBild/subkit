import { getWorkflowDraft } from "./authoring-state.ts";
import { missingFreshCheckpoints } from "./tools/authoring-contract.ts";
import type { DraftDocument } from "./types.ts";

export type ReplyLocale = "de" | "en";

export type HandoffKind = "save_confirm" | "confirm" | "choice" | "input" | "review";

export type SavePreviewEvidence =
  | "passed"
  | "passed_metadata"
  | "passed_schema_only"
  | "failed"
  | "skipped_by_user"
  | "missing";

export interface SaveVerificationEvidence {
  preview: SavePreviewEvidence;
  summary?: string;
}

const SAVE_PREVIEW_RESULT: Record<ReplyLocale, Record<SavePreviewEvidence, string>> = {
  de: {
    passed:
      "Ich habe den Entwurf angepasst und geprüft; der Testlauf ohne Wirkung war erfolgreich.",
    failed:
      "Ich habe den Entwurf angepasst; der letzte Testlauf ohne Wirkung ist fehlgeschlagen, das Speichern wäre eine bewusste Ausnahme.",
    passed_metadata:
      "Ich habe den Entwurf angepasst und geprüft; der Testlauf ohne Wirkung war erfolgreich, Inhalte blieben dabei vertraulich.",
    passed_schema_only:
      "Ich habe den Entwurf angepasst und seine Struktur geprüft; Inhalte wurden nicht geprüft, die Live-Prüfung übernimmt die angemeldete Person im Cockpit.",
    skipped_by_user:
      "Ich habe den Entwurf angepasst und geprüft; den Testlauf ohne Wirkung habe ich wie gewünscht ausgelassen, die Laufzeitprüfung steht noch aus.",
    missing:
      "Ich habe den Entwurf angepasst; ein Testlauf ohne Wirkung für diese Fassung liegt noch nicht vor.",
  },
  en: {
    passed: "I adjusted and checked the draft; the test run without effects succeeded.",
    failed:
      "I adjusted the draft; the latest test run without effects failed, so saving would be a deliberate exception.",
    passed_metadata:
      "I adjusted and checked the draft; the test run without effects succeeded and its contents stayed confidential.",
    passed_schema_only:
      "I adjusted the draft and checked its structure; its content was not checked, so the signed-in person verifies it live in the Cockpit.",
    skipped_by_user:
      "I adjusted and checked the draft; as requested I skipped the test run without effects, so runtime verification is still outstanding.",
    missing: "I adjusted the draft; there is no test run without effects for this version yet.",
  },
};

const SAVE_NEXT_STEP: Record<ReplyLocale, string> = {
  de: "Nächster Schritt: Speichern in der Karte bestätigen oder ablehnen – aktiviert wird dabei nichts.",
  en: "Next step: confirm or decline saving in the card – nothing gets activated.",
};

const OTHER_HANDOFFS: Record<ReplyLocale, Record<Exclude<HandoffKind, "save_confirm">, string>> = {
  de: {
    confirm:
      "Für diesen Schritt brauche ich deine Bestätigung; ausgeführt wurde noch nichts. Nächster Schritt: In der Karte bestätigen oder ablehnen.",
    choice:
      "Hier fehlt noch eine Entscheidung von dir. Nächster Schritt: Wähle in der Karte eine Option, dann mache ich weiter.",
    input:
      "Hier fehlen noch Angaben von dir. Nächster Schritt: Ergänze sie in der Karte, dann mache ich weiter.",
    review:
      "Die Prüfung für den automatischen Betrieb ist vorbereitet; aktiviert wurde nichts. Nächster Schritt: Prüfe die Karte und entscheide dort.",
  },
  en: {
    confirm:
      "This step needs your confirmation; nothing has run yet. Next step: confirm or decline in the card.",
    choice:
      "A decision from you is still missing. Next step: pick an option in the card and I will continue.",
    input:
      "Some details from you are still missing. Next step: fill them in the card and I will continue.",
    review:
      "The review for automatic operation is ready; nothing was activated. Next step: review the card and decide there.",
  },
};

export function handoffSummary(p: {
  locale: ReplyLocale;
  handoff: HandoffKind;
  evidence?: SaveVerificationEvidence | null;
}): string {
  if (p.handoff !== "save_confirm") return OTHER_HANDOFFS[p.locale][p.handoff];
  const preview = p.evidence?.preview ?? "missing";
  return `${SAVE_PREVIEW_RESULT[p.locale][preview]} ${SAVE_NEXT_STEP[p.locale]}`;
}

const GERMAN_MARKERS =
  /[äöüß]|\b(?:der|die|das|und|nicht|ich|bitte|diesen?|keine?|soll|speichere|prüfe|erkläre|mit|für|ist)\b/gi;
const ENGLISH_MARKERS =
  /\b(?:the|and|not|please|this|that|should|save|check|explain|with|for|is|do|it)\b/gi;

export function inferReplyLocale(text: string | null | undefined): ReplyLocale {
  if (!text) return "de";
  const german = text.match(GERMAN_MARKERS)?.length ?? 0;
  const english = text.match(ENGLISH_MARKERS)?.length ?? 0;
  return english > german ? "en" : "de";
}

export function saveVerificationEvidence(
  draft: DraftDocument,
  previewsForbiddenByUser: boolean,
): SaveVerificationEvidence {
  const latest = draft.latest_preview ?? null;
  const fresh = missingFreshCheckpoints(draft, ["workflow_previewed"]).length === 0;
  if (latest?.ok === true && fresh) {
    const sensitive = getWorkflowDraft(draft).execution_privacy === "sensitive";
    if (latest.redacted === true)
      return sensitive
        ? { preview: "passed_schema_only", summary: latest.summary }
        : { preview: previewsForbiddenByUser ? "skipped_by_user" : "missing" };
    return sensitive
      ? { preview: "passed_metadata", summary: latest.summary }
      : { preview: "passed", summary: latest.summary };
  }
  if (latest?.ok === false) return { preview: "failed", summary: latest.summary };
  return { preview: previewsForbiddenByUser ? "skipped_by_user" : "missing" };
}

const PREVIEW_EVIDENCE = new Set<string>([
  "passed",
  "passed_metadata",
  "passed_schema_only",
  "failed",
  "skipped_by_user",
  "missing",
]);

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function evidenceOf(input: Record<string, unknown> | null): SaveVerificationEvidence | null {
  const verification = recordOf(input?.verification);
  const preview = verification?.preview;
  if (typeof preview !== "string" || !PREVIEW_EVIDENCE.has(preview)) return null;
  return {
    preview: preview as SavePreviewEvidence,
    ...(typeof verification?.summary === "string" ? { summary: verification.summary } : {}),
  };
}

function isSaveProposal(input: Record<string, unknown> | null): boolean {
  if (input?.kind === "save_workflow_draft") return true;
  return recordOf(input?.commit_intent)?.kind === "save_workflow_draft";
}

export function turnHandoff(
  pending: { tool_name: string; input?: unknown } | undefined,
  reviewCardShown: boolean,
): { handoff: HandoffKind; evidence: SaveVerificationEvidence | null } | null {
  if (!pending) return reviewCardShown ? { handoff: "review", evidence: null } : null;
  const input = recordOf(pending.input);
  if (pending.tool_name === "ask_user_confirm") {
    return isSaveProposal(input)
      ? { handoff: "save_confirm", evidence: evidenceOf(input) }
      : { handoff: "confirm", evidence: null };
  }
  if (pending.tool_name === "ask_user_choice" || pending.tool_name === "ask_user_multi") {
    return { handoff: "choice", evidence: null };
  }
  return { handoff: "input", evidence: null };
}

export function saveEvidenceLabel(evidence: SaveVerificationEvidence): string {
  switch (evidence.preview) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "passed_metadata":
      return "passed with metadata only";
    case "passed_schema_only":
      return "structure checked, content not checked";
    case "skipped_by_user":
      return "skipped as requested";
    case "missing":
      return "not run";
  }
}
