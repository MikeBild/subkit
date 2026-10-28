---
slug: sandbox-data-tools
summary: Rechne, zerlege und prüfe Daten in JavaScript-Umformungen mit eingebauten Helfern.
section: operate
order: 10
audience: operator
---
## Sandbox-Datenwerkzeuge

In einem Umformungs-Schritt mit JavaScript rechnest, zerlegst und prüfst du Daten mit den eingebauten `sk`-Helfern. Du brauchst sie, wenn ein Workflow Beträge rechnet, CSV oder XML liest, Zeiten über Zeitzonen umrechnet oder Eingaben prüft. Danach weißt du, was jeder Helfer kann und wo seine Grenzen liegen.

Die Helfer laufen synchron und begrenzt in der Sandbox, der abgeschotteten Laufzeit des Schritts. Sie greifen nie auf Netzwerk, Dateisystem oder Zugangsdaten zu. Die Namensräume der Helfer sind unveränderlich. Promises und Zufallswerte ohne festen Startwert werden nicht unterstützt; für wiederholbare Werte nimmst du die Ausführungsuhr und `sk.uuid()`.

| Aufgabe | Helfer | Regeln |
| --- | --- | --- |
| Dezimalbeträge | `sk.money.add/sub/mul/div/round/compare` | Dezimalzeichenketten; `div` und `round` erfordern Skalierung und `down`, `halfUp`, `halfEven` oder `up`. Keine Währungsumrechnung. |
| CSV | `sk.csv.parse/stringify` | Explizite Trennzeichen-/Header-Optionen; der Export maskiert Tabellenkalkulationsformeln standardmäßig. Bis zu 10.000 Zeilen. |
| Datum | `sk.date.parse/format/add/startOf/convertZone` | Reine Datumswerte bleiben Daten. Lokale Zeitangaben erfordern eine IANA-Zone; mehrdeutige oder fehlende Sommerzeit-Zeiten erfordern ausdrücklich `earlier`/`later`. |
| Validierung | `sk.schema.validate/assert`, `sk.assert` | Nur lokale Schema-Verweise; keine Auflösung aus der Ferne und keine asynchronen Validatoren. |
| URLs | `sk.url.parse/build/query/encode/decode` | WHATWG-Parsing, wiederholte Query-Einträge, UTF-8-Prozentkodierung. Keine Anfragen. |
| XML | `sk.xml.parse/build` | Geordnete `{name, attributes, children}`-Bäume behalten gemischten Text; kein DTD und keine eigenen Entitäten. |
| Text und Datensätze | `sk.template.render`, `sk.diff.records` | Standardmäßig maskiertes HTML, expliziter Textmodus; begrenzte Listenabschnitte. Der Datensatzvergleich erfordert einen eindeutigen Schlüssel. |

```javascript
return {
  total: sk.money.add("19.90", "4.95"),
  csv: sk.csv.stringify([{ name: "Ada", amount: "24.85" }]),
  tomorrow: sk.date.add("2024-02-28", 1, "days"),
  greeting: sk.template.render("Hello {{name}}", { name: "Ada" })
};
```

### Grenzen und Betrieb

Text-Ein- und -Ausgaben sind auf 1 MiB begrenzt, Strukturen auf 100.000 Knoten und 64 Ebenen.
Die bestehenden Sandbox-Budgets für Speicher, Ausführung und Ausgabe gelten weiterhin. Jeder
Helfer ist eingebettet und wird in jeder Sandbox erst beim ersten Zugriff geladen.
Paketversionen und Zeitzonendaten sind je Release festgeschrieben. Dokumenten-Rendering, OCR
oder einen Browser bringen die Helfer nicht mit.

JavaScript-Umformungen, JSONata und Binär-Parsing laufen in begrenzten Worker-Prozessen. Die
Standardspur führt bis zu zwei Worker parallel aus; Hooks haben eine eigene Spur.
Je Engine-Prozess gelten globale Grenzen und Grenzen je Mandant (im Cockpit: Arbeitsbereich) für die Warteschlange, über beide
Spuren hinweg. Unter Linux gibt es einen RSS-Watchdog, der den Speicherverbrauch regelmäßig abfragt.
Er ist keine vom Kernel durchgesetzte Speicherobergrenze.
