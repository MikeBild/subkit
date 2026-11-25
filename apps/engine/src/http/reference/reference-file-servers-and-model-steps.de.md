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
- **Anmeldung:** entweder Benutzername und Passwort, gespeichert als Zugangsdaten des Connectors (`auth_type: "basic"`), oder ein privater SSH-Key aus dem Tresor (`auth_type: "none"` und `config.auth`, siehe unten).
- **Ordner:** Jeder Pfad, den ein Workflow nutzt, bleibt in dem Ordner aus der Adresse. Ein Pfad, der hinausführt, wird mit `sftp_path_outside_root` abgelehnt.
- **Netzwerk:** Die Verbindung läuft durch dieselben Egress-Regeln wie bei jedem anderen Connector. Private Adressen bleiben also gesperrt, solange die Einstellungen deiner Engine sie nicht freigeben.

Der Test des Connectors listet den Ordner mit einem Eintrag. Damit sind Adresse, Host-Key und Anmeldung bestätigt.

### Anmeldung mit einem SSH-Key aus dem Tresor

Der private Schlüssel bleibt im Tresor. Der Connector kennt nur die Namen der Tresor-Einträge, nie den Schlüssel selbst.

1. Speichere den Schlüssel als Workspace-Secret im Tresor, in der Umgebung des Connectors, zum Beispiel mit `subkit vault add sftp-deploy-key --env prod < deploy_key`. Unterstützt werden OpenSSH, RSA-PEM, EC-PEM und PKCS#8, auch verschlüsselt. Einen PKCS#8-Schlüssel wandelt subkit nur im Speicher in ein Format um, das der SSH-Client liest. Als Schlüsseltyp gehen Ed25519, RSA und ECDSA auf P-256, P-384 oder P-521.
2. Ist der Schlüssel verschlüsselt, speichere seine Passphrase als zweites Secret, zum Beispiel `sftp-deploy-key-passphrase`.
3. Setze am Connector `auth_type: "none"` und verweise in `config.auth` auf die Einträge:

```json
{
  "host_key_sha256": "SHA256:…",
  "auth": {
    "method": "private_key",
    "username": "deploy",
    "private_key_item": "sftp-deploy-key",
    "passphrase_item": "sftp-deploy-key-passphrase"
  }
}
```

SubKit liest den Schlüssel erst beim Verbinden aus dem Tresor deines Workspace, nach der Prüfung des Host-Keys. Jede Nutzung steht ohne den Schlüssel in der Aktivität des Tresor-Eintrags. Ein Connector in einem anderen Workspace kann deine Einträge nicht nutzen, auch nicht bei gleichem Namen.

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
| `prompt` | Die Anweisung. Platzhalter werden vor dem Aufruf ausgefüllt; jeder eingesetzte Wert ist als nicht vertrauenswürdige Daten markiert. |
| `system` | Optionaler System-Prompt. Er kommt nach der Schutzanweisung für Workflow-Steps, die immer erhalten bleibt. |
| `input` | Daten, die das Modell neben dem Prompt bekommt, immer als Daten und nie als Anweisung. |
| `output_schema` | JSON-Schema, zu dem die Antwort passen muss. |
| `max_output_tokens` | Obergrenze für die Antwort, höchstens 32.000. Standard 1.024. |

- Die Ausgabe des Steps ist die gelesene Antwort. Ist die Antwort kein gültiges JSON oder passt sie nicht zum Schema, scheitert der Step mit `model_output_invalid`. `model_output_schema_invalid` heißt, dass `output_schema` selbst kein brauchbares JSON-Schema ist; schon beim Speichern wird so ein Schema abgelehnt.
- Ein Model-Step nutzt nur Werte aus `input`, `scope`, `item`, `state` und `caller`. Zugangsdaten, Secrets und Connector-Einstellungen werden beim Speichern abgelehnt und zur Laufzeit mit `model_step_secret_placeholder`, weil sie sonst beim Modellanbieter landen.
- Jeder Aufruf zählt gegen das KI-Budget deines Workspaces. Ist das Monatslimit erreicht, läuft der Step nicht, und der Run sagt dir das.
- Die Freigabeprüfung zeigt jeden Model-Step als Wirkung beim KI-Modell: Er schickt Step-Daten an das KI-Modell deines Workspaces. Du siehst die Datenpfade, die Obergrenze für Ausgabe-Tokens pro Aufruf und ob der Step einmal pro Eintrag läuft. Eine neue Version, die einen Model-Step hinzufügt, `max_output_tokens` erhöht, ihn pro Eintrag laufen lässt oder neue Datenpfade schickt, braucht eine neue Freigabe. Ändert sich nur der Wortlaut des Prompts, bleibt die bestehende Freigabe gültig.

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
| `source` | Wo die Datei im Run liegt, als Punkt-Pfad: die Ausgabe eines früheren Steps wie `download.data` oder eine Run-Eingabe wie `$input.invoice`. Beim Speichern wird geprüft, dass der Pfad mit `$input`, `$state`, `$item` (das Element einer `for_each`-Schleife) oder der ID eines anderen Steps beginnt. |
| `format` | `csv`, `xlsx`, `pdf`, `docx` oder `zip`. Ohne Angabe liest der Step den Typ aus der Datei selbst. |
| `sheet` | Tabellenblatt, das gelesen wird. Ohne Angabe das erste. |
| `max_rows` | Obergrenze für Tabellenzeilen aus einer CSV- oder Tabellendatei, höchstens 10.000. |

| Format | Ausgabe |
| --- | --- |
| `csv` | `rows`, `row_count` und `truncated` |
| `xlsx` | `sheet` (das gelesene Tabellenblatt), `sheets` (die Namen aller Tabellenblätter), `rows`, `row_count` und `truncated` |
| `pdf` | `text` und `pages` |
| `docx` | `text`, das Dokument als Markdown |
| `zip` | `text`, `entries` und `skipped` für Dateien, die nicht lesbar waren |

Jede Ausgabe enthält außerdem `format` und `filename`.

Tabellenformate liefern höchstens `max_rows` Zeilen, ohne Angabe 10.000. `row_count` ist die Zahl der gelesenen Datenzeilen, und `truncated` ist `true`, wenn Zeilen weggelassen wurden.

- **CSV:** Die erste Zeile ist der Header, jede weitere Zeile wird ein Objekt mit diesen Schlüsseln und Text-Werten. Leere Zeilen werden übersprungen, und eine Byte Order Mark wird ignoriert. Das Trennzeichen erkennt der Step an den ersten Zeilen: Komma, Semikolon, Tab oder senkrechter Strich; passt keins, gilt das Komma. Eine Datei, die kein gültiges UTF-8 ist, liest der Step als Windows-1252. So kommt auch ein deutscher Excel-Export mit Semikolons und Umlauten mit sauberen Spalten an. Der Step liest die ganze Datei, daher zählt `row_count` jede Zeile, auch über `max_rows` hinaus. Ein nicht geschlossenes Anführungszeichen oder eine Zeile mit zu wenigen oder zu vielen Feldern lässt den Step mit `parse_file_failed` scheitern; die Meldung nennt die erste fehlerhafte Zeile.
- **XLSX:** Der Step liest nur das gewählte Tabellenblatt, bis zu `max_rows` Zeilen. `row_count` stammt aus dem belegten Bereich des Blatts und nennt bei einem längeren Blatt die volle Länge, auch wenn nur `max_rows` Zeilen zurückkommen.

Eine Datei darf höchstens 25 MB groß sein. Der Step nimmt keine `expression`; alles steht im Block `file`.

### Fehlercodes

| Code | Bedeutung |
| --- | --- |
| `sftp_address_invalid` | Die Connector-Adresse hat nicht die Form `sftp://host[:port]/ordner`. |
| `sftp_host_key_missing` | Der Connector hat keinen Fingerabdruck des Host-Keys. |
| `sftp_host_key_mismatch` | Der Server hat einen anderen Host-Key gezeigt. |
| `sftp_path_outside_root` | Der Pfad führt aus dem Connector-Ordner hinaus. |
| `sftp_key_item_missing` | Im Tresor gibt es in der Umgebung des Connectors kein Workspace-Secret mit diesem Namen. |
| `sftp_key_not_private_key` | Der Tresor-Eintrag enthält keinen privaten SSH-Key. |
| `sftp_key_format_unsupported` | Mit diesem Schlüsseltyp oder Format geht keine Anmeldung, zum Beispiel DSA oder X25519; speichere einen Ed25519-, RSA- oder ECDSA-Schlüssel als OpenSSH, PEM oder PKCS#8. |
| `sftp_key_passphrase_required` | Der Schlüssel ist verschlüsselt, und `passphrase_item` fehlt. |
| `sftp_key_passphrase_wrong` | Die Passphrase öffnet den Schlüssel nicht. |
| `sftp_key_rejected` | Der Server hat den Schlüssel für diesen Benutzernamen abgelehnt. |
| `model_output_invalid` | Die Antwort des Modells ist kein gültiges JSON oder passt nicht zu `output_schema`. |
| `model_output_schema_invalid` | `output_schema` ist kein brauchbares JSON-Schema. |
| `model_step_secret_placeholder` | Der Model-Step nutzt Zugangsdaten, ein Secret oder eine Connector-Einstellung. |
| `parse_file_source_missing` | Unter `source` liegt keine Datei. |
| `parse_file_unsupported_format` | Der Dateityp ist keines der fünf Formate. |
| `parse_file_sheet_missing` | Die Tabelle hat kein Blatt mit diesem Namen. |
| `parse_file_too_large` | Die Datei ist größer als 25 MB. |
| `parse_file_failed` | Die Datei ließ sich nicht lesen, oder die CSV-Datei ist fehlerhaft. |
