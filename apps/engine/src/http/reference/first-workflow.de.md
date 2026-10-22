---
slug: first-workflow
summary: Baue deinen ersten Workflow im Cockpit-Chat, gib ihn frei und starte ihn.
order: 5
section: start
audience: public
---
## Dein erster Workflow

Hier kommst du von der Anmeldung zu deinem ersten erfolgreichen Lauf.
Du beschreibst eine Aufgabe im Chat, speicherst den Workflow, gibst ihn frei, startest ihn und liest das Ergebnis.
Das funktioniert in SubKit Cloud und auf einer selbst betriebenen Engine gleich.

### Was du brauchst

- Ein SubKit-Konto in einem Arbeitsbereich.
  - Cloud: `https://subkit-cloud.mikebild.info`
  - Selbst betrieben: `https://<deine-engine>/cockpit`
- Die Berechtigung, Workflows anzulegen und auszuführen. Fehlt ein Button, bitte eine Administratorin oder einen Administrator darum.
- Einen KI-Anbieter. Die Cloud stellt ihn bereit. Eine selbst betriebene Engine nutzt den Anbieter, den du bei `sk init` gewählt hast.

### Anmelden

1. Öffne das Cockpit.
2. Wähle **Mit Firmenkonto anmelden**.

Du landest in deinem Arbeitsbereich auf **Übersicht**.
Selbst betrieben ohne Anmeldeanbieter? Wähle stattdessen **Mit API-Schlüssel anmelden** und gib deinen Schlüssel ein.

### Die Aufgabe beschreiben

1. Öffne in der Navigation **Chat**.
2. Wähle **Neue Unterhaltung**.
3. Beschreibe die Aufgabe in einfachen Worten: was hineingeht, was passieren soll, was herauskommt.
   Beispiel: „Hol die offenen Issues meines GitHub-Repositorys und gib mir eine kurze Liste mit Titel und Link.“
4. Beantworte die Rückfragen von SubKit. Braucht die Aufgabe einen Dienst, bittet dich SubKit,
   ihn zu verbinden oder dich dort anzumelden.

Gut zu wissen: Eine kleine Aufgabe lässt sich leichter prüfen. Erweitern kannst du den Workflow später im selben Chat.

### Den Workflow speichern

Ist der Workflow fertig, zeigt SubKit eine Karte **Workflow-Entwurf speichern**.

1. Öffne **Was sich ändert** und lies, welche Schritte und Ziele enthalten sind.
2. Wähle **Inaktive Version speichern**.

Speichern startet nichts. Der Workflow erscheint jetzt unter **Workflows**.

### Freigeben, was er berühren darf

Eine neue Version berührt nichts außerhalb von SubKit, bis ein Mensch sie freigibt.
Ohne Freigabe startet ein Lauf nur als Probelauf ohne Wirkung.

1. Öffne **Workflows** und wähle deinen Workflow.
   Die Statuszeile zeigt **Wartet auf Freigabe** oder **Nicht freigegeben**.
2. Wähle in der Statuszeile **Freigeben…**.
3. Prüfe **Umgebung**, **Gültigkeit** sowie **Operationen und externe Ziele**.
4. Bestätige mit **Freigeben**.
   **Nur aktivieren** übernimmt die Version, ohne Läufe freizugeben.

![Freigabedialog für „Invoice export v1“ mit Umgebung „Entwicklung“, Gültigkeit, Lesezugriff auf die Sales reporting API als externes Ziel und der Schaltfläche „Übernehmen und Läufe erlauben“](images/first-workflow-approval.de.webp)

Die Freigabe startet keinen Lauf. Eine Freigabe gilt für eine Umgebung und eine Dauer.
Auch eine neue Version, deren Grenze nicht wächst, ist davon gedeckt.
Im Tab **Freigaben** kannst du sie jederzeit widerrufen.
Du kannst auch im Chat freigeben: Wähle **Gespeicherte Änderung prüfen** und dann **Übernehmen und Läufe erlauben**.

| Feld | Was es festlegt |
| --- | --- |
| **Umgebung** | Wo die Läufe erlaubt sind, zum Beispiel **Produktion**. |
| **Operationen und externe Ziele** | Welche Dienste und Adressen der Workflow erreicht. |
| **Gültigkeit** | Wie lange die Freigabe gilt: **7 Tage**, **30 Tage** oder **Bis auf Widerruf**. |

### Den Workflow ausführen

1. Wähle auf der Workflow-Seite **Ausführen**.
2. Fülle die Eingaben aus, wenn der Workflow welche verlangt.
3. Wähle **Ausführen**, um zu bestätigen. Der Dialog sagt **Startet einen Lauf mit der freigegebenen Version.**

Du siehst **Lauf gestartet**. Ist der Button nicht verfügbar, nennt der Hinweis den Grund, zum Beispiel
**Aktiviere den Workflow vor dem Ausführen.**

### Das Ergebnis prüfen

1. Öffne auf der Workflow-Seite den Tab **Verlauf**.
   Der neueste Lauf steht oben, mit seinem Status. **Erfolgreich** heißt, der Lauf ist durchgelaufen.
2. Öffne den Lauf.
   Du siehst jeden Schritt mit seiner Ausgabe. Ein fehlgeschlagener Schritt zeigt **Fehler in Schritt „…“** mit der Ursache.

   ![Erfolgreicher Lauf von „CRM contact sync“ aus dem Verlauf mit einem Schritt, dem Auftraggeber „API“ und dem aufgeklappten Ergebnis mit einem Kontakt](images/first-workflow-run-result.de.webp)

3. Optional: Wähle **Im Audit-Trail**, um zu sehen, wer den Lauf gestartet und freigegeben hat.

Dasselbe prüfst du mit der sk-CLI:

```bash
sk executions list --limit 5
sk executions steps <run-id>
sk executions result <run-id>
```

`sk workflows run <workflow-slug> --follow` startet einen weiteren Lauf und zeigt seine Schritte live.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Das Ergebnis des Laufs ist mit **Vorschau – nicht geschrieben** überschrieben | Die Version ist noch nicht freigegeben. Folge „Freigeben, was er berühren darf“. |
| „Nicht gestartet (…): Für diesen Lauf gibt es keine gültige Freigabe.“ | Die Freigabe fehlt, ist abgelaufen oder aufgebraucht. Gib erneut frei oder verlängere sie. |
| „… muss neu verbunden werden“ | Melde dich unter **Konnektoren** erneut beim Konnektor an. |
| **Du darfst diesen Workflow nicht ausführen.** | Bitte eine Administratorin oder einen Administrator um eine Rolle, die Workflows ausführen darf. |
| Ein Schritt ist fehlgeschlagen | Öffne den Lauf, lies den Fehler und beschreibe ihn im selben Chat. SubKit schlägt eine Korrektur vor, die du erneut prüfst. |
