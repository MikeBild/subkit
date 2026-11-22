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

Ein Connector ist der Schlüssel zu einem anderen Dienst. Ohne ihn erreicht weder ein Workflow noch eine Aufgabe einen Dienst.

| Du willst | Nimm |
| --- | --- |
| Jedes Mal dieselben Schritte, schnell und günstig | Einen Workflow |
| Ein Ziel, bei dem der Weg von Fall zu Fall anders sein kann | Eine Aufgabe |
| Eine Prüfung, die mehrere Anläufe oder einen späteren Blick braucht | Eine Aufgabe |
| Etwas, das eine Aufgabe mehrmals auf dieselbe Weise erledigt hat | Einen Workflow, gebaut aus diesem Run |

Beispiel: „Fasse offene Rechnungen nach, bis sie bezahlt sind“ ist eine Aufgabe. Sie muss nachsehen, erinnern, warten und wieder nachsehen. „Schicke jeden Montag die Wochenzahlen“ ist ein Workflow.

Eine Aufgabe kostet in jeder Arbeitsrunde KI-Aufrufe. Ein Workflow kostet sie nur in seinen Schritten „KI fragen“. Hat eine Aufgabe den Weg bewiesen, mach daraus einen Workflow.

### Was du brauchst

- Eine Rolle, die Aufgaben nutzen darf. Die Rollen Mitglied und Admin dürfen das. Die eingebaute Rolle `enduser` darf es nicht.
- Einen KI-Anbieter für den Arbeitsbereich. Ohne ihn startet kein Run.
- Die Workflows und Connectors, die die Aufgabe nutzen soll. Eine Aufgabe nutzt nur, was du an sie bindest.

### Eine Aufgabe anlegen

1. Öffne in der Navigation **Aufgaben**.
2. Wähle **Neue Aufgabe**.
3. Fülle die drei Felder aus:
   - **Was soll erledigt werden?** Das Ziel in ein oder zwei Sätzen.
   - **Woran erkennst du, dass es fertig ist?** Die Bedingung, die die Aufgabe beendet, zum Beispiel „alle Rechnungen aus Oktober sind bezahlt“.
   - **Womit darf gearbeitet werden?** Wähle die Workflows und Connectors.
4. Wähle **Anlegen**.

Alles Weitere ist vorbelegt und zugeklappt: der Zeitplan, die Grenzen, die Websuche und ob die Aufgabe im **Test** oder im **Echtbetrieb** arbeitet.

Im Chat geht es schneller. Beschreibe das Ziel, arbeite es einmal durch und bitte SubKit, es als Aufgabe zu speichern. SubKit zeigt, was es speichern wird, und wartet auf deine Bestätigung. Die Aufgabe übernimmt ihre Schritte aus dem Plan dieser Unterhaltung. Sie bleibt an die Nachricht gebunden, die sie gewünscht hat: Der Chat zeigt die Aufgabe unter dieser Nachricht, und **Gewünscht in** auf dem Tab **Überblick** der Aufgabe führt zurück zu ihr.

Gut zu wissen:

- Eine Aufgabe hat einen Plan mit 1 bis 19 Schritten. Einen letzten Schritt ergänzt SubKit selbst: Du bestätigst das Ergebnis.
- Eine Aufgabe bindet höchstens 20 Workflows, 20 Connectors und 20 Skills. Gebundene Skills werden zu Beginn jedes Runs geladen.
- Speichern startet nichts und erlaubt nichts.
- Die Aufgabe gehört dir. Andere Personen im Arbeitsbereich sehen sie nicht. Admins sehen jede Aufgabe.

### Eine Aufgabe starten

Es gibt drei Arten zu starten. Du wählst sie im Reiter **Zeitplan**.

| Auswahl | Was passiert |
| --- | --- |
| **Nur von Hand** | Ein Run startet, wenn du **Starten** wählst. |
| **Einmal am …** | Ein Run startet zu dem Zeitpunkt, den du festlegst. |
| **Täglich**, **Werktags**, **Wöchentlich** | Ein Run startet zu jedem dieser Zeitpunkte, in der Zeitzone, die du gewählt hast. |
| **Eigener Rhythmus** | Du gibst einen Cron-Ausdruck mit fünf Feldern ein. |

Unter der Auswahl steht in Klartext, wann der nächste Run startet.

Für Zeitpläne gelten drei Regeln:

- Zwischen zwei Runs liegen mindestens 15 Minuten. Einen engeren Zeitplan lehnt SubKit beim Speichern ab.
- Eine Aufgabe hat immer nur einen offenen Run. Solange ein Run läuft, wartet oder schläft, wird ein fälliger geplanter Start gehalten. Er startet, sobald dieser Run beendet ist.
- Aus mehreren verpassten Startzeiten wird ein Nachhol-Run, nicht einer pro verpasstem Termin. Das gilt, wenn SubKit ausgeschaltet war und wenn Starts gehalten wurden.

Ein Start von Hand braucht nichts weiter: Mit **Starten** erlaubst du diesen einen Run in den Grenzen der Aufgabe.
Ein Start nach Zeitplan braucht deine Dauererlaubnis, weil dann niemand da ist, der **Starten** wählt.

### Die Dauererlaubnis

Mit der Dauererlaubnis darf eine Aufgabe alleine starten. Sie gilt für genau diese Aufgabe, so wie sie jetzt ist.

1. Öffne die Aufgabe. Die Statuszeile sagt, dass die Aufgabe noch nicht alleine starten darf, und bietet **Erlauben** an.
2. Lies, was der Dialog auflistet. Er nennt den Zeitplan und für jeden gebundenen Workflow und Connector, was er liest, schreibt oder startet.
3. Wähle unter **Gültigkeit**, wie lange: **Bis auf Widerruf**, **30 Tage** oder **7 Tage**.
4. Bestätige mit **Erlauben**.

Das kann nur eine Person, die im Browser im Cockpit angemeldet ist. Mit einem API-Schlüssel, in der Kommandozeile `subkit` oder aus einem KI-Client geht es nicht.

Was sie abdeckt:

- **Die geplanten Starts dieser Aufgabe**, in der Umgebung, in der die Aufgabe arbeitet.
- **Die gebundenen Workflows.** SubKit legt für jeden eine normale Workflow-Freigabe mit derselben Gültigkeit an. Du findest sie am Workflow unter **Freigaben**, und andere Starts dieses Workflows nutzen sie ebenfalls. Ein Workflow, der schon eine gültige Freigabe hat, behält sie.
- **Nicht** die Schreibzugriffe, die die Aufgabe über einen Connector macht. Die fragen jedes Mal.

Lässt sich ein gebundener Workflow nicht für wiederholte Runs freigeben, nennt der Dialog ihn. Die Aufgabe startet trotzdem alleine, aber dieser Workflow fragt dich in jedem Run. Ein als vertraulich markierter Workflow (`execution_privacy: sensitive`) lässt sich aus einer Aufgabe gar nicht starten.

Die Dauererlaubnis endet, wenn:

- du im Reiter **Darf** **Widerrufen** wählst.
- ihre Zeit abgelaufen ist oder ihre Run-Grenze aufgebraucht und der letzte dieser Runs beendet ist.
- du die Aufgabe änderst: das Ziel, die Fertig-Bedingung, den Plan, die Bindungen, die Websuche, den Zeitplan, die Grenzen oder Test und Echtbetrieb. Ein neuer Name, eine neue Beschreibung oder Kategorie ändert nichts.
- du die Aufgabe löschst oder ihre Besitzerin den Arbeitsbereich verlässt.

Endet sie, enden auch die Workflow-Freigaben, die sie angelegt hat. Das gilt nicht, wenn eine andere Aufgabe mit eigener Dauererlaubnis denselben Workflow nutzt.

Sieben Tage vor dem Ende, oder wenn weniger als ein Zehntel der Runs übrig ist, erscheint ein Hinweis mit **Erneuern**. Drei Tage vor dem Ende folgt die Benachrichtigung: SubKit sendet einmal das Ereignis `task.grant_expiring`. Mehr in „Zeitpläne im Blick behalten“.
Ist sie weg, werden die geplanten Starts gehalten, und ein Hinweis sagt, dass die Aufgabe nicht mehr alleine starten darf. Es geht nichts verloren: Erlaube erneut, und der gehaltene Start läuft kurz danach.

In der Liste und auf der Seite der Aufgabe steht bei einer Startzeit, die schon vorbei ist:

| Was du liest | Bedeutung |
| --- | --- |
| **fällig, wartet auf Erlaubnis** | Die Dauererlaubnis fehlt oder gilt nicht mehr. Wähle **Erlauben**. |
| **wartet auf den laufenden Run** | Die Erlaubnis gilt, aber der vorige Run ist noch offen. |
| **startet gleich** | Nichts steht im Weg. Der Run startet in wenigen Augenblicken. |

### Was ein Run darf

Ein Run arbeitet in einer eigenen Unterhaltung. Darin darf SubKit:

| Handlung | Regel |
| --- | --- |
| Lesen | Ohne Rückfrage erlaubt, so weit deine eigene Rolle reicht. Das umfasst Workflows, Runs, Connectors, Wissen, Skills und Dateien. |
| Seinen Plan pflegen | Erlaubt. Der Plan zeigt jeden Schritt mit seinen Belegen. |
| Einen gebundenen Workflow starten | Erlaubt. Jeder gebundene Workflow hat im Run sein eigenes Tool. Deckt eine gültige Freigabe des Workflows den Start, schreibt der Workflow ohne Rückfrage, auch wenn die Aufgabe keine Dauererlaubnis hat. Ohne sie werden seine Schreibzugriffe zurückgehalten, und der Run fragt dich vorher. |
| Einen gebundenen Connector aufrufen | Lesen ist erlaubt. Alles, was schreibt, fragt dich vorher, jedes Mal. |
| Im Web suchen | Nur, wenn du es für diese Aufgabe eingeschaltet hast. |
| Etwas nutzen, das nicht gebunden ist | Abgelehnt. Nichts läuft, und niemand wird gefragt. |
| Workflows, Connectors, Wissen oder Skills anlegen oder ändern | Nie. |

Weitere Grenzen:

- Ein Run arbeitet immer in der Umgebung seiner Aufgabe. Er kann nicht zwischen Test und Echtbetrieb wechseln.
- Ein Connector, den du als vertrauenswürdig markiert hast, fragt in einem Run trotzdem.
- Was eine Webseite, eine Datei oder ein Dienst zurückgibt, sind Daten. Es ist nie eine Anweisung und nie eine Erlaubnis.
- Die Grenzen eines Runs stehen beim Start fest. Nichts, was der Run liest, kann sie erweitern.

Ein Run hat außerdem zwei eigene Grenzen: eine Zahl von Runden, 10, wenn du nichts änderst, und eine Frist, 4 Stunden, wenn du nichts änderst. Ist eine davon aufgebraucht und liegt ein Ergebnis vor, bekommst du es zur Prüfung. Liegt keines vor, endet der Run als **fehlgeschlagen** und nennt das Rundenlimit oder die Frist als Grund. Er lässt sich nicht fortsetzen. Wähle **Neu starten**. Die Aufgabe ist danach wieder frei für den nächsten Start. Das Monatskontingent des Arbeitsbereichs gilt zusätzlich.

### Einen Run verfolgen und eingreifen

Die Seite der Aufgabe zeigt den Zustand des letzten Runs und eine empfohlene Handlung.

| Zustand | Bedeutung | Was du tust |
| --- | --- | --- |
| **läuft** | SubKit arbeitet. | Nichts, oder im Menü **Run abbrechen**. |
| **wartet auf dich** | Der Run hat eine Rückfrage, braucht deine Freigabe, wurde angehalten oder kam nicht voran. | **Antworten** |
| **schläft bis …** | Der Run hat sich einen Zeitpunkt gesetzt, um wieder nachzusehen, etwa wenn eine Antwort erwartet wird. | Nichts. Er arbeitet von selbst weiter. |
| **Ergebnis liegt vor** | Die Arbeit ist getan und wartet auf deine Bestätigung. | **Ergebnis prüfen** |
| **erledigt** | Du hast das Ergebnis bestätigt. | Nichts. |
| **abgebrochen** | Du oder ein Admin hat den Run abgebrochen, oder die Aufgabe wurde geändert. | Starte einen neuen Run, wenn du ihn brauchst. |
| **fehlgeschlagen** | Etwas ist ausgefallen, wovon sich der Run nicht erholen konnte, oder der Run hat sein Rundenlimit oder seine Frist erreicht, ohne ein Ergebnis zu liefern. | Öffne den Run, lies den Grund, starte einen neuen Run. Nach einem erreichten Limit: **Neu starten**. |

Der Reiter **Überblick** zeigt **Nächste Prüfung**, **Verbrauch** und **Fertig, wenn**; schläft ein Run, nennt **Wartet auf** den Grund. Was gerade läuft und auf wen es wartet, steht in der Statuszeile oben. Darunter stehen die Schritte des Plans mit ihrem Fortschritt.

Ein Run wartet in diesen Fällen auf dich:

- Er stellt eine Rückfrage oder braucht deine Freigabe für einen Schreibzugriff.
- Zwei Runden hintereinander brachten keinen echten Fortschritt. Als Fortschritt zählt, dass ein Schritt fertig wird, ein neuer Beleg oder ein neues Ergebnis dazukommt, ein gebundener Workflow oder Connector läuft, du schreibst oder antwortest oder der Run seine nächste Prüfung plant. Nur Notizen im Plan umzuschreiben zählt nicht.
- Du hast am Eingabefeld **Stoppen** gewählt, während eine Runde lief.
- Das monatliche KI-Budget ist erreicht, oder der Arbeitsbereich hat gerade keinen KI-Anbieter. In diesen beiden Fällen musst du im Run nichts tun: Er arbeitet von selbst weiter, sobald das Budget es wieder erlaubt oder ein Anbieter eingerichtet ist.

Ein Run schläft, wenn er sich selbst eine nächste Prüfung gesetzt hat, wenn der KI-Anbieter SubKit bremst oder solange die Aufgabe pausiert ist. Eine nächste Prüfung liegt höchstens 31 Tage voraus und nie hinter der Frist des Runs.

Zum Eingreifen öffnest du den Run im Reiter **Runs** und wählst **Unterhaltung öffnen**. Über der Unterhaltung steht eine Zeile: die Aufgabe, der Zustand, **Jetzt**, **Nächste Prüfung** und die Aktion **Abbrechen**. Schreib dort wie in jedem Chat.

Die Unterhaltung kennt zwei Arten anzuhalten. **Abbrechen** in der Zeile darüber beendet den Run endgültig. **Stoppen** am Eingabefeld unterbricht nur die laufende Runde: Der Run wartet dann auf dich und arbeitet weiter, wenn du ihm schreibst.

Schreibst du in einen Run hinein, gelten für dich dieselben Grenzen. Der Run bleibt, was du erlaubt hast: Er nutzt weiter nur, was gebunden ist, und er fragt weiter vor Schreibzugriffen, die keine Freigabe deckt. Deinen Run lesen und in ihn schreiben können nur du und Admins. Für alle anderen gibt es seine Unterhaltung nicht. Bittet ein Run darum, zurückgehaltene Schreibzugriffe freizugeben, kannst du als Besitzerin antworten oder ein Admin. Alle anderen sehen statt der Antwort-Schaltflächen einen Hinweis. Run-Unterhaltungen stehen nicht in der normalen Liste der Unterhaltungen. Du öffnest sie über die Aufgabe.

Eine offene Rückfrage hält den nächsten geplanten Start auf, weil der Run noch offen ist. Beantworte sie oder brich den Run ab.

### Das Ergebnis prüfen

Sind alle Schritte erledigt, lautet der Zustand **Ergebnis liegt vor**, und du bekommst einen Hinweis. Der Run fragt dich nicht selbst, ob das Ergebnis stimmt: Er übergibt es, indem er seine Runde beendet. Er schreibt dir in der Sprache, die du beim letzten Speichern der Aufgabe verwendet hast.

1. Wähle **Ergebnis prüfen**.
2. Lies, was der Run getan hat. Jeder Schritt zeigt seine Belege.
3. Wähle **Passt**, um zu bestätigen. Der Zustand wechselt zu **erledigt**.
4. Oder wähle **Nacharbeiten**. Der Run erfährt, dass das Ergebnis noch nicht reicht, und arbeitet weiter. Schreib in seine Unterhaltung, was fehlt. Dasselbe Ergebnis legt er dir nicht unverändert noch einmal vor.

Ein Ergebnis bestätigt oder verwirft nur ein Mensch, der im Browser im Cockpit angemeldet ist. Mit einem API-Schlüssel, in der Kommandozeile `subkit` oder aus einem KI-Client geht es nicht, und SubKit kann seine eigene Arbeit nicht bestätigen.

Ein Ergebnis, das du noch nicht bestätigt hast, hält den Zeitplan nicht auf. Der nächste Run einer täglichen Aufgabe startet morgen, auch wenn das Ergebnis von gestern noch offen ist. **Nacharbeiten** geht nur, solange kein neuerer Run offen ist und die Aufgabe seitdem weder geändert noch pausiert wurde.

### Pausieren, ändern und löschen

**Pausieren** hält eine Aufgabe an. Es startet kein Run, weder von Hand noch nach Zeitplan, und ein laufender Run schläft ein. **Fortsetzen** nimmt sie wieder auf, und ein Run, der die Pause verschlafen hat, arbeitet weiter. Die Dauererlaubnis bleibt, wie sie ist.

**Bearbeiten** ändert eine Aufgabe. Ein neuer Name, eine neue Beschreibung oder Kategorie ist unbedenklich. Jede andere Änderung beendet den offenen Run und die Dauererlaubnis, weil die Erlaubnis für die Aufgabe galt, wie sie war. Erlaube sie danach erneut.

**Löschen** archiviert eine Aufgabe. Der offene Run endet, und die Dauererlaubnis endet. Die bisherigen Runs und ihr Verlauf bleiben lesbar.

Wird eine Person aus dem Arbeitsbereich entfernt oder deaktiviert, werden ihre Aufgaben pausiert, ihre offenen Runs enden, und ihre Dauererlaubnisse enden. Die Aufgaben bleiben pausiert, bis jemand **Fortsetzen** wählt, auch wenn die Person wieder eingeladen wird. Eine Aufgabe mit Zeitplan braucht dann eine neue Dauererlaubnis.

### Aus einem bewährten Run einen Workflow machen

Ein Run kann keine Workflows schreiben. Das bleibt deine Entscheidung.

1. Öffne im Reiter **Runs** einen Run, der **erledigt** ist.
2. Wähle in seinem Menü **Als Workflow weiterführen**. Eine normale Unterhaltung öffnet sich, und die Bitte, einen Workflow mit denselben Schritten zu bauen, steht schon im Eingabefeld.
3. Sende die Bitte und arbeite den Entwurf mit SubKit durch.
4. Speichere den Entwurf und gib ihn frei, wie in „Dein erster Workflow“ beschrieben.

Binde den neuen Workflow dann an die Aufgabe, oder ersetze die Aufgabe durch einen Zeitplan am Workflow. Je mehr vom Weg in Workflows feststeht, desto weniger muss ein Run überlegen und fragen.

### Was Admins können

Eine Aufgabe gehört der Person, die sie angelegt hat. Personen mit der Rolle Admin können mit jeder Aufgabe alles tun: sie sehen, starten, pausieren und fortsetzen, ihre Runs abbrechen, ihre Rückfragen beantworten, ihre Ergebnisse bestätigen, sie ändern und löschen und die Dauererlaubnis erteilen oder widerrufen.

Dazu gehört auch, Schreibzugriffe freizugeben, die ein Run zurückhält: Ein Admin kann sie in der Run-Unterhaltung oder über den Freigabe-Link freigeben oder ablehnen. Der Audit-Trail nennt den Admin als die Person, die entschieden hat.

Ein Run arbeitet trotzdem mit den Rechten der Besitzerin, nicht mit denen des Admins, der eingegriffen hat. Schreibzugriffe, die ein Admin freigibt, werden mit dem ausgeführt, was der Run darf: mit den gebundenen Workflows und Connectors, der Umgebung der Aufgabe und den Rechten der Besitzerin. Stehen diese nicht mehr zur Verfügung, etwa weil die Besitzerin nicht mehr da ist oder die Aufgabe pausiert ist, wird die Freigabe abgelehnt und nichts geändert.

Admins sehen außerdem einen Hinweis, wenn eine Aufgabe pausiert ist, weil ihre Besitzerin nicht mehr da ist.

### Kosten

Jede Runde eines Runs ist ein oder mehrere KI-Aufrufe. Haben sie einen Preis, zählen sie zum monatlichen KI-Budget des Arbeitsbereichs. Ist das Budget erreicht, wartet ein Run. Er schlägt nicht fehl und arbeitet von selbst weiter, sobald das Budget es wieder erlaubt.

Auf der Seite **Nutzung** wählst du unter **Aufschlüsseln nach** den Eintrag **Aufgabe** und siehst Kosten und KI-Aufrufe je Aufgabe. Weil das die Aufgaben aller Personen umfasst, braucht es `stats:read:all`. Auf der Seite der Aufgabe zeigt die Kachel **Verbrauch** im Reiter **Überblick** den letzten Run und den laufenden Monat. Dafür brauchst du kein zusätzliches Recht.

Eines steckt nicht in den Zahlen einer Aufgabe: KI-Aufrufe in den Workflow-Runs, die die Aufgabe gestartet hat. Diese Schritte „KI fragen“ zählen beim Workflow. Wurde die Unterhaltung eines Runs gelöscht, lassen sich seine Aufrufe der Aufgabe nicht mehr zuordnen.

So hältst du die Kosten niedrig:

- Binde Workflows für die festen Teile. Ein Workflow-Schritt kostet keinen KI-Aufruf, außer er ist ein Schritt „KI fragen“.
- Lass den Run eine nächste Prüfung setzen, statt alle paar Minuten wieder nachzusehen.
- Halte die Zahl der Runden klein, wenn eine Aufgabe schnell gehen soll.

### Sehen, was passiert ist

- **An der Aufgabe:** Der Reiter **Runs** listet jeden Run mit seinem Zustand. Der Reiter **Verlauf** zeigt, wer was angelegt, geändert, pausiert, erlaubt und gestartet hat.
- **Im Run:** Die Unterhaltung zeigt jeden Schritt, jede Rückfrage und jede Antwort.
- **Im Audit-Trail:** Jeder Start, jedes Warten, jedes Ergebnis, jede Bestätigung und jeder Abbruch ist ein Eintrag. Einträge, die während eines Runs entstehen, sind als Aufgaben-Run gekennzeichnet. Sie nennen die Aufgabe und den Run, aber nie den Text des Ziels oder deine Antworten.
- **Hinweise:** In der **Übersicht** erscheint eine Aufgabe, wenn ein Run auf deine Antwort wartet, ein Ergebnis vorliegt, ein Run fehlgeschlagen ist oder die Dauererlaubnis fehlt oder bald endet. Sind Push-Nachrichten eingeschaltet, bekommst du zusätzlich einen neutralen Push.
- **Webhooks:** Die Ereignisse `task_run.started`, `task_run.waiting`, `task_run.result_ready`, `task_run.completed` und `task_run.failed` stehen für Abonnements bereit.

Der `subkit`-Eingang eines neuen Arbeitsbereichs erhält zusätzlich `task_run.waiting`, `task_run.result_ready` und `task_run.failed`. Ein Arbeitsbereich, den es schon gab, behält seine gespeicherte Eingangsregel. Damit die Aufgaben-Ereignisse dort ankommen, ergänze sie in dieser Regel mit `subkit notifications rules`.

### Was SubKit nicht erzwingt

- **Lesen reicht so weit wie deine Rolle.** Bindungen begrenzen, was ein Run starten und aufrufen darf, nicht, was er nachschlagen darf. Ein Run kann Workflows, Connector-Dokumentation und Wissen durchsuchen, die du lesen darfst.
- **Ein externer Browser-Dienst entscheidet selbst, welche Website er öffnet.** Steuert eine Aufgabe oder ein Workflow einen Browser über einen solchen Dienst, läuft der Seiten-Code dort, nicht in SubKit. SubKit prüft die Anfrage an den Dienst, nicht, welche Website der Browser danach besucht oder was er absendet. Binde einen solchen Connector nur an Aufgaben, bei denen das vertretbar ist.
- **Unterhaltungen bleiben erhalten.** Eine tägliche Aufgabe erzeugt jeden Tag eine Unterhaltung. Eine automatische Aufbewahrungsfrist gibt es für sie nicht.
- **Eine Grenze legt fest, wohin eine Anfrage geht und wie groß sie ist, nicht, was sie sagt.** Das gilt für die Workflows, die eine Aufgabe startet, wie in „Dein erster Workflow“ beschrieben.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| Die Aufgabe darf nicht alleine starten | Öffne die Aufgabe und wähle **Erlauben**. |
| Die Dauererlaubnis endete, nachdem du die Aufgabe bearbeitet hast | Das ist gewollt. Prüfe die Änderung und wähle erneut **Erlauben**. |
| **Starten** meldet, dass schon ein Run läuft | Öffne den Run. Beantworte ihn, warte auf ihn oder wähle **Abbrechen**, dann starte erneut. |
| Der geplante Start blieb aus | Lies die Zeile zum nächsten Start. **fällig, wartet auf Erlaubnis**: Wähle **Erlauben**. **wartet auf den laufenden Run**: Beantworte den offenen Run oder brich ihn ab. Sonst prüfe, ob die Aufgabe pausiert ist. |
| Der Run wartet und nennt das Budget | Das monatliche KI-Budget ist erreicht. Ein Administrator erhöht es unter **Einstellungen** › **Nutzung** oder macht diesen Monat weiter; sonst wartet der Run auf den nächsten Monat. Er arbeitet dann von selbst weiter. |
| Der Run wartet ohne Rückfrage | Er kam nicht voran, oder eine Runde wurde angehalten: Sag ihm, was fehlt. |
| Der Run endete am Rundenlimit oder an der Frist | Er lässt sich nicht fortsetzen. Wähle **Neu starten**. Reichen die Runden für die Aufgabe nicht, erhöhe sie beim Bearbeiten der Aufgabe. |
| „This workflow is not part of the task.“ | Binde den Workflow an die Aufgabe. Das beendet die Dauererlaubnis. Erlaube sie danach erneut. |
| Ein Zeitplan wird als zu häufig abgelehnt | Wähle Startzeiten, die mindestens 15 Minuten auseinanderliegen. |
| Jemand anderes hat die Aufgabe geändert, während du sie bearbeitet hast | Lade die Aufgabe neu und wiederhole deine Änderung. |
| **Nacharbeiten** wird abgelehnt | Ein neuerer Run ist offen, oder die Aufgabe wurde geändert oder ist pausiert. Starte stattdessen einen neuen Run. |
| Eine Rückfrage eines Runs zeigt einen Hinweis statt der Antwort-Schaltflächen | Die Rückfrage gibt Schreibzugriffe frei, die der Run zurückhält. Nur die Besitzerin der Aufgabe oder ein Admin kann sie beantworten. Bitte eine dieser Personen darum, oder brich den Run ab. |
| Die Freigabe eines Admins wird als nicht mehr verfügbar abgelehnt | Der Run kann die Rechte nicht mehr nutzen, mit denen die Schreibzugriffe vorbereitet wurden: Die Besitzerin ist nicht mehr verfügbar, die Aufgabe ist pausiert oder der Run ist beendet. Nichts wurde geändert. Brich den Run ab und starte einen neuen. |
| Das Ergebnis lässt sich nicht bestätigen, weil der Plan geändert wurde | Der Run gilt als fehlgeschlagen. Starte einen neuen Run. |

### Dasselbe im Terminal und aus KI-Clients

Mit der Kommandozeile `subkit`:

```bash
subkit tasks list
subkit tasks get <task-id>
subkit tasks create --file task.json
subkit tasks update <task-id> --cron "0 7 * * *" --timezone Europe/Berlin
subkit tasks run <task-id>
subkit tasks runs <task-id>
subkit tasks pause <task-id>
subkit tasks resume <task-id>
subkit tasks abort <run-id>
subkit tasks delete <task-id>
```

`subkit tasks update <task-id> --run-at <time>` legt einen einzelnen Start fest. Wartet ein Run auf einen Menschen, gibt `subkit` die Adresse der Aufgabe im Cockpit aus. Die Dauererlaubnis lässt sich in `subkit` nicht erteilen, und ein Ergebnis lässt sich dort weder bestätigen noch verwerfen. `subkit tasks get` zeigt, ob eine Dauererlaubnis gilt.

KI-Clients, die per MCP angebunden sind, können Aufgaben finden, lesen, starten und abbrechen. Anlegen und Ändern braucht die Stufe **Bearbeiten**. Rückfragen eines Runs beantwortest du im Cockpit, und dort bestätigst du auch Ergebnisse. Mehr dazu in „KI-Clients per MCP anbinden“.

Über die HTTP-API liegen dieselben Aktionen unter `/v1/tasks` und `/v1/task-runs`. Sie stehen in der API-Referenz deiner Engine unter `/openapi.json`.
