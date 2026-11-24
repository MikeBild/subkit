import type { ApprovalDecisionDenialCode } from "../../tools/index.ts";
import type { AuthLocale } from "../routes/oauth/ui.ts";

const en = {
  context: "Allow once",
  pending: "Decision pending",
  title: "Allow this action once?",
  requester: "Requested by",
  decider: "Deciding person",
  person: "Person",
  systemAccount: "System account",
  ownRequest: "Your request",
  titleForTarget: "Allow {operation} to {target} once?",
  titleForRequests: "Allow {count} prepared requests once?",
  intro: "Allows exactly this one action. Anything else needs a new decision.",
  targetShort: "Target",
  titleForRename: "Allow renaming {workflow} once?",
  titleForWorkflowChange: "Allow changing {workflow} once?",
  proposedName: "New name",
  proposedSlug: "New slug",
  proposedDescription: "New description",
  proposedLifecycle: "New status",
  cleared: "Cleared",
  unknownEffect: "What this action reaches is not shown in advance.",
  contextNote:
    "This tool call is waiting for a human decision. Preparation may already have run; allowing it is not evidence of execution or success.",
  summary: "Binding",
  tool: "Tool",
  workflow: "Workflow",
  environment: "Environment",
  unspecified: "Not recorded",
  dev: "Development (dev)",
  prod: "Production (prod)",
  scope: "Allowed scope",
  once: "One use of this tool call — no standing approval",
  expiry: "Decide by",
  claim: "After allowing",
  claimHelp:
    "The system has {minutes} minutes to use this one-time permission. This does not prove that execution starts or succeeds within that time.",
  why: "Why a decision is needed",
  whyHelp:
    "This call requested a separate human decision. It cannot allow itself or extend an existing approval.",
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
  version: "Prepared version ID",
  versionOnlyHelp:
    "The prepared version, inputs and environment are recorded. A verified review of the final requests is missing; version binding alone does not establish an external-effect boundary.",
  boundHelp:
    "These prepared HTTP requests are bound to the workflow version, inputs, environment and identified connector access, including credential references in earlier steps. Changed requests or access require a new decision. This is not a standing workflow approval.",
  directBoundHelp:
    "This single-use connector action is bound to its saved configuration, environment and credential permissions. Changes require a new decision; this is not permission for later calls or other targets.",
  directEffectsHelp:
    "This action is planned against the saved connector below. Requesting approval has not sent it. Credentials are hidden.",
  attempts: "Allowed dispatch attempts",
  attemptsValue: "At most {count} for this prepared request",
  attemptsHelp:
    "A run can contain several requests. Each limit includes retries; a reserved attempt may already have reached the external system. No exactly-once effect or automatic rollback is guaranteed.",
  requestContent: "Prepared request content",
  contentHelp:
    "Sensitive fields and header values are hidden. Content is shown as text, never executed.",
  contentTruncated: "Content is truncated. This is not a complete content review.",
  opaqueContent: "An opaque payload is not displayed. Its content cannot be reviewed here.",
  missingReview: "No verified content review is available for this prepared request.",
  step: "Step",
  method: "Operation",
  target: "Target (sensitive URL parts hidden)",
  details: "Technical details",
  via: "Requested via",
  signed: "Signed in as",
  attribution: "Your decision is recorded against this account.",
  approve: "Allow once",
  decline: "Decline",
  language: "Language",
  outcome: "Decision and execution are separate",
  outcomeHelp:
    "Check the execution history for the actual result. A permission, queue entry or used handle is not a successful external action.",
  deadTitle: "Link expired or unavailable",
  deadMessage:
    "This link cannot be used to decide. Request a fresh review link. This page cannot establish whether an earlier decision or execution occurred.",
  invalidTitle: "Invalid submission",
  invalidMessage: "A valid link and decision are required. This submission recorded no decision.",
  signTitle: "Sign in to decide",
  signMessage:
    "Open the link again and sign in. This submission recorded no decision; an API key cannot replace a human browser session.",
  csrfTitle: "Could not verify this submission",
  csrfMessage:
    "Open the link again and decide from that page. This submission recorded no decision.",
  refusedTitle: "Nothing to decide",
  unchanged: "Nothing was changed by this submission.",
  approvedTitle: "Allowed once",
  approvedMessage:
    "The one-time permission was recorded. The assistant can use it within the allowed window; ask it to continue if needed. Execution outcome is not established here.",
  queuedMessage:
    "The one-time permission was recorded and continuation was queued. Queueing does not establish execution start or success. Check the execution history for the result.",
  consumedTitle: "Permission used — outcome unknown",
  consumedMessage:
    "The one-time permission has been used and cannot be reused. This does not prove that the action was carried out or succeeded. Check the execution history.",
  declinedTitle: "Declined",
  declinedMessage:
    "This request was declined and cannot allow the action. This decision says nothing about earlier preparation or other executions.",
};

const de: typeof en = {
  context: "Einmal erlauben",
  pending: "Entscheidung ausstehend",
  title: "Diese Aktion einmal erlauben?",
  requester: "Angefragt von",
  decider: "Entscheidet",
  person: "Person",
  systemAccount: "Systemkonto",
  ownRequest: "Eigene Anfrage",
  titleForTarget: "{operation} an {target} einmal erlauben?",
  titleForRequests: "{count} vorbereitete Zugriffe einmal erlauben?",
  intro: "Erlaubt genau diese eine Aktion. Alles Weitere braucht eine neue Entscheidung.",
  targetShort: "Ziel",
  titleForRename: "Umbenennen von {workflow} einmal erlauben?",
  titleForWorkflowChange: "Änderung an {workflow} einmal erlauben?",
  proposedName: "Neuer Name",
  proposedSlug: "Neuer Slug",
  proposedDescription: "Neue Beschreibung",
  proposedLifecycle: "Neuer Status",
  cleared: "Geleert",
  unknownEffect: "Was diese Aktion erreicht, ist vorab nicht sichtbar.",
  contextNote:
    "Dieser Werkzeug-Aufruf wartet auf eine menschliche Entscheidung. Vorbereitende Schritte können bereits gelaufen sein; die Erlaubnis bestätigt weder den Lauf noch seinen Erfolg.",
  summary: "Bindung",
  tool: "Tool",
  workflow: "Workflow",
  environment: "Umgebung",
  unspecified: "Nicht hinterlegt",
  dev: "Test (dev)",
  prod: "Produktion (prod)",
  scope: "Erlaubter Umfang",
  once: "Einmalige Verwendung dieses Tool-Aufrufs — keine dauerhafte Freigabe",
  expiry: "Entscheiden bis",
  claim: "Nach dem Erlauben",
  claimHelp:
    "Das System hat {minutes} Minuten, um diese einmalige Erlaubnis zu nutzen. Das bestätigt weder den Start noch den Erfolg innerhalb dieses Zeitfensters.",
  why: "Warum eine Entscheidung nötig ist",
  whyHelp:
    "Dieser Aufruf hat eine eigene menschliche Entscheidung angefordert. Er kann sich weder selbst erlauben noch eine bestehende Freigabe erweitern.",
  changes: "Änderung seit der letzten Entscheidung",
  changesHelp:
    "Ein Vergleich mit einer früheren Entscheidung ist nicht hinterlegt. Daraus folgt weder, dass dies die erste Anfrage ist, noch dass die Grenze unverändert ist.",
  effects: "Vorbereitete externe Anfragen",
  effectsHelp:
    "Diese Anfragen wurden bei der Vorbereitung ermittelt und zurückgehalten, nicht gesendet. Zugangsdaten und vollständige Eingaben werden nicht angezeigt.",
  missing:
    "Für diesen Tool-Aufruf ist keine Vorschau externer Anfragen hinterlegt. Das bedeutet nicht, dass die Operation nur liest oder keine externe Wirkung hat.",
  limitations:
    "Die gespeicherte Vorschau belegt keine unveränderliche Bindung an Workflow-Version oder Konnektor-Rechte. Prüfe die angeforderte Aktion vor der Entscheidung.",
  version: "ID der vorbereiteten Version",
  versionOnlyHelp:
    "Vorbereitete Version, Eingaben und Umgebung sind hinterlegt. Eine verifizierte Ansicht der fertigen Anfragen fehlt; die Versionsbindung allein legt noch keine Grenze für externe Wirkungen fest.",
  boundHelp:
    "Diese vorbereiteten HTTP-Anfragen sind an Workflow-Version, Eingaben, Umgebung und ermittelte Connector-Zugriffe gebunden, einschließlich der Zugangsdaten aus früheren Schritten. Geänderte Anfragen oder Zugriffsrechte benötigen eine neue Entscheidung. Dies ist keine dauerhafte Workflow-Freigabe.",
  directBoundHelp:
    "Diese einmalige Connector-Aktion ist an die gespeicherte Konfiguration, Umgebung und Zugriffsrechte der Zugangsdaten gebunden. Änderungen benötigen eine neue Entscheidung. Die Erlaubnis gilt nicht für spätere Aufrufe oder andere Ziele.",
  directEffectsHelp:
    "Diese Aktion ist für den unten genannten gespeicherten Connector vorgesehen. Die Anfrage hat sie noch nicht ausgeführt. Zugangsdaten sind verborgen.",
  attempts: "Erlaubte Sendeversuche",
  attemptsValue: "Höchstens {count} für diese vorbereitete Anfrage",
  attemptsHelp:
    "Ein Lauf kann mehrere Anfragen enthalten. Das jeweilige Limit schließt Wiederholungen ein; ein reservierter Versuch kann das Fremdsystem bereits erreicht haben. Genau eine externe Wirkung oder automatisches Rückgängigmachen wird nicht zugesagt.",
  requestContent: "Vorbereiteter Anfrageinhalt",
  contentHelp:
    "Sensible Felder und Header-Werte sind verborgen. Inhalte werden nur als Text angezeigt, nie ausgeführt.",
  contentTruncated: "Der Inhalt ist gekürzt. Dies ist keine vollständige Inhaltsprüfung.",
  opaqueContent:
    "Ein nicht strukturiertes Payload wird nicht angezeigt. Sein Inhalt kann hier nicht geprüft werden.",
  missingReview: "Für diese vorbereitete Anfrage liegt keine verifizierte Inhaltsansicht vor.",
  step: "Schritt",
  method: "Operation",
  target: "Ziel (sensible URL-Bestandteile verborgen)",
  details: "Technische Details",
  via: "Angefordert über",
  signed: "Angemeldet als",
  attribution: "Deine Entscheidung wird diesem Konto zugeordnet.",
  approve: "Einmal erlauben",
  decline: "Ablehnen",
  language: "Sprache",
  outcome: "Entscheidung und Lauf sind getrennt",
  outcomeHelp:
    "Das tatsächliche Ergebnis steht im Verlauf der Läufe. Eine Erlaubnis, ein Warteschlangeneintrag oder eine genutzte Erlaubnis ist keine erfolgreiche externe Aktion.",
  deadTitle: "Link abgelaufen oder nicht verfügbar",
  deadMessage:
    "Mit diesem Link ist keine Entscheidung möglich. Fordere einen neuen Link an. Diese Seite kann nicht feststellen, ob früher eine Entscheidung oder ein Lauf stattgefunden hat.",
  invalidTitle: "Ungültige Übermittlung",
  invalidMessage:
    "Ein gültiger Link und eine Entscheidung sind erforderlich. Durch diese Übermittlung wurde keine Entscheidung gespeichert.",
  signTitle: "Zum Entscheiden anmelden",
  signMessage:
    "Öffne den Link erneut und melde dich an. Diese Übermittlung hat keine Entscheidung gespeichert; ein API-Schlüssel ersetzt keine menschliche Browsersitzung.",
  csrfTitle: "Diese Übermittlung konnte nicht geprüft werden",
  csrfMessage:
    "Öffne den Link erneut und entscheide dort. Durch diese Übermittlung wurde keine Entscheidung gespeichert.",
  refusedTitle: "Keine Entscheidung mehr möglich",
  unchanged: "Durch diese Übermittlung wurde nichts geändert.",
  approvedTitle: "Einmal erlaubt",
  approvedMessage:
    "Die einmalige Erlaubnis wurde gespeichert. Der Assistent kann sie innerhalb des erlaubten Zeitfensters nutzen; bitte ihn bei Bedarf fortzufahren. Das Ausführungsergebnis steht hier nicht fest.",
  queuedMessage:
    "Die einmalige Erlaubnis wurde gespeichert und die Fortsetzung eingereiht. Der Warteschlangeneintrag bestätigt weder Start noch Erfolg. Prüfe das Ergebnis im Verlauf der Läufe.",
  consumedTitle: "Erlaubnis genutzt — Ergebnis unbekannt",
  consumedMessage:
    "Die einmalige Erlaubnis wurde genutzt und kann nicht erneut verwendet werden. Das belegt weder den Lauf noch seinen Erfolg. Prüfe den Verlauf der Läufe.",
  declinedTitle: "Abgelehnt",
  declinedMessage:
    "Diese Anfrage wurde abgelehnt und kann die Aktion nicht erlauben. Diese Entscheidung bewertet weder frühere Vorbereitungen noch andere Läufe.",
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
