---
slug: product-bearer-tokens-and-caller-budgets
summary: Lass eine App SubKit mit ihrer eigenen Anmeldung aufrufen und begrenze die Nutzung je Aufrufer.
section: operate
order: 6
audience: operator
---
## Produkt-Bearer-Tokens und Aufruferbudgets

Eine native App kann SubKit mit ihrer eigenen Anmeldung statt mit einem SubKit-Schlüssel aufrufen. Füge über die Laufzeitkonfiguration einen `oidc_bearer`-Anbieter und einen `products`-Eintrag hinzu. Die Hosts unten sind Platzhalter. `audience` und `required_claims` haben keine Standardwerte; der Betreiber gibt beide für den verwendeten Aussteller an (die vollständige Checkliste steht unter „Eine App anbinden“). `reject_anonymous` lehnt Tokens ab, deren `is_anonymous`-Claim wahr ist.

```json
{
  "auth": {
    "providers": [
      { "protocol": "api_key", "id": "api-key", "label": "SubKit API key" },
      {
        "protocol": "oidc_bearer",
        "id": "app-accounts",
        "label": "App account",
        "issuer_url": "https://idp.example.test",
        "audience": "app-audience",
        "algorithms": ["ES256"],
        "product_id": "app",
        "tenant_slug": "default",
        "required_claims": [
          { "path": "idp", "equals": "primary" },
          { "path": "claims.tier", "equals": "member" }
        ],
        "reject_anonymous": true,
        "clock_tolerance_s": 30
      }
    ]
  },
  "products": {
    "app": {
      "execution_environment": "prod",
      "assistant_workflow_id": "00000000-0000-4000-8000-000000000001",
      "budget_bucket": "assistant"
    }
  }
}
```

Die App sendet `Authorization: Bearer <access token>`. SubKit liest nur diesen Header, nie einen `token`-Query-Parameter. Ein Token wird nur dann beansprucht, wenn es ein kompaktes JWS ist, dessen `iss` einem konfigurierten `issuer_url` entspricht; SubKit-Schlüssel, Portal-Tokens, MCP-Tokens und getauschte Tokens werden nie beansprucht. SubKit verifiziert die Signatur gegen das JWKS des Ausstellers (aus `jwks_uri` oder der OIDC-Discovery des Ausstellers, pro Anbieter zwischengespeichert und bei einem unbekannten Schlüssel einmal neu geladen), die Audience, die Algorithmenliste, `exp`, `iat`, ein UUID-`sub` und jeden `required_claims`-Eintrag (`path` ist ein Punktpfad in die verifizierte Nutzlast). Anonyme Subjects werden abgelehnt, wenn `reject_anonymous` wahr ist. Ein beanspruchtes Token, das eine Prüfung nicht besteht, antwortet mit `401 {"code":"unauthorized","error":"unauthorized","message":"invalid bearer token"}`; für diese Anfrage wird kein anderer Anbieter, kein Cookie und kein Schlüssel versucht.

Das erste verifizierte Token eines Subjects legt einen Produktbenutzer mit der eingebauten Mitgliedsrolle, einer Platzhalteradresse und einer Identitätsbindung an Anbieter, Aussteller und Produkt an; Adressen werden nie verknüpft. Die Produktobergrenze beschränkt den Principal dann auf `workflow:run`, `execution:read` und `execution:abort` für gespeicherte Workflows mit derselben `product_id` und für seine eigenen Ausführungen. Produkt-Principals haben keine MCP-Oberfläche: `/mcp` antwortet mit `403 product_caller_forbidden`, und der Tool-Dispatcher lehnt jedes Tool außerhalb dieser drei Berechtigungen mit `policy_denied` ab. `oidc_bearer`-Anbieter stellen nie API-Schlüssel oder Browsersitzungen aus und werden für die Browseranmeldung nicht aufgeführt. Läufe eines Produkt-Principals verwenden immer die `execution_environment` des Produkts; ein `x-subkit-environment`-Header wird für sie ignoriert. Ein Lauf eines von einem `oidc_bearer`-Anbieter verifizierten Produkt-Principals ist immer live: Ohne eine Live-Ausführungsautorität, eine aktive Version oder ein nutzbares vorbereitetes Zugangsdatum antwortet er mit 403 und dem Ablehnungscode, statt als zurückgehaltene Vorbereitung zu laufen, und `hold_writes: true` antwortet mit `403 product_preparation_forbidden`.

Ein sensibler Produkt-Workflow mit `required_caller_kind: "user"` kann `execution_guards.caller_daily_limit` (`bucket`, `limit`, IANA-`tz`, `$input`-Pfad `unit`, `lease_ms`, `billable_steps`, optional JSONata-`meter`, `max_metered`, JSONata-`commit_when` über die Lauf-Ausgabe, `attach_usage_as`) und `execution_guards.input_bytes` (maximale UTF-8-Bytes pro `$input`-Pfad; eine Zeichenkette zählt sich selbst, andere Werte ihren JSON-Text) deklarieren. Die Zulassung prüft die Größen und reserviert dann eine Einheit pro Aufrufer und lokalem Tag in derselben Transaktion, die die Ausführung anlegt, nach der Idempotenz-Wiederholungsprüfung; eine Wiederholung berechnet nie etwas. Spätere Aufrufe einer reservierten oder festgeschriebenen Einheit sind kostenlos, bis `max_metered` Aufrufe verbraucht wurden. Eine Einheit führt jeweils einen Aufruf aus; ein Aufruf, dessen Abbruch angefordert wurde, zählt nicht mehr als laufend. Ablehnungen tragen keine Ausführung:

- `429 {"error":"rate-limited","code":"rate_limited","message":"…","usage":{"usedToday":50,"dailyLimit":50}}`, wenn der Tag aufgebraucht ist,
- `409 {"error":"turn-busy","code":"turn_busy"}`, solange ein anderer Lauf der Einheit eingereiht ist oder läuft; dieser Lauf läuft weiter, und dieselbe Anfrage mit demselben `idempotency_key` wiederholt ihn (`idempotent_replay: true`, 202 solange er läuft), statt erneut zu reservieren,
- `429 {"error":"turn-limit","code":"turn_limit"}`, sobald `max_metered` Aufrufe verbraucht wurden (jede Anfrage, die ein abrechenbarer Schritt sendet, zählt beim Senden),
- `400 {"error":"invalid","code":"invalid"}` für einen Eingabeteil über seiner Byte-Grenze.

Wenn ein Lauf endet, schreibt ein Erfolg die Einheit fest, falls `commit_when` wahr ist, und hält sie andernfalls für den nächsten Aufruf reserviert; die Anfrage eines abrechenbaren Schritts markiert die Einheit als abrechenbar, sobald sie gesendet wird, nach der Prüfung der Ausführungsautorität, sodass ein Fehler, Abbruch oder Timeout nach diesem Punkt berechnet bleibt; ein fehlgeschlagener, abgebrochener oder abgelaufener Lauf erstattet die Einheit nur, wenn keine abrechenbare Anfrage gesendet wurde, kein abrechenbarer Schritt erfolgreich war und kein anderer Lauf der Einheit aktiv ist. Reservierungen, deren Lease abläuft, werden beim nächsten Lesen abgerechnet: abrechenbare Einheiten werden festgeschrieben, andere erstattet. Das sensible Ergebnis eines erfolgreichen Laufs trägt `usage: {usedToday, dailyLimit}`. `GET /v1/budget` antwortet mit `{usedToday, dailyLimit, day, resetsAt}` für den Assistenten-Workflow des Produkts, und `GET /v1/health` antwortet mit `{ok, version, model, key}`, wobei `ok` den aktiven Workflow, eine Live-Ausführungsautorität für die Produktumgebung und ein nutzbares Zugangsdatum an jedem verwendeten Konnektor erfordert; kein Secret wird gelesen. Beide antworten Principals ohne Produkt mit 404. `POST /v1/executions` mit einer `workflow_id` und ohne `source` führt diesen gespeicherten Workflow aus, sodass ein Produkt-Client nur `{workflow_id, idempotency_key, async, input}` sendet. `GET /v1/executions/{id}` liefert für fehlgeschlagene oder abgelaufene Läufe außerdem `execution_id` und `error: {code}`.

`caller_erasure: "on_success"` an einem solchen Workflow löscht den Aufrufer, wenn der Lauf erfolgreich ist: Budgetzeilen und Identitätsbindungen werden gelöscht, Sitzungen und Schlüssel widerrufen, der Benutzer deaktiviert und anonymisiert, das Subject aus dem Aufrufer-Kontext seiner Ausführungen entfernt, und ein Tombstone mit nur dem SHA-256 des Subjects lehnt vor der Löschung ausgestellte Tokens ab. Request-Schritte können den eigenen Datensatz des Aufrufers mit `${caller.subject}` und der Grenzregel `{caller_bound: true}` adressieren, die auch bei einem DELETE akzeptiert wird. Ein Admin kann einen Workflow unter einer festen `id` anlegen, damit eine App ihn ohne Konfiguration adressieren kann; die ID muss unbenutzt sein.

Ein Request-Schritt eines gespeicherten Workflows, der unter einer Live-Ausführungsautorität läuft und keine zurückgehaltene Vorbereitung ist, kann das Zugangsdatum seines eigenen Konnektors als `${cred.<own-slug>.<field>}` ohne `connector:read` lesen; der Verweis muss innerhalb der freigegebenen Autorität bleiben. Entwurfs- und Schrittläufe, zurückgehaltene Vorbereitungen und gespeicherte Läufe ohne Autorität benötigen weiterhin `connector:read` für diesen Konnektor. Das Zugangsdatum wird nur an den Origin dieses Konnektors gesendet und nie mit einer Weiterleitung. Das ist die Grenze. SubKit maskiert außerdem die rohe, URL-kodierte, formularkodierte und JSON-maskierte Form des Werts in Schrittausgaben, Fehlern, Audit und Logs, aber diese Maskierung ist eine Best-Effort-Hilfe: Ein Upstream, der den Wert in einer anderen Kodierung widerspiegelt oder ihn speichert und später zurückgibt, wird nicht abgedeckt.
