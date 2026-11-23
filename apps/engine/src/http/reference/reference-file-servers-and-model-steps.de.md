---
slug: reference-file-servers-and-model-steps
title: Referenz: SFTP-Connectors, Model-Steps und Dateien auslesen
summary: Schlag nach, wie ein Workflow einen SFTP-Server erreicht, ein Modell nach einer geprüften Antwort fragt und CSV-, Excel-, PDF-, Word- oder ZIP-Dateien liest.
section: reference
order: 11
audience: public
---
## Referenz: SFTP-Connectors, Model-Steps und Dateien auslesen

Diese Seite beschreibt drei Bausteine für Workflows: einen Connector zu einem SFTP-Dateiserver, einen Step, der ein KI-Modell nach einer Antwort in fester Form fragt, und einen Step, der den Inhalt einer Datei liest.
Sie ist für alle, die Workflow-Definitionen schreiben oder prüfen. Die vollständige, maschinenlesbare Beschreibung jedes Felds findest du unter `/openapi.json` auf deiner Engine.

### SFTP-Connector

Ein SFTP-Connector verbindet SubKit mit genau einem Ordner auf einem Dateiserver.

- **Adresse:** `sftp://host:22/ordner`. Der Port ist optional, ohne Angabe gilt 22. Die Adresse enthält nur Host, Port und Ordner; Benutzername und Passwort gehören nie hinein.
- **Host-Key:** `config.host_key_sha256` enthält den SHA256-Fingerabdruck des Host-Keys des Servers, zum Beispiel aus `ssh-keyscan host | ssh-keygen -lf -`. Fehlt er, lehnt SubKit jeden Aufruf mit `sftp_host_key_missing` ab. Zeigt der Server einen anderen Schlüssel, stoppt der Aufruf mit `sftp_host_key_mismatch`, bevor etwas gesendet wird.
- **Anmeldung:** Benutzername und Passwort, gespeichert als Zugangsdaten des Connectors.
- **Ordner:** Jeder Pfad, den ein Workflow nutzt, bleibt in dem Ordner aus der Adresse. Ein Pfad, der hinausführt, wird mit `sftp_path_outside_root` abgelehnt.
- **Netzwerk:** Die Verbindung läuft durch dieselben Egress-Regeln wie bei jedem anderen Connector. Private Adressen bleiben also gesperrt, solange die Einstellungen deiner Engine sie nicht freigeben.

Der Test des Connectors listet den Ordner mit einem Eintrag. Damit sind Adresse, Host-Key und Anmeldung bestätigt.

### SFTP-Steps

Ein Request-Step mit `protocol: "sftp"` arbeitet mit genau einem Pfad unterhalb des Connector-Ordners.

```json
{
  "id": "list_inbox",
  "kind": "request",
  "protocol": "sftp",
  "connector_id": "<Connector-ID>",
  "method": "LIST",
  "sftp": { "path": "inbox/", "max_entries": 500 }
}
```

| Methode | Macht | Ausgabe |
| --- | --- | --- |
| `LIST` | Liest einen Ordner. | `entries` mit Name, Pfad, Art, Größe und Änderungszeit, nach Name sortiert; `truncated: true`, wenn `max_entries` die Liste gekürzt hat. |
| `GET` | Lädt eine Datei herunter. | Eine Run-Datei, die du an spätere Steps weitergibst, zum Beispiel an einen Parse-File-Step. |
| `PUT` | Lädt den Body des Steps als eine Datei hoch. | Den geschriebenen Pfad und die Anzahl der Bytes. |
| `DELETE` | Entfernt eine Datei. | Den entfernten Pfad. Ordner werden nie entfernt (`sftp_delete_not_a_file`), und ein `DELETE` mit Body wird abgelehnt. |

- `sftp.path` ist der einzige Weg, eine Datei anzusprechen. `url` und `path` am Step werden abgelehnt.
- `PUT` und `DELETE` schreiben. Deshalb brauchen beide dieselbe Freigabe wie jeder andere schreibende Zugriff, und eine Vorschau hält beide zurück.
- Platzhalter wie `${input.folder}` werden vor dem Aufruf ausgefüllt.

### Model-Step

Ein Step mit `kind: "model"` stellt dem KI-Modell deines Workspaces genau eine Frage und prüft die Antwort gegen ein JSON-Schema.

```json
{
  "id": "classify",
  "kind": "model",
  "prompt": "Sort this support message into one category.",
  "input": "${scope.fetch_message.data.body}",
  "output_schema": {
    "type": "object",
    "properties": { "category": { "enum": ["billing", "shipping", "other"] } },
    "required": ["category"]
  },
  "max_output_tokens": 200
}
```

| Feld | Bedeutung |
| --- | --- |
| `prompt` | Die Anweisung. Platzhalter werden vor dem Aufruf ausgefüllt. |
| `system` | Optionaler System-Prompt. Ohne ihn nutzt der Step einen kurzen, neutralen Standard. |
| `input` | Daten, die das Modell neben dem Prompt bekommt, immer als Daten und nie als Anweisung. |
| `output_schema` | JSON-Schema, zu dem die Antwort passen muss. |
| `max_output_tokens` | Obergrenze für die Antwort, höchstens 32.000. Standard 1.024. |

- Die Ausgabe des Steps ist die gelesene Antwort. Ist die Antwort kein gültiges JSON, scheitert der Step mit `model_output_invalid`; passt sie nicht zum Schema, mit `model_output_schema_invalid`.
- Ein Model-Step nutzt nur Werte aus `input`, `scope`, `item`, `state` und `caller`. Zugangsdaten, Secrets und Connector-Einstellungen werden mit `model_step_secret_placeholder` abgelehnt, weil sie sonst beim Modellanbieter landen.
- Jeder Aufruf zählt gegen das KI-Budget deines Workspaces. Ist das Monatslimit erreicht, läuft der Step nicht, und der Run sagt dir das.

### Dateien mit Parse-File lesen

Ein Transform-Step mit `language: "parse-file"` liest eine Datei aus dem Run und gibt ihren Inhalt als Daten zurück.

```json
{
  "id": "read_invoice",
  "kind": "transform",
  "language": "parse-file",
  "file": { "source": "download.data", "format": "xlsx", "sheet": "Items", "max_rows": 2000 }
}
```

| Feld | Bedeutung |
| --- | --- |
| `source` | Wo die Datei im Run liegt, als Punkt-Pfad: die Ausgabe eines früheren Steps wie `download.data` oder eine Run-Eingabe wie `$input.invoice`. |
| `format` | `csv`, `xlsx`, `pdf`, `docx` oder `zip`. Ohne Angabe liest der Step den Typ aus der Datei selbst. |
| `sheet` | Tabellenblatt, das gelesen wird. Ohne Angabe das erste. |
| `max_rows` | Obergrenze für Tabellenzeilen aus einer CSV- oder Tabellendatei, höchstens 10.000. |

| Format | Ausgabe |
| --- | --- |
| `csv` | `rows` |
| `xlsx` | `sheets`, je Tabellenblatt eine Liste von Zeilen |
| `pdf` | `text` und `pages` |
| `docx` | `markdown` |
| `zip` | `text`, `entries` und `skipped` für Dateien, die nicht lesbar waren |

Eine Datei darf höchstens 25 MB groß sein. Der Step nimmt keine `expression`; alles steht im Block `file`.

### Fehlercodes

| Code | Bedeutung |
| --- | --- |
| `sftp_address_invalid` | Die Connector-Adresse hat nicht die Form `sftp://host[:port]/ordner`. |
| `sftp_host_key_missing` | Der Connector hat keinen Fingerabdruck des Host-Keys. |
| `sftp_host_key_mismatch` | Der Server hat einen anderen Host-Key gezeigt. |
| `sftp_path_outside_root` | Der Pfad führt aus dem Connector-Ordner hinaus. |
| `model_output_invalid` | Die Antwort des Modells ist kein gültiges JSON. |
| `model_output_schema_invalid` | Die Antwort passt nicht zu `output_schema`. |
| `model_step_secret_placeholder` | Der Model-Step nutzt Zugangsdaten, ein Secret oder eine Connector-Einstellung. |
| `parse_file_source_missing` | Unter `source` liegt keine Datei. |
| `parse_file_unsupported_format` | Der Dateityp ist keines der fünf Formate. |
| `parse_file_sheet_missing` | Die Tabelle hat kein Blatt mit diesem Namen. |
| `parse_file_too_large` | Die Datei ist größer als 25 MB. |
| `parse_file_failed` | Die Datei ließ sich nicht lesen. |
