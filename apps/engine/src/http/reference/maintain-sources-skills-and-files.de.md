---
slug: maintain-sources-skills-and-files
title: Quellen, Skills und Dateien pflegen
summary: Halte das Wissen deines Teams aktuell und hol frühere Stände zurück.
section: work
order: 10
audience: public
---
## Quellen, Skills und Dateien pflegen

Dieses Kapitel ist für alle, die im Cockpit das Wissen ihres Teams pflegen. Du findest Quellen, Skills und Dateien in der Gruppe **Wissen**. Danach weißt du, wer was geändert hat, und holst einen früheren Stand zurück, ohne den jetzigen zu verlieren.

Die drei Begriffe im Alltag:

- **Quelle**: ein Dokument, in dem der Assistent nachschlägt, etwa eine Preisliste oder ein Handbuch.
- **Skill**: eine Regel, an die sich der Assistent hält, etwa eure Vorgaben für Rechnungstexte.
- **Datei**: eine Datei, die ein Workflow liest oder erzeugt, etwa eine Vorlage oder ein Bericht.

### Was du brauchst

- Zum Ansehen: `knowledge:read` für Quellen, `skill:read` für Skills, `file:read` für Dateien.
- Zum Wiederherstellen und Ersetzen: `knowledge:write`, `skill:write` oder `file:write`.

### Versionen einer Quelle oder eines Skills vergleichen

Jede Änderung an einer Quelle oder einem Skill wird eine neue Version. Zu jeder Version siehst du, wer sie gespeichert hat und wann. Bei Quellen steht oft auch dabei, warum. Bei Quellen bewahrt SubKit bis zu 50 Versionen auf.

1. Öffne **Quellen** oder **Skills** und klicke auf eine Quelle oder einen Skill.
2. Öffne den Tab **Versionen**. Die neueste Version steht oben und ist mit **Aktuell** markiert.
3. Klicke auf eine Version. Unter **Änderung gegenüber v…** siehst du **Vorher** und **Nachher** nebeneinander.

### Eine frühere Version wiederherstellen

1. Öffne die Version wie oben.
2. Wähle **Diese Version wiederherstellen**. Die aktuelle Version lässt sich nicht wiederherstellen.
3. Die Frage **Diese Version wiederherstellen?** erscheint. Bestätige mit **Wiederherstellen**.

SubKit speichert den wiederhergestellten Inhalt als neue Version. Die bisherige Version bleibt unter **Versionen** erhalten, du kannst also jederzeit zurück.

### Unterhaltungen zu einer Quelle oder einem Skill finden

1. Öffne die Quelle oder den Skill.
2. Öffne den Tab **Verwendung** und klappe **Unterhaltungen dazu** auf.

Die Liste zeigt Unterhaltungen, die die Quelle oder den Skill mit einem `@`-Verweis nennen. Bei einer Quelle zählen auch Unterhaltungen, in denen der Assistent die Quelle gelesen oder gefunden hat. Bei einem Skill zählen auch Unterhaltungen, die den Skill geladen haben. Klicke auf eine Unterhaltung, um sie zu öffnen. Gibt es noch keine, startest du mit **Im Chat fragen** eine neue.

### Skill-Vorschläge entscheiden

SubKit schlägt Skills vor, wenn sich ein Muster wiederholt. Du entscheidest sie auf der Seite **Skill-Kandidaten**, nicht in der Skill-Tabelle.

1. Öffne **Skills** und klicke im Kopf auf **… Vorschläge offen**.
2. Klicke auf einen Kandidaten und prüfe Inhalt und Geltungsbereich.
3. Wähle **Übernehmen** oder **Verwerfen**. Mehrere Kandidaten wählst du in der Liste aus und entscheidest sie gemeinsam.

Zum Verwerfen brauchst du `skill:write`, zum Übernehmen zusätzlich `skill:activate`. Einen verworfenen Kandidaten schlägt SubKit nicht noch einmal vor.

### Eine Datei ersetzen

1. Öffne **Dateien** und klicke auf die Datei.
2. Öffne **Weitere Aktionen** und wähle **Ersetzen**.
3. Wähle die neue Datei und bestätige mit **Ersetzen**.

Der Verweis auf die Datei bleibt gleich. Workflows und Chat nutzen deshalb sofort den neuen Inhalt, ohne dass du sie anpasst. Der neue Dateiname wird übernommen, der bisherige Inhalt bleibt als frühere Version erhalten.

### Einen früheren Stand einer Datei wiederherstellen

1. Öffne die Datei und den Tab **Verwendung**.
2. Klappe **Ersetzt** auf. Der Bereich erscheint, sobald eine Datei frühere Versionen hat.
3. Klicke auf eine Version. Du siehst ihre Vorschau.
4. Wähle bei einer früheren Version **Wiederherstellen**.

Der frühere Stand wird als neue Version aktuell. Der jetzige Inhalt bleibt als frühere Version erhalten.

Gut zu wissen:

- SubKit behält die letzten 20 früheren Versionen einer Datei.
- Löschst du eine Datei, entfernt das auch alle ihre früheren Versionen.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| **Diese Version wiederherstellen** fehlt | Du hast die aktuelle Version geöffnet. Öffne eine frühere. Fehlt der Button weiter, bitte eine Administratorin oder einen Administrator um das Schreibrecht für Quellen oder Skills. |
| „Für diese Version ist kein Stand gespeichert; sie lässt sich nicht wiederherstellen.“ | Wähle eine andere Version oder ändere den Skill direkt. |
| Der Bereich **Ersetzt** fehlt | Die Datei wurde noch nie ersetzt. Es gibt noch keine früheren Versionen. |
| **Ersetzen** fehlt im Menü | Bitte eine Administratorin oder einen Administrator um `file:write`. |

### Dasselbe im Terminal

Dateien ersetzt du auch mit der Kommandozeile `subkit`. Wie du sie einrichtest, steht im Kapitel „Die subkit-CLI auf deinem Rechner verwenden“.

```bash
subkit files replace <file-id> <path>
subkit files versions <file-id>
subkit files restore <file-id> <version>
```
