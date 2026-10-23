---
slug: usage-and-costs
title: Nutzung und Kosten im Blick
summary: Sieh, was KI-Aufrufe kosten und wofür, und pass Kontingent und Preise an.
section: work
order: 11
audience: public
---
## Nutzung und Kosten im Blick

Die Seite **Nutzung** zeigt, was KI-Aufrufe kosten und wofür.
Ein KI-Aufruf ist eine Anfrage von SubKit an ein KI-Modell. Jeder Aufruf kostet.
Ganz oben steht ein Satz, der den Zeitraum zusammenfasst, etwa „Diese Woche 84,20 $ für 1.240 KI-Aufrufe.“
Steigen die Kosten, nennt der Satz den größten Treiber.

### Was du brauchst

- Zum Ansehen: `stats:read`. Standardmäßig hat das nur die Rolle Admin.
- Für **Person** und **Unterhaltung** unter **Aufschlüsseln nach**: `stats:read:all`. Ohne dieses Recht siehst du diese Tabs nicht.
- Zum Ändern von Kontingent und Preisen: `settings:write`. Die Rolle Admin hat beide Rechte.

### Den Zeitraum wählen

Wähle oben rechts den **Zeitraum**: **24 Std**, **Diese Woche**, **Letzte Woche**, **Dieser Monat** oder **Letzter Monat**.
Wochen beginnen am Montag, und es gilt deine Zeitzone.
Alle Zahlen vergleichen den Zeitraum mit dem gleich langen Abschnitt davor.

So liest du den Trend:

- **↑ 18 %** oder **↓ 18 %**: mehr oder weniger als im Zeitraum davor.
- **≈ gleich**: weniger als 5 % Unterschied.
- **Neu**: im Zeitraum davor noch nicht genutzt.
- **–**: Für den Zeitraum davor fehlen Daten.

### Die vier Kacheln

- **Kosten**: geschätzte Kosten aller KI-Aufrufe im Zeitraum.
- **KI-Aufrufe**: wie oft SubKit ein KI-Modell gefragt hat. Gibt es Fehler, steht darunter etwa **3 fehlgeschlagen**. Ein Klick öffnet die Fehlgeschlagenen KI-Aufrufe.
- **Kontingent · Monat**: wie viel vom Monatskontingent verbraucht ist. Diese Kachel gilt immer für den laufenden Monat.
- **Gespart durch Cache**: was wiederverwendete Eingaben gegenüber dem vollen Preis gespart haben, etwa „40 % der Eingaben aus dem Cache“.

Unter dem Kontingent steht die Prognose. SubKit rechnet dafür den Verbrauch der letzten 7 Tage hoch:

- **Reicht bis Monatsende.**
- **Bis Monatsende etwa 94 %.** Das Kontingent wird knapp.
- **Aufgebraucht am 26.** Das Kontingent reicht nicht bis Monatsende.
- **Aufgebraucht. Chat, Erstellen und Korrekturen stehen still.**
- **Noch keine Prognose. Zu wenige Tage im Monat.** Das gilt für die ersten beiden Tage im Monat.

Fehlt für ein Modell ein Preis, steht vor den Kosten **mind.**
Der Betrag ist dann eine Untergrenze. Die echten Kosten sind höher.
Darunter steht, wie viele Aufrufe keinen Preis haben, etwa **Aufrufe ohne Preis: 12**.
Fehlen alle Preise, zeigt die Kachel **Kosten unbekannt**.

### Auffälligkeiten

Unter **Auffälligkeiten** steht, was sich deutlich verändert hat oder Geld kostet.
Jeder Hinweis hat eine passende Aktion:

| Hinweis | Aktion |
| --- | --- |
| Ein Workflow kostet je Lauf mindestens 1,5-mal so viel wie im Zeitraum davor. | **Kosten ansehen** |
| Für ein Modell ist kein Preis hinterlegt. | **Modell ansehen** |
| Für mehrere Modelle ist kein Preis hinterlegt. | **Modelle ansehen** |
| Das Monatskontingent ist voraussichtlich vor Monatsende aufgebraucht. | **Kontingent anpassen** |
| Eine Person verursacht mindestens die Hälfte der Kosten. | **Aufschlüsselung ansehen** |

Ist alles ruhig, steht dort „Nichts Auffälliges in diesem Zeitraum.“

### Kosten nach Herkunft

**Kosten nach Herkunft** zeigt die Kosten je Tag, bei **24 Std** je Stunde.
Die Balken sind nach Herkunft gestapelt:

- **Chat**: Antworten in Unterhaltungen.
- **Workflows entwerfen**: Workflows im Chat erstellen und korrigieren.
- **Zusammenfassungen**: Kurzfassungen von Läufen und Inhalten.
- **Prüfungen**: KI prüft Entwürfe und Ergebnisse.
- **Wissen & Dateien**: Quellen und Dateien lesen und beschreiben.
- **Workflow-Läufe**: Schritte „KI fragen“ in Läufen.
- **Sonstiges**: alles, was keiner Herkunft zuzuordnen ist.

Mit **Als Tabelle** siehst du dieselben Werte als Tabelle mit einer Spalte **Summe**. **Als Diagramm** schaltet zurück.
Klick auf eine Herkunft in der Liste darunter, um ihre Details zu öffnen.
Fehlen Preise, zeigt das Diagramm die Token-Menge statt der Kosten.

### Aufschlüsseln nach

Unter **Aufschlüsseln nach** wählst du **Workflow**, **Person**, **Modell** oder **Unterhaltung**.
Jede Zeile zeigt **Kosten**, **KI-Aufrufe**, **Anteil** und **Trend**.
Je nach Tab kommt eine Spalte dazu: **Läufe** bei Workflow, **Fehlerquote** bei Modell, **Zuletzt** bei Unterhaltung.

Die letzte Zeile sammelt, was keiner Zeile zuzuordnen ist:

- **Ohne Workflow (Chat, Entwerfen, Wissen …)**
- **Ohne Person (Zeitplan, Webhook)**
- **Weitere** bei Modellen
- **Ohne Unterhaltung (Läufe, Wissen, Prüfungen …)**

So ergeben alle Zeilen zusammen die Summe oben.

### Details öffnen

Klick auf eine Zeile, um ihre Details seitlich zu öffnen:

- **Workflow**: **Kosten je Lauf**, **KI-Aufrufe je Lauf**, **Teuerste Läufe** und **Genutzte Modelle**. Mit **Workflow öffnen** springst du zum Workflow.
- **Person**: **Woher die Nutzung kommt**, dazu ihre **Workflows** und **Unterhaltungen**.
- **Modell**: **Anteil aus Cache**, **Fehlerquote**, **Preis je 1 Mio. Token** und **Antwortzeit (typisch)**.
- **Unterhaltung**: Kosten und KI-Aufrufe. Mit **Unterhaltung öffnen** springst du in den Chat.
- **Herkunft**: unter **Größte Posten** die teuersten Workflows, Personen oder Modelle dieser Herkunft.

Lange Unterhaltungen werden teurer, weil jede Antwort den bisherigen Verlauf mitliest. Für ein neues Thema lohnt eine neue Unterhaltung.

**Fehlgeschlagene KI-Aufrufe** öffnest du über die Kachel **KI-Aufrufe**.
Fehlgeschlagene Aufrufe kosten trotzdem. Das Sheet nennt den Betrag.
Unter **Wo sie auftreten** siehst du Workflow oder Unterhaltung und den Grund:
**Fehler beim Anbieter**, **Eingabe zu groß** oder **Kontingent aufgebraucht**.

### Kontingent anpassen

Das Monatskontingent ist die Höchstmenge an Token je Monat.

1. Klick auf **Kontingent anpassen** in den Auffälligkeiten oder auf die Prognose in der Kachel.
   Ohne Kontingent wählst du **Kontingent setzen** in der Kachel.
2. Trag unter **Token pro Monat** einen Wert ein.
3. Speichere. Die Meldung **Kontingent gespeichert** bestätigt die Änderung.

Dafür brauchst du `settings:write`, standardmäßig also die Rolle Admin.
Ohne dieses Recht siehst du nur den Stand und „Frag eine Person mit Admin-Rolle.“

Was beim Verbrauch passiert:

- Ab 75 % erscheint ein Hinweis.
- Ab 100 % pausieren Chat, Erstellen und Korrekturen bis zum Monatsersten.
- Freigegebene Workflows laufen weiter.

Ohne Kontingent sind KI-Aufrufe unbegrenzt.

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
- Das **Kontingent** in Token, etwa „120.000 von 150.000 Token · 30.000 übrig“.
- Die **Preisquelle**: eingebaute Listenpreise je Modell oder die Preise in `tokens.prices`.
- Deine **Zeitzone** und die **Internen Abläufe je Herkunft**.
- Die **Abfrage**, mit der du dieselben Zahlen per CLI oder API holst.

### Dieselben Zahlen per CLI oder API

`sk stats llm` und `GET /v1/stats/llm` liefern dieselben Zahlen wie die Seite.
Jede Antwort enthält Token, Kosten und die Ersparnis durch den Cache.

```bash
sk stats llm --bucket day --from <from> --to <to> --group-by workflow
```

- `group_by` schlüsselt nach `model`, `flow`, `user`, `workflow`, `conversation` oder `execution` auf. Höchstens zwei Werte zugleich.
- `result=` filtert nach Ergebnis: `success`, `quota_exhausted`, `context_too_large` oder `error`.
- `workflow_id=` zeigt nur die Aufrufe eines Workflows.
- Aufschlüsselungen nach `user` oder `conversation` brauchen `stats:read:all`. Das gilt nicht, wenn `user_id` deine eigene Kennung ist.

### Wenn etwas nicht klappt

| Was du siehst | Was du tust |
| --- | --- |
| **Keine Rechte** statt der Seite | Bitte eine Person mit Admin-Rolle um `stats:read`. |
| **Person** und **Unterhaltung** fehlen | Dir fehlt `stats:read:all`. Bitte eine Person mit Admin-Rolle darum. |
| **mind.** vor den Kosten | Für manche Modelle fehlt ein Preis. Hinterleg ihn über **Preis hinterlegen**. |
| **Kosten unbekannt** | Für keines der genutzten Modelle ist ein Preis hinterlegt. Hinterleg die Preise. |
| „Frag eine Person mit Admin-Rolle.“ statt **Kontingent anpassen** | Dir fehlt `settings:write`. Bitte eine Person mit Admin-Rolle, das Kontingent zu ändern. |
| Chat, Erstellen und Korrekturen stehen still | Das Monatskontingent ist aufgebraucht. Erhöhe es oder warte bis zum Monatsersten. |
| „Das Kontingent war nicht lesbar …“ | Lad die Seite neu. Das sagt nichts darüber, ob ein Kontingent gesetzt ist. |
| „Keine KI-Aufrufe in diesem Zeitraum.“ | Wähle **Dieser Monat anzeigen** oder einen anderen Zeitraum. |
