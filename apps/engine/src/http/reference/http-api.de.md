---
slug: http-api
summary: Rufe SubKit per HTTP aus deinem eigenen Programm oder Skript auf.
section: work
order: 6
audience: public
---
## Die HTTP-API nutzen

In diesem Kapitel rufst du SubKit aus deinem eigenen Programm oder Skript auf.
Du legst einen API-Schlüssel an, prüfst ihn, listest deine Workflows, startest einen Lauf und liest sein Ergebnis.
Alle Beispiele nutzen `curl`. So kannst du alles zuerst im Terminal ausprobieren.

Es funktioniert in SubKit Cloud und auf einer selbst betriebenen Engine gleich.

### Was du brauchst

- Die Adresse deiner Engine.
  - Cloud: `https://subkit-cloud.mikebild.info`
  - Selbst betrieben: `https://<deine-engine>`
- Die sk-CLI, angemeldet an dieser Engine. Siehe das Kapitel **Die sk-CLI auf deinem Rechner verwenden**.
- Einen Workflow, der aktiv und freigegeben ist. Siehe das Kapitel **Dein erster Workflow**.
- `curl` in deinem Terminal.

### So ist die API aufgebaut

- Jede API-Route beginnt mit `/v1`, zum Beispiel `/v1/workflows`.
- Deinen API-Schlüssel schickst du im Header `Authorization` als Bearer-Token.
- Anfragen und Antworten sind JSON.
- `/openapi.json` beschreibt jede Route, jedes Feld und jeden Statuscode (OpenAPI 3.1).
- `/docs` zeigt dieselbe Beschreibung als durchsuchbare Referenz.

Öffne `https://<deine-engine>/docs` im Browser, um jede Route aus diesem Kapitel nachzuschlagen.

### Schritt 1: Die Engine erreichen

`/health` braucht keinen Schlüssel. Damit prüfst du die Adresse.

```bash
export SK_URL=https://<deine-engine>
curl -s "$SK_URL/health"
```

```json
{ "status": "ok", "service": "subkit", "version": "<version>" }
```

### Schritt 2: Einen API-Schlüssel anlegen

1. Leg mit der sk-CLI einen Schlüssel an. Gib ihm einen Namen und nur die Berechtigungen, die dieses Kapitel braucht:

   ```bash
   sk apikeys create --name http-api-test --scopes workflow:read,workflow:run,execution:read
   ```

2. Die Antwort ist JSON. Kopiere den Wert von `plaintext_key`.
   Der Schlüssel wird nur einmal angezeigt. Bewahre ihn in einem Passwortmanager oder Secret-Speicher auf.
3. Leg den Schlüssel für die nächsten Schritte in eine Variable:

   ```bash
   export SK_KEY=<api-key>
   ```

Ohne `--scopes` bekommt der Schlüssel dieselben Scopes wie dein eigener Zugang.
`sk apikeys revoke <key-id>` widerruft den Schlüssel, wenn du ihn nicht mehr brauchst.

### Schritt 3: Den Schlüssel prüfen

Frag die Engine, wer du bist:

```bash
curl -s "$SK_URL/v1/identity/whoami" \
  -H "Authorization: Bearer $SK_KEY"
```

Die Antwort nennt dein Konto, deinen Workspace und die Scopes des Schlüssels (gekürzt):

```json
{
  "id": "<user-id>",
  "kind": "user",
  "tenant_slug": "<workspace>",
  "role_name": "admin",
  "scopes": ["workflow:read", "workflow:run", "execution:read"]
}
```

Bekommst du `401`, ist der Schlüssel falsch oder widerrufen. Siehe **Wenn etwas nicht klappt**.

### Schritt 4: Deine Workflows auflisten

```bash
curl -s "$SK_URL/v1/workflows?status=active&limit=20" \
  -H "Authorization: Bearer $SK_KEY"
```

Die Antwort enthält `items`, `total` und `categories`. Jeder Eintrag trägt unter anderem
`id`, `slug`, `name`, `lifecycle` und `operating_status` (gekürzt):

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

Kopiere die `id`. Läufe brauchen diese ID; ein Slug wird nicht angenommen.
`q=<text>` durchsucht Name, Slug, Beschreibung und Kategorie.

### Schritt 5: Einen Lauf starten

Schick die Workflow-ID und ihre Eingabe an `/v1/executions`:

```bash
curl -s -X POST "$SK_URL/v1/executions" \
  -H "Authorization: Bearer $SK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source":"saved","workflow_id":"<workflow-id>","input":{}}'
```

- `input` muss zur Eingabe des Workflows passen. `GET /v1/workflows/<workflow-id>/input-schema` zeigt, was er erwartet.
- Ohne `async` wartet der Aufruf, bis der Lauf fertig ist. Er antwortet mit `200` und
  `execution_id`, `status`, `output` und `steps`.

Längere Läufe startest du im Hintergrund:

```bash
curl -s -X POST "$SK_URL/v1/executions" \
  -H "Authorization: Bearer $SK_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: daily-report-2026-10-21" \
  -d '{"source":"saved","workflow_id":"<workflow-id>","input":{},"async":true}'
```

```json
{ "execution_id": "<execution-id>", "status": "queued", "hold_writes": false }
```

Die Antwort ist `202`. Der Header `Idempotency-Key` ist optional (1 bis 200 Zeichen).
Schickst du denselben Schlüssel noch einmal, startet kein zweiter Lauf. Die Antwort trägt dann die ID des ersten Laufs und `"idempotent_replay": true`.

### Schritt 6: Prüfen

1. Lies den Lauf:

   ```bash
   curl -s "$SK_URL/v1/executions/<execution-id>" \
     -H "Authorization: Bearer $SK_KEY"
   ```

2. Schau auf `status`. `queued` und `running` heißen, dass der Lauf noch nicht fertig ist; frag etwas später erneut.
   `succeeded` heißt, dass der Lauf fertig ist. `failed`, `timed_out` und `aborted` heißen, dass er abgebrochen ist.
3. `outcome.kind` fasst den Lauf zusammen, zum Beispiel `succeeded`, `failed` oder `held`.
   Bei einem fehlgeschlagenen Lauf nennt `outcome.failed_step` den Schritt, und `error` enthält die Ursache.
4. Lies die Ausgabe jedes Schritts:

   ```bash
   curl -s "$SK_URL/v1/executions/<execution-id>/steps" \
     -H "Authorization: Bearer $SK_KEY"
   ```

   Jeder Eintrag hat `step_key`, `status` und eine Vorschau seiner Ausgabe in `output_preview` oder `result_preview`.
   Der letzte Schritt enthält meist das Ergebnis des Workflows.

`sk executions result <execution-id>` zeigt dasselbe Ergebnis in deinem Terminal.

### Seitenweise lesen

Listen liefern jeweils eine Seite. `total` zählt alle Treffer.

| Liste | Seitengröße | Nächste Seite |
| --- | --- | --- |
| `GET /v1/workflows` | `limit` (bis 200) | `offset`: so viele Einträge überspringen |
| `GET /v1/executions` | `limit` (bis 200) | `cursor`: der `next_cursor` der vorigen Seite |

Läufe kommen neueste zuerst. Gib `next_cursor` genau so zurück, wie du ihn bekommen hast.
Ist `next_cursor` `null`, bist du auf der letzten Seite.

```bash
curl -s "$SK_URL/v1/executions?workflow_id=<workflow-id>&status=failed,timed_out&limit=50" \
  -H "Authorization: Bearer $SK_KEY"
```

`status` nimmt mehrere Werte, durch Kommas getrennt.

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
| `401` | `unauthorized` | Der Schlüssel fehlt, ist falsch, abgelaufen oder widerrufen. |
| `403` | `forbidden` | Der Schlüssel oder deine Rolle darf das nicht. |
| `404` | `not_found` | Die ID gibt es in deinem Workspace nicht. |
| `409` | `conflict` | Der aktuelle Zustand erlaubt es nicht, zum Beispiel keine freigegebene Version. |
| `429` | `rate_limit_exceeded`, `rate_limited` | Ein Limit ist erreicht. Warte so lange, wie der Header `Retry-After` sagt, falls er gesetzt ist. |
| `500` | `internal_error` | Ein Fehler in der Engine. Melde die `trace_id`. |

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| `404 Not Found` als reiner Text | Den Pfad gibt es nicht. Prüfe, ob er mit `/v1` beginnt. |
| `401` mit `unauthorized` | Prüfe den Header `Authorization: Bearer <api-key>`. Leg einen neuen Schlüssel an, wenn er widerrufen wurde. |
| `403` mit `forbidden` | Dem Schlüssel fehlt ein Scope oder deiner Rolle die Berechtigung. Leg einen Schlüssel mit den Scopes aus Schritt 2 an. |
| `400` mit `request validation failed` | Lies `details`. Oft ist `workflow_id` keine UUID oder `source` fehlt. |
| Der Lauf antwortet mit `"hold_writes": true` | Die Version ist für diese Umgebung nicht freigegeben. Nichts wurde geschrieben. Gib sie frei wie in **Dein erster Workflow**, Schritt 4. |
| `409` beim Starten eines Laufs | Lies `message` und `details`. Der Workflow hat keine aktive Version, oder seine Freigabe fehlt oder ist aufgebraucht. |
| `429` | Warte so lange, wie `Retry-After` sagt, oder bis das Limit zurückgesetzt ist. Versuch es dann mit demselben `Idempotency-Key` erneut. |

### Weiter

Du kannst Workflows jetzt aus jedem Programm starten und prüfen. Mach weiter mit dem Kapitel
**Eine App anbinden**, damit die Benutzer deiner eigenen App SubKit mit ihrer Anmeldung aufrufen.
