# SubKit: Testkonzept und Cloud-Browser-Strategie

## Aufteilung und Freigabegrenzen

Diese Strategie spezifiziert was, wann, wie, wo und durch wen geprüft wird.
Sie startet keine Tests und richtet keine CI, Scheduler oder Anbietersitzungen ein.
[AGENTS](../AGENTS.md), [Roadmap](PRODUCT-ROADMAP.md), [operative Aufgaben](TODO.md)
und [BrowserStack-Voraussetzungen](browserstack.md) sind verbindlich.

| Prüfziel | Verfahren / Ort | Aussagegrenze |
| --- | --- | --- |
| Domainlogik, Isolation, Budgets, Auth, Audit | Bestehende automatisierte API-/Security-/Domain-/Vertragschecks, isoliertes PostgreSQL | Mock-/Fixture-PASS beweist keinen Cloud-Betrieb |
| Cockpit-/Website-Journey | browser-use mit Codex oder Claude Code gegen reale isolierte Dienste | Konfigurationsreadback oder API-PASS ersetzt keine Browseraktion |
| Weitere Browserengines und Mobile Web | Gezielte BrowserStack-Live-Prüfung nach Zugangsnachweis; ergänzend manuell | Keine vorhandene Integration oder unterstützte Automation voraussetzen |
| Tatsächlicher Modell-/Mail-/Kanalfluss | Dediziertes Testkonto, echter Provider und ausgewählter verbundener Kanal | Kosten und externe Wirkung begrenzen; Simulation getrennt ausweisen |
| Gestaltung | Konkreter Lovable-Entwurf bei gleicher Ansichtsgröße, persönliche Nutzerabnahme | Kein automatischer Pixelvergleich und kein Screenshot-Gate |
| Betrieb | Tatsächliche Testinstallation, Restore/Upgrade/Monitoring nach externem Runbook | /health allein beweist keine Wiederherstellung, Isolation oder Cloud-Öffnung |

Keine Playwright-Suiten, Screenshot-Testprogramme oder visuellen Matrizen erstellen,
wiederherstellen oder ausführen. Historische Lovable-Browser-Skripte vor Nutzung
prüfen; deren Existenz ist keine Ausnahme. BrowserStack ersetzt keine bestehenden
Release-Gates und ist ohne verbundenen Zugang kein verfügbarer Prüfnachweis.

## Browserauswahl und Ausführungsanlässe

Gezielte geplante Auswahl, kein heutiges Supportversprechen und keine bestätigte
Account-Geräteliste. Versionen bei Durchführung aus dem tatsächlichen Angebot
wählen und im Ergebnis festhalten; keinen Browser stillschweigend ersetzen.

| Rolle | Browser / Oberfläche | Anlass |
| --- | --- | --- |
| Basis | Chromium Desktop, Cockpit und Website | Nach relevanter Integration und am Cloud-Kandidaten |
| Abweichende Engine | Safari Desktop und Firefox Desktop | Auth-/Cookie-/Redirect-/SSE-/Upload-Änderungen und vor Öffnung |
| Mobile Web | Safari auf iPhone, Chrome auf Android | Registrierungs-/Onboarding-/Navigationseingriffe und vor Öffnung; nur vorgesehene responsive Zustände |
| Inhalt | DE und EN, Systemtheme, Tastatur | Geänderte Texte/Zustände, Erststart, Fehler und Rechtsseiten |

Kein kartesisches Produkt aller Browser, Bildschirmgrößen und Zustände prüfen.
Risikobezogen wählen; kritische Registrierung und Freigaben mindestens je gewählter
Engine am Kandidaten abdecken. Wenn ein notwendiger Zustand in Lovable fehlt,
Entwurf einholen, keine mobile Bedienung erfinden.

## Testkatalog

Alle nachfolgenden Cloud-Fälle sind **spezifiziert, nicht durch diesen Auftrag
ausgeführt**. Bestehende Teilnachweise anhand Quell-/Runtimeversion zuordnen,
nicht pauschal auf Cloud übertragen.

| Fall | Ausführung / Soll | Voraussetzung |
| --- | --- | --- |
| CB-01 Registrierung | Unverifizierte E-Mail abweisen; echte Bestätigung; wiederholter und konkurrierender Callback erzeugt genau einen eigenen Mandanten; bestehendes Konto sicher wiederfinden | C02/C03/C06; echte Mail für Live-Beleg |
| CB-02 Identität und Einladung | Fremder Tenant-Parameter, unpassender Issuer/Subject, ungültige/verbrauchte Einladung, abgelaufener Link und Wiederholungsversuch werden kontrolliert behandelt | C03; automatisierte Negativchecks plus reale Browserfortsetzung |
| CB-03 Isolation | Zwei Mandanten: Listen, Detail-IDs, Suche, Downloads, Objects, Credentials, Rollen, Konfiguration, HTTP/MCP/CLI und Chat erlauben keine fremden Daten oder Effekte | C02/C04; tatsächliche Testinstallation, keine alleinige Sichtprüfung |
| CB-04 Budget | Parallele direkte und Hintergrund-Modellaufrufe überschreiten weder Mandanten- noch Globalbudget; Fehler/Abbruch hinterlassen keine unbegrenzten oder doppelt abgerechneten Reservierungen | C02; deterministische Kostenchecks, begrenzter echter Providerlauf separat |
| CB-05 Last und Missbrauch | Drosselung, Speicher-/Uploadlimits, Inline-/Queue-Fairness; ein Mandant verdrängt andere nicht; SSRF-/Redirect-/DNS-Rebinding-Negativfälle | C04; kontrollierte API-/Security-Prüfungen, keine öffentliche Lastkampagne |
| CB-06 Erster Workflow | Registrieren → Konnektor verbinden → echte Assistentenantwort → prüfbare Wirkung → menschliche Freigabe → echter begrenzter Lauf → Audit/Protokoll; nach Reload erhalten | C01–C06; reale Browser- und Providerstrecke |
| CB-07 Freigabe | Wirkungserweiterung braucht erneute Freigabe; Widerruf verhindert weitere Effekte; Modellantwort oder Self-Service-Anmeldung ersetzt keine Zustimmung | Bestehende Approval-Checks plus Cloud-Einstieg |
| CB-08 Sperrung und Ablauf | Login, Keys, Token-Exchange, MCP, Inline-Chat, Hooks, Cron, Seeds und Dequeue beachten Status; bereits laufende Arbeit nach definierter Lifecycle-Regel behandeln | C02/C05; vor Implementierung festgelegte Abbruch-/Drain-Semantik |
| CB-09 Export und Löschung | Export vollständig und berechtigt; Löschung erfasst Daten, Objects, Secrets und Config; Sessions/Keys widerrufen; Audit-/Backup-Retention folgt bestätigter Regel | C05/C08; ausschließlich dedizierte Testkonten |
| CB-10 Intake | Sammeln/Kategorie ändern bleibt unbestätigt; null normale Suchtreffer; Review → Proposal → authentifizierter Browserhandoff → Bestätigung → genau eine Übernahme mit Provenienz | Clipper, CLI, MCP, HTTP, Cockpit, Google Chat; verbundene Kanäle live separat |
| CB-11 Intake-Negativfälle | Veralteter/edierter Vorschlag und fehlende Zielrechte abweisen; API-Key, MCP OAuth, Token-Exchange und Chat bestätigen nie selbst | Bestehende Domainchecks und Browserberechtigungen |
| CB-12 Agentbriefings | Codex und Claude Code entdecken bestätigte Quelle in beabsichtigter Domäne; rohe Clips bleiben ausgeschlossen; bounded Review-Reminder und nützliche nächste Aktion | Gemeinsamer Handler und echter Clientdispatch getrennt belegen |
| CB-13 Browser und Oberfläche | Login/Logout, Redirects, SSE-Antwort, Upload, Navigation, Persistenz, DE/EN, Fokus, Systemtheme, Mobilzustände und Fehlerpfade funktionieren | Konkreter Lovable-Entwurf; keine persönliche Sichtabnahme durch Agentbericht ersetzen |
| CB-14 Recht und Website | Cloud/Self-Hosting korrekt getrennt; Clipper-/Cloud-Datenflüsse erklärt; keine Analytics auf Clipper-Hinweisen; keine Registrierungszusage vor Öffnung | C08, Website-Aufgaben; echte Formularzustellung separat |
| CB-15 Recovery und Betrieb | Konsistentes DB-/Object-/Key-Backup isoliert wiederherstellen; Daten/Secrets/Laufzeit prüfen; Monitoring reagiert auf kontrollierte Störung | C07; private Betriebsumsetzung und definierte Wiederanlaufziele |

Discard/Restore, Kategorienauswahl und sichtbare Einzelreferenzen sind Teil von
CB-10. Quellen bleiben nachvollziehbar, normale Suche schließt unbestätigte Inhalte
aus. Menschliche Inhaltsbestätigung und Connector-Ausführungsfreigabe sind getrennte
Entscheidungen. Fehlende native Kanalaktionen benötigen eine funktionierende
Fortsetzung, keinen behaupteten Erfolg.

## Durchführung, Verantwortung und Belege

Ausführender Entwicklungsagent: fokussierte Domain-/API-/Vertragschecks und erlaubte
Browser-Journeys. Benannter Cloud-Operator je Serie: BrowserStack-Account,
Browserauswahl, Laufzeit-/Kostenlimit, Ergebnisabruf und Schließen eigener Sitzungen.
Nutzer: visuelle, rechtliche und Öffnungsentscheidungen. Betriebsverantwortlicher:
externe Installation, Restore und Incident-Nachweis. Keine automatische Delegation.

Vor einem Produkt-Release die vorhandenen Gates unverändert ausführen; vor Übergabe
einer geänderten lokalen Demo zusätzlich `bun run demo:local:verify` und die echten
Browser-/Providerwege. Für reine Dokumentänderungen Links, Aussagen, Aufgabenübernahme
und generierte Selbstbeschreibung gezielt prüfen; keine Runtime-Abnahme behaupten.

Pro Serie erfassen:

- Fall, Zeitpunkt, ausführende Rolle, geprüfter Quellcommit und tatsächliche
  Runtime-/Artefaktversion; dirty-Status und isolierte Umgebungsklasse.
- Browser, OS, Sprache/Theme und Ansicht; nur zum konkreten Entwurf passende Maße.
- Schritte, Assertions, Ergebnis PASS/FAIL/BLOCKED/UNVERIFIED, Dauer und Fehler.
- Simulation oder echter Provider/Kanal/Cloud-Browser; Nachweisumfang und Lücken.
- Erzeugte Fixture-IDs, exaktes Cleanup, geschlossene eigene Sitzungen/Tunnel.
  Sensible Rohbelege und Anbieterkennungen extern halten; bereinigte Aussage ins Repo.

Keine manuellen Nutzer-Inboxen mit synthetischen Daten befüllen, keine fremden
Fixtures löschen. BrowserStack-Videos/Logs können Eingaben enthalten: nur
synthetische Inhalte und dedizierte kurzlebige Testzugänge verwenden, Token nicht
in URLs, Reports oder Modellprompts. Retention vor Nutzung prüfen.

Ein Browserlauf mit simuliertem Backend ist kein Produktionsbeleg. Ein fehlender
Google-Chat-Lauf, echter Clientdispatch, Mailversand oder Safari-Zugang bleibt eine
explizite Lücke. Ein erneuter grüner Lauf löscht keinen historischen Fehlschlag.

## Gegenwärtige Evidenz

Dieser Dokumentationsauftrag hat keine BrowserStack-Sitzung, keinen Cloud-Signup,
keine neue Browser-Journey und keine echte Mail-/Modellprüfung durchgeführt.
Lovable-Projektmetadaten und SubKit-Wissen wurden lesend per MCP gegengeprüft;
historische Lovable-Tests bleiben zugeschriebene historische Ergebnisse.
Checkout und lokale Engineversion wurden getrennt ermittelt; Details in der
[Roadmap](PRODUCT-ROADMAP.md#quellen-bestand-und-aussagegrenzen). Aktuelle
Dokumentprüfungen stehen im [Launch-Status](../LAUNCH_STATUS.md#cloud-dokumentation-und-quellenabgleich).
