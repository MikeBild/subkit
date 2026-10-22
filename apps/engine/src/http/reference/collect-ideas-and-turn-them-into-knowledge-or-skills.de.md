---
slug: collect-ideas-and-turn-them-into-knowledge-or-skills
summary: Sammle Seiten und Ideen und prüfe, was davon zu Wissen oder Skills wird.
section: work
order: 5
audience: public
---
## Ideen sammeln und in Wissen oder Skills verwandeln

Sammle jetzt Seiten und Ideen und entscheide später, was zu Wissen oder einem Skill wird. Nichts Gesammeltes ist Wissen, bis eine angemeldete Person es im Cockpit bestätigt.

Der Weg ist immer gleich: **sammeln → im Chat prüfen → bestätigen → Wissen oder Skill**.

### Was du brauchst

- Den Web Clipper in Chrome, installiert und verbunden. Installation, Updates und Fehlerbehebung des Web Clippers stehen im Kapitel „Webseiten mit dem Web Clipper sammeln“.
- Zum Sammeln: ein Konto mit `intake:read` und `intake:write`.
- Zum Bestätigen: eine Browsersitzung im Cockpit mit `intake:confirm`, dazu `knowledge:write` für Wissen oder `skill:write` und `skill:activate` für einen Skill. Wer Skills ersetzt, braucht zusätzlich `skill:archive` für jeden ersetzten Skill.

### Etwas sammeln

1. Öffne die Seite.
2. Optional: Markiere den Text, den du als Ausschnitt willst.
3. Wähle in der Symbolleiste das Symbol des Web Clippers („SubKit Clipper“).
4. Prüfe die Vorschau. Die Quelladresse wird automatisch erfasst.
5. Optional: Ergänze, warum es wichtig ist.
6. Wähle eine Kategorie. Deine Standardkategorie ist vorausgewählt, anfangs `inbox`.
7. Wähle **Sammeln**.

Erkenntnisse aus Sitzungen mit Coding-Agenten landen als Einträge mit der Herkunft `session` im selben Eingang. Der Eingang zeigt die Herkunft als Filter und Badge.

### Einträge prüfen und ordnen

1. Öffne im Cockpit **Eingang**.
2. Öffne einen Eintrag, um Inhalt und Originalquelle zu sehen.
3. Optional: Bearbeite Titel, Inhalt oder Kategorie. Das erfasste Original bleibt erhalten.
4. Optional: Verschiebe, verwirf oder stelle den Eintrag wieder her.

Die Sichtbarkeit im Eingang folgt den Berechtigungen deines Arbeitsbereichs. Kategorien sind nicht privat.

### Im Chat prüfen

Einen Eintrag prüfen:

1. Öffne den Eintrag im **Eingang**.
2. Wähle **Im Chat prüfen**. Der Chat zeigt den Eintrag als `@`-Verweis.

Eine ganze Kategorie prüfen:

- Starte in einem neuen Chat den Prüfvorschlag der Kategorie oder frag: „Sieh meine neuen Research-Einträge durch und schlag vor, was wir behalten.“

Der Chat bereitet einen Vorschlag mit Inhalt, Quellen und Ziel vor und verlinkt ihn. Abgeschlossene Entscheidungen bleiben im Verlauf des Chats.

### Einen Vorschlag bestätigen

Du brauchst eine Browsersitzung im Cockpit, `intake:confirm` und das Recht des Ziels. API-Schlüssel, MCP-Clients und der Web Clipper können nicht bestätigen.

1. Prüfe den Vorschlag: Inhalt, Quellen und Ziel.
2. Wähle **Als Wissen bestätigen** oder **Als Skill bestätigen**.

Erst danach kann die gewöhnliche Wissensabfrage das Ergebnis nutzen oder können Agenten-Briefings den Skill tragen. Bei einem Skill archiviert das Bestätigen auch die Skills, die er ersetzt. Der Vorschlag zeigt jede Änderung.

Gut zu wissen:

- Verschieben, Bearbeiten oder Verwerfen macht einen Eintrag nie zu Wissen.
- Ändert sich ein Vorschlag oder seine Quellen, prüfst du ihn erneut.
- SubKit ersetzt Geheimnisse wie API-Schlüssel und Tokens, bevor ein Clip gespeichert wird.
- Der Original-Clip bleibt mit dem Wissen oder Skill verknüpft.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Der Web Clipper meldet keine Verbindung oder einen ungültigen Schlüssel | Folge „Wenn etwas nicht klappt“ im Kapitel „Webseiten mit dem Web Clipper sammeln“. |
| Ein Eintrag fehlt im **Eingang** | Prüfe Kategorie und Herkunftsfilter. |
| Beim Vorschlag steht „Zum Bestätigen nötig: …“ | Bitte eine Administratorin oder einen Administrator um die genannten Rechte. |
| „Dieser Vorschlag hat sich geändert. Prüfe den aktuellen Inhalt, bevor du bestätigst.“ | Lies den aktuellen Inhalt und bestätige dann erneut. |
| „Ein Skill, auf den sich dieser Vorschlag bezieht, lässt sich nicht mehr laden. …“ | Überarbeite den Vorschlag im Chat, bevor du bestätigst. |
