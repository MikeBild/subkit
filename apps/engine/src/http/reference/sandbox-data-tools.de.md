---
slug: sandbox-data-tools
summary: Welche sk-Helfer JavaScript-Transformationen nutzen können und wo ihre Grenzen liegen.
section: operate
order: 10
audience: operator
---
## Sandbox-Datenwerkzeuge

JavaScript-Workflow-Transformationen können begrenzte, synchrone `sk`-Helfer verwenden. Sie
führen keinen Netzwerk-, Dateisystem- oder Zugangsdatenzugriff aus. Namensräume sind unveränderlich.
Promises und nicht initialisierte Zufallswerte werden nicht unterstützt; verwende die
Ausführungsuhr und `sk.uuid()` für wiederholbare Werte.

| Aufgabe | Helfer | Vertrag |
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

Text-Ein- und -Ausgaben sind auf 1 MiB begrenzt, Strukturen auf 100.000 Knoten und 64 Ebenen.
Die bestehenden Sandbox-Budgets für Speicher, Ausführung und Ausgabe gelten weiterhin. Jeder
Helfer ist eingebettet und wird in jeder Sandbox beim ersten Zugriff geladen; generiere ihn
mit `bun run gen:sandbox-tools` neu und prüfe ihn mit `bun run check:sandbox-tools-drift`.
Paketversionen und Zeitzonendaten sind in der Lockfile festgeschrieben. Diese Werkzeuge fügen
weder Dokumenten-Rendering noch OCR noch einen Browser hinzu. JavaScript-Transformationen, JSONata
und Binär-Parsing nutzen begrenzte Worker-Prozesse. Die Standardspur kann zwei Worker parallel
ausführen; Hooks haben eine eigene Spur. Pro Engine-Prozess gelten globale und mandantenbezogene
Warteschlangengrenzen über Standard- und Hook-Worker hinweg. Der RSS-Watchdog ist unter Linux
verfügbar; er ist eine Polling-Grenze und keine vom Kernel durchgesetzte Speicherobergrenze.
