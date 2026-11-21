---
slug: http-api
summary: Starte Workflows aus deinem eigenen Programm und lies ihre Ergebnisse.
section: work
order: 6
audience: public
---
## Die HTTP-API nutzen

Dein Programm, Skript oder Backend soll einen freigegebenen Workflow starten und mit dem Ergebnis weiterarbeiten.
Dieses Kapitel ist für Entwickler und führt dich vom ersten Schlüssel bis zum gelesenen Run.
Danach weißt du, wie du Runs startest, auf sie wartest und Fehler sauber behandelst.

Alle Beispiele nutzen `curl`, du kannst sie also zuerst im Terminal ausprobieren.
SubKit Cloud und eine selbst betriebene Engine verhalten sich dabei gleich.

### Was du brauchst

- Die Adresse deiner Engine.
  - Cloud: `https://subkit-cloud.mikebild.dev` (ohne `/cockpit`)
  - Selbst betrieben: `https://<deine-engine>`
- Einen API-Schlüssel mit den Scopes `workflow:read`, `workflow:run` und `execution:read`. Ein Scope ist ein einzelnes Recht, das der Schlüssel mitbringt. Leg den Schlüssel mit der sk-CLI an, wie unten gezeigt, oder im Cockpit unter **API-Zugang**. Für die CLI meldest du dich an wie in „Die sk-CLI auf deinem Rechner verwenden“ beschrieben.
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

   Die Antwort nennt dein Konto, deinen Arbeitsbereich und die Scopes des Schlüssels (gekürzt). Der Arbeitsbereich ist der abgetrennte Bereich deines Teams in der Engine:

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

   Jeder Eintrag in `items` trägt unter anderem `id`, `slug`, `name`, `lifecycle` und `operating_status`. Im Beispiel heißt der Workflow „Tagesbericht“ (gekürzt):

   ```json
   {
     "items": [
       {
         "id": "<workflow-id>",
         "slug": "tagesbericht",
         "name": "Tagesbericht",
         "lifecycle": "active",
         "operating_status": "active"
       }
     ],
     "total": 1,
     "categories": [{ "category": "reporting", "count": 1 }]
   }
   ```

2. Kopiere die `id`. Ein Run braucht die ID, einen Slug nimmt die Engine nicht an.

`q=<text>` durchsucht Name, Slug, Beschreibung und Kategorie.

### Einen Run starten

- Schick die Workflow-ID und die Eingabe an `/v1/executions`:

  ```bash
  curl -s -X POST "$SK_URL/v1/executions" \
    -H "Authorization: Bearer $SK_KEY" \
    -H "Content-Type: application/json" \
    -d '{"source":"saved","workflow_id":"<workflow-id>","input":{}}'
  ```

  Der Aufruf wartet auf den Run und antwortet mit `200`, `execution_id`, `status`, `output` und `steps`.

`input` muss zur Eingabe des Workflows passen. `GET /v1/workflows/<workflow-id>/input-schema` zeigt, was er erwartet.

### Einen langen Run im Hintergrund starten

1. Schick den Run mit `"async":true`. Optional ergänzt du einen Header `Idempotency-Key`. Mit ihm startet ein versehentlich doppelt gesendeter Aufruf trotzdem nur einen Run:

   ```bash
   curl -s -X POST "$SK_URL/v1/executions" \
     -H "Authorization: Bearer $SK_KEY" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: tagesbericht-<datum>" \
     -d '{"source":"saved","workflow_id":"<workflow-id>","input":{},"async":true}'
   ```

   Die Engine antwortet sofort mit `202`:

   ```json
   { "execution_id": "<execution-id>", "status": "queued", "hold_writes": false }
   ```

2. Kopiere `execution_id` und lies das Ergebnis wie im nächsten Abschnitt beschrieben.

- Der Header `Idempotency-Key` nimmt 1 bis 200 Zeichen.
- Schickst du denselben Schlüssel noch einmal, startet kein zweiter Run. Die Antwort trägt die ID des ersten Runs und `"idempotent_replay": true`.

### Das Ergebnis lesen

1. Lies den Run:

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
| `queued`, `running` | Der Run arbeitet noch. |
| `succeeded` | Der Run ist fertig. |
| `failed`, `timed_out`, `aborted` | Der Run wurde vorzeitig beendet. |

`outcome.kind` fasst den Run zusammen, zum Beispiel `succeeded`, `failed` oder `held`.
`sk executions result <execution-id>` zeigt dasselbe Ergebnis im Terminal.

### Prüfen, ob ein Workflow automatisch laufen kann

Bevor ein Workflow nach Zeitplan läuft, willst du wissen, ob eine Freigabe ihn überhaupt abdecken kann. Diese Antwort steckt im Feld `automation_readiness`.

Du bekommst es beim Speichern eines Workflows (`POST /v1/workflows`, `PUT /v1/workflows/{id}`). Ebenso beim Anlegen oder Ändern eines Zeitplans (`POST /v1/schedules`, `PUT /v1/schedules/{id}`). Das Feld hat die Form `{environment, workflow_version_id, state, issues, repair_guidance}`.

| `state` | Bedeutung |
| --- | --- |
| `eligible` | Eine Person kann wiederkehrende Runs freigeben. |
| `repair_required` | Keine Freigabe kann die genannten Schritte abdecken, solange sie nicht geändert sind. |
| `verification_unavailable` | Die Engine konnte die Prüfung nicht durchführen. Versuch es später erneut. |

Jeder Eintrag in `issues` nennt `step_id` und `code`. `repair_guidance` sagt, wie du den Schritt änderst. Ein pausierter Zeitplan bekommt kein Urteil.

### Ein Paket exportieren und importieren

Ein Paket bringt die eigenen Ressourcen deines Arbeitsbereichs auf eine andere Engine. Die Schritte nach dem Import stehen in „Die sk-CLI auf deinem Rechner verwenden“.
Der Export braucht `package:export`, der Import `package:import`.

| Route | Macht |
| --- | --- |
| `POST /v1/packages/export` | Erstellt das Paket und antwortet mit seiner `file_id`. |
| `GET /v1/packages/archives/{file_id}` | Lädt das Paket als ZIP-Datei herunter. |
| `POST /v1/packages/import/preview` | Nimmt die ZIP-Datei als Multipart-Feld `archive` oder `{"archive_file_id": "<file-id>"}`. Antwortet mit einem Plan pro Eintrag und einem `plan_digest`. Ändert nichts. |
| `POST /v1/packages/import/apply` | Nimmt `{"archive_file_id": "<file-id>", "expected_plan_digest": "<plan-digest>"}` und wendet den Plan an. |
| `GET /v1/packages/installs`, `GET /v1/packages/installs/{id}` | Listet frühere Importe. |

Hat sich das Ziel nach der Vorschau geändert, antwortet apply mit `409`. Starte die Vorschau erneut.

### Seitenweise lesen

Listen liefern jeweils eine Seite. `total` zählt alle Treffer.

| Liste | Seitengröße | Nächste Seite |
| --- | --- | --- |
| `GET /v1/workflows` | `limit` (bis 200) | `offset`: so viele Einträge überspringen |
| `GET /v1/executions` | `limit` (bis 200) | `cursor`: der `next_cursor` der vorigen Seite |

Runs kommen neueste zuerst. Gib `next_cursor` genau so zurück, wie du ihn bekommen hast. Ist er `null`, bist du auf der letzten Seite.

```bash
curl -s "$SK_URL/v1/executions?workflow_id=<workflow-id>&status=failed,timed_out&limit=50" \
  -H "Authorization: Bearer $SK_KEY"
```

`status` nimmt mehrere Werte, durch Kommas getrennt.

### So ist die API aufgebaut

- Jede Route beginnt mit `/v1`, zum Beispiel `/v1/workflows`.
- Deinen API-Schlüssel schickst du im Header `Authorization` als `Bearer <api-key>`. „Bearer“ heißt: Wer den Schlüssel vorzeigt, gilt als berechtigt.
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
| `202` | | Angenommen. Der Run geht im Hintergrund weiter. |
| `400` | `bad_request` | Die Anfrage ist ungültig. `details` nennt die Felder. |
| `401` | `unauthorized` | Der Schlüssel fehlt, ist falsch, abgelaufen oder widerrufen. Prüfe `Authorization: Bearer <api-key>` oder leg einen neuen Schlüssel an. |
| `403` | `forbidden` | Dem Schlüssel fehlt ein Scope oder deiner Rolle das Recht. Leg einen Schlüssel mit `workflow:read`, `workflow:run` und `execution:read` an. |
| `404` | `not_found` | Die ID gibt es in deinem Arbeitsbereich nicht. |
| `409` | `conflict` | Der aktuelle Zustand erlaubt es nicht. Bei einem Run: Es gibt keine aktive Version, oder die Freigabe fehlt oder ist aufgebraucht. |
| `429` | `rate_limit_exceeded`, `rate_limited` | Ein Limit ist erreicht. Warte so lange, wie der Header `Retry-After` sagt. Versuch es dann mit demselben `Idempotency-Key` erneut. |
| `500` | `internal_error` | Ein Fehler in der Engine. Melde die `trace_id`. |

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `404 Not Found` als reiner Text | Den Pfad gibt es nicht. Prüfe, ob er mit `/v1` beginnt. |
| `400` mit `request validation failed` | Lies `details`. Oft ist `workflow_id` keine UUID, oder `input` passt nicht zum Eingabeschema. |
| Der Run antwortet mit `"hold_writes": true` | Die Version hat für diese Umgebung keine Freigabe. Nichts wurde geschrieben. Gib sie frei wie in „Dein erster Workflow“ beschrieben. |
| Ein anderer Fehlerstatus | Schlag den Status unter „Fehler und Statuscodes“ nach und lies `message` und `details`. |
