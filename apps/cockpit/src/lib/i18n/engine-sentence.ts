export const engineSentenceEn = {
  "engine.hold.execution_authority_required":
    "No approval covers the current version, so automatic starts wait. Review and approve the workflow to start them again. Nothing has run since the hold.",
  "engine.hold.execution_authority_unavailable":
    "The approval has expired, is used up or was revoked, so automatic starts wait. Renew the approval to start them again. Nothing has run since the hold.",
  "engine.hold.input_required":
    "The schedule has no input for a required field, so scheduled runs wait. Add the missing input to start them again.",
  "engine.class.auth_failed":
    "The connected service rejected the sign-in. Reconnect the connector, then run again. Nothing was changed by this step.",
  "engine.class.authority_mismatch":
    "The approval no longer covers what this run would do. Review and renew the approval, then run again.",
  "engine.class.connector_missing":
    "A connector this run needs does not exist in this environment. Add it, then run again.",
  "engine.class.connector_unavailable":
    "A connector this run needs is disabled or has no usable credential. Reconnect or enable it, then run again.",
  "engine.class.budget_exhausted":
    "The token allowance is used up. Raise the limit or wait for the month to roll over.",
  "engine.class.rate_limited":
    "The service’s rate limit stopped this run. Retry after the limit resets.",
  "engine.class.timeout": "A step took longer than its time limit. Retry, or raise the limit.",
  "engine.class.placeholder_unresolved":
    "A step referred to a value that was not available. Check the workflow’s inputs and earlier steps.",
  "engine.class.schema_mismatch":
    "The service answered in an unexpected shape. Check the step’s data selector against the response.",
  "engine.class.incomplete_read":
    "The run stopped before every page was read, so its result would be incomplete.",
  "engine.class.payload_invalid":
    "The message a step built is malformed and was not sent. Fix how the step builds it; the approval still fits.",
  "engine.code.sensitive_execution_failure":
    "This run works with protected data, so the engine does not show the cause here. The run view names the failing step.",
  "engine.code.graphql_pagination_incomplete":
    "The pages of a GraphQL query are incomplete. Check pageInfo, totalCount, the cursors and the configured limits, then retry.",
  "engine.code.graphql_pagination_not_read_only":
    "Paging by cursor needs a read-only GraphQL query. Remove the mutations from this step.",
  "engine.code.data_selector_error":
    "The data selector of a step failed. Check its expression against the shape of the connector’s answer, then retry.",
  "engine.code.pagination_limit_reached":
    "Paging reached its configured limit of pages, items or size before the endpoint ended. Raise the limit or narrow the request.",
  "engine.code.pagination_link_foreign":
    "The link to the next page pointed to another host. Nothing was sent there; check the endpoint, then retry.",
  "engine.code.pagination_link_unsupported":
    "The link to the next page changed the request beyond the declared paging parameters. Check link_params, then retry.",
  "engine.code.pagination_link_loop":
    "The link to the next page repeated an earlier page. Check the endpoint’s paging, then retry.",
  "engine.code.pagination_short_page":
    "The server returned fewer items than requested although more pages exist. Lower page_size to the service’s maximum.",
  "engine.code.upstream_rate_limited":
    "The service’s rate limit does not reset before the deadline of the step or workflow. Retry after the limit resets.",
  "engine.code.graphql_endpoint_invalid":
    "The GraphQL address must be a fixed path ending in /graphql on the connector’s own host, for example /graphql.",
  "engine.code.graphql_path_required":
    "A GraphQL step on an HTTP connector needs a fixed path such as /graphql.",
  "engine.code.pagination_truncated":
    "Paging stopped at its configured limit, so the result of this step is incomplete.",
  "engine.code.skipped_dependency_held":
    "This step was skipped because an earlier writing step was held in the trial run.",
  "engine.code.caller_saved_workflow_required":
    "This caller can run only a saved workflow version, not a draft.",
} as const;

export const engineSentenceDe: Record<keyof typeof engineSentenceEn, string> = {
  "engine.hold.execution_authority_required":
    "Für die aktuelle Version gibt es keine Freigabe, deshalb warten automatische Starts. Prüfe den Workflow und gib ihn frei, dann laufen sie wieder. Seit dem Anhalten ist nichts gelaufen.",
  "engine.hold.execution_authority_unavailable":
    "Die Freigabe ist abgelaufen, aufgebraucht oder widerrufen, deshalb warten automatische Starts. Erneuere die Freigabe, dann laufen sie wieder. Seit dem Anhalten ist nichts gelaufen.",
  "engine.hold.input_required":
    "Dem Zeitplan fehlt die Eingabe für ein Pflichtfeld, deshalb warten die geplanten Läufe. Trag die fehlende Eingabe nach, dann laufen sie wieder.",
  "engine.class.auth_failed":
    "Der verbundene Dienst hat die Anmeldung abgelehnt. Verbinde den Konnektor neu und starte den Lauf noch einmal. Dieser Schritt hat nichts verändert.",
  "engine.class.authority_mismatch":
    "Die Freigabe deckt nicht mehr ab, was dieser Lauf tun würde. Prüfe und erneuere die Freigabe und starte den Lauf noch einmal.",
  "engine.class.connector_missing":
    "Ein Konnektor, den dieser Lauf braucht, fehlt in dieser Umgebung. Leg ihn an und starte den Lauf noch einmal.",
  "engine.class.connector_unavailable":
    "Ein Konnektor, den dieser Lauf braucht, ist ausgeschaltet oder hat keine nutzbaren Zugangsdaten. Verbinde ihn neu oder schalte ihn ein und starte den Lauf noch einmal.",
  "engine.class.budget_exhausted":
    "Das Token-Kontingent ist aufgebraucht. Erhöhe das Limit oder warte auf den nächsten Monat.",
  "engine.class.rate_limited":
    "Das Anfragelimit des Dienstes hat diesen Lauf gestoppt. Versuch es noch einmal, sobald das Limit zurückgesetzt ist.",
  "engine.class.timeout":
    "Ein Schritt hat länger gebraucht als sein Zeitlimit. Versuch es noch einmal oder erhöhe das Limit.",
  "engine.class.placeholder_unresolved":
    "Ein Schritt hat sich auf einen Wert bezogen, den es nicht gab. Prüfe die Eingaben des Workflows und die früheren Schritte.",
  "engine.class.schema_mismatch":
    "Der Dienst hat in einer unerwarteten Form geantwortet. Prüfe die Datenauswahl des Schritts gegen die Antwort.",
  "engine.class.incomplete_read":
    "Der Lauf hat gestoppt, bevor alle Seiten gelesen waren. Sein Ergebnis wäre unvollständig.",
  "engine.class.payload_invalid":
    "Die Nachricht, die ein Schritt gebaut hat, ist fehlerhaft und wurde nicht gesendet. Korrigiere, wie der Schritt sie baut; die Freigabe passt weiterhin.",
  "engine.code.sensitive_execution_failure":
    "Dieser Lauf arbeitet mit geschützten Daten, deshalb zeigt die Engine die Ursache hier nicht. Die Laufansicht nennt den fehlgeschlagenen Schritt.",
  "engine.code.graphql_pagination_incomplete":
    "Die Seiten einer GraphQL-Abfrage sind unvollständig. Prüfe pageInfo, totalCount, die Cursor und die eingestellten Limits und versuch es noch einmal.",
  "engine.code.graphql_pagination_not_read_only":
    "Blättern per Cursor braucht eine GraphQL-Abfrage, die nur liest. Entferne die Mutationen aus diesem Schritt.",
  "engine.code.data_selector_error":
    "Die Datenauswahl eines Schritts ist fehlgeschlagen. Prüfe ihren Ausdruck gegen die Form der Konnektor-Antwort und versuch es noch einmal.",
  "engine.code.pagination_limit_reached":
    "Das Blättern hat sein eingestelltes Limit für Seiten, Einträge oder Größe erreicht, bevor der Endpunkt zu Ende war. Erhöhe das Limit oder grenze die Anfrage ein.",
  "engine.code.pagination_link_foreign":
    "Der Link zur nächsten Seite zeigte auf einen anderen Host. Dorthin wurde nichts gesendet; prüfe den Endpunkt und versuch es noch einmal.",
  "engine.code.pagination_link_unsupported":
    "Der Link zur nächsten Seite hat die Anfrage über die angegebenen Blätter-Parameter hinaus verändert. Prüfe link_params und versuch es noch einmal.",
  "engine.code.pagination_link_loop":
    "Der Link zur nächsten Seite hat eine frühere Seite wiederholt. Prüfe das Blättern des Endpunkts und versuch es noch einmal.",
  "engine.code.pagination_short_page":
    "Der Server hat weniger Einträge geliefert als angefragt, obwohl es weitere Seiten gibt. Senke page_size auf das Maximum des Dienstes.",
  "engine.code.upstream_rate_limited":
    "Das Anfragelimit des Dienstes wird nicht vor der Frist des Schritts oder des Workflows zurückgesetzt. Versuch es noch einmal, sobald das Limit zurückgesetzt ist.",
  "engine.code.graphql_endpoint_invalid":
    "Die GraphQL-Adresse muss ein fester Pfad auf dem eigenen Host des Konnektors sein, der auf /graphql endet, zum Beispiel /graphql.",
  "engine.code.graphql_path_required":
    "Ein GraphQL-Schritt auf einem HTTP-Konnektor braucht einen festen Pfad wie /graphql.",
  "engine.code.pagination_truncated":
    "Das Blättern hat an seinem eingestellten Limit gestoppt, das Ergebnis dieses Schritts ist deshalb unvollständig.",
  "engine.code.skipped_dependency_held":
    "Dieser Schritt wurde übersprungen, weil ein früherer schreibender Schritt im Probelauf angehalten wurde.",
  "engine.code.caller_saved_workflow_required":
    "Dieser Aufrufer kann nur eine gespeicherte Workflow-Version ausführen, keinen Entwurf.",
};
