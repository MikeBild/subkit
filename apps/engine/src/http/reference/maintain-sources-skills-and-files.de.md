---
slug: maintain-sources-skills-and-files
title: Quellen, Skills und Dateien pflegen
summary: Vergleiche frühere Versionen, stelle sie wieder her und finde Unterhaltungen zu einer Quelle oder einem Skill.
section: work
order: 10
audience: public
---
## Quellen, Skills und Dateien pflegen

Quellen, Skills und Dateien findest du im Cockpit in der Gruppe **Wissen**.
SubKit bewahrt frühere Stände auf. Du siehst, was sich geändert hat, und holst einen früheren Stand zurück.

### Was du brauchst

- Zum Ansehen: `knowledge:read` für Quellen, `skill:read` für Skills, `file:read` für Dateien.
- Zum Wiederherstellen und Ersetzen: `knowledge:write`, `skill:write` oder `file:write`.

### Versionen einer Quelle oder eines Skills vergleichen

1. Öffne **Quellen** oder **Skills** und klicke auf eine Quelle oder einen Skill.
2. Öffne den Tab **Versionen**. Die neueste Version steht oben und ist mit **Aktuell** markiert.
3. Klicke auf eine Version.
   Unter **Änderung gegenüber v…** siehst du **Vorher** und **Nachher** nebeneinander.

### Eine frühere Version wiederherstellen

1. Öffne die Version wie oben.
2. Wähle **Diese Version wiederherstellen**. Die aktuelle Version lässt sich nicht wiederherstellen.
3. Die Frage **Diese Version wiederherstellen?** erscheint. Bestätige mit **Wiederherstellen**.

SubKit speichert den wiederhergestellten Inhalt als neue Version. Die bisherige Version bleibt unter **Versionen** erhalten.

### Unterhaltungen zu einer Quelle oder einem Skill finden

1. Öffne die Quelle oder den Skill.
2. Öffne den Tab **Verwendung** und klappe **Unterhaltungen dazu** auf.

Die Liste zeigt Unterhaltungen, die die Quelle oder den Skill mit einem `@`-Verweis nennen.
Bei einer Quelle zählen auch Unterhaltungen, in denen ein Wissenswerkzeug die Quelle gelesen oder gefunden hat.
Bei einem Skill zählen auch Unterhaltungen, die den Skill geladen haben.
Klicke auf eine Unterhaltung, um sie zu öffnen. Gibt es noch keine, startest du mit **Im Chat fragen** eine neue.

### Eine Datei ersetzen

1. Öffne **Dateien** und klicke auf die Datei.
2. Öffne **Weitere Aktionen** und wähle **Ersetzen**.
3. Wähle die neue Datei und bestätige mit **Ersetzen**.

Der neue Dateiname wird übernommen. Der Verweis bleibt gleich, Workflows und Chat nutzen also sofort den neuen Inhalt.
Der bisherige Inhalt bleibt als frühere Version erhalten.

### Einen früheren Stand einer Datei wiederherstellen

1. Öffne die Datei und den Tab **Verwendung**.
2. Klappe **Ersetzt** auf. Der Bereich erscheint, sobald eine Datei frühere Versionen hat.
3. Klicke auf eine Version. Du siehst ihre Vorschau.
4. Wähle bei einer früheren Version **Wiederherstellen**.

Der frühere Stand wird als neue Version aktuell. Der jetzige Inhalt bleibt als frühere Version erhalten.

Gut zu wissen:

- SubKit behält die letzten 20 früheren Versionen einer Datei.
- Löschst du eine Datei, entfernt das auch alle ihre früheren Versionen.

Dasselbe geht mit der sk-CLI:

```bash
sk files replace <file-id> <path>
sk files versions <file-id>
sk files restore <file-id> <version>
```

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| **Diese Version wiederherstellen** fehlt | Du hast die aktuelle Version geöffnet. Öffne eine frühere. Fehlt der Button weiter, bitte eine Administratorin oder einen Administrator um das Schreibrecht für Quellen oder Skills. |
| „Für diese Version ist kein Stand gespeichert; sie lässt sich nicht wiederherstellen.“ | Wähle eine andere Version oder ändere den Skill direkt. |
| Der Bereich **Ersetzt** fehlt | Die Datei wurde noch nie ersetzt. Es gibt noch keine früheren Versionen. |
| **Ersetzen** fehlt im Menü | Bitte eine Administratorin oder einen Administrator um `file:write`. |
