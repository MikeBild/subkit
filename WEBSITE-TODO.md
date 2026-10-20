# SubKit Website: Aufgaben und Session-Übergabe

## Einstieg für die nächste Session

Diese Datei vor weiterer Website-Arbeit lesen. Sie verlinkt Nutzerentscheidungen
und hält Umsetzungsstand und offene Website-Aufgaben fest; sie ist keine Release-Freigabe.
Die operativen W01–W04-Issues und Prioritäten stehen im
[SubKit Product Project](https://github.com/users/MikeBild/projects/4/views/5);
die [ID-Zuordnung](docs/roadmap-issues.json) verbindet Issues und Handoff.
Zusätzlich AGENTS.md, LAUNCH.md, LAUNCH_STATUS.md und LAUNCH_SYNC.md beachten.
Ältere Framer-Aufträge und widersprechende Schreibregeln sind durch das
verlinkte aktuelle Briefing ersetzt.

Die Website liegt in Mike’s Lovable. Ausschließlich die offizielle
Lovable-Integration für Designänderungen verwenden. Aktuellen Projektstand und
laufende Nachrichten zuerst prüfen, keine zweite Website anlegen.
Projektlinks, bestätigte Betreiber-/Domainangaben und die zuletzt bearbeiteten
Nachrichten stehen außerhalb des Repositorys in
`/Users/mikebild/Documents/SubKit-Lovable/WEBSITE-HANDOFF.md`.
Diese Angaben nicht erneut vom Nutzer erfragen.

Aktueller Formularauftrag: am 20.10.2026 veröffentlicht und auf dem öffentlichen
Host geprüft. Kontakt- und Beta-Anfragen senden je eine Betreiberbenachrichtigung
und eine lokalisierte Eingangsbestätigung über den bestehenden Gmail-Konnektor.
Die korrigierte dritte Workflowfassung wurde persönlich für Produktion und
30 Tage freigegeben. Der separat verwaltete signierte Eingang blieb nach
Aktivierung erhalten. Zwei Vorschau- und zwei öffentliche Anfragen liefen jeweils
mit sechs erfolgreichen Schritten; beide Bestätigungen wurden in den eigenen
Posteingängen geprüft. Eine identische wiederholte Anfrage erzeugte keinen
weiteren Lauf. Website-Annahme und tatsächlicher Mailnachweis sind getrennt belegt.

Die benannte Vorschau lieferte zunächst einen älteren Stand; zwei dort gespeicherte
Anfragen bleiben ohne Versandversuch im Zustand „nicht konfiguriert“. Die aktuelle
Projektvorschau und der veröffentlichte Host sind geprüft. Keine alten Anfragen
wiederholen oder löschen. Der ursprüngliche Schutz vor Wiederholung wurde nach
einer unerwünschten Änderung mit einer Folgemigration wiederhergestellt und direkt
im Annahmespeicher geprüft; vollständiger isolierter Migrations-Replay bestanden.
Analytics in App und Plattform ist ausgeschaltet. Die Veröffentlichung ist kein
Cloud-/Produkt-Beta-Go und kein Nachweis öffentlicher Installierbarkeit oder
Rechtsabnahme. Konkrete Versionen, Adressen und datierte Nachweise stehen in der
externen Übergabe.

## Maßgebliche Quellen

- [Produkt-/Website-Briefing](docs/lovable-website-briefing.md): verbindliche Texte,
  verworfene Formulierungen, Design, Sprachen, Theme und Analytics.
- [Lovable-Setup](docs/lovable-setup.md): Projektzugang, aktueller MCP-Abgleich und
  Prüfgrenzen; konkrete private Angaben verbleiben in der externen Übergabe.
- [Produktroadmap](docs/PRODUCT-ROADMAP.md) und [Produktaufgaben](docs/TODO.md):
  Cloud-Zielbild und technische Voraussetzungen. Diese Datei führt ausschließlich
  Website-Aufgaben; Launch-Aufgabenstatus bleiben in LAUNCH_STATUS.md.

Die Cloud-Beta ist geplant, noch nicht offen. Bestehende Anfrage- und
Self-Hosting-Einstiege erst nach nachgewiesener Cloud-Öffnung ändern.

## Umgesetzt und überprüft

- [x] Bevorzugte Hero-Gestaltung wiederhergestellt, beanstandete Texte ersetzt.
- [x] Abstände/Alignments und mobile Umbrüche durch Lovable geprüft/korrigiert.
- [x] Mobile Menü-CTA lesbar; Formularbestätigungen unter sticky Header sichtbar.
- [x] Bestätigte Betreiber-, Kontakt- und Ziel-Domainangaben übernommen.
- [x] DE/EN-Seiten und automatische Sprach-/Theme-Erkennung ohne Schalter.
- [x] Social-Bilder, Sprachmetadaten und vorbereitete Sitemap.
- [x] Consent und deaktivierte GA4-Vorbereitung, inklusive Widerruf.
- [x] Übersetzungsfragmente bei Inline-Auszeichnung korrigiert.
- [x] Unbekannte Links werden nicht mehr auf Startseite umgeschrieben.
- [x] Spät ladende Analytics-Scripts können nach Widerruf keine vorgemerkten
  Ereignisse mehr senden; Warteschlange wird verworfen.

Historischer Nachweis vor der Formularintegration: Lovable meldet erfolgreichen
Build und 41 fokussierte Tests.
Geprüft wurden acht vollständige englische Seiten, 16 direkte Sprachseiten,
275 Links/Anker, zwölf simulierte Formularzustände, Systemwechsel und Consent
einschließlich Reload, Cross-tab, Widerruf während Scriptladung und erneuter
Einwilligung. Browsernachweise stammen aus Chromium auf localhost.
Google-Scripts wurden lokal abgefangen, Formularantworten simuliert.
In diesem historischen Prüfumfang keine echten E-Mails, keine reale GA-Messung
und keine Veröffentlichung; aktueller Live-Nachweis siehe Einstieg.
Ausgewählte Codeänderungen wurden zusätzlich über die offizielle Integration
nachgelesen. Der damalige Umfang war kein eigener vollständiger Produktionsnachweis.

Im Lovable-Projekt enthalten RELEASE.md und VERIFICATION.md die Aktivierungsregeln,
Reproduktionsbefehle und offenen Prüfgrenzen. Diese vor neuen Tests lesen und
bestandene Ergebnisse wiederverwenden. Keine automatische visuelle Matrix erneut
starten; manuelle Sichtabnahme bleibt beim Nutzer. Safari/Firefox wurden noch
nicht nachgewiesen; öffentliche Hosting-Ausführung inzwischen gemäß Einstieg geprüft.

## Offene Aufgaben, priorisiert

### 1. Inhalt und echter Produkteinblick

- [ ] Verbliebene Textprobleme in DE und EN korrigieren: „Eure KI-Experimente
  werden prüfbar“, „Fremdcode nur im Käfig“, pauschale Vergleichsaussagen wie
  „Nicht vorgesehen“, „Alles, was du darfst“ und Abwertung wiederverwendbarer Skripte.
- [ ] Unbelegte Absolutheiten überprüfen/präzisieren: Test-Umgebung allein
  garantiere keinen Produktionszugriff; automatische Datenmaskierung;
  zuverlässige Erkennung jeder API-Änderung. Rechte, Konfiguration und tatsächlich
  ausgelieferten Funktionsumfang unterscheiden.
- [ ] Produktbild-Platzhalter durch freigegebene echte Aufnahmen mit isolierten
  Beispieldaten ersetzen. Keine privaten laufenden Installationen oder erfundenen
  Cockpit-Screenshots verwenden.
- [ ] Vorschlag, noch nicht umgesetzt/abgenommen: einen nachvollziehbaren
  Beispielworkflow zeigen — Aufgabe beschreiben → Konnektor erstellen → prüfen
  und freigeben → Lauf mit Protokoll. Bestehenden Hero erhalten.
- [ ] Vorschlag, noch nicht umgesetzt/abgenommen: Wiederholungen kürzen und kurze
  FAQ zu Kosten, Kenntnissen, Konnektoren, Berechtigungen und Fehlerbehandlung.
- [ ] Zentrales SubKit-Briefing/Schreibregeln an Nutzerkorrekturen angleichen.
  Eine Korrektur wurde als Lernvorschlag gesammelt, nicht als aktive Regel bestätigt.
  Wissens-/Skill-Übernahme nur über den vorgesehenen menschlichen Prüfprozess.

### 2. Einstiege vollständig funktionsfähig machen

- [x] Website-Endpunkte, dauerhafte Annahme, strikte Validierung, signierte
  SubKit-Übergabe und Schutz vor parallelem Mehrfachversand implementieren.
  Lovable meldet 150 Tests, Build/Typprüfung und isolierten Migrations-Replay
  bestanden; das ist noch kein Nachweis der produktiven Zustellung.
- [x] Vollständige inaktive Workflowfassung persönlich speichern, ihre beiden
  Gmail-Effekte prüfen und persönlich freigeben. Gemeinsamen Signaturschlüssel
  über den sicheren Lovable-Dialog provisionieren.
- [x] Allgemeine Engine-Korrektur ausgeliefert; Ersatz-Eingang über öffentliche
  Verwaltung angelegt, tatsächliche Kennung in Version 3 referenziert, persönlich
  freigegeben und Erhalt nach Aktivierung nachgewiesen. Website-Übergabe über
  unterstützte Settings-Ersetzung aktiviert; Signaturprüfung unverändert.

  Quellprüfung: zehn PostgreSQL-Regressionstests für die Bindung bestanden;
  sämtliche 2.176 Testdateien über den Gesamtlauf und dokumentierte Fortsetzungen
  geprüft. Ein Dokumentationslink im Generator und ein falscher MCP-Testmodus
  wurden korrigiert. Fehlender lokaler Abhängigkeitspatch über das gesperrte
  Lockfile nachinstalliert; auffällige Queue-/Scheduler-Fälle isoliert bestanden.
  KI-Verträge, kompilierte Programme und CLI-End-to-End bestanden. Nach Übernahme
  paralleler Root-/Konfigurationsänderungen weitere 37 Tests bestanden. Dies ist
  ausdrücklich kein Nachweis produktiver Gmail-Zustellung oder Veröffentlichung.
- [x] Echte Zustellung beider Mailarten in DE/EN über Vorschau und öffentlichen
  Host geprüft; vier erfolgreiche Läufe, acht Mails, eigene Empfangsadressen.
  Identische Wiederholung ohne weiteren Lauf. Fehler-/Signatur-/Rate-Limit-Verträge
  bleiben automatisierte Nachweise; kein Lasttest durch echten Massenversand.
- [x] Beta-Anfrage erklärt konkret, was nach Absenden passiert; keine erfundene
  Reaktionszeit, automatische Aufnahme oder Newsletter-Anmeldung.
- [ ] Öffentlich freigegebenes Self-Hosting-Paket mit exakter Version,
  Release-Compose, Prüfsumme und passenden Start-/Setup-Befehlen eintragen.
- [ ] Installation ohne privaten Zugang bis zum ersten erfolgreichen Workflow
  durchtesten. Neustart, Datenerhalt und Sicherung mit Release-Anleitung abstimmen.
- [ ] Dokumentation, Downloads, Release Notes, Quellcode und Supportziele wirklich
  öffentlich erreichbar machen/prüfen; keine Platzhalter oder erfundenen Links.

### 3. Veröffentlichung abschließen

- [ ] Tatsächliches Hosting, Versanddienst, Aufbewahrungsfristen und Datenflüsse
  klären; Datenschutzhinweise DE/EN vervollständigen und rechtlich prüfen lassen.
  Vorhandene Betreiberangaben allein sind keine vollständige Rechtsfreigabe.
- [x] Beauftragte Lovable-Subdomain veröffentlicht und öffentlich über HTTPS geprüft;
  keine zusätzliche eigene Domain oder DNS-Änderung vorgenommen.
- [ ] Finale manuelle Inhalts-/Sichtabnahme und gezielter Browser-/Tastaturcheck.
- [x] Produktions-SEO auf dem veröffentlichten Host geprüft: robots erlaubt,
  Sitemap mit 16 URLs, Canonical/hreflang, Sprach-/Rechtsseiten und echte 404.
  Vorschau bleibt durch die hostabhängige Indexierungsregel gesperrt.
- [ ] Echte Social-Linkvorschauen auf der öffentlichen Domain testen.
- [ ] GA-Kennung später ergänzen; kein Blocker für einen Start ohne Analytics.
  Enhanced Measurement/Google Signals/Werbefunktionen nach RELEASE.md deaktivieren;
  echte Messung und Einwilligung erst nach Freigabe mit dem realen Konto prüfen.
- [ ] Website-Publikation und Produkt-/Beta-Go getrennt behandeln. Öffentliche
  Pakete, Repository-Öffnung oder Engine-Deployment sind nicht durch Website-Arbeit
  automatisch autorisiert.

### 4. Cloud-Einstieg vorbereiten

- [ ] Neue Cloud-Zustände nach dem [Briefing](docs/lovable-website-briefing.md)
  gezielt durch Lovable entwerfen lassen; bestehenden Hero und Design erhalten.
- [ ] Self-Hosting und geplante kostenlose begrenzte Cloud-Beta in DE/EN klar
  unterscheiden; sofortigen Zugang erst nach dem Cloud-Go anbieten.
- [ ] Website- und Clipper-Datenschutz anhand der tatsächlichen Cloud-Datenflüsse
  ergänzen; Rechtsprüfung mit C08 in docs/TODO.md abstimmen.
- [ ] Historische Browser-Skripte in Lovable VERIFICATION.md vor weiterer Nutzung
  gegen die heutige browser-use-Regel prüfen und Übergabe korrigieren; keine
  Playwright-/Screenshot-Testprogramme wiederherstellen oder ausführen.

## Arbeitsstand der Übergabe

Die Session-Dokumentation wird auf ausdrücklichen Nutzerwunsch in main committed
und gepusht. Der zuerst gescheiterte Fast-forward-Abgleich ist aufgelöst: Der
patchgleiche lokale Release-Commit wurde beim Rebase auf origin/main übersprungen.
Neuere Remote-Produktnachweise sind erhalten; lokale Website-Nachweise wurden mit
separaten IDs ergänzt, statt neuere Launch-Ergebnisse zurückzusetzen.

Der Nutzer hat ausdrücklich angewiesen, die lokalen Push-Hooks für diesen
Dokumentationsabschluss zu überspringen. Kein Release-Tag, Engine-Deployment oder
Website-Publishing. Historische Sicherungs-Stashes bleiben als Sicherungen bestehen;
sie sind nicht automatisch erneut anzuwenden. Den tatsächlichen Push-/Arbeitsbaumstand
vor neuer Arbeit mit git status prüfen.


## Clipper-Store: bestätigter Session-Abschluss

- Der Nutzer hat SubKit Clipper im Chrome Web Store eingereicht. Die offizielle
  Status-API bestätigt `PENDING_REVIEW` für Version `9.15.2`. Das ist eine
  eingereichte, auf Google-Prüfung wartende Version, keine öffentliche Freigabe.
- Store-Beschreibung auf Englisch und Deutsch im gemeinsamen Feld gespeichert;
  Symbol, echter Screenshot und kleine Werbekachel hochgeladen. Zweck,
  Berechtigungsbegründungen, Angabe ohne Remote-Code und Datenarten gespeichert.
- Der Nutzer hat eine bestehende persönliche Datenschutzseite als Übergang
  freigegeben. Ihre deutsche Fassung ist erreichbar, die vorgeschlagene englische
  Fassung lieferte 404. Der geprüfte Inhalt beschreibt die Website, noch nicht
  die Clipper-Datenverarbeitung. Dies bleibt ein inhaltlicher Release-Punkt;
  ein erfolgreicher Einreichungsstatus bestätigt keine Datenschutzvollständigkeit.
- Lovable hat separate Seiten `/de/clipper-datenschutz`, `/en/clipper-privacy`
  und den automatischen Einstieg `/clipper-privacy` implementiert. Laut Lovable
  28 fokussierte Tests bestanden; keine Website-Analytics oder Formulare auf
  diesen Seiten. Inhalt und Hosting-Grenzen stehen im Lovable-Projekt in
  `CLIPPER-PRIVACY.md`, `RELEASE.md` und `VERIFICATION.md`.
- Stand 20.10.2026: Mit der ausdrücklich beauftragten Gesamtveröffentlichung sind
  beide Clipper-Datenschutzseiten öffentlich erreichbar (HTTP 200). Keine
  Analytics oder Formulare auf diesen Seiten. Store-Link und Googles
  Prüfentscheidung wurden in diesem Formularauftrag nicht geändert oder geprüft.
- Konkrete Projekt-/Store-Adressen, IDs, Auftrags- und Commitstand sowie die
  operative Übergabe liegen außerhalb des Repositorys in
  `/Users/mikebild/Documents/SubKit-Lovable/WEBSITE-HANDOFF.md` und
  `/Users/mikebild/Documents/SubKit-Lovable/Chrome-Web-Store/status.txt`.
- Kein erneutes Einreichen, Zurückziehen, Website-Publishing, DNS-Wechsel oder
  Engine-Deployment aus diesem Status ableiten. Kein öffentlicher Store-Erfolg
  behaupten, bevor er tatsächlich bestätigt ist.

### Validierungsgrenze beim Git-Abschluss

Alle zu diesem Zeitpunkt vorhandenen Änderungen auf main wurden auf ausdrücklichen
Nutzerwunsch mit `--no-verify` committed und gepusht, einschließlich vorhandener
Hook-Hinweis- und HTTP-400-Korrekturen. `git diff --check` bestand. Der gezielte
Test `apps/engine/src/http/tests/request-media-type.test.ts` brach beim Aufbau
der Testdatenbank während der Migrationen mit einem PostgreSQL-Verbindungsfehler
ab (0 bestandene Tests); die HTTP-Assertions wurden nicht verifiziert.
Vollständige Hooks und Release-Gate wurden nicht ausgeführt. Vor einem Release
diese Prüflücke schließen. Der separate Tenant-Authority-Worktree enthält
weiterhin uncommittete Entwicklungsarbeit und wurde weder gemergt noch entfernt.
