export type HeldDetailKey =
  | "held.execution_authority_required"
  | "held.execution_authority_expired"
  | "held.execution_authority_exhausted"
  | "held.execution_authority_revoked"
  | "held.execution_authority_changed"
  | "held.input_required";

export const HELD_DETAIL_COPY: Readonly<
  Record<"en" | "de", Readonly<Record<HeldDetailKey, string>>>
> = {
  en: {
    "held.execution_authority_required":
      "No approval covers the current version, so scheduled runs wait. Review and approve the workflow to start them again. Nothing has run since the hold.",
    "held.execution_authority_expired":
      "The approval has expired, so scheduled runs wait. Renew the approval to start them again. Nothing has run since the hold.",
    "held.execution_authority_exhausted":
      "The approval is used up: every approved run has started, so scheduled runs wait. Approve more runs to start them again. Nothing has run since the hold.",
    "held.execution_authority_revoked":
      "The approval was revoked, so scheduled runs wait. Approve the workflow again to start them. Nothing has run since the hold.",
    "held.execution_authority_changed":
      "The workflow would now do something the approval does not cover, so scheduled runs wait. Review what changed and approve it to start them again. Nothing has run since the hold.",
    "held.input_required":
      "The schedule has no input for a required field, so scheduled runs wait. Add the missing input to start them again.",
  },
  de: {
    "held.execution_authority_required":
      "Keine Freigabe deckt die aktuelle Version ab, deshalb warten geplante Runs. Prüfe den Workflow und gib ihn frei, damit sie wieder starten. Seit dem Halt ist nichts gelaufen.",
    "held.execution_authority_expired":
      "Die Freigabe ist abgelaufen, deshalb warten geplante Runs. Erneuere die Freigabe, damit sie wieder starten. Seit dem Halt ist nichts gelaufen.",
    "held.execution_authority_exhausted":
      "Die Freigabe ist aufgebraucht: Alle freigegebenen Runs sind gestartet, deshalb warten geplante Runs. Gib weitere Runs frei, damit sie wieder starten. Seit dem Halt ist nichts gelaufen.",
    "held.execution_authority_revoked":
      "Die Freigabe wurde widerrufen, deshalb warten geplante Runs. Gib den Workflow erneut frei, damit sie wieder starten. Seit dem Halt ist nichts gelaufen.",
    "held.execution_authority_changed":
      "Der Workflow würde jetzt etwas tun, das die Freigabe nicht abdeckt, deshalb warten geplante Runs. Prüfe die Änderung und gib sie frei, damit sie wieder starten. Seit dem Halt ist nichts gelaufen.",
    "held.input_required":
      "Dem Zeitplan fehlt die Eingabe für ein Pflichtfeld, deshalb warten geplante Runs. Ergänze die fehlende Eingabe, damit sie wieder starten.",
  },
};
