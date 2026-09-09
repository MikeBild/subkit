import type { ApprovalDecisionDenialCode } from "../../tools/index.ts";
import type { AuthLocale } from "./oauth/ui.ts";

const en = {
  context: "Single-use approval",
  pending: "Approval pending",
  title: "Authorize this action once?",
  intro:
    "This tool call is waiting for a human decision. Preparation may already have run; approval is not evidence of execution or success.",
  summary: "Decision boundary",
  tool: "Tool",
  workflow: "Workflow",
  environment: "Environment",
  unspecified: "Not recorded on this approval",
  dev: "Development (dev)",
  prod: "Production (prod)",
  scope: "Allowed scope",
  once: "One use of this tool call — no standing authority",
  expiry: "Decide by",
  claim: "After approval",
  claimHelp:
    "The system has {minutes} minutes to claim the single-use approval. This does not prove that execution starts or succeeds within that time.",
  why: "Why a decision is needed",
  whyHelp:
    "This call requested a separate human decision. It cannot approve itself or extend an existing authority.",
  changes: "Change since the previous approval",
  changesHelp:
    "No comparison with a previous approval is recorded. Do not assume that this is the first request or that its boundary is unchanged.",
  effects: "Prepared external requests",
  effectsHelp:
    "These requests were resolved during preparation and held, not sent. Credentials and full inputs are not displayed.",
  missing:
    "No external-request preview is recorded for this tool call. That does not establish that the operation is read-only or has no external effect.",
  limitations:
    "The saved preview does not establish immutable workflow-version or connector-permission binding. Review the requested action before deciding.",
  step: "Step",
  method: "Operation",
  target: "Target (sensitive URL parts hidden)",
  details: "Request details",
  via: "Requested via",
  signed: "Signed in as",
  attribution: "Your decision is recorded against this account.",
  approve: "Authorize this action once",
  decline: "Decline",
  language: "Language",
  outcome: "Decision and execution are separate",
  outcomeHelp:
    "Check the execution history for the actual result. An approval, queue entry or consumed handle is not a successful external action.",
  deadTitle: "Approval link expired or unavailable",
  deadMessage:
    "This link cannot be used to decide. Request a fresh review link. This page cannot establish whether an earlier decision or execution occurred.",
  invalidTitle: "Invalid approval submission",
  invalidMessage: "A valid link and decision are required. This submission recorded no decision.",
  signTitle: "Sign in to decide",
  signMessage:
    "Open the approval link again and sign in. This submission recorded no decision; an API key cannot replace a human browser session.",
  csrfTitle: "Could not verify this submission",
  csrfMessage:
    "Open the approval link again and decide from that page. This submission recorded no decision.",
  refusedTitle: "Nothing to decide",
  unchanged: "Nothing was changed by this submission.",
  approvedTitle: "Approved",
  approvedMessage:
    "The single-use approval was recorded. The assistant can claim it within the allowed window; ask it to continue if needed. Execution outcome is not established here.",
  queuedMessage:
    "The single-use approval was recorded and continuation was queued. Queueing does not establish execution start or success. Check the execution history for the result.",
  consumedTitle: "Approval consumed — outcome unknown",
  consumedMessage:
    "The single-use approval has been claimed and cannot be reused. This does not prove that the action was carried out or succeeded. Check the execution history.",
  declinedTitle: "Declined",
  declinedMessage:
    "This request was declined and cannot authorize the action. This decision says nothing about earlier preparation or other executions.",
};

const de: typeof en = {
  context: "Einzelfreigabe",
  pending: "Freigabe ausstehend",
  title: "Diese Aktion einmalig freigeben?",
  intro:
    "Dieser Tool-Aufruf wartet auf eine menschliche Entscheidung. Vorbereitende Schritte können bereits gelaufen sein; eine Freigabe bestätigt weder Ausführung noch Erfolg.",
  summary: "Handlungsgrenze",
  tool: "Tool",
  workflow: "Workflow",
  environment: "Umgebung",
  unspecified: "In dieser Freigabe nicht hinterlegt",
  dev: "Entwicklung (dev)",
  prod: "Produktion (prod)",
  scope: "Erlaubter Umfang",
  once: "Einmalige Verwendung dieses Tool-Aufrufs — keine dauerhafte Autorisierung",
  expiry: "Entscheiden bis",
  claim: "Nach der Freigabe",
  claimHelp:
    "Das System hat {minutes} Minuten, um die Einzelfreigabe zu beanspruchen. Das bestätigt weder den Start noch den Erfolg innerhalb dieses Zeitfensters.",
  why: "Warum eine Entscheidung nötig ist",
  whyHelp:
    "Dieser Aufruf hat eine eigene menschliche Entscheidung angefordert. Er kann sich weder selbst freigeben noch eine bestehende Autorisierung erweitern.",
  changes: "Änderung seit der letzten Freigabe",
  changesHelp:
    "Ein Vergleich mit einer früheren Freigabe ist nicht hinterlegt. Daraus folgt weder, dass dies die erste Anfrage ist, noch dass die Handlungsgrenze unverändert ist.",
  effects: "Vorbereitete externe Anfragen",
  effectsHelp:
    "Diese Anfragen wurden bei der Vorbereitung ermittelt und zurückgehalten, nicht gesendet. Zugangsdaten und vollständige Eingaben werden nicht angezeigt.",
  missing:
    "Für diesen Tool-Aufruf ist keine Vorschau externer Anfragen hinterlegt. Das bedeutet nicht, dass die Operation nur liest oder keine externe Wirkung hat.",
  limitations:
    "Die gespeicherte Vorschau belegt keine unveränderliche Bindung an Workflow-Version oder Connector-Berechtigungen. Prüfe die angeforderte Aktion vor der Entscheidung.",
  step: "Schritt",
  method: "Operation",
  target: "Ziel (sensible URL-Bestandteile verborgen)",
  details: "Anfragedetails",
  via: "Angefordert über",
  signed: "Angemeldet als",
  attribution: "Deine Entscheidung wird diesem Konto zugeordnet.",
  approve: "Diese Aktion einmalig freigeben",
  decline: "Ablehnen",
  language: "Sprache",
  outcome: "Entscheidung und Ausführung sind getrennt",
  outcomeHelp:
    "Das tatsächliche Ergebnis steht im Ausführungsverlauf. Eine Freigabe, ein Warteschlangeneintrag oder eine verbrauchte Freigabe ist keine erfolgreiche externe Aktion.",
  deadTitle: "Freigabelink abgelaufen oder nicht verfügbar",
  deadMessage:
    "Mit diesem Link ist keine Entscheidung möglich. Fordere einen neuen Prüfungslink an. Diese Seite kann nicht feststellen, ob früher eine Entscheidung oder Ausführung stattgefunden hat.",
  invalidTitle: "Ungültige Freigabeanfrage",
  invalidMessage:
    "Ein gültiger Link und eine Entscheidung sind erforderlich. Durch diese Übermittlung wurde keine Entscheidung gespeichert.",
  signTitle: "Zum Entscheiden anmelden",
  signMessage:
    "Öffne den Freigabelink erneut und melde dich an. Diese Übermittlung hat keine Entscheidung gespeichert; ein API-Schlüssel ersetzt keine menschliche Browsersitzung.",
  csrfTitle: "Diese Übermittlung konnte nicht geprüft werden",
  csrfMessage:
    "Öffne den Freigabelink erneut und entscheide dort. Durch diese Übermittlung wurde keine Entscheidung gespeichert.",
  refusedTitle: "Keine Entscheidung mehr möglich",
  unchanged: "Durch diese Übermittlung wurde nichts geändert.",
  approvedTitle: "Freigegeben",
  approvedMessage:
    "Die Einzelfreigabe wurde gespeichert. Der Assistent kann sie innerhalb des erlaubten Zeitfensters beanspruchen; bitte ihn bei Bedarf fortzufahren. Das Ausführungsergebnis steht hier nicht fest.",
  queuedMessage:
    "Die Einzelfreigabe wurde gespeichert und die Fortsetzung eingereiht. Der Warteschlangeneintrag bestätigt weder Start noch Erfolg. Prüfe das Ergebnis im Ausführungsverlauf.",
  consumedTitle: "Freigabe verbraucht — Ergebnis unbekannt",
  consumedMessage:
    "Die Einzelfreigabe wurde beansprucht und kann nicht erneut verwendet werden. Das belegt weder die Ausführung noch ihren Erfolg. Prüfe den Ausführungsverlauf.",
  declinedTitle: "Abgelehnt",
  declinedMessage:
    "Diese Anfrage wurde abgelehnt und kann die Aktion nicht autorisieren. Diese Entscheidung bewertet weder frühere Vorbereitungen noch andere Ausführungen.",
};

export function approvalCopy(locale: AuthLocale): typeof en {
  return locale === "de" ? de : en;
}

export function approvalDenialCopy(code: ApprovalDecisionDenialCode, locale: AuthLocale): string {
  const copy = approvalCopy(locale);
  const messages: Record<ApprovalDecisionDenialCode, string> = {
    approval_not_found: copy.deadMessage,
    approval_already_granted: copy.approvedMessage,
    approval_already_declined: copy.declinedMessage,
    approval_already_used: copy.consumedMessage,
    approval_expired: copy.deadMessage,
  };
  return messages[code];
}
