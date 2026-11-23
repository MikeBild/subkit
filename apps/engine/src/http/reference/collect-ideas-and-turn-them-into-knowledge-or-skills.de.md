---
slug: collect-ideas-and-turn-them-into-knowledge-or-skills
summary: Halte Seiten und Ideen fest und entscheide, was dein Team behalten soll.
section: work
order: 5
audience: public
---
## Ideen sammeln und in Wissen oder Skills verwandeln

Dieses Kapitel ist für alle, die Webseiten, Notizen oder Erkenntnisse aus KI-Sitzungen festhalten wollen, ohne gleich zu entscheiden. Alles landet im Cockpit unter **Eingang**. Daraus wird Wissen oder ein Skill erst, wenn eine angemeldete Person mit Schreibrecht es im Cockpit bestätigt.

Der Weg ist immer gleich: **sammeln → im Chat prüfen → bestätigen → Wissen oder Skill**.

### Was du brauchst

- Für Webseiten: den Web Clipper in Chrome, installiert und verbunden. Wie du ihn einrichtest, steht im Kapitel „Webseiten mit dem Web Clipper sammeln“.
- Zum Sammeln: ein Konto mit `intake:read` und `intake:write`.
- Zum Bestätigen: eine Anmeldung im Cockpit mit `intake:confirm`. Dazu `knowledge:write` für Wissen oder `skill:write` und `skill:activate` für einen Skill. Wer Skills ersetzt, braucht für jeden ersetzten Skill zusätzlich `skill:archive`.

### Etwas sammeln

Der **Eingang** sammelt aus zwei Richtungen:

- **Webseiten** aus dem Web Clipper. Sie tragen die Herkunft **Browser**.
- **Erkenntnisse aus Sitzungen** mit KI-Assistenten. Als Herkunft steht dort der Assistent, etwa **Claude Code**, **Codex** oder **Chat**. Ist er unbekannt, steht dort **KI-Assistent**.

Eine Webseite sammelst du so:

1. Öffne die Seite in Chrome.
2. Optional: Markiere den Text, den du als Ausschnitt willst.
3. Wähle in der Symbolleiste das Symbol des Web Clippers („SubKit Clipper“).
4. Prüfe die Vorschau. Die Quelladresse wird automatisch erfasst.
5. Optional: Ergänze, warum die Seite wichtig ist.
6. Wähle eine Kategorie. Deine Standardkategorie ist vorausgewählt, anfangs `inbox`.
7. Wähle **Sammeln**.

Wartet dieselbe Seite oder fast derselbe Text schon im **Eingang** auf Prüfung, legt SubKit keinen neuen Eintrag an. Es hängt das Gesammelte als Beleg an den vorhandenen Eintrag; du findest es dort unter **Beleg aus der Sitzung**. Bei der Adresse ignoriert SubKit `www.` und Tracking-Parameter wie `utm_source`. Berichte, die ohne Anmeldung gesendet wurden, werden immer ein neuer Eintrag.

### Eine Notiz hinzufügen

Eine Notiz ist ein Eintrag ohne Quelladresse, etwa ein Gedanke oder eine Idee.

1. Öffne im Cockpit **Eingang** und wähle **Eintrag hinzufügen**. Ist der Eingang noch leer, wähle **Notiz hinzufügen**.
2. Gib im Dialog **Zum Eingang hinzufügen** einen **Titel** ein.
3. Schreib unter **Inhalt** den Text. Markdown ist erlaubt.
4. Wähle eine **Kategorie** oder lege mit **Neue Kategorie …** eine neue an.
5. Wähle **Hinzufügen**.

Die Notiz trägt die Herkunft **Notiz**. Auf ihrer Seite fehlt der Link **Ursprüngliche Seite öffnen**, weil es keine Quelle gibt.

### Einträge prüfen und ordnen

1. Öffne im Cockpit **Eingang**.

   ![Eingang mit sieben gesammelten Einträgen der Herkunft „Notiz“, „Browser“, „Claude Code“, „Chat“ und „Codex“ in der Kategorie Inbox, Status „Gesammelt“, und dem Hinweis, dass drei Einträge deiner KI-Assistenten auf deine Prüfung warten](images/collect-ideas-and-turn-them-into-knowledge-or-skills-inbox.de.webp)

2. Optional: Klicke über der Liste auf den Hinweis, etwa „3 Einträge deiner KI-Assistenten warten auf deine Prüfung“. Dann siehst du nur Einträge deiner KI-Assistenten. Der Filter **Herkunft: KI-Assistent** steht neben der Suche; ein Klick darauf hebt ihn auf.
3. Klicke auf einen Eintrag. Im Tab **Inhalt** nennt ein Satz die Herkunft, etwa „Gesammelt von Chat in der Sitzung … · für … · …“. **Unterhaltung öffnen** führt zur Chat-Unterhaltung, **Ursprüngliche Seite öffnen** zur gesammelten Seite.
4. Optional: Wähle **Eintrag bearbeiten**, um Titel, Inhalt oder Kategorie zu ändern. Das erfasste Original bleibt erhalten.
5. Optional: Wähle **Verwerfen** oder **Wiederherstellen**.

Wer was im Eingang sieht, folgt den Rechten deines Arbeitsbereichs. Kategorien sind nicht privat.

### Einträge gruppieren und mehrere auf einmal bearbeiten

1. Wähle im **Eingang** unter **Gruppieren nach** den Punkt **Thema**. Einträge von derselben Website, aus derselben Arbeitssitzung oder mit demselben Tag stehen dann zusammen. Eine Tag-Gruppe heißt etwa `#research`. Einträge ohne Thema stehen unter **Ohne Gruppe**.
2. Wähle die Einträge über die Kästchen davor aus.
3. Wähle eine Aktion für die Auswahl.

| Aktion | Was sie bewirkt |
| --- | --- |
| **In Kategorie verschieben** | Verschiebt die Einträge in eine andere Kategorie. |
| **Verwerfen** | Verwirft die Einträge. Du kannst sie jederzeit wiederherstellen. |
| **Vorschlag vorbereiten** | Öffnet einen neuen Chat mit den ausgewählten Einträgen, der einen Wissenseintrag vorbereitet. Möglich für bis zu 100 Einträge. |
| **… verworfene Einträge endgültig löschen** | Entfernt die Einträge und ihre Rohinhalte endgültig. Erscheint nur, wenn alle ausgewählten Einträge verworfen sind. |

- Übernommene Einträge lassen sich nicht auswählen. Die Aktionen erscheinen, wenn alle ausgewählten Einträge gesammelt oder in Prüfung sind oder wenn alle verworfen sind. Eine gemischte Auswahl bietet keine Aktion.
- Haben sich Einträge zwischenzeitlich geändert, bleiben sie unverändert. Du liest „… Einträge haben sich zwischenzeitlich geändert und sind unverändert geblieben. Lade die Liste neu, um sie zu sehen.“

### Im Chat prüfen

Einen Eintrag prüfst du so:

1. Öffne den Eintrag im **Eingang**.
2. Wähle **Im Chat prüfen**. Der Chat zeigt den Eintrag als `@`-Verweis.

Für eine ganze Kategorie startest du in einem neuen Chat den Prüfvorschlag der Kategorie. Oder du fragst: „Sieh meine neuen Research-Einträge durch und schlag vor, was wir behalten.“

Der Chat bereitet einen Vorschlag mit Inhalt, Quellen und Ziel vor und verlinkt ihn. Der Link öffnet den Tab **Prüfen** des Eintrags. Abgeschlossene Entscheidungen stehen im Tab **Verlauf** unter **Vorschläge und Entscheidungen**.

### Einen Vorschlag bestätigen

Bestätigen kann nur eine Person, die im Cockpit angemeldet ist und `intake:confirm` sowie das Recht für das Ziel hat. API-Schlüssel, MCP-Clients und der Web Clipper können nicht bestätigen.

1. Öffne den Eintrag und wähle **Prüfen**.
2. Lies den Vorschlag: Inhalt, Quellen und Ziel.
3. Wähle **Als Quelle bestätigen** oder **Als Skill bestätigen**.

Erst jetzt findet die Wissenssuche das Ergebnis, und erst jetzt tragen Agenten-Briefings den Skill. Ersetzt ein Skill andere Skills, archiviert das Bestätigen sie. Der Vorschlag zeigt jede dieser Änderungen vorher.

Gut zu wissen:

- Verschieben, Bearbeiten oder Verwerfen macht einen Eintrag nie zu Wissen.
- Ändert sich ein Vorschlag oder eine seiner Quellen, prüfst du ihn erneut.
- Zugangsdaten wie API-Schlüssel und Tokens ersetzt SubKit, bevor ein Eintrag gespeichert wird.
- Das Original des Eintrags bleibt mit dem Wissen oder Skill verknüpft.
- Wie du bestätigte Quellen und Skills weiter pflegst, steht im Kapitel „Quellen, Skills und Dateien pflegen“.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Der Web Clipper meldet keine Verbindung oder einen ungültigen Schlüssel | Folge „Wenn etwas nicht klappt“ im Kapitel „Webseiten mit dem Web Clipper sammeln“. |
| Ein Eintrag fehlt im **Eingang** | Prüfe Kategorie und Herkunft. Hebe den Filter **Herkunft** auf. |
| „Dafür fehlen dir die Rechte. …“ | Bitte eine Administratorin oder einen Administrator um `intake:confirm` und das Recht für das Ziel. |
| „Dieser Vorschlag hat sich geändert. Prüfe den aktuellen Inhalt, bevor du bestätigst.“ | Lies den aktuellen Inhalt und bestätige dann erneut. |
| „Ein Skill, auf den sich dieser Vorschlag bezieht, lässt sich nicht mehr laden. …“ | Überarbeite den Vorschlag im Chat, bevor du bestätigst. |
