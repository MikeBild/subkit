---
slug: usage-and-costs
title: Nutzung und Kosten im Blick
summary: Sieh, was KI-Aufrufe kosten, und lege KI-Budget und Preise fest.
section: work
order: 11
audience: public
---
## Nutzung und Kosten im Blick

Dieses Kapitel ist für alle, die wissen müssen, was die KI im Arbeitsbereich kostet, meist Teamleitung oder Admin. Danach kennst du die Kosten je Workflow, Person und Modell und weißt, wie das monatliche KI-Budget wirkt. Ein KI-Aufruf ist dabei eine Anfrage von SubKit an ein KI-Modell.

Alles steht auf der Seite **Nutzung**. Ganz oben fasst ein Satz den Zeitraum zusammen, etwa „Diese Woche 84,20 $ für 1.240 KI-Aufrufe.“ Steigen die Kosten, nennt der Satz den größten Treiber.

### Was du brauchst

- Zum Ansehen: `stats:read`. Standardmäßig hat das nur die Rolle Admin.
- Für **Person**, **Unterhaltung** und **Aufgabe** unter **Aufschlüsseln nach**: `stats:read:all`. Ohne dieses Recht siehst du diese Tabs nicht.
- Zum Ändern der Preise: `settings:write`. Zum Ändern des KI-Budgets: `identity:write`. Die Rolle Admin hat beide Rechte.

### Den Zeitraum wählen

Wähle oben rechts den **Zeitraum**: **24 Std**, **Diese Woche**, **Letzte Woche**, **Dieser Monat** oder **Letzter Monat**.
Wochen beginnen am Montag, und es gilt deine Zeitzone.
Alle Zahlen vergleichen den Zeitraum mit dem gleich langen Abschnitt davor.

Die **Übersicht** bietet dieselbe Auswahl. Dort folgt die Kachel **Nutzung** dem gewählten Zeitraum und zeigt die Kosten darin oder „Keine KI-Aufrufe im Zeitraum“. Darunter steht, wie viel des KI-Budgets ausgegeben ist, etwa „42 % des monatlichen KI-Budgets“. Für den schnellen Blick reicht diese Kachel, für die Gründe öffnest du **Nutzung**.

So liest du den Trend:

- **↑ 18 %** oder **↓ 18 %**: mehr oder weniger als im Zeitraum davor.
- **≈ gleich**: weniger als 5 % Unterschied.
- **Neu**: im Zeitraum davor noch nicht genutzt.
- **–**: Für den Zeitraum davor fehlen Daten.

### Die fünf Kacheln

- **Kosten**: geschätzte Kosten aller KI-Aufrufe im Zeitraum.
- **KI-Aufrufe**: wie oft SubKit ein KI-Modell gefragt hat. Gibt es Fehler, steht darunter etwa **3 fehlgeschlagen**. Ein Klick öffnet die Fehlgeschlagenen KI-Aufrufe.
- **KI-Budget · Monat**: wie viel vom monatlichen KI-Budget ausgegeben ist. Diese Kachel gilt immer für den laufenden Monat.
- **Gespart durch Cache**: was wiederverwendete Eingaben gegenüber dem vollen Preis gespart haben.
- **Aus dem Zwischenspeicher**: welcher Anteil der Eingabe wiederverwendet statt neu bezahlt wurde. Darunter zeigt **Zwischenspeicher je Ablauf** den Anteil je Herkunft. Höher ist günstiger und schneller. **Ohne Daten** heißt: Der Anbieter meldet für diese Herkunft keinen Zwischenspeicher.

Fehlt für ein Modell ein Preis, steht vor den Kosten **mind.**
Der Betrag ist dann eine Untergrenze. Die echten Kosten sind höher.
Darunter steht, wie viele Aufrufe keinen Preis haben, etwa **Aufrufe ohne Preis: 12**.
Fehlen alle Preise, zeigt die Kachel **Kosten unbekannt**.

### Bestätigungen

Unter **Bestätigungen** steht in einer Zeile, wie oft jemand im Zeitraum etwas bestätigen musste, zum Beispiel „0,35 je Gesprächsrunde · Median 0,5 je Run einer Aufgabe · 3 ohne Frage gelaufen“.

- **je Gesprächsrunde**: Bestätigungsfragen geteilt durch die Gesprächsrunden, die im Zeitraum begonnen haben.
- **Median je Run einer Aufgabe**: der mittlere Wert über alle Runs, die im Zeitraum gestartet sind. Ein Run ohne Frage zählt mit 0.
- **ohne Frage gelaufen**: Aufrufe, die gefragt hätten, aber durch eine Regel, deine eigenen Worte oder eine stehende Freigabe gedeckt waren.

**Je Werkzeug** klappt die Zahlen pro Werkzeug auf. Sinkt die Zahl je Gesprächsrunde nach einer neuen Regel oder Freigabe, wirkt sie. Steigt sie ohne Grund, lohnt ein Blick.

### Auffälligkeiten

Unter **Auffälligkeiten** steht, was sich deutlich verändert hat oder Geld kostet.
Jeder Hinweis hat eine passende Aktion:

| Hinweis | Aktion |
| --- | --- |
| Ein Workflow kostet je Run mindestens 1,5-mal so viel wie im Zeitraum davor. | **Kosten ansehen** |
| Für ein Modell ist kein Preis hinterlegt. | **Modell ansehen** |
| Für mehrere Modelle ist kein Preis hinterlegt. | **Modelle ansehen** |
| Eine Person verursacht mindestens die Hälfte der Kosten. | **Aufschlüsselung ansehen** |

Ist alles ruhig, steht dort „Nichts Auffälliges in diesem Zeitraum.“

### Kosten nach Herkunft

**Kosten nach Herkunft** zeigt die Kosten je Tag, bei **24 Std** je Stunde.
Die Balken sind nach Herkunft gestapelt:

- **Chat**: Antworten in Unterhaltungen.
- **Workflows entwerfen**: Workflows im Chat erstellen und korrigieren.
- **Zusammenfassungen**: Kurzfassungen von Runs und Inhalten.
- **Prüfungen**: KI prüft Entwürfe und Ergebnisse.
- **Wissen & Dateien**: Quellen und Dateien lesen und beschreiben.
- **Workflow-Runs**: Schritte „KI fragen“ in Runs.
- **Sonstiges**: alles, was keiner Herkunft zuzuordnen ist.

Mit **Als Tabelle** siehst du dieselben Werte als Tabelle mit einer Spalte **Summe**. **Als Diagramm** schaltet zurück.
Klick auf eine Herkunft in der Liste darunter, um ihre Details zu öffnen.
Fehlen Preise, zeigt das Diagramm die Token-Menge statt der Kosten.

### Aufschlüsseln nach

Unter **Aufschlüsseln nach** wählst du **Workflow**, **Person**, **Modell**, **Unterhaltung** oder **Aufgabe**.
Jede Zeile zeigt **Kosten**, **KI-Aufrufe**, **Anteil** und **Trend**.
Je nach Tab kommt eine Spalte dazu: **Runs** bei Workflow, **Fehlerquote** bei Modell, **Zuletzt** bei Unterhaltung.

Die letzte Zeile sammelt, was keiner Zeile zuzuordnen ist:

- **Ohne Workflow (Chat, Entwerfen, Wissen …)**
- **Ohne Person (automatisch)**: Zeitpläne, Webhooks und Hintergrundarbeit wie das Katalogisieren
- **Weitere** bei Modellen
- **Ohne Unterhaltung (Runs, Wissen, Prüfungen …)**

So ergeben alle Zeilen zusammen die Summe oben.

**Aufgabe** zeigt, was jede Aufgabe gekostet hat: die KI-Aufrufe ihrer Runs, auch die Runden, in denen du selbst in einen Run geschrieben hast. Zwei Dinge stehen nicht in der Zeile einer Aufgabe. KI-Aufrufe in den Workflow-Runs, die eine Aufgabe gestartet hat, zählen beim Workflow, unter **Workflow**. Und wurde die Unterhaltung eines Runs gelöscht, lassen sich seine Aufrufe der Aufgabe nicht mehr zuordnen. Wie du eine Aufgabe günstig hältst, steht im Kapitel „Ein Ziel als Aufgabe übergeben“.

### Details öffnen

Klick auf eine Zeile, um ihre Details seitlich zu öffnen:

- **Workflow**: **Kosten je Run**, **KI-Aufrufe je Run**, **Teuerste Runs** und **Genutzte Modelle**. Mit **Workflow öffnen** springst du zum Workflow.
- **Person**: **Woher die Nutzung kommt**, dazu ihre **Workflows** und **Unterhaltungen**.
- **Modell**: **Anteil aus Cache**, **Fehlerquote**, **Preis je 1 Mio. Token** und **Antwortzeit (typisch)**.
- **Unterhaltung**: Kosten, KI-Aufrufe und **Aus dem Cache**: der Anteil der Eingabe, den der KI-Anbieter wiederverwendet hat, darunter die wiederverwendeten Token. **Ohne Daten** heißt, dass der Anbieter für diese Unterhaltung keine Cache-Zahlen meldet. Mit **Unterhaltung öffnen** springst du in den Chat.
- **Herkunft**: unter **Größte Posten** die teuersten Workflows, Personen oder Modelle dieser Herkunft.

Lange Unterhaltungen werden teurer, weil jede Antwort den bisherigen Verlauf mitliest. Für ein neues Thema lohnt eine neue Unterhaltung.

**Fehlgeschlagene KI-Aufrufe** öffnest du über die Kachel **KI-Aufrufe**.
Fehlgeschlagene Aufrufe können trotzdem kosten. Das Sheet nennt den Betrag.
Unter **Wo sie auftreten** siehst du Workflow oder Unterhaltung und den Grund:
**Fehler beim Anbieter**, **Eingabe zu groß**, **API-Schlüssel abgelehnt** oder **KI-Budget erreicht**.
Lehnt der Anbieter den API-Schlüssel während eines Runs ab, bittet dich **Braucht dich**, den Schlüssel unter **Einstellungen** › **KI-Assistent** neu zu verbinden.

### Das KI-Budget

Jeder Arbeitsbereich hat genau eine Grenze für KI-Kosten: das monatliche KI-Budget in US-Dollar. Token werden weiter gezählt, aber nicht begrenzt. Ein neuer Arbeitsbereich beginnt mit 50 $ im Monat. Ein Arbeitsbereich, den es schon vor dem KI-Budget gab, beginnt ohne Grenze und bekommt einen Punkt unter **Braucht dich**: „Monatliches KI-Budget festlegen“. Der Monat richtet sich nach der Zeitzone deines Arbeitsbereichs.

Das Budget steht an einer Stelle: **Einstellungen** › **Budget**. Dort siehst du, was die Modellaufrufe dieses Monats gekostet haben, zum Beispiel „12,40 $ von 50 $“. Sehen kannst du es mit `stats:read`; Administratoren ändern es dort, alle anderen mit `stats:read` sehen es nur.

- Es zählen nur Aufrufe mit Preis. Ein lokales Modell oder ein Modell ohne Preis zählt nie zum KI-Budget.
- Diktieren zählt, wenn es den Schlüssel des Betreibers der Engine nutzt. Bevor SubKit den Transkriptionsdienst aufruft, hält es die Länge der Aufnahme zurück, oder fünf Minuten, wenn die Länge unbekannt ist. Danach bucht es die tatsächliche Länge. Den Betrag gibt es nur zurück, wenn der Dienst die Aufnahme sicher nicht verarbeitet hat, zum Beispiel weil er den Schlüssel oder die Datei abgelehnt hat; nach einer Zeitüberschreitung oder einem Serverfehler bleibt der Betrag gebucht, wird zur Prüfung markiert, und dieselbe Aufnahme antwortet mit `transcription_unsettled` (HTTP 409). Diktieren mit dem eigenen Schlüssel deines Arbeitsbereichs oder mit dem lokalen Sprachmodell zählt nie. Kann SubKit den Betrag nicht innerhalb von 10 Minuten abschließen, bleibt er gebucht und wird zur Prüfung markiert.
- Bei 80 % bekommst du einen Punkt unter **Braucht dich** und eine Benachrichtigung, einmal im Monat.
- Bei 100 % pausieren Chat, Aufgaben und Modellschritte in Workflows. Ein Run einer Aufgabe wartet und arbeitet von selbst weiter. Ein Workflow-Run wartet vor seinem Modellschritt, gibt seinen Worker frei und läuft von selbst weiter, sobald das Budget es wieder erlaubt: nach **Budget erhöhen**, nach **Diesen Monat weiter ohne Grenze** oder wenn der nächste Monat beginnt. Schritte, die schon gelaufen sind, laufen nicht noch einmal. Workflows ohne Modellschritt laufen weiter.
- Kostet eine Chat-Antwort oder ein Run einer Aufgabe mehr als 5 $, erscheint ein Hinweis, einmal je Run. Nichts hält an.

Was ein Administrator tun kann, wenn das Budget erreicht ist:

1. Öffne den Punkt unter **Braucht dich** oder **Einstellungen** › **Budget**.
2. Wähle **Budget erhöhen** und eine neue Grenze: 20 $, 50 $, 200 $ oder **Ohne Grenze**.
3. Oder wähle **Diesen Monat weiter ohne Grenze**. Der nächste Monat beginnt wieder mit der Grenze.

Für beides brauchst du `identity:write`, also die Rolle Administrator. Das gilt auch in gehosteten Arbeitsbereichen: Das KI-Budget entscheidet der Arbeitsbereich. Der Audit-Trail hält jede Änderung als „Monatliches KI-Budget geändert“ oder „KI-Arbeit läuft diesen Monat ohne Grenze weiter“ fest.

Rechnet der Arbeitsbereich Preise in einer anderen Währung als USD (`tokens.currency`), gibt es keinen Dollarbetrag, und das KI-Budget gilt nicht.

Für Entwicklerinnen und Entwickler: `GET /v1/workspace/spend-limit` (`stats:read`) liest den Monat, `PUT /v1/workspace/spend-limit` mit `{"limit_usd": 200}` setzt die Grenze (0 heißt: keine Grenze), `POST /v1/workspace/spend-limit/continue` macht diesen Monat weiter. Ein abgewiesener Modellaufruf antwortet mit dem Code `llm_spend_limit_reached` (HTTP 429). `POST /v1/speech/transcriptions` nimmt eine `client_request_id` je Aufnahme: Dieselbe ID noch einmal liefert den ersten Text und wird nur einmal gebucht; zahlt der Schlüssel des Betreibers, wird eine Anfrage ohne ID mit `client_request_id_required` (HTTP 400) abgewiesen, bevor etwas gebucht wird; läuft der erste Versuch noch, antwortet die Engine mit `transcription_in_progress` (HTTP 409); ein Provider-Konto ohne Kontingent antwortet mit `llm_provider_quota_exhausted`. Ein wartender Workflow-Run behält den Status `queued` und zeigt `waiting_reason: "budget"`; ein Modellschritt, der nicht warten kann, schlägt mit `llm_spend_limit_reached` fehl.

### Preis hinterlegen

Fehlt für ein Modell ein Preis, fehlen seine Aufrufe in den Kosten.

1. Öffne das Modell, etwa über **Modell ansehen** oder den Tab **Modell**.
2. Wähle **Preis hinterlegen**.
3. Trag **Eingabe je 1 Mio. Token** und **Ausgabe je 1 Mio. Token** ein und speichere.

Die Meldung **Preis gespeichert** bestätigt die Änderung. Danach rechnet die Seite mit dem neuen Preis.
Auch dafür brauchst du `settings:write`, standardmäßig also die Rolle Admin.
Der Preis gilt für deinen Arbeitsbereich. In den Einstellungen steht er unter `tokens.prices`.

### Exportieren

1. Wähle oben **Exportieren**.
2. Bestätige mit **Exportieren**.

Du bekommst eine CSV-Datei für den gewählten Zeitraum.
Die Datei hat eine Zeile je Tag, Herkunft und Modell, bei **24 Std** je Stunde.
Die Spalten sind Zeitpunkt, **Herkunft**, **Modell**, **KI-Aufrufe**, die vier Token-Arten, **Kosten** und **Währung**.

### Technische Angaben

Klappe **Technische Angaben** am Ende der Seite auf. Dort stehen:

- **Eingabe-Token**, **Ausgabe-Token**, **Aus Cache gelesen**, **In Cache geschrieben** und **Gesamt**.
- **Modelle ohne Preis** und die Zahl der Aufrufe ohne Preis.
- Das **KI-Budget**, etwa „12,40 $ von 50 $ · 37,60 $ übrig“.
- Die **Preisquelle**: eingebaute Listenpreise je Modell oder die Preise in `tokens.prices`.
- Deine **Zeitzone** und die **Internen Abläufe je Herkunft**.
- Die **Abfrage**, mit der du dieselben Zahlen per CLI oder API holst.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| **Keine Rechte** statt der Seite | Bitte eine Person mit Admin-Rolle um `stats:read`. |
| **Person**, **Unterhaltung** und **Aufgabe** fehlen | Dir fehlt `stats:read:all`. Bitte eine Person mit Admin-Rolle darum. |
| **mind.** vor den Kosten | Für manche Modelle fehlt ein Preis. Hinterleg ihn über **Preis hinterlegen**. |
| **Kosten unbekannt** | Für keines der genutzten Modelle ist ein Preis hinterlegt. Hinterleg die Preise. |
| Chat, Aufgaben und Modellschritte pausieren | Das KI-Budget ist erreicht. Ein Administrator erhöht es unter **Einstellungen** › **Budget** oder macht diesen Monat weiter. |
| „Keine KI-Aufrufe in diesem Zeitraum.“ | Wähle **Dieser Monat anzeigen** oder einen anderen Zeitraum. |
| Ein Workflow-Run schlägt mit `llm_spend_limit_reached` fehl | Sein Modellschritt liegt in einer Schleife, einem parallelen Block oder einem „für jeden“, wo ein Run nicht warten kann, ohne Schritte zu wiederholen. Erhöhe die Grenze oder mach diesen Monat unter **Einstellungen** › **Budget** weiter, dann starte den Workflow erneut. |
| Ein Workflow-Run bleibt **wartend** mit „Wartet auf Budget“ | Das KI-Budget ist erreicht. Erhöhe es oder mach diesen Monat weiter; der Run läuft dann von selbst weiter. |

### Dasselbe im Terminal

Dieselben Zahlen holst du mit `subkit stats llm` oder über die HTTP-API mit `GET /v1/stats/llm`. Jede Antwort enthält Token, Kosten und die Ersparnis durch den Cache. Wie du `subkit` einrichtest, steht im Kapitel „Die subkit-CLI auf deinem Rechner verwenden“.

```bash
subkit stats llm --bucket day --from <from> --to <to> --group-by workflow
```

- `group_by` schlüsselt nach `model`, `flow`, `user`, `workflow`, `conversation`, `execution` oder `task` auf. Höchstens zwei Werte zugleich.
- `result=` filtert nach Ergebnis: `success`, `quota_exhausted`, `context_too_large`, `key_rejected` oder `error`.
- `workflow_id=` zeigt nur die Aufrufe eines Workflows.
- Aufschlüsselungen nach `user`, `conversation` oder `task` brauchen `stats:read:all`. Das gilt nicht, wenn `user_id` deine eigene Kennung ist.
- Jede Gruppe und die Summe des Zeitraums enthalten `prompt_cache`: `reported_calls` (Aufrufe, deren Anbieter Cache-Zahlen gemeldet hat), `reported_prompt_tokens`, `reported_cache_read_tokens` und `hit_percent`, den Anteil der Eingabe aus dem Cache über diese Aufrufe. `hit_percent` ist `null`, wenn kein Aufruf Cache-Zahlen gemeldet hat. Mit `group_by=conversation` bekommst du den Anteil je Unterhaltung.

Jede Chat-Antwort meldet ihre eigenen Zahlen außerdem im Ereignis `completed` unter `usage`: `cache_read_tokens`, `cache_creation_tokens`, `cache_reported` und, wenn der Anbieter Cache-Zahlen gemeldet hat, `cache_read_pct`.
