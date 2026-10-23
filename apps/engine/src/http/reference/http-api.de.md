---
slug: http-api
summary: Rufe SubKit per HTTP aus deinem eigenen Programm oder Skript auf.
section: work
order: 6
audience: public
---
## Die HTTP-API nutzen

Starte Workflows aus deinem eigenen Programm oder Skript und lies ihr Ergebnis.
Alle Beispiele nutzen `curl`, du kannst sie also zuerst im Terminal ausprobieren.
Es funktioniert in SubKit Cloud und auf einer selbst betriebenen Engine gleich.

### Was du brauchst

- Die Adresse deiner Engine.
  - Cloud: `https://subkit-cloud.mikebild.info` (ohne `/cockpit`)
  - Selbst betrieben: `https://<deine-engine>`
- Einen API-Schlüssel mit `workflow:read`, `workflow:run` und `execution:read`. Leg ihn mit der sk-CLI an, wie in diesem Kapitel gezeigt, oder im Cockpit unter **API-Zugang**. Für die CLI meldest du dich an wie in „Die sk-CLI auf deinem Rechner verwenden“ beschrieben.
- Einen Workflow, der aktiv und freigegeben ist. Siehe „Dein erster Workflow“.
- `curl` in deinem Terminal.

### Die Engine erreichen

`/health` braucht keinen Schlüssel.

1. Setze die Adresse als Variable:

   ```bash
   export SK_URL=https://<deine-engine>
   ```

2. Rufe `/health` auf:

   ```bash
   curl -s "$SK_URL/health"
   ```

   ```json
   { "status": "ok", "service": "subkit", "version": "<version>" }
   ```

### Einen API-Schlüssel anlegen und prüfen

1. Leg einen Schlüssel mit genau den Rechten an, die dieses Kapitel braucht:

   ```bash
   sk apikeys create --name http-api-test --scopes workflow:read,workflow:run,execution:read
   ```

2. Kopiere `plaintext_key` aus der JSON-Antwort. Er wird nur einmal angezeigt, bewahre ihn in einem Passwortmanager auf.
3. Leg den Schlüssel in eine Variable:

   ```bash
   export SK_KEY=<api-key>
   ```

4. Frag die Engine, wer du bist:

   ```bash
   curl -s "$SK_URL/v1/identity/whoami" \
     -H "Authorization: Bearer $SK_KEY"
   ```

   Die Antwort nennt dein Konto, deinen Arbeitsbereich und die Scopes des Schlüssels (gekürzt):

   ```json
   {
     "id": "<user-id>",
     "kind": "user",
     "tenant_slug": "<workspace>",
     "role_name": "admin",
     "scopes": ["workflow:read", "workflow:run", "execution:read"]
   }
   ```

Ohne `--scopes` bekommt der Schlüssel dieselben Scopes wie dein eigener Zugang.
`sk apikeys revoke <key-id>` widerruft den Schlüssel.

### Deine Workflows auflisten

1. Rufe die aktiven Workflows ab:

   ```bash
   curl -s "$SK_URL/v1/workflows?status=active&limit=20" \
     -H "Authorization: Bearer $SK_KEY"
   ```

   Jeder Eintrag in `items` trägt unter anderem `id`, `slug`, `name`, `lifecycle` und `operating_status` (gekürzt):

   ```json
   {
     "items": [
       {
         "id": "<workflow-id>",
         "slug": "daily-report",
         "name": "Daily report",
         "lifecycle": "active",
         "operating_status": "active"
       }
     ],
     "total": 1,
     "categories": [{ "category": "reporting", "count": 1 }]
   }
   ```

2. Kopiere die `id`. Läufe brauchen die ID, ein Slug wird nicht angenommen.

`q=<text>` durchsucht Name, Slug, Beschreibung und Kategorie.

### Einen Lauf starten

- Schick die Workflow-ID und die Eingabe an `/v1/executions`:

  ```bash
  curl -s -X POST "$SK_URL/v1/executions" \
    -H "Authorization: Bearer $SK_KEY" \
    -H "Content-Type: application/json" \
    -d '{"source":"saved","workflow_id":"<workflow-id>","input":{}}'
  ```

  Der Aufruf wartet auf den Lauf und antwortet mit `200`, `execution_id`, `status`, `output` und `steps`.

`input` muss zur Eingabe des Workflows passen. `GET /v1/workflows/<workflow-id>/input-schema` zeigt, was er erwartet.

### Einen langen Lauf im Hintergrund starten

1. Schick den Lauf mit `"async":true`. Optional: Ergänze einen Header `Idempotency-Key`:

   ```bash
   curl -s -X POST "$SK_URL/v1/executions" \
     -H "Authorization: Bearer $SK_KEY" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: daily-report-<date>" \
     -d '{"source":"saved","workflow_id":"<workflow-id>","input":{},"async":true}'
   ```

   Die Engine antwortet sofort mit `202`:

   ```json
   { "execution_id": "<execution-id>", "status": "queued", "hold_writes": false }
   ```

2. Kopiere `execution_id` und lies das Ergebnis wie im nächsten Abschnitt beschrieben.

- Der Header `Idempotency-Key` nimmt 1 bis 200 Zeichen.
- Schickst du denselben Schlüssel noch einmal, startet kein zweiter Lauf. Die Antwort trägt die ID des ersten Laufs und `"idempotent_replay": true`.

### Das Ergebnis lesen

1. Lies den Lauf:

   ```bash
   curl -s "$SK_URL/v1/executions/<execution-id>" \
     -H "Authorization: Bearer $SK_KEY"
   ```

2. Prüfe `status`.
3. Lies bei einem Fehler `outcome.failed_step` für den Schritt und `error` für die Ursache.
4. Lies die Ausgabe jedes Schritts:

   ```bash
   curl -s "$SK_URL/v1/executions/<execution-id>/steps" \
     -H "Authorization: Bearer $SK_KEY"
   ```

   Jeder Eintrag hat `step_key`, `status` und eine Vorschau in `output_preview` oder `result_preview`. Der letzte Schritt enthält meist das Ergebnis des Workflows.

| `status` | Bedeutung |
| --- | --- |
| `queued`, `running` | Der Lauf arbeitet noch. |
| `succeeded` | Der Lauf ist fertig. |
| `failed`, `timed_out`, `aborted` | Der Lauf wurde vorzeitig beendet. |

`outcome.kind` fasst den Lauf zusammen, zum Beispiel `succeeded`, `failed` oder `held`.
`sk executions result <execution-id>` zeigt dasselbe Ergebnis im Terminal.

### Seitenweise lesen

Listen liefern jeweils eine Seite. `total` zählt alle Treffer.

| Liste | Seitengröße | Nächste Seite |
| --- | --- | --- |
| `GET /v1/workflows` | `limit` (bis 200) | `offset`: so viele Einträge überspringen |
| `GET /v1/executions` | `limit` (bis 200) | `cursor`: der `next_cursor` der vorigen Seite |

Läufe kommen neueste zuerst. Gib `next_cursor` genau so zurück, wie du ihn bekommen hast. Ist er `null`, bist du auf der letzten Seite.

```bash
curl -s "$SK_URL/v1/executions?workflow_id=<workflow-id>&status=failed,timed_out&limit=50" \
  -H "Authorization: Bearer $SK_KEY"
```

`status` nimmt mehrere Werte, durch Kommas getrennt.

### So ist die API aufgebaut

- Jede Route beginnt mit `/v1`, zum Beispiel `/v1/workflows`.
- Deinen API-Schlüssel schickst du im Header `Authorization` als Bearer-Token.
- Anfragen und Antworten sind JSON.
- `/openapi.json` beschreibt jede Route, jedes Feld und jeden Statuscode im OpenAPI-Format.
- `/docs` zeigt dieselbe Beschreibung als durchsuchbare Referenz. Öffne `https://<deine-engine>/docs` im Browser.

### Fehler und Statuscodes

Fehler sind JSON mit einem maschinenlesbaren `code` und einer lesbaren `message`:

```json
{
  "code": "not_found",
  "message": "workflow not found",
  "trace_id": "<trace-id>"
}
```

Manche Fehler ergänzen `hint` (was zu tun ist), `details` (zum Beispiel die ungültigen Felder) oder `retry_after` (Sekunden).
Verzweige in deinem Programm nach `code`, nicht nach `message`. Heb `trace_id` auf, wenn du ein Problem meldest.

| Status | `code` (Beispiele) | Bedeutung |
| --- | --- | --- |
| `200` | | Erledigt. |
| `202` | | Angenommen. Der Lauf geht im Hintergrund weiter. |
| `400` | `bad_request` | Die Anfrage ist ungültig. `details` nennt die Felder. |
| `401` | `unauthorized` | Der Schlüssel fehlt, ist falsch, abgelaufen oder widerrufen. Prüfe `Authorization: Bearer <api-key>` oder leg einen neuen Schlüssel an. |
| `403` | `forbidden` | Dem Schlüssel fehlt ein Scope oder deiner Rolle das Recht. Leg einen Schlüssel mit `workflow:read`, `workflow:run` und `execution:read` an. |
| `404` | `not_found` | Die ID gibt es in deinem Arbeitsbereich nicht. |
| `409` | `conflict` | Der aktuelle Zustand erlaubt es nicht. Bei einem Lauf: keine aktive Version, oder die Freigabe fehlt oder ist aufgebraucht. |
| `429` | `rate_limit_exceeded`, `rate_limited` | Ein Limit ist erreicht. Warte so lange, wie der Header `Retry-After` sagt, und versuch es dann mit demselben `Idempotency-Key` erneut. |
| `500` | `internal_error` | Ein Fehler in der Engine. Melde die `trace_id`. |

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `404 Not Found` als reiner Text | Den Pfad gibt es nicht. Prüfe, ob er mit `/v1` beginnt. |
| `400` mit `request validation failed` | Lies `details`. Oft ist `workflow_id` keine UUID, oder `input` passt nicht zum Eingabeschema. |
| Der Lauf antwortet mit `"hold_writes": true` | Die Version hat für diese Umgebung keine Freigabe. Nichts wurde geschrieben. Gib sie frei wie in „Dein erster Workflow“ beschrieben. |
| Ein anderer Fehlerstatus | Schlag den Status unter „Fehler und Statuscodes“ nach und lies `message` und `details`. |
