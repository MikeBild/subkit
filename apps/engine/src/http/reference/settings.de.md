---
slug: settings
title: Einstellungen
summary: Schlag jede Einstellung der Engine mit Beschreibung und Standardwert nach.
section: reference
order: 2
audience: public
---
Hier steht jeder Wert der Laufzeitkonfiguration mit Beschreibung und Standardwert. Du änderst ihn mit `sk settings configure` und `sk settings set`, über die HTTP- oder MCP-Schnittstelle für Einstellungen oder in der Konfigurationsdatei `subkit.config.json`. Eigene Werte für einen Arbeitsbereich gelten nur bei Einstellungen, die dafür markiert sind (`scope=tenant`). Umgebungsvariablen setzen keine dieser Einstellungen. Ausnahmen sind die Bootstrap-Werte `database.url`, `storage.backend`, `storage.filesystem.root` und `deployment.mode` (aus `SUBKIT_DEPLOYMENT_MODE`) – diese Werte kommen bei jedem Start aus der Umgebung.

## Dateien in einem Ordner statt im Objektspeicher

Auf einem einzelnen Gerät legt die Engine Dateien und ausgelagerte Ergebnisse in einem Ordner ab statt in einem S3-kompatiblen Objektspeicher. Setz dafür vor dem Start zwei Umgebungsvariablen:

| Variable | Einstellung | Wert |
| -------- | ----------- | ---- |
| `OBJECT_STORAGE_BACKEND` | `storage.backend` | `filesystem` (Standard: `s3`) |
| `OBJECT_STORAGE_ROOT` | `storage.filesystem.root` | absoluter Ordner, zum Beispiel `<App-Daten>/local/<Arbeitsbereich>/files` |

Beide Werte gelten nur beim Start. Eine gespeicherte Revision ändert sie nicht, und die Settings-APIs lehnen Änderungen ab. Die Werte unter `storage.object_store` brauchst du in diesem Modus nicht.

- **Prüfung beim Start:** Der übergeordnete Ordner muss existieren. Die Engine legt den Ordner mit Modus `0700` an, setzt einen vorhandenen auf `0700` und prüft, dass sie darin schreiben, lesen, löschen und Hard-Links anlegen kann. Schlägt eine Prüfung fehl, startet die Engine nicht und nennt Grund und Abhilfe (`root_parent_missing`, `root_not_directory`, `root_not_writable`, `root_cross_device`, `root_no_hard_links`).
- **Schreiben:** Jedes Objekt landet erst in einer Zwischendatei, wird auf die Platte geschrieben und dann an seinen Platz verlinkt. Wer liest, sieht das ganze Objekt oder keins. Ein vorhandener Schlüssel wird nie überschrieben. Dateien bekommen Modus `0600`, Ordner `0700`.
- **Schlüssel:** Jedes Segment wird in kleine ASCII-Zeichen übersetzt (`a-z`, `0-9`, `.`, `_`, `-`, alles andere als `%xx`). So bleiben Schlüssel getrennt, die sich nur in Groß- und Kleinschreibung oder Unicode-Form unterscheiden, auch auf Platten ohne Unterscheidung der Schreibweise. Reservierte Windows-Namen sind sicher. `..`, leere Segmente und absolute Schlüssel lehnt die Engine ab, und einem Link aus dem Ordner hinaus folgt sie nie.
- **Sicherung:** Der Ordner ist der ganze Objektspeicher. Kopier ihn zusammen mit dem Datenbank-Dump.
- **Nicht unterstützt:** Netzlaufwerke, Ordner mit Cloud-Sync und Platten ohne Hard-Links wie exFAT.

Die Referenz unten wird aus der Konfiguration erzeugt und ist deshalb auf Englisch.
