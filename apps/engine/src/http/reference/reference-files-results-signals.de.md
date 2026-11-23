---
slug: reference-files-results-signals
title: Referenz: Dateien vom Desktop, Run-Ergebnisse und Anmeldesignale
summary: Schlag die Routen, Felder, Ereignisse und Audit-Aktionen für abgelegte Dateien, Markdown-Ergebnisse, Anmeldesignale und lückenlose Statistiken nach.
section: reference
order: 7
audience: public
---
## Referenz: Dateien vom Desktop, Run-Ergebnisse und Anmeldesignale

Diese Seite listet, was SubKit ergänzt, damit Desktop-App und Cockpit Dateien, Ergebnisse und Anmeldungen zeigen, ohne zu raten.
Sie ist für alle, die mit eigenem Code oder im Betrieb auf diesen Teilen aufbauen. Die vollständige, maschinenlesbare Beschreibung jeder Route findest du unter `/openapi.json` auf deiner Engine.

### Routen

| Route | Wer darf sie aufrufen | Macht |
| --- | --- | --- |
| `POST /v1/chat/composer/attachments` | Eine Person mit `conversation:write` | Legt eine Datei in dein Chat-Eingabefeld. Dort wartet sie auf deine nächste Nachricht. |
| `GET /v1/chat/composer/attachments` | Eine Person mit `conversation:read` | Listet die wartenden Dateien, die neueste zuerst. |
| `POST /v1/chat/composer/attachments/claim` | Eine Person mit `conversation:write` | Hängt die wartenden Dateien an eine Unterhaltung und leert das Eingabefeld. |
| `DELETE /v1/chat/composer/attachments/{id}` | Eine Person mit `conversation:write` | Nimmt eine Datei aus deinem Eingabefeld. |
| `POST /v1/intake/items/file` | `intake:write` | Sammelt eine Datei in den Eingang. |

„Eine Person“ heißt ein Benutzerkonto, kein Systemkonto. Ein Systemkonto bekommt `403 person_required`.

### Dateien für deine nächste Chat-Nachricht

Die Ablage der Desktop-App nutzt diese Routen für „Im Chat anhängen“. Der Cockpit-Chat holt die Dateien ab, sobald er sich öffnet oder den Fokus bekommt.

- Der Body von `POST` ist derselbe wie für einen Anhang einer Unterhaltung: `{filename, content_type, content_base64}` für eine neue Datei oder `{"$file": "<Datei-ID>"}` für eine vorhandene.
- Die Antwort ist `{id, file, staged_at, expires_at}`. `file` hat dieselben Felder wie ein Anhang einer Unterhaltung, auch `slug` und `reference`.
- Eine Datei wartet 24 Stunden. Dein Eingabefeld fasst höchstens 10 Dateien; eine weitere bekommt `409 composer_full`. Legst du dieselbe Datei noch einmal ab, verlängert sich nur ihre Zeit.
- Dateien dürfen höchstens 5 MB groß sein und durchlaufen dieselbe Malware-Prüfung wie jeder Upload.
- Nur du siehst, übernimmst oder entfernst deine wartenden Dateien. Die ID einer anderen Person beantwortet SubKit mit `404`.
- `claim` nimmt `{conversation_id, ids?}`. Ohne `ids` übernimmt es alle wartenden Dateien. Wartet eine der `ids` nicht in deinem Eingabefeld, lehnt SubKit den ganzen Aufruf mit `404` ab und ändert nichts.

### Dateien im Eingang

`POST /v1/intake/items/file` nimmt `{client_request_id, captured_at, filename, content_type, content_base64, category?, title?, note?}`.

| Art | `content_type` |
| --- | --- |
| PDF | `application/pdf` |
| Bilder | `image/png`, `image/jpeg`, `image/gif`, `image/webp` |
| Text | `text/csv`, `text/plain`, `text/markdown`, `application/json` |

- Höchstens 5 MB.
- Der Inhalt muss zur Art passen: Ein PNG muss wie ein PNG beginnen, Text muss UTF-8 sein, JSON muss sich lesen lassen. HTML, SVG, XML und Skripte lehnt SubKit ab, auch wenn sie sich als Text ausgeben.
- Die Datei durchläuft die Malware-Prüfung. Eine abgelehnte Datei legt keinen Eintrag an.
- `title` ist ohne Angabe der Dateiname. Der Text des Eintrags ist bei CSV, Text, Markdown und JSON der Inhalt der Datei, bei PDFs und Bildern eine Zeile mit dem Dateinamen.
- `client_request_id` wirkt wie bei Texteinträgen: Dieselbe ID mit derselben Datei liefert denselben Eintrag.
- Jeder Eintrag im Eingang hat jetzt `attachment`: `null` oder `{file_id, filename, content_type, size_bytes}`. Die Datei lädst du mit `GET /v1/files/{file_id}/content` (`file:read`).

| Antwort | Code | Bedeutung |
| --- | --- | --- |
| 413 | `too_large` | Größer als 5 MB. |
| 422 | `unsupported_file_type` | Die Art steht nicht in der Liste. |
| 422 | `content_type_mismatch` | Der Inhalt passt nicht zur Art. |
| 422 | `file_rejected` | Die Malware-Prüfung hat die Datei abgelehnt. |
| 409 | `conflict` | Die `client_request_id` wurde schon für etwas anderes verwendet. |

### Markdown-Ergebnis eines Runs

`GET /v1/executions/{id}` liefert jetzt `result_markdown` (Text oder `null`) und `result_markdown_truncated`. Die Run-Ansicht zeigt den Text als Ergebnis des Runs.

Ein Workflow liefert das Ergebnis auf einem von zwei Wegen:

1. **Deklariert:** Sein `output_schema` kennzeichnet einen Text mit `"contentMediaType": "text/markdown"` als Markdown, entweder für die ganze Ausgabe oder für ein Feld der obersten Ebene. Tragen mehrere Felder die Kennzeichnung, zählt das erste.
2. **Über den Namen:** Ohne Kennzeichnung zählt ein Textfeld `result_markdown` auf der obersten Ebene der Ausgabe.

```json
{
  "output_schema": {
    "type": "object",
    "properties": {
      "summary": { "type": "string", "contentMediaType": "text/markdown" }
    }
  }
}
```

- Es zählt die Ausgabe nach `output_transform`. So kann eine Transformation den Text aus dem letzten Schritt bauen.
- Nur ein erfolgreicher Run behält ein Ergebnis. SubKit speichert es einmal, wenn der Run endet.
- Geheimnisse entfernt SubKit vor dem Speichern: Tokens, Schlüssel und Passwörter werden zu `***redacted***`, ebenso Zugangsdaten in Links. Vertrauliche Workflows behalten nie ein Ergebnis.
- SubKit behält höchstens 64 KiB Text. Ein längerer Text wird gekürzt, und `result_markdown_truncated` ist `true`.

### Links zu geänderten Datensätzen

`GET /v1/executions/{id}`, das MCP-Tool `get_execution` und `subkit executions show` liefern `record_links`: je einen Eintrag pro Datensatz, den ein Request-Step in einem externen System angelegt oder geändert hat, mit `label`, `url`, `connector`, `connector_name` und `step_key`. Das Cockpit zeigt sie als Buttons wie „In GitHub ansehen“, die in einem neuen Tab öffnen.

- Eingebaute Connector-Templates legen fest, welche Requests zu einem Datensatz führen (`record_url_patterns`) und welche Web-Hosts erlaubt sind (`web_hosts`). Eine Webadresse, die schon in der Antwort steht, hat Vorrang.
- Es zählen nur `https`-Adressen auf einem bekannten Web-Host. Connectoren ohne eingebautes Template bekommen keine Links.
- Vertrauliche Runs, zurückgehaltene Schreibzugriffe und Step-Ausgaben, die geschwärzt oder als Datei abgelegt wurden, bekommen keine Links.
- Höchstens 20 Links pro Run, in der Reihenfolge der Steps, jede Adresse einmal.

### Ausgang eines geplanten Runs

Jeder Eintrag der Zeitplan-Historie (`GET /v1/workflows/{id}/schedule-occurrences`, `GET /v1/tasks/{id}/schedule-occurrences`) hat jetzt `run_outcome`:

| `run_outcome` | Bedeutung |
| --- | --- |
| `running` | Der Run ist noch nicht zu Ende. |
| `succeeded` | Der Run ist erfolgreich zu Ende gegangen. |
| `failed` | Der Run ist fehlgeschlagen oder hat die Zeit überschritten. |
| `aborted` | Der Run wurde angehalten. |
| `null` | Der Eintrag hat keinen Run gestartet, oder der Run ist nicht mehr gespeichert. |

`state` beschreibt weiter den Zeitpunkt (pünktlich, verspätet, ausgelassen, angehalten), `run_outcome` den Ausgang des Runs.

### Anmeldung abgeschlossen

Endet die Anmeldung bei einem Connector, erfolgreich oder nicht, schreibt SubKit das Ereignis `connector.oauth.signin_finished`. Das gilt für OAuth-Connectors, MCP-Connectors und Kontoverbindungen; bei einer Kontoverbindung schreibt SubKit ein Ereignis je Connector, der sie nutzt, mit `connector_slug` `null`.

| Feld | Bedeutung |
| --- | --- |
| `connector_id` | Der Connector. |
| `connector_slug` | Sein Kurzname oder `null`. |
| `outcome` | `succeeded` oder `failed`. |
| `reason` | Warum es fehlschlug: `provider_error`, `missing_code` oder `token_exchange_failed`. Bei Erfolg `null`. |

- Im Cockpit-Stream (`GET /v1/cockpit/events/stream`, mit `connector:read`) kommt das Ereignis mit `connector_id`, `attention_id`, `outcome` und bei einem Fehler `reason`. Desktop-App und Cockpit warten darauf, statt aus dem Fensterfokus zu raten.
- Webhook-Abonnements können es wie jedes andere Ereignis abonnieren.
- Ein abgelaufener oder unbekannter Anmeldelink gehört zu keinem Connector und schreibt kein Ereignis.

### Lückenlose Statistiken

`GET /v1/stats/executions` und `GET /v1/stats/llm` nehmen `fill`:

- `zero` (Standard): Jeder Abschnitt des Zeitraums steht in der Antwort, der älteste zuerst, auch die leeren mit `0`. Ohne `group_by` hat die Antwort immer genau eine Gruppe.
- `none`: nur Abschnitte mit Daten, wie bisher. Sinnvoll für breite Aufschlüsselungen wie `group_by=conversation`.

### Audit-Aktionen

| Aktion | Geschrieben, wenn |
| --- | --- |
| `chat.composer_attachment_staged` | Eine Datei wurde in ein Eingabefeld gelegt. |
| `chat.composer_attachment_removed` | Eine Datei wurde aus einem Eingabefeld genommen. |
| `chat.composer_attachments_claimed` | Wartende Dateien wurden an eine Unterhaltung gehängt. Für jede Datei folgt `file.link_added`. |
| `intake_item.collected` | Wie bisher; bei einer Datei mit `attachment_file_id`. |
