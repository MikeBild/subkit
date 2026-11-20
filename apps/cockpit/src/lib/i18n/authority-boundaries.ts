export const authorityBoundariesEn = {
  "authority.boundary.connectorAdds":
    "The connector adds its own sign-in or fixed parameters to every request of this step.",
  "authority.boundary.connectorQuery.one":
    "The connector adds the parameter {names} to every request, with a value that comes from the connector and is not shown here.",
  "authority.boundary.connectorQuery.other":
    "The connector adds the parameters {names} to every request, with values that come from the connector and are not shown here.",
  "authority.refusal.connector_query_conflict":
    "The connector adds a parameter that this step also sets itself, so remove it from the step or rename it there.",
  "authority.refusal.connector_query_unresolved":
    "SubKit cannot tell which parameters the connector adds to this request, so check that the connector has working sign-in details and review again.",
  "authority.refusal.connector_query_needs_boundary":
    "The connector adds its own parameters to this read, so the step needs a limit that names them before it can be approved.",
  "authority.boundary.bodyPagingNote.one":
    "This step reads 1 page, and only the paging fields in what it sends may change.",
  "authority.boundary.bodyPagingNote.other":
    "This step reads up to {count} pages, and between pages only the paging fields in what it sends change.",
  "authority.boundary.bodyPaging.one":
    "SubKit sends 1 request to the address, and in what it sends only {params} are set by paging.",
  "authority.boundary.bodyPaging.other":
    "SubKit sends up to {count} requests to the same address, and in what it sends only {params} move from page to page.",
  "authority.refusal.pagination_unsupported":
    "A limit cannot describe a step that reads page by page while uploading files or that has a paging field without a name.",
  "authority.refusal.pagination_body_unsupported":
    "This step pages through what it sends, and a limit can only cover that when the content is a plain set of named fields with the paging fields at the top.",
  "authority.mcp.read": "Read through a tool",
  "authority.mcp.write": "Change something through a tool",
  "authority.mcp.statedRead": "You approve this tool call as one that only reads.",
  "authority.mcp.statedWrite": "You approve this tool call as one that may change data.",
  "authority.mcp.hintReadOnly":
    "The server lists this tool as read-only, which SubKit cannot check.",
  "authority.mcp.hintDestructive":
    "The server lists this tool as one that can delete or overwrite data.",
  "authority.mcp.hintChanges": "The server lists this tool as one that changes data.",
  "authority.mcp.hintNone": "The server does not say whether this tool changes data.",
  "authority.mcp.statedReadUnconfirmed":
    "The workflow states that this call only reads, but the tool is not listed as read-only, so approve it only if you know the tool.",
  "authority.mcp.pinned":
    "If the server describes this tool differently later, the next run stops and asks you to review again.",
  "authority.mcp.fixedArguments":
    "Everything the call passes to the tool is fixed, except the values listed here.",
  "authority.mcp.noVariables": "Everything the call passes to the tool is fixed.",
  "authority.mcp.descriptor": "Tool description checked before every call: {digest}",
  "authority.refusal.mcp_not_a_tool_call":
    "This step reads a resource or a prompt, and only a tool call can get a limit and be approved for repeated runs.",
  "authority.refusal.mcp_no_boundary":
    "This tool call has no limit yet, so ask the assistant to add one to the step.",
  "authority.refusal.mcp_boundary_invalid":
    "The limit on this tool call is incomplete or cannot be read, so ask the assistant to write it again.",
  "authority.refusal.mcp_tool_not_literal":
    "A limit needs one fixed tool name, and this step only decides the tool while the workflow runs.",
  "authority.refusal.mcp_server_unresolved":
    "The connector has no usable server address, so the tool call has no fixed destination.",
  "authority.refusal.mcp_runtime_value_outside_arguments":
    "Only argument values may vary, and this step decides another value while the workflow runs.",
  "authority.refusal.mcp_argument_placeholder_unsupported":
    "A limit can only cover a whole argument value, and this call mixes fixed text with a run-time value or uses one as a name.",
  "authority.refusal.mcp_variables_mismatch":
    "The limit does not name exactly the values that vary in this tool call, and each one needs its own rule.",
  "authority.refusal.mcp_caller_bound_mismatch":
    "A value tied to the signed-in person has the wrong kind of rule, or another value uses that rule.",
  "authority.refusal.mcp_write_needs_single_attempt":
    "A tool call that may change data must not be retried, so ask the assistant to switch off retries on this step.",
  "authority.refusal.mcp_tool_changed":
    "The server describes this tool differently than the step records, so ask the assistant to update the step and review again.",
  "authority.refusal.mcp_tool_unavailable":
    "SubKit could not find this tool on the server just now, so check the connector and review again.",
  "authority.mcp.recordedReadOnly":
    "The step records this tool as read-only, and SubKit has not compared that with the server for you.",
  "authority.mcp.recordedDestructive":
    "The step records this tool as one that can delete or overwrite data, and SubKit has not compared that with the server for you.",
  "authority.mcp.recordedChanges":
    "The step records this tool as one that changes data, and SubKit has not compared that with the server for you.",
  "authority.mcp.recordedNone":
    "The step records nothing about whether this tool changes data, and SubKit has not compared that with the server for you.",
} as const;

export const authorityBoundariesDe: Record<keyof typeof authorityBoundariesEn, string> = {
  "authority.boundary.connectorAdds":
    "Der Konnektor hängt an jede Anfrage dieses Schritts eigene Anmelde- oder feste Parameter an.",
  "authority.boundary.connectorQuery.one":
    "Der Konnektor hängt an jede Anfrage den Parameter {names} an, dessen Wert vom Konnektor kommt und hier nicht angezeigt wird.",
  "authority.boundary.connectorQuery.other":
    "Der Konnektor hängt an jede Anfrage die Parameter {names} an, deren Werte vom Konnektor kommen und hier nicht angezeigt werden.",
  "authority.refusal.connector_query_conflict":
    "Der Konnektor hängt einen Parameter an, den dieser Schritt auch selbst setzt, also entferne ihn am Schritt oder benenne ihn dort um.",
  "authority.refusal.connector_query_unresolved":
    "SubKit kann nicht erkennen, welche Parameter der Konnektor an diese Anfrage anhängt, also prüfe seine Zugangsdaten und starte die Prüfung erneut.",
  "authority.refusal.connector_query_needs_boundary":
    "Der Konnektor hängt eigene Parameter an diesen Lesezugriff an, deshalb braucht der Schritt vor der Freigabe eine Grenze, die sie nennt.",
  "authority.boundary.bodyPagingNote.one":
    "Dieser Schritt liest 1 Seite, und im gesendeten Inhalt dürfen sich nur die Felder zum Blättern ändern.",
  "authority.boundary.bodyPagingNote.other":
    "Dieser Schritt liest bis zu {count} Seiten, und von Seite zu Seite ändern sich im gesendeten Inhalt nur die Felder zum Blättern.",
  "authority.boundary.bodyPaging.one":
    "SubKit sendet 1 Anfrage an die Adresse, und im gesendeten Inhalt setzt das Blättern nur {params}.",
  "authority.boundary.bodyPaging.other":
    "SubKit sendet bis zu {count} Anfragen an dieselbe Adresse, und im gesendeten Inhalt bewegen sich von Seite zu Seite nur {params}.",
  "authority.refusal.pagination_unsupported":
    "Eine Grenze kann keinen Schritt beschreiben, der seitenweise liest und dabei Dateien hochlädt oder ein Feld zum Blättern ohne Namen hat.",
  "authority.refusal.pagination_body_unsupported":
    "Dieser Schritt blättert über den gesendeten Inhalt, und eine Grenze deckt das nur ab, wenn der Inhalt aus benannten Feldern besteht und die Felder zum Blättern ganz oben stehen.",
  "authority.mcp.read": "Über ein Tool lesen",
  "authority.mcp.write": "Über ein Tool etwas ändern",
  "authority.mcp.statedRead": "Du gibst diesen Tool-Aufruf als einen frei, der nur liest.",
  "authority.mcp.statedWrite": "Du gibst diesen Tool-Aufruf als einen frei, der Daten ändern kann.",
  "authority.mcp.hintReadOnly":
    "Der Server führt dieses Tool als nur lesend, was SubKit nicht prüfen kann.",
  "authority.mcp.hintDestructive":
    "Der Server führt dieses Tool als eines, das Daten löschen oder überschreiben kann.",
  "authority.mcp.hintChanges": "Der Server führt dieses Tool als eines, das Daten ändert.",
  "authority.mcp.hintNone": "Der Server sagt nicht, ob dieses Tool Daten ändert.",
  "authority.mcp.statedReadUnconfirmed":
    "Der Workflow gibt an, dass dieser Aufruf nur liest, aber das Tool ist nicht als nur lesend geführt, also gib ihn nur frei, wenn du das Tool kennst.",
  "authority.mcp.pinned":
    "Beschreibt der Server dieses Tool später anders, hält der nächste Lauf an und bittet dich um eine neue Prüfung.",
  "authority.mcp.fixedArguments":
    "Alles, was der Aufruf an das Tool übergibt, steht fest, außer den hier genannten Werten.",
  "authority.mcp.noVariables": "Alles, was der Aufruf an das Tool übergibt, steht fest.",
  "authority.mcp.descriptor": "Vor jedem Aufruf geprüfte Tool-Beschreibung: {digest}",
  "authority.refusal.mcp_not_a_tool_call":
    "Dieser Schritt liest eine Ressource oder einen Prompt, und nur ein Tool-Aufruf kann eine Grenze bekommen und für wiederholte Läufe freigegeben werden.",
  "authority.refusal.mcp_no_boundary":
    "Dieser Tool-Aufruf hat noch keine Grenze, also bitte den Assistenten, am Schritt eine festzulegen.",
  "authority.refusal.mcp_boundary_invalid":
    "Die Grenze dieses Tool-Aufrufs ist unvollständig oder nicht lesbar, also bitte den Assistenten, sie neu zu schreiben.",
  "authority.refusal.mcp_tool_not_literal":
    "Eine Grenze braucht genau einen festen Tool-Namen, und dieser Schritt wählt das Tool erst, während der Workflow läuft.",
  "authority.refusal.mcp_server_unresolved":
    "Der Konnektor hat keine brauchbare Server-Adresse, also hat der Tool-Aufruf kein festes Ziel.",
  "authority.refusal.mcp_runtime_value_outside_arguments":
    "Nur Argumentwerte dürfen variieren, und dieser Schritt legt einen anderen Wert erst fest, während der Workflow läuft.",
  "authority.refusal.mcp_argument_placeholder_unsupported":
    "Eine Grenze deckt nur einen ganzen Argumentwert ab, und dieser Aufruf mischt festen Text mit einem Laufzeitwert oder nutzt einen als Namen.",
  "authority.refusal.mcp_variables_mismatch":
    "Die Grenze nennt nicht genau die Werte, die in diesem Tool-Aufruf variieren, und jeder davon braucht eine eigene Regel.",
  "authority.refusal.mcp_caller_bound_mismatch":
    "Ein Wert, der an die angemeldete Person gebunden ist, hat die falsche Art von Regel, oder ein anderer Wert nutzt diese Regel.",
  "authority.refusal.mcp_write_needs_single_attempt":
    "Ein Tool-Aufruf, der Daten ändern kann, darf nicht wiederholt werden, also bitte den Assistenten, die Wiederholungen an diesem Schritt abzuschalten.",
  "authority.refusal.mcp_tool_changed":
    "Der Server beschreibt dieses Tool anders, als der Schritt es festhält, also bitte den Assistenten, den Schritt zu aktualisieren, und prüfe erneut.",
  "authority.refusal.mcp_tool_unavailable":
    "SubKit konnte dieses Tool gerade nicht auf dem Server finden, also prüfe den Konnektor und starte die Prüfung erneut.",
  "authority.mcp.recordedReadOnly":
    "Der Schritt hält dieses Tool als nur lesend fest, und SubKit hat das für dich nicht mit dem Server verglichen.",
  "authority.mcp.recordedDestructive":
    "Der Schritt hält dieses Tool als eines fest, das Daten löschen oder überschreiben kann, und SubKit hat das für dich nicht mit dem Server verglichen.",
  "authority.mcp.recordedChanges":
    "Der Schritt hält dieses Tool als eines fest, das Daten ändert, und SubKit hat das für dich nicht mit dem Server verglichen.",
  "authority.mcp.recordedNone":
    "Der Schritt hält nicht fest, ob dieses Tool Daten ändert, und SubKit hat das für dich nicht mit dem Server verglichen.",
};
