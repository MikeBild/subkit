---
slug: first-workflow
summary: Bring deinen ersten Workflow vom Satz im Chat bis zum geprüften Lauf.
order: 5
section: start
audience: public
---
## Dein erster Workflow

Am Ende dieses Kapitels hast du einen freigegebenen Workflow und einen ersten Lauf, dessen Schritte du nachlesen kannst.
Du beschreibst eine Aufgabe im Chat, speicherst den Workflow, gibst ihn frei, startest ihn und liest das Ergebnis.
Das funktioniert in SubKit Cloud und auf einer selbst betriebenen Engine gleich.

### Was du brauchst

- Ein SubKit-Konto in einem Arbeitsbereich.
  - Cloud: `https://subkit-cloud.mikebild.dev`
  - Selbst betrieben: `https://<deine-engine>/cockpit`
- Das Recht, Workflows anzulegen und zu starten. Fehlt ein Button, bitte eine Administratorin oder einen Administrator darum.
- Einen KI-Anbieter. Die Cloud stellt ihn bereit. Eine selbst betriebene Engine nutzt den Anbieter, den du bei `sk init` gewählt hast.

### Anmelden

1. Öffne das Cockpit.
2. Wähle **Mit Firmenkonto anmelden**.

Du landest in deinem Arbeitsbereich auf **Übersicht**.
Selbst betrieben ohne Anmeldeanbieter? Wähle stattdessen **Mit API-Schlüssel anmelden** und gib deinen Schlüssel ein.

### Die Aufgabe beschreiben

1. Öffne in der Navigation **Chat**.
2. Wähle **Neue Unterhaltung**.
3. Beschreibe die Aufgabe in eigenen Worten: was hineingeht, was passieren soll, was herauskommt.
   Beispiel: „Hol die offenen Issues meines GitHub-Repositorys und gib mir eine kurze Liste mit Titel und Link.“
4. Beantworte die Rückfragen von SubKit. Braucht die Aufgabe einen Dienst, bittet dich SubKit,
   ihn zu verbinden oder dich dort anzumelden.

Gut zu wissen: Eine kleine Aufgabe lässt sich leichter prüfen. Erweitern kannst du den Workflow später im selben Chat.

### Den Workflow speichern

Ist der Workflow fertig, zeigt SubKit eine Karte **Workflow-Entwurf speichern**.

1. Öffne **Was sich ändert** und lies, welche Schritte und Ziele enthalten sind.
2. Wähle **Inaktive Version speichern**.

Speichern startet nichts. Der Workflow erscheint jetzt unter **Workflows**.

Ohne Chat legst du einen Workflow unter **Workflows** mit **Workflow erstellen** an. Der Assistent führt dich durch **Wie**, **Was**, **Wann** und **Prüfen**.

### Freigeben, was er berühren darf

Eine neue Version berührt nichts außerhalb von SubKit, bis ein Mensch sie freigibt.
Ohne Freigabe startet ein Lauf nur als Probelauf ohne Wirkung.

1. Öffne **Workflows** und klicke auf deinen Workflow. Seine Seite öffnet sich mit dem Tab **Übersicht**.
   Die Statuszeile zeigt **Wartet auf Freigabe** oder **Nicht freigegeben**.
2. Wähle in der Statuszeile **Freigeben**.
3. Prüfe **Umgebung**, **Gültigkeit** sowie **Operationen und externe Ziele**.
4. Bestätige mit **Freigeben**.
   **Nur übernehmen** übernimmt die Version, ohne Läufe freizugeben.

![Freigabedialog für „Invoice export v1“ mit der Umgebung „Test“, der Gültigkeit „Bis auf Widerruf“, einem Lesezugriff auf die Sales reporting API, keinem Schreibzugriff und den Schaltflächen „Nur übernehmen“ und „Freigeben“](images/first-workflow-approval.de.webp)

Die Freigabe startet keinen Lauf. Eine Freigabe gilt für eine Umgebung und eine Dauer.
Eine neue Version braucht keine neue Freigabe, solange sie nicht mehr Systeme, Adressen oder Schreibrechte anfasst als die freigegebene. Greift sie weiter, fragt SubKit erneut und nennt den Unterschied.
Im Tab **Freigaben** kannst du sie jederzeit widerrufen.
Hat eine Freigabe noch ein Ablaufdatum, macht **Unbefristet machen** im selben Tab daraus eine Freigabe bis auf Widerruf und hebt auch eine Laufgrenze auf. Ist nur noch eine Laufgrenze übrig, heißt die Aktion **Laufgrenze aufheben**.
Bietet dir der Chat eine Freigabe an, öffnet sie denselben Dialog.

| Feld | Was es festlegt |
| --- | --- |
| **Umgebung** | Wo die Läufe erlaubt sind, zum Beispiel **Produktion**. |
| **Operationen und externe Ziele** | Welche Dienste und Adressen der Workflow erreicht. Jeder Dienst trägt das Logo seines Anbieters. |
| **Gültigkeit** | Wie lange die Freigabe gilt: **7 Tage**, **30 Tage** oder **Bis auf Widerruf**. **Bis auf Widerruf** ist vorausgewählt. Dieselbe Wahl hast du, wenn du im Chat eine gespeicherte Änderung prüfst. |

**Start aus dem Chat.** Im Chat-Modus **Fragt vorher** fragt SubKit vor einem Start nicht, wenn eine gültige Freigabe genau diesen Lauf deckt: dieselbe Version, dieselbe Umgebung und unveränderte Wirkung. Der Audit-Trail nennt die Freigabe, die den Start gedeckt hat. In drei Fällen fragt SubKit weiterhin: im Modus **Nur planen**, wenn ein Lauf Daten aus einem früheren Lauf weitergibt, und wenn du der Unterhaltung gesagt hast, jeden Start zu bestätigen.

**Wenn SubKit ohne neue Version erneut fragt.** Eine Freigabe gilt für die Konnektoren, wie sie geprüft wurden. Wird ein Konnektor neu angemeldet oder ändert sich seine Konfiguration, braucht der Workflow heute eine neue Prüfung, auch wenn seine Schritte gleich geblieben sind.

**Wenn Freigeben fehlt.** Ein Schritt braucht eine Grenze, bevor eine Freigabe ihn abdecken kann. Eine Grenze legt fest, wohin der Schritt senden oder speichern darf, welche Werte sich ändern dürfen und wie viel er senden darf. Fehlt eine Grenze, lautet der Status **Umbau nötig vor der Freigabe** und bietet **Grenzen festlegen** an.

1. Wähle **Grenzen festlegen**. SubKit liest, was der Schritt in früheren Läufen getan hat, und listet die vorgeschlagenen Grenzen auf.
2. Prüfe die Liste und wähle **Grenzen übernehmen**. SubKit speichert eine neue Version und zeigt sie dir zur Freigabe. Werte, die eine Grenze auflistet, werden im Workflow gespeichert, prüfe sie deshalb vor der Freigabe.
3. Ist der Schritt noch nie gelaufen, wähle **Probelauf starten**. Ein Probelauf liest wirklich aus deinen Systemen und hält jede Anfrage zurück, die etwas ändern würde. So wird nichts geschrieben.

Drei Arten von Schritten können eine Grenze bekommen, die sie bisher nicht bekommen konnten:

- **Ein Konnektor, der eigene Query-Parameter anhängt.** Die festen Parameter des Konnektors zählen zur Adresse. Der Dialog nennt sie, aber nicht ihre Werte.
- **Blättern im Inhalt, den ein Schritt sendet.** Die Grenze enthält die höchste Zahl von Seiten. Von Seite zu Seite ändern sich nur die Felder zum Blättern.
- **Ein Tool-Aufruf an einem MCP-Server.** Die Grenze nennt das eine Tool, welche Argumentwerte sich ändern dürfen und ob der Aufruf liest oder Daten ändert. Ein Aufruf, der Daten ändern kann, wird nie automatisch wiederholt. Sein Schritt trägt `max_retries: 0`. SubKit prüft die Beschreibung des Tools vor jedem Aufruf. Beschreibt der Server das Tool später anders, hält der nächste Lauf an, und du prüfst erneut.

Manches bleibt außerhalb jeder Grenze, weil die Grenze sonst nichts mehr aussagen würde:

- Blättern ohne höchste Zahl von Seiten,
- eine Anfrage, deren Adresse zur Laufzeit frei gewählt wird,
- ein Löschen ohne Liste dessen, was gelöscht werden darf,
- eine Mail, deren Empfänger aus Daten stammen,
- Daten, die aus einem früheren Lauf weitergegeben werden.

Wähle bei solchen Schritten **Im Chat beheben**: SubKit baut genau diese Schritte um, prüft sie ohne Live-Wirkungen und speichert einen Entwurf. Danach gibst du die neue Version frei.

### Den Workflow starten

1. Wähle auf der Workflow-Seite **Starten**.
2. Fülle das Formular aus, wenn der Workflow Eingaben verlangt. JSON gibst du nur unter **Als JSON eingeben** ein.
3. Wähle **Starten**, um zu bestätigen. Der Dialog sagt **Startet einen Lauf mit der freigegebenen Version.**
   Ohne Freigabe heißt der Button **Probelauf starten**.

Du siehst **Lauf gestartet**. Ist der Button nicht verfügbar, nennt der Hinweis den Grund, zum Beispiel
**Schalte den Workflow vor dem Starten ein.**

### Das Ergebnis prüfen

1. Öffne auf der Workflow-Seite den Tab **Verlauf**.
   Der neueste Lauf steht oben, mit seinem Status. **Erfolgreich** heißt, der Lauf ist durchgelaufen.
2. Klicke auf den Lauf.
   Du siehst jeden Schritt mit seiner Ausgabe. Ein fehlgeschlagener Schritt zeigt **Fehler in Schritt „…“** mit der Ursache.

   ![Erfolgreicher Lauf von „CRM contact sync“ mit einem Schritt „Dienst abfragen“, dem Auftraggeber „API“ und den eingeklappten Abschnitten „Warum erlaubt“ und „Technische Angaben“](images/first-workflow-run-result.de.webp)

3. Optional: Wähle **Im Audit-Trail**, um zu sehen, wer den Lauf gestartet und freigegeben hat.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Das Ergebnis des Laufs ist mit **Ergebnis des Probelaufs – nicht geschrieben** überschrieben | Die Version ist noch nicht freigegeben. Folge „Freigeben, was er berühren darf“. |
| „Nicht gestartet (…): Für diesen Lauf gibt es keine gültige Freigabe.“ | Die Freigabe fehlt, ist abgelaufen oder aufgebraucht. Gib erneut frei oder verlängere sie. |
| „… muss neu verbunden werden“ | Öffne den Konnektor unter **Konnektoren** und wähle **Neu anmelden**. |
| **Du darfst diesen Workflow nicht starten.** | Bitte eine Administratorin oder einen Administrator um eine Rolle, die Workflows starten darf. |
| Ein Schritt ist fehlgeschlagen | Öffne den Lauf, lies den Fehler und beschreibe ihn im selben Chat. SubKit schlägt eine Korrektur vor, die du erneut prüfst. |

### Dasselbe im Terminal

Mit der Kommandozeile `sk` legst du Workflows mit `sk workflows create` an, änderst sie mit `sk workflows update` und planst sie mit `sk schedules create` ein.
Braucht ein Schritt einen Umbau vor der Freigabe, melden diese Befehle `automation: repair required`.
Läufe prüfst du so:

```bash
sk executions list --limit 5
sk executions steps <run-id>
sk executions result <run-id>
```

`sk workflows run <workflow-slug> --follow` startet einen weiteren Lauf und zeigt seine Schritte live.
Mehr steht in „Die sk-CLI auf deinem Rechner verwenden“.
