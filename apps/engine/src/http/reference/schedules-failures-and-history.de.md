---
slug: schedules-failures-and-history
title: Zeitpläne im Blick behalten
summary: Lies, warum ein geplanter Lauf gescheitert ist oder wartet, und bring ihn wieder zum Laufen.
section: work
order: 17
audience: public
---
## Zeitpläne im Blick behalten

Dieses Kapitel ist für alle, deren Workflows oder Aufgaben nach Zeitplan laufen.
Danach kannst du lesen, warum ein Lauf gescheitert ist, warum ein Zeitplan wartet oder pausiert wurde und was jeder fällige Termin ergeben hat.
Du weißt dann auch, wie du einen Zeitplan fortsetzt und eine Freigabe erneuerst, bevor sie endet.

### Was du brauchst

- Einen Workflow oder eine Aufgabe mit Zeitplan. Wie du ihn anlegst, steht in „Dein erster Workflow“ und in „Ein Ziel als Aufgabe übergeben“.
- Zum Lesen des Verlaufs: `execution:read` für Workflows, `task:read` für Aufgaben.
- Zum Fortsetzen eines Zeitplans: `workflow:write`.

### Lesen, warum ein Lauf gescheitert ist

Ein gescheiterter Lauf zeigt einen Hinweis mit drei Teilen: was passiert ist, eine empfohlene Handlung und die zugeklappten **Technischen Angaben**.

1. Öffne den Lauf über **Läufe** oder über die Liste **Braucht dich** in der **Übersicht**.
2. Lies die Ursache und wähle die empfohlene Handlung.

| Ursache | Empfohlene Handlung |
| --- | --- |
| **Anmeldung abgelehnt** | **Neu anmelden**: Verbinde den Konnektor neu. |
| **Freigabe passt nicht mehr**, **Vor dem Start abgelehnt** | **Freigabe prüfen**: Prüfe und erneuere die Freigabe. |
| **Zeitüberschreitung**, **Abgebrochen**, **Konnektor nicht verfügbar**, **Abrufgrenze des Anbieters erreicht**, **Nicht vollständig gelesen**, **Fehler im Fremdsystem** | **Erneut versuchen** |
| **Token-Budget erschöpft** | **Administrator fragen** |
| **Konnektor fehlt**, **Platzhalter nicht auflösbar**, **Antwort in unerwarteter Form**, **Nachricht fehlerhaft**, **Nicht eingeordnet** | **Im Chat beheben**: Der Chat öffnet sich mit der Frage nach Ursache und Lösung. |

Für vertrauliche Workflows (`execution_privacy: sensitive`) speichert SubKit keine Fehlerdetails. Seit dieser Version behält ein solcher Lauf trotzdem seine Ursache und einen festen Satz, der sagt, was zu tun ist. Beispiel: „The connected service rejected the sign-in. Reconnect the connector, then run again. Nothing was changed by this step.“ Erkennt SubKit keine Ursache, bleibt es bei „Sensitive execution failed.“ Diese Sätze schreibt die Engine auf Englisch. Das Cockpit sagt sie in deiner Sprache, wo es die Ursache, den Grund eines Anhaltens oder den Fehlercode kennt: in der Übersicht bei angehaltenen und scheiternden Workflows, bei einem abgelehnten erneuten Start und in Fehlerhinweisen. Das Beispiel oben liest du dort als „Der verbundene Dienst hat die Anmeldung abgelehnt. Verbinde den Konnektor neu und starte den Lauf noch einmal. Dieser Schritt hat nichts verändert.“ In den technischen Angaben eines Laufs, über die HTTP-API und in `sk` steht weiter der englische Satz der Engine. Auch SubKit Desktop benachrichtigt in deiner Sprache.

### Warum ein Zeitplan wartet

Ein gehaltener Zeitplan startet keinen Lauf, verliert aber nichts. Sobald du den Grund behebst, läuft er weiter. Der Grund steht am Workflow, in der **Übersicht** und im **Zeitplan-Verlauf**.

| Was du liest | Was du tust |
| --- | --- |
| „Angehalten: Für diese Version fehlt die Freigabe. Erteile sie, dann läuft der Zeitplan weiter.“ | Öffne den Workflow, prüfe ihn und erteile die Freigabe. |
| „Angehalten: Die Freigabe gilt nicht mehr. Erneuere sie, dann läuft der Zeitplan weiter.“ | Die Freigabe ist abgelaufen, aufgebraucht oder widerrufen. Erneuere sie. |
| „Angehalten: Dem Lauf fehlen Eingaben. Ergänze sie im Zeitplan.“ | Trage im Zeitplan die fehlende Eingabe ein. |
| „Angehalten: Der Aufgabe fehlt die Dauererlaubnis. Erteile sie, dann läuft der Zeitplan weiter.“ | Öffne die Aufgabe und wähle **Erlauben**. |
| „Angehalten: Die Dauererlaubnis ist abgelaufen. Erneuere sie, dann läuft der Zeitplan weiter.“ | Öffne die Aufgabe und wähle **Erlauben**. |

### Was nach wiederholten Fehlern passiert

Scheitert ein geplanter Workflow-Lauf mehrmals in Folge an derselben Ursache, bremst SubKit den Zeitplan und pausiert ihn dann.

| Fehler in Folge | Was SubKit tut |
| --- | --- |
| 1 und 2 | Nichts. Der nächste Termin läuft wie geplant. |
| 3 | Wartet 2 Minuten nach dem letzten Fehler, bevor der nächste Lauf startet. |
| 4 | Wartet 6 Minuten nach dem letzten Fehler. |
| 5 | Pausiert den Zeitplan. Kein Lauf startet mehr, bis du ihn fortsetzt. |

- Als Fehler zählt ein geplanter Lauf, der fehlgeschlagen ist oder seine Zeit überschritten hat. Ein Lauf von Hand zählt nicht.
- Ein erfolgreicher Lauf, ein gestoppter Lauf oder ein Fehler mit anderer Ursache beendet die Folge.
- Termine, die in eine Wartezeit fallen, stehen im Verlauf als „Übersprungen: Nach wiederholten Fehlern wartet der Zeitplan länger bis zum nächsten Versuch.“
- Die Pause meldet SubKit genau einmal: als Punkt „Nach wiederholten Fehlern pausiert“ unter **Braucht dich**, als Push und als Ereignis `schedule.auto_paused`.
- Das gilt für Zeitpläne von Workflows. Zeitpläne von Aufgaben werden nicht gebremst und nicht automatisch pausiert.

### Einen pausierten Zeitplan fortsetzen

1. Öffne den Workflow. Oben steht „‚…‘ wurde automatisch pausiert“ mit der Zahl der Läufe und dem Zeitpunkt, seit dem kein Lauf gestartet ist.
2. Behebe die Ursache. Liegt es an der Freigabe, bietet der Hinweis **Freigabe erneuern** an. Erneuere zuerst die Freigabe.
3. Wähle **Zeitplan fortsetzen**. Du liest „Zeitplan fortgesetzt“.

Nach dem Fortsetzen zählt SubKit die Fehler neu. Geändert wurde durch die Pause sonst nichts: Workflow, Freigabe und Zeitplan sind unverändert.

### Den Zeitplan-Verlauf lesen

Der Verlauf zeigt für jeden fälligen Termin, was daraus wurde.

1. Öffne den Workflow oder die Aufgabe und wähle den Reiter **Zeitplan**.
2. Lies unter **Zeitplan-Verlauf** die Einträge, die neuesten zuerst. **Ältere anzeigen** lädt weitere.
3. Wähle bei einem Eintrag **Lauf öffnen**, um den zugehörigen Lauf zu sehen.

| Eintrag | Bedeutung |
| --- | --- |
| „Pünktlich gelaufen.“ | Der Lauf ist zum Termin gestartet. |
| „Später gestartet als geplant, weil die Engine beschäftigt war oder nicht lief.“ | Der Lauf ist mehr als 5 Minuten nach dem Termin gestartet. |
| „Einmal für mehrere verpasste Termine gelaufen, statt jeden nachzuholen.“ | Aus mehreren verpassten Terminen wurde ein Lauf. |
| „Übersprungen: Am Wochenende läuft dieser Zeitplan nicht.“ | Der Zeitplan schließt Wochenenden aus. |
| „Übersprungen: Dieser Tag ist im Zeitplan ausgenommen.“ | Der Tag steht in den Ausnahmen des Zeitplans. |
| „Übersprungen: Der vorherige Lauf war noch nicht fertig.“ | Eine Aufgabe hat immer nur einen offenen Lauf. |
| „Nicht gestartet: Der Zeitplan hat sich selbst pausiert, weil sich derselbe Fehler wiederholt hat.“ | Setz den Zeitplan fort, wie oben beschrieben. |
| „Angehalten: …“ | Der Zeitplan wartet auf dich. Die Gründe stehen in „Warum ein Zeitplan wartet“. |

Gut zu wissen:

- Wiederholt sich derselbe Grund, fasst SubKit die Termine in einem Eintrag zusammen. „Steht für 12 Termine“ nennt die Zahl.
- Der Verlauf reicht 90 Tage zurück. Ältere Einträge löscht SubKit.
- Ein Zeitplan, der häufiger als einmal pro Minute läuft, schreibt für pünktliche Läufe keinen Eintrag.

### Eine Freigabe erneuern, bevor sie endet

Eine Freigabe eines Workflows und die Dauererlaubnis einer Aufgabe können ein Enddatum haben. SubKit kündigt das Ende in zwei Stufen an: Hinweis 7 Tage vorher in der Übersicht, mit Push auch auf deinen Geräten, und Benachrichtigung über Kanäle und Regeln 3 Tage vorher.

| Wann | Was passiert |
| --- | --- |
| 7 Tage vorher: Hinweis | Am Workflow oder an der Aufgabe erscheint ein Hinweis wie „Die Freigabe läuft in 5 Tagen ab“ mit **Erneuern**. Unter **Braucht dich** erscheint ein Punkt, und mit eingeschaltetem Push bekommst du den Hinweis auch auf deine Geräte. |
| 3 Tage vorher: Benachrichtigung | SubKit sendet einmal das Ereignis `workflow.approval_expiring` oder `task.grant_expiring` an Abonnements, Webhooks und den `sk`-Eingang. |
| Weniger als ein Zehntel der Läufe übrig | Bei einer Freigabe mit Laufgrenze erscheint der Punkt unter **Braucht dich** ebenfalls. |

1. Wähle **Erneuern** im Hinweis oder am Punkt unter **Braucht dich**.
2. Beim Workflow öffnet sich der Freigabe-Dialog, bei der Aufgabe der Dialog der Dauererlaubnis. Prüfe, was aufgelistet ist, und wähle die neue Gültigkeit.
3. Bestätige.

**Erneuern** verlängert nichts von selbst. Erst deine Bestätigung im Dialog erteilt die neue Freigabe.

Das Ereignis kommt nur, wenn das Ende etwas ändern würde: Der Workflow hat einen aktiven Zeitplan in dieser Umgebung oder im Echtbetrieb einen aktiven eingehenden Webhook, und keine länger laufende Freigabe deckt dieselbe Version. Bei einer Aufgabe muss ein Zeitplan oder ein noch offener einmaliger Start anstehen.

### Einen laufenden Lauf stoppen

1. Öffne den laufenden Lauf.
2. Wähle **Diesen Lauf stoppen** und bestätige mit **Lauf stoppen**.

Der Lauf endet sofort. Der Zeitplan bleibt aktiv. Schritte, die ein Fremdsystem schon erreicht haben, können ausgeführt sein.

### Grenzen

- **Die Schwellen sind fest.** Wartezeiten, die Pause nach fünf Fehlern, die 90 Tage des Verlaufs und die Fristen der Ankündigung lassen sich nicht einstellen.
- **Fehlende Eingaben pausieren nichts.** Ein Zeitplan, dem Eingaben fehlen, wird gehalten und meldet sich in der **Übersicht**, zählt aber nicht als Fehler.
- **Die Ursache der Pause ist bei vertraulichen Workflows grob.** Für sie zählt SubKit alle Fehler ohne erkannte Ursache als dieselbe Ursache.
- **Manche Gründe bei Aufgaben haben keinen eigenen Text.** Ist die Dauererlaubnis aufgebraucht, passt sie nicht mehr zur geänderten Aufgabe, fehlt die Besitzerin, fehlt der KI-Anbieter oder ist die Aufgabe pausiert, steht im Verlauf nur „Angehalten, bis du handelst.“ Den genauen Grund zeigt die Seite der Aufgabe.
- **Der `sk`-Eingang bestehender Arbeitsbereiche bekommt die neuen Ereignisse nicht von selbst.** Ergänze sie mit `sk notifications rules` in der gespeicherten Regel.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| „Der Zeitplan konnte nicht fortgesetzt werden und bleibt pausiert.“ | Prüfe, ob du `workflow:write` hast, und versuch es erneut. |
| Der Zeitplan pausiert kurz nach dem Fortsetzen wieder | Die Ursache besteht noch. Öffne den letzten Lauf, lies die Ursache und behebe sie zuerst. |
| „Der Zeitplan-Verlauf konnte nicht geladen werden“ | Wähle **Erneut versuchen**. |
| „Bisher war noch kein Termin fällig.“ | Der Zeitplan ist neu oder pausiert. Einträge entstehen erst, wenn ein Termin fällig war. |
| Der Reiter **Zeitplan** fehlt am Workflow | Dir fehlt `execution:read`. Bitte einen Administrator darum. |
| Ein Hinweis nennt die Ursache auf Englisch mit dem Vermerk „Wortlaut der Engine“ | Das Cockpit kennt diesen Code noch nicht und zeigt deshalb den Satz der Engine. Die Handlung daneben ist übersetzt. |

### Das Gleiche im Terminal und über die HTTP-API

Mit der Kommandozeile `sk`:

```bash
sk schedules list
sk schedules pause <schedule-id>
sk schedules resume <schedule-id>
```

`sk schedules resume` setzt auch einen automatisch pausierten Zeitplan fort und zählt die Fehler neu. Für den Verlauf gibt es keinen `sk`-Befehl.

| Route | Bewirkt |
| --- | --- |
| `GET /v1/workflows/{id}/schedule-occurrences` | Liest den Verlauf eines Workflows, neueste zuerst. Braucht `workflow:read`. |
| `GET /v1/tasks/{id}/schedule-occurrences` | Liest den Verlauf einer Aufgabe. Braucht `task:read`, und du musst die Aufgabe sehen dürfen. |
| `PUT /v1/schedules/{id}` mit `{"paused": false}` | Setzt einen Zeitplan fort. Braucht `workflow:write`. |
| `POST /v1/executions/{id}/cancel` | Stoppt einen laufenden Lauf. |

Die Felder der Antworten, die Ereignisse und die Gründe stehen in „Referenz: Desktop-App, Regeln, Zeitpläne und Fehlerberichte“.
