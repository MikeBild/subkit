---
slug: tasks
title: Ein Ziel als Aufgabe übergeben
summary: Gib SubKit ein Ziel mit Grenzen, lass es darauf hinarbeiten und bestätige das Ergebnis.
section: work
order: 12
audience: public
---
## Ein Ziel als Aufgabe übergeben

Dieses Kapitel ist für alle, die SubKit ein Ziel erreichen lassen wollen, statt feste Schritte zu wiederholen.
Danach kannst du eine Aufgabe anlegen, sie von Hand oder nach Zeitplan starten, ihre Rückfragen beantworten und ihr Ergebnis bestätigen.
Du weißt dann auch, was eine Aufgabe alleine darf und wo sie dich fragen muss.

### Aufgabe oder Workflow

Ein Workflow ist ein Rezept. Er führt jedes Mal dieselben festen Schritte aus und denkt nicht nach.

Eine Aufgabe ist ein Auftrag. Du nennst ein Ziel und woran du erkennst, dass es erreicht ist. SubKit plant den Weg, arbeitet ihn ab, fragt nach, wenn es dich braucht, und meldet sich zurück.

Ein Konnektor ist der Schlüssel zu einem anderen Dienst. Ohne ihn erreicht weder ein Workflow noch eine Aufgabe einen Dienst.

| Du willst | Nimm |
| --- | --- |
| Jedes Mal dieselben Schritte, schnell und günstig | Einen Workflow |
| Ein Ziel, bei dem der Weg von Fall zu Fall anders sein kann | Eine Aufgabe |
| Eine Prüfung, die mehrere Anläufe oder einen späteren Blick braucht | Eine Aufgabe |
| Etwas, das eine Aufgabe mehrmals auf dieselbe Weise erledigt hat | Einen Workflow, gebaut aus diesem Lauf |

Beispiel: „Fasse offene Rechnungen nach, bis sie bezahlt sind“ ist eine Aufgabe. Sie muss nachsehen, erinnern, warten und wieder nachsehen. „Schicke jeden Montag die Wochenzahlen“ ist ein Workflow.

Eine Aufgabe kostet in jeder Arbeitsrunde KI-Aufrufe. Ein Workflow kostet sie nur in seinen Schritten „KI fragen“. Hat eine Aufgabe den Weg bewiesen, mach daraus einen Workflow.

### Was du brauchst

- Eine Rolle, die Aufgaben nutzen darf. Die Rollen Mitglied und Admin dürfen das. Die eingebaute Rolle `enduser` darf es nicht.
- Einen KI-Anbieter für den Arbeitsbereich. Ohne ihn startet kein Lauf.
- Die Workflows und Konnektoren, die die Aufgabe nutzen soll. Eine Aufgabe nutzt nur, was du an sie bindest.

### Eine Aufgabe anlegen

1. Öffne in der Navigation **Aufgaben**.
2. Wähle **Neue Aufgabe**.
3. Fülle die drei Felder aus:
   - **Was soll erledigt werden?** Das Ziel in ein oder zwei Sätzen.
   - **Woran erkennst du, dass es fertig ist?** Die Bedingung, die die Aufgabe beendet, zum Beispiel „alle Rechnungen aus Oktober sind bezahlt“.
   - **Womit darf gearbeitet werden?** Wähle die Workflows und Konnektoren.
4. Wähle **Anlegen**.

Alles Weitere ist vorbelegt und zugeklappt: der Zeitplan, die Grenzen, die Websuche und ob die Aufgabe im **Test** oder im **Echtbetrieb** arbeitet.

Im Chat geht es schneller. Beschreibe das Ziel, arbeite es einmal durch und bitte SubKit, es als Aufgabe zu speichern. SubKit zeigt, was es speichern wird, und wartet auf deine Bestätigung. Die Aufgabe übernimmt ihre Schritte aus dem Plan dieser Unterhaltung.

Gut zu wissen:

- Eine Aufgabe hat einen Plan mit 1 bis 19 Schritten. Einen letzten Schritt ergänzt SubKit selbst: Du bestätigst das Ergebnis.
- Eine Aufgabe bindet höchstens 20 Workflows, 20 Konnektoren und 20 Skills. Gebundene Skills werden zu Beginn jedes Laufs geladen.
- Speichern startet nichts und erlaubt nichts.
- Die Aufgabe gehört dir. Andere Personen im Arbeitsbereich sehen sie nicht. Admins sehen jede Aufgabe.

### Eine Aufgabe starten

Es gibt drei Arten zu starten. Du wählst sie im Reiter **Zeitplan**.

| Auswahl | Was passiert |
| --- | --- |
| **Nur von Hand** | Ein Lauf startet, wenn du **Starten** wählst. |
| **Einmal am …** | Ein Lauf startet zu dem Zeitpunkt, den du festlegst. |
| **Täglich**, **Werktags**, **Wöchentlich** | Ein Lauf startet zu jedem dieser Zeitpunkte, in der Zeitzone, die du gewählt hast. |
| **Eigener Rhythmus** | Du gibst einen Cron-Ausdruck mit fünf Feldern ein. |

Unter der Auswahl steht in Klartext, wann der nächste Lauf startet.

Für Zeitpläne gelten drei Regeln:

- Zwischen zwei Läufen liegen mindestens 15 Minuten. Einen engeren Zeitplan lehnt SubKit beim Speichern ab.
- Eine Aufgabe hat immer nur einen offenen Lauf. Solange ein Lauf läuft, wartet oder schläft, wird ein fälliger geplanter Start gehalten. Er startet, sobald dieser Lauf beendet ist.
- Aus mehreren verpassten Startzeiten wird ein Nachhol-Lauf, nicht einer pro verpasstem Termin. Das gilt, wenn SubKit ausgeschaltet war und wenn Starts gehalten wurden.

Ein Start von Hand braucht nichts weiter: Mit **Starten** erlaubst du diesen einen Lauf in den Grenzen der Aufgabe.
Ein Start nach Zeitplan braucht deine Dauererlaubnis, weil dann niemand da ist, der **Starten** wählt.

### Die Dauererlaubnis

Mit der Dauererlaubnis darf eine Aufgabe alleine starten. Sie gilt für genau diese Aufgabe, so wie sie jetzt ist.

1. Öffne die Aufgabe. Die Statuszeile sagt, dass die Aufgabe noch nicht alleine starten darf, und bietet **Erlauben** an.
2. Lies, was der Dialog auflistet. Er nennt den Zeitplan und für jeden gebundenen Workflow und Konnektor, was er liest, schreibt oder startet.
3. Wähle unter **Gültigkeit**, wie lange: **Bis auf Widerruf**, **30 Tage** oder **7 Tage**.
4. Bestätige mit **Erlauben**.

Das kann nur eine Person, die im Browser im Cockpit angemeldet ist. Mit einem API-Schlüssel, in der Kommandozeile `sk` oder aus einem KI-Client geht es nicht.

Was sie abdeckt:

- **Die geplanten Starts dieser Aufgabe**, in der Umgebung, in der die Aufgabe arbeitet.
- **Die gebundenen Workflows.** SubKit legt für jeden eine normale Workflow-Freigabe mit derselben Gültigkeit an. Du findest sie am Workflow unter **Freigaben**, und andere Starts dieses Workflows nutzen sie ebenfalls. Ein Workflow, der schon eine gültige Freigabe hat, behält sie.
- **Nicht** die Schreibzugriffe, die die Aufgabe über einen Konnektor macht. Die fragen jedes Mal.

Lässt sich ein gebundener Workflow nicht für wiederholte Läufe freigeben, nennt der Dialog ihn. Die Aufgabe startet trotzdem alleine, aber dieser Workflow fragt dich in jedem Lauf. Ein als vertraulich markierter Workflow (`execution_privacy: sensitive`) lässt sich aus einer Aufgabe gar nicht starten.

Die Dauererlaubnis endet, wenn:

- du im Reiter **Darf** **Widerrufen** wählst.
- ihre Zeit abgelaufen ist oder ihre Laufgrenze aufgebraucht und der letzte dieser Läufe beendet ist.
- du die Aufgabe änderst: das Ziel, die Fertig-Bedingung, den Plan, die Bindungen, die Websuche, den Zeitplan, die Grenzen oder Test und Echtbetrieb. Ein neuer Name, eine neue Beschreibung oder Kategorie ändert nichts.
- du die Aufgabe löschst oder ihre Besitzerin den Arbeitsbereich verlässt.

Endet sie, enden auch die Workflow-Freigaben, die sie angelegt hat. Das gilt nicht, wenn eine andere Aufgabe mit eigener Dauererlaubnis denselben Workflow nutzt.

Sieben Tage vor dem Ende, oder wenn weniger als ein Zehntel der Läufe übrig ist, erscheint ein Hinweis mit **Erneuern**. Drei Tage vor dem Ende folgt die Benachrichtigung: SubKit sendet einmal das Ereignis `task.grant_expiring`. Mehr in „Zeitpläne im Blick behalten“.
Ist sie weg, werden die geplanten Starts gehalten, und ein Hinweis sagt, dass die Aufgabe nicht mehr alleine starten darf. Es geht nichts verloren: Erlaube erneut, und der gehaltene Start läuft kurz danach.

In der Liste und auf der Seite der Aufgabe steht bei einer Startzeit, die schon vorbei ist:

| Was du liest | Bedeutung |
| --- | --- |
| **fällig, wartet auf Erlaubnis** | Die Dauererlaubnis fehlt oder gilt nicht mehr. Wähle **Erlauben**. |
| **wartet auf den laufenden Lauf** | Die Erlaubnis gilt, aber der vorige Lauf ist noch offen. |
| **startet gleich** | Nichts steht im Weg. Der Lauf startet in wenigen Augenblicken. |

### Was ein Lauf darf

Ein Lauf arbeitet in einer eigenen Unterhaltung. Darin darf SubKit:

| Handlung | Regel |
| --- | --- |
| Lesen | Ohne Rückfrage erlaubt, so weit deine eigene Rolle reicht. Das umfasst Workflows, Läufe, Konnektoren, Wissen, Skills und Dateien. |
| Seinen Plan pflegen | Erlaubt. Der Plan zeigt jeden Schritt mit seinen Belegen. |
| Einen gebundenen Workflow starten | Erlaubt. Jeder gebundene Workflow hat im Lauf sein eigenes Tool. Deckt eine gültige Freigabe des Workflows den Start, schreibt der Workflow ohne Rückfrage, auch wenn die Aufgabe keine Dauererlaubnis hat. Ohne sie werden seine Schreibzugriffe zurückgehalten, und der Lauf fragt dich vorher. |
| Einen gebundenen Konnektor aufrufen | Lesen ist erlaubt. Alles, was schreibt, fragt dich vorher, jedes Mal. |
| Im Web suchen | Nur, wenn du es für diese Aufgabe eingeschaltet hast. |
| Etwas nutzen, das nicht gebunden ist | Abgelehnt. Nichts läuft, und niemand wird gefragt. |
| Workflows, Konnektoren, Wissen oder Skills anlegen oder ändern | Nie. |

Weitere Grenzen:

- Ein Lauf arbeitet immer in der Umgebung seiner Aufgabe. Er kann nicht zwischen Test und Echtbetrieb wechseln.
- Ein Konnektor, den du als vertrauenswürdig markiert hast, fragt in einem Lauf trotzdem.
- Was eine Webseite, eine Datei oder ein Dienst zurückgibt, sind Daten. Es ist nie eine Anweisung und nie eine Erlaubnis.
- Die Grenzen eines Laufs stehen beim Start fest. Nichts, was der Lauf liest, kann sie erweitern.

Ein Lauf hat außerdem zwei eigene Grenzen: eine Zahl von Runden, 10, wenn du nichts änderst, und eine Frist, 4 Stunden, wenn du nichts änderst. Ist eine davon aufgebraucht und liegt ein Ergebnis vor, bekommst du es zur Prüfung. Liegt keines vor, endet der Lauf als **fehlgeschlagen** und nennt das Rundenlimit oder die Frist als Grund. Er lässt sich nicht fortsetzen. Wähle **Neu starten**. Die Aufgabe ist danach wieder frei für den nächsten Start. Das Monatskontingent des Arbeitsbereichs gilt zusätzlich.

### Einen Lauf verfolgen und eingreifen

Die Seite der Aufgabe zeigt den Zustand des letzten Laufs und eine empfohlene Handlung.

| Zustand | Bedeutung | Was du tust |
| --- | --- | --- |
| **läuft** | SubKit arbeitet. | Nichts, oder im Menü **Lauf abbrechen**. |
| **wartet auf dich** | Der Lauf hat eine Rückfrage, braucht deine Freigabe, wurde angehalten oder kam nicht voran. | **Antworten** |
| **schläft bis …** | Der Lauf hat sich einen Zeitpunkt gesetzt, um wieder nachzusehen, etwa wenn eine Antwort erwartet wird. | Nichts. Er arbeitet von selbst weiter. |
| **Ergebnis liegt vor** | Die Arbeit ist getan und wartet auf deine Bestätigung. | **Ergebnis prüfen** |
| **erledigt** | Du hast das Ergebnis bestätigt. | Nichts. |
| **abgebrochen** | Du oder ein Admin hat den Lauf abgebrochen, oder die Aufgabe wurde geändert. | Starte einen neuen Lauf, wenn du ihn brauchst. |
| **fehlgeschlagen** | Etwas ist ausgefallen, wovon sich der Lauf nicht erholen konnte, oder der Lauf hat sein Rundenlimit oder seine Frist erreicht, ohne ein Ergebnis zu liefern. | Öffne den Lauf, lies den Grund, starte einen neuen Lauf. Nach einem erreichten Limit: **Neu starten**. |

Der Reiter **Überblick** zeigt vier Angaben: **Jetzt**, **Wartet auf**, **Nächste Prüfung** und **Fertig, wenn**. Darunter stehen die Schritte des Plans mit ihrem Fortschritt.

Ein Lauf wartet in diesen Fällen auf dich:

- Er stellt eine Rückfrage oder braucht deine Freigabe für einen Schreibzugriff.
- Zwei Runden hintereinander brachten keinen echten Fortschritt. Als Fortschritt zählt, dass ein Schritt fertig wird, ein neuer Beleg oder ein neues Ergebnis dazukommt, ein gebundener Workflow oder Konnektor läuft, du schreibst oder antwortest oder der Lauf seine nächste Prüfung plant. Nur Notizen im Plan umzuschreiben zählt nicht.
- Du hast am Eingabefeld **Stoppen** gewählt, während eine Runde lief.
- Das Monatskontingent ist aufgebraucht, oder der Arbeitsbereich hat gerade keinen KI-Anbieter. In diesen beiden Fällen musst du im Lauf nichts tun: Er arbeitet von selbst weiter, sobald wieder Kontingent frei oder ein Anbieter eingerichtet ist.

Ein Lauf schläft, wenn er sich selbst eine nächste Prüfung gesetzt hat, wenn der KI-Anbieter SubKit bremst oder solange die Aufgabe pausiert ist. Eine nächste Prüfung liegt höchstens 31 Tage voraus und nie hinter der Frist des Laufs.

Zum Eingreifen öffnest du den Lauf im Reiter **Läufe** und wählst **Unterhaltung öffnen**. Über der Unterhaltung steht eine Zeile: die Aufgabe, der Zustand, **Jetzt**, **Nächste Prüfung** und die Aktion **Abbrechen**. Schreib dort wie in jedem Chat.

Die Unterhaltung kennt zwei Arten anzuhalten. **Abbrechen** in der Zeile darüber beendet den Lauf endgültig. **Stoppen** am Eingabefeld unterbricht nur die laufende Runde: Der Lauf wartet dann auf dich und arbeitet weiter, wenn du ihm schreibst.

Schreibst du in einen Lauf hinein, gelten für dich dieselben Grenzen. Der Lauf bleibt, was du erlaubt hast: Er nutzt weiter nur, was gebunden ist, er fragt weiter vor Schreibzugriffen, die keine Freigabe deckt, und du kannst ihn nicht in einen Modus schalten, der nicht mehr fragt. Deinen Lauf lesen und in ihn schreiben können nur du und Admins. Für alle anderen gibt es seine Unterhaltung nicht. Bittet ein Lauf darum, zurückgehaltene Schreibzugriffe freizugeben, kannst du als Besitzerin antworten oder ein Admin. Alle anderen sehen statt der Antwort-Schaltflächen einen Hinweis. Lauf-Unterhaltungen stehen nicht in der normalen Liste der Unterhaltungen. Du öffnest sie über die Aufgabe.

Eine offene Rückfrage hält den nächsten geplanten Start auf, weil der Lauf noch offen ist. Beantworte sie oder brich den Lauf ab.

### Das Ergebnis prüfen

Sind alle Schritte erledigt, lautet der Zustand **Ergebnis liegt vor**, und du bekommst einen Hinweis. Der Lauf fragt dich nicht selbst, ob das Ergebnis stimmt: Er übergibt es, indem er seine Runde beendet. Er schreibt dir in der Sprache, die du beim letzten Speichern der Aufgabe verwendet hast.

1. Wähle **Ergebnis prüfen**.
2. Lies, was der Lauf getan hat. Jeder Schritt zeigt seine Belege.
3. Wähle **Passt**, um zu bestätigen. Der Zustand wechselt zu **erledigt**.
4. Oder wähle **Nacharbeiten**. Der Lauf erfährt, dass das Ergebnis noch nicht reicht, und arbeitet weiter. Schreib in seine Unterhaltung, was fehlt. Dasselbe Ergebnis legt er dir nicht unverändert noch einmal vor.

Ein Ergebnis bestätigt oder verwirft nur ein Mensch, der im Browser im Cockpit angemeldet ist. Mit einem API-Schlüssel, in der Kommandozeile `sk` oder aus einem KI-Client geht es nicht, und SubKit kann seine eigene Arbeit nicht bestätigen.

Ein Ergebnis, das du noch nicht bestätigt hast, hält den Zeitplan nicht auf. Der nächste Lauf einer täglichen Aufgabe startet morgen, auch wenn das Ergebnis von gestern noch offen ist. **Nacharbeiten** geht nur, solange kein neuerer Lauf offen ist und die Aufgabe seitdem weder geändert noch pausiert wurde.

### Pausieren, ändern und löschen

**Pausieren** hält eine Aufgabe an. Es startet kein Lauf, weder von Hand noch nach Zeitplan, und ein laufender Lauf schläft ein. **Fortsetzen** nimmt sie wieder auf, und ein Lauf, der die Pause verschlafen hat, arbeitet weiter. Die Dauererlaubnis bleibt, wie sie ist.

**Bearbeiten** ändert eine Aufgabe. Ein neuer Name, eine neue Beschreibung oder Kategorie ist unbedenklich. Jede andere Änderung beendet den offenen Lauf und die Dauererlaubnis, weil die Erlaubnis für die Aufgabe galt, wie sie war. Erlaube sie danach erneut.

**Löschen** archiviert eine Aufgabe. Der offene Lauf endet, und die Dauererlaubnis endet. Die bisherigen Läufe und ihr Verlauf bleiben lesbar.

Wird eine Person aus dem Arbeitsbereich entfernt oder deaktiviert, werden ihre Aufgaben pausiert, ihre offenen Läufe enden, und ihre Dauererlaubnisse enden. Die Aufgaben bleiben pausiert, bis jemand **Fortsetzen** wählt, auch wenn die Person wieder eingeladen wird. Eine Aufgabe mit Zeitplan braucht dann eine neue Dauererlaubnis.

### Aus einem bewährten Lauf einen Workflow machen

Ein Lauf kann keine Workflows schreiben. Das bleibt deine Entscheidung.

1. Öffne im Reiter **Läufe** einen Lauf, der **erledigt** ist.
2. Wähle in seinem Menü **Als Workflow weiterführen**. Eine normale Unterhaltung öffnet sich, und die Bitte, einen Workflow mit denselben Schritten zu bauen, steht schon im Eingabefeld.
3. Sende die Bitte und arbeite den Entwurf mit SubKit durch.
4. Speichere den Entwurf und gib ihn frei, wie in „Dein erster Workflow“ beschrieben.

Binde den neuen Workflow dann an die Aufgabe, oder ersetze die Aufgabe durch einen Zeitplan am Workflow. Je mehr vom Weg in Workflows feststeht, desto weniger muss ein Lauf überlegen und fragen.

### Was Admins können

Eine Aufgabe gehört der Person, die sie angelegt hat. Personen mit der Rolle Admin können mit jeder Aufgabe alles tun: sie sehen, starten, pausieren und fortsetzen, ihre Läufe abbrechen, ihre Rückfragen beantworten, ihre Ergebnisse bestätigen, sie ändern und löschen und die Dauererlaubnis erteilen oder widerrufen.

Dazu gehört auch, Schreibzugriffe freizugeben, die ein Lauf zurückhält: Ein Admin kann sie in der Lauf-Unterhaltung oder über den Freigabe-Link freigeben oder ablehnen. Der Audit-Trail nennt den Admin als die Person, die entschieden hat.

Ein Lauf arbeitet trotzdem mit den Rechten der Besitzerin, nicht mit denen des Admins, der eingegriffen hat. Schreibzugriffe, die ein Admin freigibt, werden mit dem ausgeführt, was der Lauf darf: mit den gebundenen Workflows und Konnektoren, der Umgebung der Aufgabe und den Rechten der Besitzerin. Stehen diese nicht mehr zur Verfügung, etwa weil die Besitzerin nicht mehr da ist oder die Aufgabe pausiert ist, wird die Freigabe abgelehnt und nichts geändert.

Admins sehen außerdem einen Hinweis, wenn eine Aufgabe pausiert ist, weil ihre Besitzerin nicht mehr da ist.

### Kosten

Jede Runde eines Laufs ist ein oder mehrere KI-Aufrufe. Sie zählen zum Monatskontingent des Arbeitsbereichs. Ist das Kontingent aufgebraucht, wartet ein Lauf. Er schlägt nicht fehl und arbeitet von selbst weiter, sobald wieder Kontingent frei ist.

Auf der Seite **Nutzung** wählst du unter **Aufschlüsseln nach** den Eintrag **Aufgabe** und siehst Kosten und KI-Aufrufe je Aufgabe. Weil das die Aufgaben aller Personen umfasst, braucht es `stats:read:all`. Auf der Seite der Aufgabe zeigt die Kachel **Verbrauch** im Reiter **Überblick** den letzten Lauf und den laufenden Monat. Dafür brauchst du kein zusätzliches Recht.

Eines steckt nicht in den Zahlen einer Aufgabe: KI-Aufrufe in den Workflow-Läufen, die die Aufgabe gestartet hat. Diese Schritte „KI fragen“ zählen beim Workflow. Wurde die Unterhaltung eines Laufs gelöscht, lassen sich seine Aufrufe der Aufgabe nicht mehr zuordnen.

So hältst du die Kosten niedrig:

- Binde Workflows für die festen Teile. Ein Workflow-Schritt kostet keinen KI-Aufruf, außer er ist ein Schritt „KI fragen“.
- Lass den Lauf eine nächste Prüfung setzen, statt alle paar Minuten wieder nachzusehen.
- Halte die Zahl der Runden klein, wenn eine Aufgabe schnell gehen soll.

### Sehen, was passiert ist

- **An der Aufgabe:** Der Reiter **Läufe** listet jeden Lauf mit seinem Zustand. Der Reiter **Verlauf** zeigt, wer was angelegt, geändert, pausiert, erlaubt und gestartet hat.
- **Im Lauf:** Die Unterhaltung zeigt jeden Schritt, jede Rückfrage und jede Antwort.
- **Im Audit-Trail:** Jeder Start, jedes Warten, jedes Ergebnis, jede Bestätigung und jeder Abbruch ist ein Eintrag. Einträge, die während eines Laufs entstehen, sind als Aufgaben-Lauf gekennzeichnet. Sie nennen die Aufgabe und den Lauf, aber nie den Text des Ziels oder deine Antworten.
- **Hinweise:** In der **Übersicht** erscheint eine Aufgabe, wenn ein Lauf auf deine Antwort wartet, ein Ergebnis vorliegt, ein Lauf fehlgeschlagen ist oder die Dauererlaubnis fehlt oder bald endet. Sind Push-Nachrichten eingeschaltet, bekommst du zusätzlich einen neutralen Push.
- **Webhooks:** Die Ereignisse `task_run.started`, `task_run.waiting`, `task_run.result_ready`, `task_run.completed` und `task_run.failed` stehen für Abonnements bereit.

Der `sk`-Eingang eines neuen Arbeitsbereichs erhält zusätzlich `task_run.waiting`, `task_run.result_ready` und `task_run.failed`. Ein Arbeitsbereich, den es schon gab, behält seine gespeicherte Eingangsregel. Damit die Aufgaben-Ereignisse dort ankommen, ergänze sie in dieser Regel mit `sk notifications rules`.

### Was SubKit nicht erzwingt

- **Lesen reicht so weit wie deine Rolle.** Bindungen begrenzen, was ein Lauf starten und aufrufen darf, nicht, was er nachschlagen darf. Ein Lauf kann Workflows, Konnektor-Dokumentation und Wissen durchsuchen, die du lesen darfst.
- **Ein externer Browser-Dienst entscheidet selbst, welche Website er öffnet.** Steuert eine Aufgabe oder ein Workflow einen Browser über einen solchen Dienst, läuft der Seiten-Code dort, nicht in SubKit. SubKit prüft die Anfrage an den Dienst, nicht, welche Website der Browser danach besucht oder was er absendet. Binde einen solchen Konnektor nur an Aufgaben, bei denen das vertretbar ist.
- **Unterhaltungen bleiben erhalten.** Eine tägliche Aufgabe erzeugt jeden Tag eine Unterhaltung. Eine automatische Aufbewahrungsfrist gibt es für sie nicht.
- **Eine Grenze legt fest, wohin eine Anfrage geht und wie groß sie ist, nicht, was sie sagt.** Das gilt für die Workflows, die eine Aufgabe startet, wie in „Dein erster Workflow“ beschrieben.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Die Aufgabe darf nicht alleine starten | Öffne die Aufgabe und wähle **Erlauben**. |
| Die Dauererlaubnis endete, nachdem du die Aufgabe bearbeitet hast | Das ist gewollt. Prüfe die Änderung und wähle erneut **Erlauben**. |
| **Starten** meldet, dass schon ein Lauf läuft | Öffne den Lauf. Beantworte ihn, warte auf ihn oder wähle **Abbrechen**, dann starte erneut. |
| Der geplante Start blieb aus | Lies die Zeile zum nächsten Start. **fällig, wartet auf Erlaubnis**: Wähle **Erlauben**. **wartet auf den laufenden Lauf**: Beantworte den offenen Lauf oder brich ihn ab. Sonst prüfe, ob die Aufgabe pausiert ist. |
| Der Lauf wartet und nennt das Kontingent | Das Monatskontingent ist aufgebraucht. Erhöhe es auf der Seite **Nutzung** oder warte auf den Monatsersten. Der Lauf arbeitet dann von selbst weiter. |
| Der Lauf wartet ohne Rückfrage | Er kam nicht voran, oder eine Runde wurde angehalten: Sag ihm, was fehlt. |
| Der Lauf endete am Rundenlimit oder an der Frist | Er lässt sich nicht fortsetzen. Wähle **Neu starten**. Reichen die Runden für die Aufgabe nicht, erhöhe sie beim Bearbeiten der Aufgabe. |
| „This workflow is not part of the task.“ | Binde den Workflow an die Aufgabe. Das beendet die Dauererlaubnis. Erlaube sie danach erneut. |
| Ein Zeitplan wird als zu häufig abgelehnt | Wähle Startzeiten, die mindestens 15 Minuten auseinanderliegen. |
| Jemand anderes hat die Aufgabe geändert, während du sie bearbeitet hast | Lade die Aufgabe neu und wiederhole deine Änderung. |
| **Nacharbeiten** wird abgelehnt | Ein neuerer Lauf ist offen, oder die Aufgabe wurde geändert oder ist pausiert. Starte stattdessen einen neuen Lauf. |
| Eine Rückfrage eines Laufs zeigt einen Hinweis statt der Antwort-Schaltflächen | Die Rückfrage gibt Schreibzugriffe frei, die der Lauf zurückhält. Nur die Besitzerin der Aufgabe oder ein Admin kann sie beantworten. Bitte eine dieser Personen darum, oder brich den Lauf ab. |
| Die Freigabe eines Admins wird als nicht mehr verfügbar abgelehnt | Der Lauf kann die Rechte nicht mehr nutzen, mit denen die Schreibzugriffe vorbereitet wurden: Die Besitzerin ist nicht mehr verfügbar, die Aufgabe ist pausiert oder der Lauf ist beendet. Nichts wurde geändert. Brich den Lauf ab und starte einen neuen. |
| Das Ergebnis lässt sich nicht bestätigen, weil der Plan geändert wurde | Der Lauf gilt als fehlgeschlagen. Starte einen neuen Lauf. |

### Dasselbe im Terminal und aus KI-Clients

Mit der Kommandozeile `sk`:

```bash
sk tasks list
sk tasks get <task-id>
sk tasks create --file task.json
sk tasks update <task-id> --cron "0 7 * * *" --timezone Europe/Berlin
sk tasks run <task-id>
sk tasks runs <task-id>
sk tasks pause <task-id>
sk tasks resume <task-id>
sk tasks abort <run-id>
sk tasks delete <task-id>
```

`sk tasks update <task-id> --run-at <time>` legt einen einzelnen Start fest. Wartet ein Lauf auf einen Menschen, gibt `sk` die Adresse der Aufgabe im Cockpit aus. Die Dauererlaubnis lässt sich in `sk` nicht erteilen, und ein Ergebnis lässt sich dort weder bestätigen noch verwerfen. `sk tasks get` zeigt, ob eine Dauererlaubnis gilt.

KI-Clients, die per MCP angebunden sind, können Aufgaben finden, lesen, starten und abbrechen. Anlegen und Ändern braucht die Stufe **Bearbeiten**. Rückfragen eines Laufs beantwortest du im Cockpit, und dort bestätigst du auch Ergebnisse. Mehr dazu in „KI-Clients per MCP anbinden“.

Über die HTTP-API liegen dieselben Aktionen unter `/v1/tasks` und `/v1/task-runs`. Sie stehen in der API-Referenz deiner Engine unter `/openapi.json`.
