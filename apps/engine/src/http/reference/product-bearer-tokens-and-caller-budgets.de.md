---
slug: product-bearer-tokens-and-caller-budgets
summary: Lass deine App SubKit mit eigener Anmeldung aufrufen, mit Tageskontingent je Nutzer.
section: operate
order: 6
audience: operator
---
## Produkt-Bearer-Tokens und Aufruferbudgets

Deine App kann SubKit mit der Anmeldung ihrer eigenen Nutzer aufrufen, statt einen SubKit-Schlüssel mitzuliefern. Du brauchst das, wenn eine native App oder ein Portal Workflows für angemeldete Kunden startet. Danach prüft SubKit jedes Token selbst und legt je Nutzer ein eng begrenztes Konto an; je Workflow kannst du zusätzlich ein Tageskontingent pro Nutzer festlegen.

Ein Bearer-Token ist ein Zugangsnachweis, den die App im Header `Authorization: Bearer …` mitschickt. Hier ist es ein JWT (JSON Web Token): ein signiertes Datenpaket, dessen Aussteller und Inhalt SubKit prüfen kann. OIDC (OpenID Connect) ist der Standard, über den SubKit die Schlüssel und Angaben des Ausstellers findet.

### Anbieter und Produkt konfigurieren

Trage in der Laufzeitkonfiguration einen Anbieter mit `oidc_bearer` und einen Eintrag unter `products` ein. Die Hosts im Beispiel sind Platzhalter. `audience` und `required_claims` haben keine Standardwerte; du gibst beide für deinen Aussteller an. Die vollständige Checkliste steht im Kapitel „Eine App anbinden“.

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

`label` ist nur der Anzeigename des Anbieters, im Beispiel das App-Konto („App account“). Ein Claim ist ein Feld im Token. `reject_anonymous` lehnt Tokens ab, deren Claim `is_anonymous` wahr ist.

### Wie SubKit das Token prüft

Die App schickt `Authorization: Bearer <access token>`. SubKit liest nur diesen Header, nie einen Query-Parameter `token`. SubKit übernimmt ein Token nur, wenn es ein kompaktes JWS ist, also ein signiertes JWT in der üblichen Punkt-getrennten Form, und sein `iss` einem konfigurierten `issuer_url` entspricht. SubKit-Schlüssel, Portal-Tokens (kurzlebige SubKit-Tokens für eingebettete Läufe von Endnutzern), MCP-Tokens und getauschte Tokens übernimmt dieser Anbieter nie.

Dann prüft SubKit:

- die Signatur gegen das JWKS des Ausstellers, also seine veröffentlichten Schlüssel; es kommt aus `jwks_uri` oder der OIDC-Discovery, wird je Anbieter zwischengespeichert und bei einem unbekannten Schlüssel einmal neu geladen,
- die Audience und die Liste der erlaubten Algorithmen,
- `exp`, `iat` und ein `sub` im UUID-Format,
- jeden Eintrag in `required_claims`, wobei `path` ein Punktpfad in die geprüfte Nutzlast ist,
- anonyme Subjects, wenn `reject_anonymous` wahr ist.

Scheitert eine Prüfung, antwortet SubKit mit `401 {"code":"unauthorized","error":"unauthorized","message":"invalid bearer token"}`. Für diese Anfrage versucht SubKit dann keinen anderen Anbieter, kein Cookie und keinen Schlüssel.

### Was ein Produkt-Aufrufer darf

Beim ersten geprüften Token eines Subjects legt SubKit einen Produktbenutzer an. Er bekommt die eingebaute Mitgliedsrolle, eine Platzhalter-Adresse und eine Identitätsbindung an Anbieter, Aussteller und Produkt; E-Mail-Adressen werden nie verknüpft. Die Obergrenze des Produkts lässt diesem Principal, also der angemeldeten Identität, nur `workflow:run`, `execution:read` und `execution:abort`. Diese Rechte gelten für gespeicherte Workflows mit derselben `product_id` und für seine eigenen Ausführungen.

Dazu kommen diese Grenzen:

- Keine MCP-Oberfläche: `/mcp` antwortet mit `403 product_caller_forbidden`, und der Tool-Dispatcher lehnt jedes Tool außerhalb der drei Rechte mit `policy_denied` ab.
- `oidc_bearer`-Anbieter stellen nie API-Schlüssel oder Browsersitzungen aus und erscheinen nicht bei der Browser-Anmeldung.
- Läufe nutzen immer die `execution_environment` des Produkts; einen Header `x-subkit-environment` ignoriert SubKit dabei.
- Läufe eines über `oidc_bearer` geprüften Produkt-Principals sind immer live. Fehlt eine Live-Freigabe, eine aktive Version oder ein nutzbares vorbereitetes Zugangsdatum, antwortet SubKit mit 403 und dem Ablehnungscode.
- Der Lauf startet dann nicht als zurückgehaltene Vorbereitung, also als Vorschau mit angehaltenen Schreibschritten. `hold_writes: true` antwortet mit `403 product_preparation_forbidden`.

### Tageskontingent je Aufrufer

Ein sensibler Produkt-Workflow mit `required_caller_kind: "user"` kann zwei Schutzregeln deklarieren:

- `execution_guards.caller_daily_limit` begrenzt die Nutzung je Aufrufer und Tag. Felder: `bucket`, `limit`, IANA-`tz`, `unit` als `$input`-Pfad, `lease_ms`, `billable_steps`, optional `meter` (JSONata), `max_metered`, `commit_when` (JSONata über die Lauf-Ausgabe) und `attach_usage_as`.
- `execution_guards.input_bytes` begrenzt die UTF-8-Bytes je `$input`-Pfad. Eine Zeichenkette zählt sich selbst, andere Werte zählen ihren JSON-Text.

Gezählt wird in Einheiten; welcher Eingabewert eine Einheit bestimmt, legt `unit` fest. Bei der Zulassung prüft SubKit zuerst die Größen. Dann reserviert es eine Einheit je Aufrufer und lokalem Tag, in derselben Transaktion, die die Ausführung anlegt, und erst nach der Prüfung auf eine Idempotenz-Wiederholung. Eine Wiederholung kostet deshalb nie etwas.

Weitere Aufrufe einer reservierten oder festgeschriebenen Einheit sind kostenlos, bis `max_metered` Aufrufe verbraucht sind. Eine Einheit führt immer nur einen Aufruf gleichzeitig aus. Ein Aufruf, dessen Abbruch angefordert ist, zählt nicht mehr als laufend. Ablehnungen legen keine Ausführung an:

- `429 {"error":"rate-limited","code":"rate_limited","message":"…","usage":{"usedToday":50,"dailyLimit":50}}`, wenn der Tag aufgebraucht ist,
- `409 {"error":"turn-busy","code":"turn_busy"}`, solange ein anderer Lauf der Einheit eingereiht ist oder läuft; dieser Lauf läuft weiter, und dieselbe Anfrage mit demselben `idempotency_key` wiederholt ihn (`idempotent_replay: true`, 202 solange er läuft), statt erneut zu reservieren,
- `429 {"error":"turn-limit","code":"turn_limit"}`, sobald `max_metered` Aufrufe verbraucht sind (jede Anfrage, die ein abrechenbarer Schritt sendet, zählt beim Senden),
- `400 {"error":"invalid","code":"invalid"}` für einen Eingabeteil über seiner Byte-Grenze.

### Abrechnen und erstatten

Wenn ein Lauf endet, gilt:

- Bei Erfolg schreibt SubKit die Einheit fest, wenn `commit_when` wahr ist. Sonst bleibt sie für den nächsten Aufruf reserviert.
- Sobald ein abrechenbarer Schritt seine Anfrage sendet, gilt die Einheit als abrechenbar. Das geschieht nach der Prüfung der Freigabe. Fehler, Abbruch oder Zeitüberschreitung danach bleiben berechnet.
- Ein fehlgeschlagener, abgebrochener oder abgelaufener Lauf bekommt die Einheit nur unter drei Bedingungen erstattet: Keine abrechenbare Anfrage wurde gesendet, kein abrechenbarer Schritt war erfolgreich, und kein anderer Lauf der Einheit ist aktiv.
- Reservierungen, deren Lease abläuft, rechnet SubKit beim nächsten Lesen ab: Abrechenbare Einheiten werden festgeschrieben, die übrigen erstattet.

Das sensible Ergebnis eines erfolgreichen Laufs enthält `usage: {usedToday, dailyLimit}`.

### Endpunkte für Produkt-Clients

- `GET /v1/budget` liefert `{usedToday, dailyLimit, day, resetsAt}` für den Assistenten-Workflow des Produkts.
- `GET /v1/health` liefert `{ok, version, model, key}`. `ok` setzt den aktiven Workflow, eine Live-Freigabe für die Produktumgebung und ein nutzbares Zugangsdatum an jedem verwendeten Konnektor voraus; ein Secret wird dabei nicht gelesen.
- Beide antworten Principals ohne Produkt mit 404.
- `POST /v1/executions` mit `workflow_id` und ohne `source` führt diesen gespeicherten Workflow aus. Ein Produkt-Client sendet also nur `{workflow_id, idempotency_key, async, input}`.
- `GET /v1/executions/{id}` liefert bei fehlgeschlagenen oder abgelaufenen Läufen zusätzlich `execution_id` und `error: {code}`.

Ein Admin kann einen Workflow unter einer festen `id` anlegen, damit eine App ihn ohne Konfiguration ansprechen kann. Die ID darf noch nicht vergeben sein.

### Aufrufer nach Erfolg löschen

`caller_erasure: "on_success"` an einem solchen Workflow löscht den Aufrufer, sobald der Lauf erfolgreich ist:

- Budgetzeilen und Identitätsbindungen werden gelöscht.
- Sitzungen und Schlüssel werden widerrufen.
- Der Benutzer wird deaktiviert und anonymisiert.
- Das Subject wird aus dem Aufrufer-Kontext seiner Ausführungen entfernt.
- Ein Löschvermerk (Tombstone) mit nur dem SHA-256 des Subjects lehnt Tokens ab, die vor der Löschung ausgestellt wurden.

Request-Schritte können den eigenen Datensatz des Aufrufers mit `${caller.subject}` und der Grenzregel `{caller_bound: true}` ansprechen. Die Regel wird auch bei einem DELETE akzeptiert.

### Zugangsdaten des eigenen Konnektors

Ein Request-Schritt eines gespeicherten Workflows darf das Zugangsdatum seines eigenen Konnektors als `${cred.<own-slug>.<field>}` lesen, ohne `connector:read`. Das gilt nur unter einer Live-Freigabe und nicht in einer zurückgehaltenen Vorbereitung. Der Verweis muss innerhalb der freigegebenen Reichweite bleiben. Entwurfs- und Schrittläufe, zurückgehaltene Vorbereitungen und gespeicherte Läufe ohne Freigabe brauchen weiter `connector:read` für diesen Konnektor.

Die eigentliche Grenze: Das Zugangsdatum geht nur an den Origin dieses Konnektors und nie mit einer Weiterleitung. Zusätzlich schwärzt SubKit den Wert in roher, URL-kodierter, formularkodierter und JSON-maskierter Form in Schrittausgaben, Fehlern, Audit und Logs. Das ist nur eine Hilfe nach bestem Bemühen. Gibt ein Upstream den Wert in einer anderen Kodierung zurück oder speichert ihn und liefert ihn später aus, greift sie nicht.
