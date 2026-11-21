---
slug: reference-local-steps
title: Referenz: Workflow-Schritte auf deinem Gerät
summary: Schlag den Body jedes lokalen Schritts für Dateien, Browser und Computer nach und was die Freigabe eines solchen Workflows bindet.
section: reference
order: 9
audience: public
---
## Referenz: Workflow-Schritte auf deinem Gerät

Ein Workflow kann Dateien in Ordnern lesen und schreiben, die du auf deinem Mac erlaubt hast, auf einer erlaubten Website arbeiten und in einer erlaubten App handeln. Jeder dieser Schritte ist ein gewöhnlicher `request`-Schritt auf einem Geräte-Connector.
Diese Seite listet die Bodys der Schritte und die Regeln der Freigabe. Sie ist für alle, die Workflows von Hand schreiben, und für Entwicklerinnen und Entwickler, die darauf aufbauen.

### Geräte-Connectoren

Wenn SubKit Desktop verbunden ist und du unter Einstellungen › Lokale Fähigkeiten eine Fähigkeit einschaltest, legt SubKit für dieses Gerät einen Connector je Fähigkeit an, zum Beispiel „MacBook Pro (Mike): Dateien“, „MacBook Pro (Mike): Browser“ und „MacBook Pro (Mike): Computer“. Der Name folgt der Sprache von SubKit Desktop auf diesem Gerät, Deutsch oder Englisch, sonst Englisch. Ein Connector behält seinen Namen, wenn du die Sprache später wechselst. Sie haben den Treiber `local_files`, `local_browser` oder `local_computer`, `config: {device_id}` und keine Zugangsdaten.
Binde einen Schritt mit `connector_id` an einen davon. Trennst du das Gerät, bleiben seine Connectoren ausgeschaltet erhalten, damit bestehende Workflows zeigen, was sie genutzt haben.

### Pfad und Methode

| Feld | Bedeutung |
| --- | --- |
| `path` | Die Aktion, zum Beispiel `/files.write`, `/browser.open` oder `/computer.type`. |
| `method` | `GET` für eine Aktion, die nur liest, `POST` für eine Aktion, die etwas ändert. Passt die Methode nicht zur Aktion, wird der Schritt abgelehnt, bevor etwas gesendet wird. |
| `body` | Die Felder der Aktion, direkt in `body`. |

Lesende Aktionen: `files.list`, `files.read_text`, `browser.snapshot`, `browser.wait`, `browser.extract`, `browser.screenshot`, `computer.apps`, `computer.snapshot`, `computer.screenshot`.

### Dateien

`folder_id` ist die ID eines Ordners, den du auf dem Gerät erlaubt hast. `path` ist relativ zu diesem Ordner.

| Aktion | Body | Ergebnis |
| --- | --- | --- |
| `files.list` | `{folder_id, path?}` | `entries`, `truncated`, `omitted` (höchstens 500 Einträge). |
| `files.read_text` | `{folder_id, path}` | `text`, `size`, `sha256` (höchstens 256 KiB). |
| `files.import` | `{folder_id, path, name?}` | Eine SubKit-Datei für die nächsten Schritte: `file`, `filename`, `content_type`, `size_bytes`, `file_id`, `sha256` (höchstens 90 MiB). |
| `files.write` | `{folder_id, path, content, replace?}` | `size`, `sha256`, `replaced`, `previous_in_trash`, Fassungen. `content` ist Text oder `{encoding: "base64", data}`; höchstens 10 MiB. |
| `files.mkdir` | `{folder_id, path}` | – |
| `files.move` | `{folder_id, to_folder_id?, path, to_path}` oder `{folder_id, to_folder_id?, items: [{from, to}]}` | Ein Ergebnis je Eintrag, höchstens 200. |
| `files.trash` | `{folder_id, path}` oder `{folder_id, paths: [...]}` | Ein Ergebnis je Eintrag, höchstens 200. |

Ein Verschiebe- oder Papierkorb-Schritt gelingt nur, wenn jeder Eintrag erledigt ist. Ersetzte und entfernte Dateien landen im Papierkorb. Versteckte Dateien, geheime Dateien wie Schlüssel und Programme werden immer abgelehnt.

### Browser

| Aktion | Body |
| --- | --- |
| `browser.open` | `{url}` auf einer Website, die du erlaubt hast. |
| `browser.press` | `{action: "click", element}`, `{action: "key", key}` oder `{action: "scroll", direction, pixels?}` |
| `browser.fill` | `{mode: "fill" oder "type", element, text}` oder `{mode: "select", element, values}` |
| `browser.wait` | `{for: "load", state?}`, `{for: "text", text}` oder `{for: "ms", ms}` (höchstens 30 s) |
| `browser.extract` | `{element?}` liefert den Text des Elements oder der Seite. |
| `browser.snapshot`, `browser.screenshot` | `{}` |
| `browser.download` | `{element, folder_id, name}` speichert in einen Ordner mit Schreibzugriff. |

`browser.pdf` und `browser.handover` gibt es in Workflows noch nicht.

### Computer

`app_id` ist die Bundle-ID einer App, die du erlaubt hast, zum Beispiel `com.apple.iWork.Numbers`. SubKit handelt im Fenster der App, das den Fokus hat, sonst in ihrem ersten Fenster.

| Aktion | Body |
| --- | --- |
| `computer.apps` | `{}` listet die Fenster erlaubter Apps. |
| `computer.snapshot`, `computer.screenshot` | `{app_id}` |
| `computer.press`, `computer.focus` | `{app_id, element}` |
| `computer.type` | `{app_id, element, text}` |
| `computer.set_value` | `{app_id, element, value}` |
| `computer.select` | `{app_id, element, option}` |
| `computer.scroll` | `{app_id, element, direction, amount}` |
| `computer.key` | `{app_id, keys}`, zum Beispiel `"cmd+s"` |

### Elemente

Benenne ein Element als `element: {role, name, nth?}`, zum Beispiel `{role: "button", name: "Download"}`. `nth` wählt unter mehreren Elementen mit gleicher Rolle und gleichem Namen, gezählt ab 0. Refs wie `e12` sind in einem Workflow nicht erlaubt, denn jeder Snapshot vergibt sie neu. SubKit macht direkt vor jeder solchen Aktion einen frischen Snapshot und findet das Element dort. Passt kein Element oder mehr als eines, schlägt der Schritt mit `element_not_found` oder `element_ambiguous` fehl und nichts wird geändert.

### Screenshots

Ein Screenshot wird auf dem Gerät geschwärzt: Passwortfelder und als sensibel markierte Felder werden abgedeckt. Das Ergebnis des Schritts behält nur `screenshot_ref`, den SHA-256 des PNG. Das Bild selbst bleibt verschlüsselt mit der Antwort des Geräts 30 Tage erhalten und wird dann gelöscht.

### Freigabe und Wachstum

- Die Freigabe nennt das Gerät und für jeden lokalen Schritt die Ordner mit Lese- oder Schreibzugriff, die Websites und die Apps, die der Schritt nutzt. Ein Import liest seinen Ordner nur.
- Schreib `folder_id`, `to_folder_id`, `url` und `app_id` als feste Werte. Ein Platzhalter dort macht den Workflow nicht freigabefähig. Ein Wert, der erst während des Runs gefüllt wird und den die Freigabe nicht nennt, wird mit `outside_boundary` abgelehnt.
- Ein Workflow mit Gerät wird auf diesem Gerät freigegeben.
- Eine neue Fassung braucht eine neue Freigabe, wenn sie einen Ordner ergänzt, Schreibzugriff braucht, wo Lesen freigegeben war, eine Website oder private Adresse ergänzt oder eine App ergänzt. Weniger Einträge übernehmen die Freigabe.
- Browser- und Computer-Schritte laufen nur für die Person des Geräts: aus ihrem Chat oder ihrer Aufgabe, aus einem Run, den sie startet, oder aus einem Zeitplan, den sie eingerichtet hat.
- Ein Workflow, den ein anderer Workflow aufruft, lehnt lokale Schritte ab. Lass lokale Schritte in dem Workflow, den du freigibst und startest.

### Fehler

| Code | Bedeutet |
| --- | --- |
| `outside_boundary` | Der Schritt geht über die Freigabe hinaus. Prüf sie und gib sie auf dem Gerät neu frei. |
| `outside_allowance`, `origin_not_allowed`, `private_address` | Das Gerät erlaubt diesen Ordner, diese Website oder diese App nicht. |
| `folder_changed` | Der erlaubte Ordner wurde ersetzt. Erlaube ihn neu und erneuere die Freigabe. |
| `permission_missing` | Eine macOS-Berechtigung fehlt (Bedienungshilfen oder Bildschirmaufnahme). |
| `kind_not_ready` | Diese Aktion gibt es in Workflows noch nicht. |
| `local_method_mismatch`, `local_step_invalid` | Methode oder Body passen nicht zur Aktion. |
| `files_partly_done` | Nicht jeder Eintrag eines Verschiebens oder Löschens wurde erledigt; das Ergebnis listet jeden Eintrag. |
| `screenshot_unverified` | Der Screenshot passt nicht zu seinem Hash. Er wurde nicht behalten. |

Jeder Fehler bringt in `guidance` einen Lösungsweg mit.
