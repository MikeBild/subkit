---
slug: schedules-failures-and-history
title: Zeitpläne im Blick behalten
summary: Lies, warum ein geplanter Run gescheitert ist oder wartet, und bring ihn wieder zum Laufen.
section: work
order: 17
audience: public
---
## Zeitpläne im Blick behalten

Dieses Kapitel ist für alle, deren Workflows oder Aufgaben nach Zeitplan laufen.
Danach kannst du lesen, warum ein Run gescheitert ist, warum ein Zeitplan wartet oder pausiert wurde und was jeder fällige Termin ergeben hat.
Du weißt dann auch, wie du einen Zeitplan fortsetzt und eine Freigabe erneuerst, bevor sie endet.

### Was du brauchst

- Einen Workflow oder eine Aufgabe mit Zeitplan. Wie du ihn anlegst, steht in „Dein erster Workflow“ und in „Ein Ziel als Aufgabe übergeben“.
- Zum Lesen des Verlaufs: `execution:read` für Workflows, `task:read` für Aufgaben.
- Zum Fortsetzen eines Zeitplans: `workflow:write`.
- Zum Übernehmen einer vorgeschlagenen Korrektur: `workflow:write`.

### Lesen, warum ein Run gescheitert ist

Ein gescheiterter Run zeigt einen Hinweis mit drei Teilen: was passiert ist, eine empfohlene Handlung und die zugeklappten **Technischen Angaben**.

1. Öffne den Run über **Runs** oder über die Liste **Braucht dich** in der **Übersicht**.
2. Lies die Ursache und wähle die empfohlene Handlung.

| Ursache | Empfohlene Handlung |
| --- | --- |
| **Anmeldung abgelehnt** | **Neu anmelden**: Verbinde den Connector neu. |
| **Freigabe passt nicht mehr**, **Vor dem Start abgelehnt** | **Freigabe prüfen**: Prüfe und erneuere die Freigabe. |
| **Zeitüberschreitung**, **Abgebrochen**, **Connector nicht verfügbar**, **Abrufgrenze des Anbieters erreicht**, **Nicht vollständig gelesen**, **Fehler im Fremdsystem** | **Erneut versuchen** |
| **KI-Budget erreicht** | **Administrator fragen**: Eine Administratorin oder ein Administrator erhöht das Budget unter **Einstellungen** › **Budget** oder macht diesen Monat ohne Grenze weiter. |
| **Connector fehlt**, **Platzhalter nicht auflösbar**, **Antwort in unerwarteter Form**, **Nachricht fehlerhaft**, **Nicht eingeordnet** | **Im Chat beheben**: Der Chat öffnet sich mit der Frage nach Ursache und Lösung. |

Für vertrauliche Workflows (`execution_privacy: sensitive`) speichert SubKit keine Fehlerdetails. Seit dieser Version behält ein solcher Run trotzdem seine Ursache und einen festen Satz, der sagt, was zu tun ist. Beispiel: „The connected service rejected the sign-in. Reconnect the connector, then run again. Nothing was changed by this step.“ Erkennt SubKit keine Ursache, bleibt es bei „Sensitive execution failed.“ Diese Sätze schreibt die Engine auf Englisch. Das Cockpit sagt sie in deiner Sprache, wo es die Ursache, den Grund eines Anhaltens oder den Fehlercode kennt: in der Übersicht bei angehaltenen und scheiternden Workflows, bei einem abgelehnten erneuten Start und in Fehlerhinweisen. Das Beispiel oben liest du dort als „Der verbundene Dienst hat die Anmeldung abgelehnt. Verbinde den Connector neu und starte den Run noch einmal. Dieser Schritt hat nichts verändert.“ In den technischen Angaben eines Runs, über die HTTP-API und in `subkit` steht weiter der englische Satz der Engine. Auch SubKit Desktop benachrichtigt in deiner Sprache.

### Warum ein Zeitplan wartet

Ein gehaltener Zeitplan startet keinen Run, verliert aber nichts. Sobald du den Grund behebst, läuft er weiter. Der Grund steht am Workflow, in der **Übersicht** und im **Zeitplan-Verlauf**.

| Was du liest | Was du tust |
| --- | --- |
| „Angehalten: Für diese Version fehlt die Freigabe. Erteile sie, dann läuft der Zeitplan weiter.“ | Öffne den Workflow, prüfe ihn und erteile die Freigabe. |
| „Angehalten: Die Freigabe ist abgelaufen. Erneuere sie, dann läuft der Zeitplan weiter.“ | Erneuere die Freigabe. |
| „Angehalten: Die freigegebene Anzahl an Runs ist aufgebraucht. Erneuere die Freigabe, dann läuft der Zeitplan weiter.“ | Erneuere die Freigabe. |
| „Angehalten: Die Freigabe wurde widerrufen. Erteile sie erneut, dann läuft der Zeitplan weiter.“ | Prüfe den Workflow und gib ihn erneut frei. |
| „Angehalten: Der Workflow wurde seit der Freigabe geändert. Prüfe die neue Version und gib sie frei.“ | Öffne die neue Version, prüfe sie und gib sie frei. |
| „Angehalten: Dem Run fehlen Eingaben. Ergänze sie im Zeitplan.“ | Trage im Zeitplan die fehlende Eingabe ein. |
| „Angehalten: Der Aufgabe fehlt die Dauererlaubnis. Erteile sie, dann läuft der Zeitplan weiter.“ | Öffne die Aufgabe und wähle **Erlauben**. |
| „Angehalten: Die Dauererlaubnis ist abgelaufen. Erneuere sie, dann läuft der Zeitplan weiter.“ | Öffne die Aufgabe und wähle **Erlauben**. |

### Warum ein Workflow angehalten ist

Solange ein Workflow angehalten ist, warten seine automatischen Starts. Nichts startet automatisch, bis du den Grund behebst. In der **Übersicht** nennt der Punkt unter **Braucht dich** den Grund mit einem kurzen Kennzeichen und einem Satz.

| Kennzeichen | Was der Satz sagt | Was du tust |
| --- | --- | --- |
| **Umbau nötig vor der Freigabe** | Der Zeitplan lässt sich ohne Änderung am Workflow nicht freigeben. Kennt SubKit den Schritt, nennt der Satz ihn und die Ursache. | Ändere den genannten Schritt, etwa mit **Im Chat beheben**. Gib danach die neue Version frei. |
| **Freigabe abgelaufen** | Die Freigabe für seinen Zeitplan ist abgelaufen. | Erneuere die Freigabe. |
| **Freigegebene Runs aufgebraucht** | Die freigegebenen Runs seines Zeitplans sind aufgebraucht. | Erneuere die Freigabe. |
| **Freigabe widerrufen** | Die Freigabe für seinen Zeitplan wurde widerrufen. | Gib den Workflow erneut frei. |
| **Seit der Freigabe geändert** | Der Workflow wurde geändert, seit sein Zeitplan freigegeben wurde. | Prüfe die neue Version und gib sie frei. |
| **Eingabe fehlt** | Seinem Zeitplan fehlt eine Eingabe. | Ergänze die Eingabe im Zeitplan. |

Dieselben Gründe halten auch einen eingehenden Webhook an. Der Satz lautet dann zum Beispiel: „… ist angehalten: er nimmt keine Aufrufe vom Webhook ‚…‘ an, weil seine Freigabe abgelaufen ist“. Behebe den Grund auf dieselbe Weise.

### Was nach wiederholten Fehlern passiert

Scheitert ein geplanter Workflow-Run mehrmals in Folge an derselben Ursache, bremst SubKit den Zeitplan und pausiert ihn dann.

| Fehler in Folge | Was SubKit tut |
| --- | --- |
| 1 und 2 | Nichts. Der nächste Termin läuft wie geplant. |
| 3 | Wartet 2 Minuten nach dem letzten Fehler, bevor der nächste Run startet. |
| 4 | Wartet 6 Minuten nach dem letzten Fehler. |
| 5 | Pausiert den Zeitplan. Kein Run startet mehr, bis du ihn fortsetzt. |

- Als Fehler zählt ein geplanter Run, der fehlgeschlagen ist oder seine Zeit überschritten hat. Ein Run von Hand zählt nicht.
- Ein erfolgreicher Run, ein gestoppter Run oder ein Fehler mit anderer Ursache beendet die Folge.
- Termine, die in eine Wartezeit fallen, stehen im Verlauf als „Übersprungen: Nach wiederholten Fehlern wartet der Zeitplan länger bis zum nächsten Versuch.“
- Die Pause meldet SubKit genau einmal: als Punkt „Nach wiederholten Fehlern pausiert“ unter **Braucht dich**, als Push und als Ereignis `schedule.auto_paused`.
- Das gilt für Zeitpläne von Workflows. Zeitpläne von Aufgaben werden nicht gebremst und nicht automatisch pausiert.

### Einen pausierten Zeitplan fortsetzen

1. Öffne den Workflow. Oben steht „Zeitplan automatisch pausiert“ mit der Zahl der Fehlschläge und dem Datum, seit dem kein Run gestartet ist.
2. Behebe die Ursache. Liegt es an der Freigabe, bietet der Hinweis **Freigabe erneuern** an. Erneuere zuerst die Freigabe.
3. Wähle **Zeitplan fortsetzen**. Du liest „Zeitplan fortgesetzt“.

Nach dem Fortsetzen zählt SubKit die Fehler neu. Geändert wurde durch die Pause sonst nichts: Workflow, Freigabe und Zeitplan sind unverändert.

### Nur einen Teil einer vorgeschlagenen Korrektur übernehmen

Scheitert ein Workflow immer wieder, kann SubKit eine Korrektur vorschlagen. Du findest sie in der **Übersicht** unter **Braucht dich**. Eine Korrektur kann aus mehreren Änderungen bestehen. Du übernimmst nur die, die du willst.

1. Öffne die vorgeschlagene Korrektur in der **Übersicht**. Jede Änderung steht als ein Satz da, zum Beispiel „Ändert die Adresse von … auf ….“
2. Wähle die Änderungen ab, die du nicht willst. Abgewählte Änderungen bleiben weg. „2 von 3 ausgewählt“ zeigt deine Wahl.
3. Hast du eine Änderung abgewählt, wähle **Erst testen**. Der Test spielt den fehlgeschlagenen Schritt mit deiner Auswahl nach und schreibt nichts in andere Systeme. Nach einem erfolgreichen Test liest du „Der Test lief ohne Fehler. In andere Systeme wurde nichts geschrieben.“
4. Wähle **Übernehmen und speichern**. SubKit übernimmt die ausgewählten Änderungen in den Workflow.

Gut zu wissen:

- Sind alle Änderungen ausgewählt, übernimmst du ohne Test.
- Sobald du eine Änderung abwählst, lässt sich **Übernehmen und speichern** erst nach einem erfolgreichen Test genau dieser Auswahl wählen. Änderst du die Auswahl nach dem Test, teste erneut.
- Willst du die ganze Korrektur ablehnen, öffne das Menü neben den Buttons und wähle **Ablehnen**.
- Schlägt der Chat eine Änderung an einem Schritt vor, listet er die Änderungen genauso auf. Dort wählst du **Übernehmen** oder **Übernehmen und speichern**, ohne Test.

### Den Zeitplan-Verlauf lesen

Der Verlauf zeigt für jeden fälligen Termin, was daraus wurde.

1. Öffne den Workflow oder die Aufgabe und wähle den Reiter **Zeitplan**.
2. Lies unter **Zeitplan-Verlauf** die Einträge, die neuesten zuerst. **Ältere anzeigen** lädt weitere.
3. Wähle bei einem Eintrag **Run öffnen**, um den zugehörigen Run zu sehen.

| Eintrag | Bedeutung |
| --- | --- |
| „Pünktlich“ | Der Run ist zum Termin gestartet. |
| „Später gestartet als geplant, weil die Engine beschäftigt war oder nicht lief.“ | Der Run ist mehr als 5 Minuten nach dem Termin gestartet. |
| „Einmal für mehrere verpasste Termine gelaufen, statt jeden nachzuholen.“ | Aus mehreren verpassten Terminen wurde ein Run. |
| „Übersprungen: Am Wochenende läuft dieser Zeitplan nicht.“ | Der Zeitplan schließt Wochenenden aus. |
| „Übersprungen: Dieser Tag ist im Zeitplan ausgenommen.“ | Der Tag steht in den Ausnahmen des Zeitplans. |
| „Übersprungen: Der vorherige Run war noch nicht fertig.“ | Eine Aufgabe hat immer nur einen offenen Run. |
| „Nicht gestartet: Der Zeitplan wurde automatisch pausiert, weil sich derselbe Fehler wiederholt hat.“ | Setz den Zeitplan fort, wie oben beschrieben. |
| „Angehalten: …“ | Der Zeitplan wartet auf dich. Die Gründe stehen in „Warum ein Zeitplan wartet“. |

Gut zu wissen:

- Wiederholt sich derselbe Grund, fasst SubKit die Termine in einem Eintrag zusammen. „Steht für 12 Termine“ nennt die Zahl.
- Der Verlauf reicht 90 Tage zurück. Ältere Einträge löscht SubKit.
- Ein Zeitplan, der häufiger als einmal pro Minute läuft, schreibt für pünktliche Runs keinen Eintrag.

### Eine Freigabe erneuern, bevor sie endet

Eine Freigabe eines Workflows und die Dauererlaubnis einer Aufgabe können ein Enddatum haben. SubKit kündigt das Ende in zwei Stufen an: Hinweis 7 Tage vorher in der Übersicht, mit Push auch auf deinen Geräten, und Benachrichtigung über Kanäle und Regeln 3 Tage vorher.

| Wann | Was passiert |
| --- | --- |
| 7 Tage vorher: Hinweis | Am Workflow oder an der Aufgabe erscheint ein Hinweis wie „Die Freigabe läuft in 5 Tagen ab“ mit **Erneuern**. Unter **Braucht dich** erscheint ein Punkt, und mit eingeschaltetem Push bekommst du den Hinweis auch auf deine Geräte. |
| 3 Tage vorher: Benachrichtigung | SubKit sendet einmal das Ereignis `workflow.approval_expiring` oder `task.grant_expiring` an Abonnements, Webhooks und den `subkit`-Eingang. |
| Weniger als ein Zehntel der Runs übrig | Bei einer Freigabe mit Run-Grenze erscheint der Punkt unter **Braucht dich** ebenfalls. |

1. Wähle **Erneuern** im Hinweis oder am Punkt unter **Braucht dich**.
2. Beim Workflow öffnet sich der Freigabe-Dialog, bei der Aufgabe der Dialog der Dauererlaubnis. Prüfe, was aufgelistet ist, und wähle die neue Gültigkeit.
3. Bestätige.

**Erneuern** verlängert nichts von selbst. Erst deine Bestätigung im Dialog erteilt die neue Freigabe.

Das Ereignis kommt nur, wenn das Ende etwas ändern würde: Der Workflow hat einen aktiven Zeitplan in dieser Umgebung oder im Echtbetrieb einen aktiven eingehenden Webhook, und keine länger laufende Freigabe deckt dieselbe Version. Bei einer Aufgabe muss ein Zeitplan oder ein noch offener einmaliger Start anstehen.

### Einen laufenden Run stoppen

1. Öffne den laufenden Run.
2. Wähle **Diesen Run stoppen** und bestätige mit **Run stoppen**.

Der Run endet sofort. Der Zeitplan bleibt aktiv. Schritte, die ein Fremdsystem schon erreicht haben, können ausgeführt sein.

### Einen Run mit unklarem Ausgang klären

Manchmal stoppt SubKit, während ein Schritt gerade eine Änderung an ein anderes System sendet, etwa bei einem Neustart. Dann ist unklar, ob die Änderung angekommen ist. SubKit sendet eine solche Änderung nie von selbst erneut. Der Run bekommt den Status **Ausgang unklar** und wartet auf deine Antwort.

1. Öffne den Run, etwa über **Runs**. Dort steht „Unklar, ob die Änderung von Schritt ‚…‘ angekommen ist“.
2. Sieh im anderen System nach, ob die Änderung da ist. Prüfe zum Beispiel, ob die E-Mail verschickt wurde oder der Datensatz existiert.
3. Wähle die passende Antwort.

| Antwort | Was passiert |
| --- | --- |
| **Ist angekommen** | Der Schritt gilt als erledigt und wird nicht erneut gesendet. Du liest „Notiert. Der Run läuft nach diesem Schritt weiter.“ |
| **Ist nicht angekommen** | Der Run sendet diesen Schritt erneut. Du liest „Notiert. Der Run sendet diesen Schritt erneut.“ |

- Bis du antwortest, wird nichts erneut gesendet.
- Haben mehrere Schritte gesendet, antwortest du für jeden. Der Run läuft weiter, sobald jeder Schritt eine Antwort hat.
- Auch ein Probe-Run eines einzelnen Schritts kann so enden. Dann steht dort „Es ist unklar, ob dieser Schritt angekommen ist. Öffne den Run, um das zu klären.“

### Grenzen

- **Die Schwellen sind fest.** Wartezeiten, die Pause nach fünf Fehlern, die 90 Tage des Verlaufs und die Fristen der Ankündigung lassen sich nicht einstellen.
- **Fehlende Eingaben pausieren nichts.** Ein Zeitplan, dem Eingaben fehlen, wird gehalten und meldet sich in der **Übersicht**, zählt aber nicht als Fehler.
- **Die Ursache der Pause ist bei vertraulichen Workflows grob.** Für sie zählt SubKit alle Fehler ohne erkannte Ursache als dieselbe Ursache.
- **Manche Gründe bei Aufgaben haben keinen eigenen Text.** Ist die Dauererlaubnis aufgebraucht, passt sie nicht mehr zur geänderten Aufgabe, fehlt die Besitzerin, fehlt der KI-Anbieter oder ist die Aufgabe pausiert, steht im Verlauf nur „Angehalten, bis du handelst.“ Den genauen Grund zeigt die Seite der Aufgabe.
- **Der `subkit`-Eingang bestehender Arbeitsbereiche bekommt die neuen Ereignisse nicht von selbst.** Ergänze sie mit `subkit notifications rules` in der gespeicherten Regel.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Der Zeitplan konnte nicht fortgesetzt werden und bleibt pausiert.“ | Prüfe, ob du `workflow:write` hast, und versuch es erneut. |
| Der Zeitplan pausiert kurz nach dem Fortsetzen wieder | Die Ursache besteht noch. Öffne den letzten Run, lies die Ursache und behebe sie zuerst. |
| „Der Zeitplan-Verlauf konnte nicht geladen werden“ | Wähle **Erneut versuchen**. |
| „Bisher war noch kein Termin fällig.“ | Der Zeitplan ist neu oder pausiert. Einträge entstehen erst, wenn ein Termin fällig war. |
| Der Reiter **Zeitplan** fehlt am Workflow | Dir fehlt `execution:read`. Bitte einen Administrator darum. |
| Ein Hinweis nennt die Ursache auf Englisch mit dem Vermerk „Wortlaut der Engine“ | Das Cockpit kennt diesen Code noch nicht und zeigt deshalb den Satz der Engine. Die Handlung daneben ist übersetzt. |
| „Deine Antwort ließ sich nicht speichern. Versuch es noch einmal.“ | Wähle die Antwort erneut. |
| „Du darfst diesen Workflow nicht starten und kannst das deshalb nicht beantworten.“ | Bitte eine Administratorin oder einen Administrator um das Recht, oder bitte jemanden, der den Workflow starten darf, um die Antwort. |
| „Dieser Run wurde beim Senden einer Änderung unterbrochen. Der Schritt ist noch nicht bekannt.“ | Antworte im Terminal. `subkit executions steps <run-id>` zeigt den Schritt-Schlüssel. |
| „Teste diese Auswahl zuerst.“ | Wähle **Erst testen** oder wähle wieder alle Änderungen aus. |
| „Der Test hat diese Auswahl nicht bestätigt, deshalb lässt sie sich nicht übernehmen.“ | Triff eine andere Auswahl oder übernimm die ganze Korrektur. |
| „Für diese Änderung gibt es keinen Test.“ | Übernimm die Korrektur als Ganzes oder lehne sie ab. |

### Das Gleiche im Terminal und über die HTTP-API

Mit der Kommandozeile `subkit`:

```bash
subkit schedules list
subkit schedules pause <schedule-id>
subkit schedules resume <schedule-id>
```

`subkit schedules resume` setzt auch einen automatisch pausierten Zeitplan fort und zählt die Fehler neu. Für den Verlauf gibt es keinen `subkit`-Befehl.

Einen Run mit unklarem Ausgang beantworten und einen Teil einer vorgeschlagenen Korrektur übernehmen:

```bash
subkit executions resolve-write <run-id> --step <step-key> --outcome arrived
subkit executions resolve-write <run-id> --step <step-key> --outcome not_arrived
subkit patch-candidates preview <candidate-id>
subkit patch-candidates dry-run <candidate-id> --accept 0,2
subkit patch-candidates approve <candidate-id> --review-digest <digest> --accept 0,2
```

`subkit` zeigt einen Run mit unklarem Ausgang als `uncertain (Outcome unknown)` und nennt die Schritte, die auf eine Antwort warten. `--accept` nimmt die Nummern der Änderungen, beginnend bei 0, in der Reihenfolge der Vorschau. Für einen Teil einer Korrektur nimmst du den `review_digest` aus dem Dry-Run genau dieser Auswahl. Ohne `--accept` übernimmst du die ganze Korrektur, mit dem Digest aus `preview`.

| Route | Bewirkt |
| --- | --- |
| `GET /v1/workflows/{id}/schedule-occurrences` | Liest den Verlauf eines Workflows, neueste zuerst. Braucht `workflow:read`. |
| `GET /v1/tasks/{id}/schedule-occurrences` | Liest den Verlauf einer Aufgabe. Braucht `task:read`, und du musst die Aufgabe sehen dürfen. |
| `PUT /v1/schedules/{id}` mit `{"paused": false}` | Setzt einen Zeitplan fort. Braucht `workflow:write`. |
| `POST /v1/executions/{id}/cancel` | Stoppt einen laufenden Run. Ein Run mit unklarem Ausgang endet als abgebrochen. |
| `POST /v1/executions/{id}/resolve-write` mit `{"step_key": "<step-key>", "outcome": "arrived"}` | Antwortet für einen Schritt eines Runs mit unklarem Ausgang: `arrived` oder `not_arrived`. Braucht `execution:abort`. Antwortet mit `409`, wenn der Run oder der Schritt auf keine Antwort wartet. |
| `POST /v1/patch-candidates/{id}/dry-run` mit `{"accepted_operations": [0, 2]}` | Testet die ausgewählten Änderungen einer Korrektur, ohne den Workflow zu ändern. Braucht `workflow:read`. |
| `POST /v1/patch-candidates/{id}/approve` mit `expected_review_digest` und `accepted_operations` | Übernimmt die ausgewählten Änderungen. Braucht `workflow:write`. |

Die Felder der Antworten, die Ereignisse und die Gründe stehen in „Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte“.
