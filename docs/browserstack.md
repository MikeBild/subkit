# BrowserStack für SubKit

## Zweck und tatsächlicher Stand

BrowserStack ist als Ergänzung für browserübergreifende Funktionsprüfungen der
Website und des Cockpits vorgesehen. SubKit ist hier eine Webanwendung; die nativen
XCUITest-/Appium-/IPA-Wege der TE-Kit-Vorlage werden nicht übernommen.

Am 19.10.2026: keine BrowserStack-Werkzeuge in dieser Sitzung verfügbar; die
Plugin-Suche lieferte keinen BrowserStack-Treffer. Das beweist kein globales Fehlen
von BrowserStack oder einer lokalen Konfiguration. Konto, Tarif, Zugang, erlaubte
Browser und ein tatsächlicher Cloud-Lauf sind **UNVERIFIED**. Keine Integration
installiert, kein Zugangsschlüssel gelesen, kein Tarif gebucht, kein Tunnel und
keine kostenpflichtige Sitzung gestartet. Die TE-Kit-Ergebnisse sind keine
SubKit-Nachweise. [Strategie und Testkatalog](browserstack-teststrategie.md).

## Geeignete Produkte und Grenzen

| Produkt / Weg | Geplanter Zweck | Voraussetzung |
| --- | --- | --- |
| BrowserStack Live | Gezielte manuelle Desktop-/Mobile-Web-Prüfung, besonders Safari und Firefox | Konto, Berechtigung und tatsächlich verfügbare Browser prüfen |
| BrowserStack Local | Optionaler Zugang zu isoliertem localhost/Staging | Nur wenn nötig; beschränkte Testumgebung und eigener Tunnel-Lifecycle |
| BrowserStack MCP | Ergänzende Produkt-/Ergebnisabfragen und Diagnose, soweit lesend verfügbar | Offizielle Tooloberfläche und Authentifizierung prüfen; keine automatische SDK-Einrichtung |
| Automate | Später zu bewertende Option | Laut offizieller MCP-Dokumentation Automate-Lizenz nötig; keine zusätzliche Suite im aktuellen Auftrag |

Die [offizielle Automate-MCP-Dokumentation](https://www.browserstack.com/docs/browserstack-mcp-server/tools/automate)
beschreibt Einrichtung und Ausführung von Automate-Tests, nicht automatisch ein
zu browser-use kompatibles Live-Bedienverfahren. Dieses muss erst nachgewiesen
werden. Keine vermeintliche Unterstützung behaupten, weil ein MCP-Server existiert.

Die verbindliche Browserabnahme bleibt browser-use mit Codex oder Claude Code.
Ein durch den Nutzer bedienter BrowserStack-Live-Lauf kann ergänzende manuelle
Evidenz liefern. Fehlender Agentzugriff bleibt eine ausgewiesene Lücke und wird
nicht durch eine neue Playwright-/Selenium-/Appium-Suite umgangen. Keine Percy-
oder Screenshot-Matrix einführen. Visuelle Abnahme bleibt persönlich.

## Vor einer späteren Einrichtung

1. Bestehenden Zugang und lokale Konfiguration gezielt prüfen; keine zweite
   Registrierung oder globale Agentkonfiguration vorsorglich anlegen.
2. Offizielles BrowserStack-MCP-Angebot, Authentifizierung, Tarif, Limits und
   tatsächlich verfügbare Browser lesend bestätigen. Keine Trial-/Upgrade-Zusage
   aus öffentlichen Produktseiten ableiten.
3. Speicherung von URLs, Videos, Logs und Sessionartefakten prüfen. Nur isolierte
   Testkonten, synthetische Daten und kurzlebige eingeschränkte Zugänge verwenden;
   keine Kundeninhalte, Plattform-Providerkeys oder Produktionscredentials übertragen.
4. Browserbedienung gegen die verbindliche browser-use-Regel verifizieren. Bei
   inkompatibler Integration lokale Browserprüfung und ergänzende manuelle Live-
   Prüfung dokumentieren; keine erfolgreiche Cloud-Automation behaupten.
5. Kosten-/Zeitgrenze, Browserfall und Verantwortlichen vor dem Lauf festhalten;
   eigene Sitzungen/Tunnel anschließend zuverlässig schließen.

Secrets gehören ausschließlich in freigegebene lokale Secretablage oder Anbieter-
Credentials außerhalb des Repos; nie in versionierte MCP-Konfiguration, Prompts,
Logs oder Beispiele. Beispiele verwenden `<test-origin>` und `<run-id>`.
Keine TE-Kit-Credentialdatei, Projektkennung oder Installationspfade übernehmen.

## Späteres Betriebsrunbook

Noch nicht implementiert; keine ausführbaren SubKit-BrowserStack-Befehle vorhanden.
Nicht existierende Skripte oder erfolgreiche Installationen nicht dokumentieren.

Vor jedem Lauf: geprüften Produktcommit und tatsächliche Runtimeversion erfassen,
Account-/Browserverfügbarkeit prüfen, einen Katalogfall und die isolierte Umgebung
wählen. Staging nur bei Bedarf über [Local Testing](https://www.browserstack.com/docs/local-testing)
zugänglich machen; keinen allgemeinen Zugang zu internen Netzen eröffnen.

Während des Laufs: Schritte und sichtbare Sollzustände ausführen, Persistenz und
Berechtigungen wirklich prüfen. Echte Modellaufrufe als solche erfassen; simulierte
Antworten entsprechend kennzeichnen. Ein erfolgreicher Login ist kein Beweis eines
freigegebenen Workflow-Laufs oder vollständiger Mandantenisolation.

Danach: Anbieterstatus abholen, Resultat mit Grenzen dokumentieren, ausschließlich
eigene Fixtures bereinigen und eigene Sessions/Tunnel schließen. Fehlgeschlagene
und abgebrochene Läufe behalten ihren Status; keine Umdeutung durch spätere Wiederholung.
Belegformat und Auswahl stehen in der [Teststrategie](browserstack-teststrategie.md).

## Offizielle Quellen

- [MCP-Übersicht](https://www.browserstack.com/docs/browserstack-mcp-server/overview)
- [MCP-Produkte und Werkzeuge](https://www.browserstack.com/docs/browserstack-mcp-server/tools)
- [Automate-MCP und Lizenzvoraussetzung](https://www.browserstack.com/docs/browserstack-mcp-server/tools/automate)
- [Live für nicht öffentliche Testumgebungen](https://www.browserstack.com/docs/live/local-testing)
- [Local Testing](https://www.browserstack.com/docs/local-testing)

Produktdokumentation im Planungsabgleich am 19.10.2026 geprüft. Sie ersetzt keine
Accountprüfung. Keine BrowserStack-Kosten, Kapazitäten oder Ergebnisse zugesichert.
