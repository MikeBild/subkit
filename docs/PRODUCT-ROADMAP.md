# SubKit: Produktroadmap für Cloud-Self-Service

## Ziel und verbindlicher Rahmen

SubKit ergänzt das bestehende Self-Hosting um ein selbst bedienbares Cloud-Angebot:
registrieren → E-Mail bestätigen → eigenen isolierten Mandanten erhalten → Konnektor
verbinden → Workflow mit dem Assistenten erstellen → Wirkung prüfen und freigeben →
ausführen und den Lauf nachvollziehen. Die Engine bleibt die gemeinsame fachliche
Grundlage für Cockpit, CLI, MCP, HTTP, Clipper und unterstützte Chatkanäle.

Nutzerentscheidungen vom 19.10.2026:

- Zunächst eine **kostenlose begrenzte Cloud-Beta** mit Plattform-KI und hartem
  Budget; Bezahlangebot, Checkout und Rechnungswesen als spätere Ausbaustufe.
- Gemeinsame Engine und isolierter Mandant je neu registriertem Konto als
  Planungsbasis. Einladungen dürfen keine fremden Mandanten erschließen.
- Cloud ist ein zusätzlicher Deploymentpfad; Self-Hosting und dessen bestehender
  Release-/Deploymentweg bleiben erhalten. Private Betriebsumsetzung bleibt extern.
- TE-Kit-Dokumentstruktur übernehmen; BrowserStack ergänzend planen und passende
  MCPs zur Gegenprüfung nutzen. Bestehende Browser-/Designregeln bleiben verbindlich.
- Dieser Auftrag konsolidiert Dokumentation; keine Produktimplementierung,
  Veröffentlichung, Registrierungseröffnung oder Infrastrukturänderung.

Präzisierter Implementierungsauftrag im aktiven Hosted-Goal: globale Identität,
höchstens ein eigener Mandant und mehrere eingeladene Mitgliedschaften; kein Trial,
sieben Tage widerrufbare Löschung. Free gilt je UTC-Kalendermonat mit 5 USD
Modellbudget pro Tenant, 50 USD global und 10.000 metrierter Requests. Gemeinsam
50.000.000 logische Bytes für Dateien und gespeicherte Nutzerinhalte einschließlich
Historien; zusätzlich 1.000 aufbewahrte Datensätze je Ressourcentyp einschließlich
logisch gelöschter Einträge bis zur physischen Bereinigung. Auth-Aktionen werden per
Webhook zugestellt; die Ziel-URL folgt. Diese Entscheidungen sind keine Aussage
über produktiv konfigurierte oder vollständig abgenommene Cloud-Fähigkeiten.

Die früheren Aussagen „kein SaaS“ gelten nicht mehr als Produktziel. Die vorhandenen
Self-Hosting-Launch-Termine werden nicht auf Cloud übertragen. Cloud hat noch keinen
zugesagten Öffnungstermin. Das historische Gesamtgate ist keine SaaS-Abnahme.

Navigation: [operative Aufgaben](TODO.md) · [Website-Aufgaben](../WEBSITE-TODO.md) ·
[Lovable-Briefing](lovable-website-briefing.md) · [Teststrategie](browserstack-teststrategie.md) ·
[Self-Hosting-Launch](../LAUNCH.md) · [Launch-Status](../LAUNCH_STATUS.md).

## Quellen, Bestand und Aussagegrenzen

Bestandsaufnahme am 19.10.2026 auf main nach erfolgreichem Fast-forward-Abgleich;
Basis b5d8c6a5e, Checkoutversion 10.1.1. Die tatsächlich erreichbare lokale Engine
meldete über /health Version 9.15.2. Sie wurde nicht geändert und ist kein Nachweis
für den Checkout oder die geplante Cloud-Beta.

| Quelle | Belegter Inhalt | Einordnung / Auflösung |
| --- | --- | --- |
| Aktueller Nutzerauftrag und angenommener Plan | Zusätzliche kostenlose begrenzte Cloud-Beta, Dokumentstruktur, MCP-Abgleich | Maßgebliche neue Produktentscheidung; keine Deploymentfreigabe |
| Bisherige Root-TODO, nach docs/TODO.md übernommen | Acht technische Inkremente, offene Prüfungen, RLS-Ausbau | Bestehenden Detailumfang erhalten; Aufgaben sind noch keine implementierten Fähigkeiten |
| README, Engine-/Shared-Guides, Identitätsschema und OIDC-Code | Mandantenmodell, Operatortrennung, Authentifizierung, Workflows, Rechte, Audit, bestehende Limits | Grundlagen vorhanden; kein vollständiges Self-Service-Provisioning oder Abrechnungsmodell daraus ableiten |
| LAUNCH.md / LAUNCH_STATUS.md / LAUNCH_EVIDENCE.md | Vorhandene Self-Hosting-Launchplanung und begrenzte Nachweise | SaaS-Ausschluss als Zielentscheidung ersetzt; historische E-Nachweise erhalten |
| Offizieller Lovable-MCP | Existierendes Projekt bereit und unveröffentlicht; aktuelle Metadaten erneut gelesen | Keine neue Website anlegen; kein Live-Angebot |
| Lovable RELEASE.md / VERIFICATION.md / roadmap.md | DE/EN, automatische Sprache/Theme, separate Clipper-Hinweise, offene Live-/Rechtsnachweise | Am gleichen Projektcommit im Planungsabgleich gelesen; historische Tests nicht als neue Ausführung darstellen |
| SubKit Knowledge, domain:subkit | Bisherige Produktpositionierung und Self-Hosting-Erklärung | Kein hinreichender SaaS-Betriebsplan; neue Repositoryentscheidung hat Vorrang vor überholter Prosa |
| BrowserStack-Dokumentation und Plugin-Suche | Web-Testprodukte dokumentiert; keine BrowserStack-Werkzeuge in dieser Sitzung und kein Plugin-Treffer | Konto, Tarif, Kapazität und Live-Sitzung UNVERIFIED; kein globales Fehlen behaupten |
| TE-Kit-Planungsdokumente | Vorbild für Aufbau, Herkunft, Status, Testkatalog und Übergabe | Native iOS-Werkzeuge, Cloud-Läufe, Produktdaten und Freigaben nicht übertragen |

SubKit-Wissen wurde über eine kurze Domänensuche geprüft, nicht automatisch geändert.
Korrekturen an bestätigtem Wissen/Skills erfordern den bestehenden menschlichen
Übernahmeprozess. Gesammelte Learnings sind keine Produktentscheidungen.

## Ausbaustufen und Voraussetzungen

Diese Roadmap führt Zielbild und Abhängigkeiten; den operativen Status führen
[GitHub Issues](https://github.com/MikeBild/subkit/issues) und das
[SubKit Product Project](https://github.com/users/MikeBild/projects/4).
[docs/TODO.md](TODO.md) hält Hosted-Kriterien und Nachweise; L-Evidenz bleibt
in LAUNCH_STATUS.md. Die [ID-Zuordnung](roadmap-issues.json) verbindet beide Ebenen.

| Stufe | Fähigkeit / Ergebnis | Voraussetzung und Abnahme |
| --- | --- | --- |
| Betriebsgrundlage | Verlässliche DB-Verbindungen, bounded timeouts, getrennte Operatorrechte | C01; Operatortrennung vorhanden, aktuelle Runtime-/Kandidatenprüfung weiter offen |
| Identität und Mandant | Verifizierte Identität provisioniert genau einen eigenen Mandanten; sichere Wiederanmeldung und Einladungen | C02/C03; globale Identitätsbindung, konkurrierende Wiederholung ohne Duplikat, kein Beitritt über frei gewählte Parameter |
| Kostenkontrolle | Betreiber setzt Geldbudget und Modelle; jede direkte Modellnutzung reserviert atomar gegen Mandanten- und Gesamtlimit | C02; Reservierung, Abrechnung/Freigabe bei Fehlern und parallele Ausschöpfung nachweisen; Verbrauchsanzeige verständlich |
| Sichere öffentliche Nutzung | Faire Queues, PostgreSQL-Limits, Ressourcenquoten, gedrosselte Registrierung, SSRF-/Egress-Schutz | C04; zwei Mandanten, alle Eintrittspunkte und Hintergrundarbeit negativ prüfen; Chat-Arbeitsbereiche erst nach Eigentumsnachweis |
| Vollständiger Lebenszyklus | Sperrung, kontrollierte Wiederaufnahme, gegebenenfalls Ablauf, Export und Löschung | C05; Sitzungen, Keys, Jobs, Objects, Secrets, Konfiguration und Aufbewahrung berücksichtigen |
| Verlässlicher Einstieg | Auth-Mails, Konnektor, echte KI-Antwort, freigegebener erster Workflow und Protokoll | C06/C09; neuer dedizierter Testnutzer, reale Zustellung und reale Providerantwort; keine Modellplanung als Ausführungsfreigabe |
| Cloud-Betrieb und Öffnung | Isolierte Installation, Backups/Restore, Monitoring, Incident-Verfahren, Recht und geprüfte Oberfläche | C07/C08/C09; alle Öffnungskriterien erfüllt, externe Freigaben separat |
| Späteres Bezahlangebot | Tarif-/Verbrauchsmodell, Checkout, Rechnungen, Zahlungsfehler, Kündigung und Supportumfang | Nach Beta-Erkenntnissen eigener Auftrag; keine monetäre Preis- oder SLA-Zusage in dieser Phase |

### Erforderliche technische Erweiterungsbereiche

Das bestehende Tenant-Modell braucht Herkunft, Lebenszyklusstatus und eine zentrale
Provisionierungsoperation mit verifizierter globaler Identitätsbindung. Identitäts-
Callbacks, CLI-Login und Token-Exchange müssen diese Bindung nutzen; der Client
bestimmt keinen fremden Zielmandanten. Bestehende Daten brauchen eine sichere
Migration ohne automatische Einordnung als öffentlich registrierter Cloud-Mandant.

Budgetverwaltung und Reservierung müssen für alle Modellpfade gemeinsam gelten,
einschließlich Chat, Hilfsaufrufen, Workflow-KI und Hintergrundverarbeitung. Ein
vorhandenes Caller-Budget ist kein Nachweis vollständiger Plattformkostenkontrolle.
Mandanten können Plattformbudget, Modelle und Grenzwerte nicht selbst erhöhen.

Lebenszyklus und Quoten benötigen dieselbe Durchsetzung in HTTP, MCP, CLI, Browser,
Hooks, Schedules, Queue und Inline-Chat. Externe Auth-Ereignisse authentifizieren,
gegen Replay schützen und eindeutig zuordnen. Ein gesperrter Mandant darf nicht über
einen anderen Eintrittspunkt weiterarbeiten. RLS bleibt ein zu bewertender zusätzlicher
Schutz; bestehende Anwendungsfilter und Auditpflicht bleiben erforderlich.

Hier werden keine API-Routen oder Wire-Schemas erfunden. Vor Implementierung je
Inkrement Domainoperationen, Migration, öffentliche Verträge und generierte Clients
konkret festlegen. Clients bleiben dünn; keine direkte Fremddatenbankintegration.

### Öffnungskriterien

Offene Registrierung erst nach abgeschlossenem Gesamtpfad C01–C09:

- Verifizierte Anmeldung und idempotente Provisionierung; Tests gegen fremde
  Mandantenauswahl und unbeabsichtigtes Verknüpfen bestehender Konten.
- Nachgewiesene Isolation, Kostenobergrenzen, Quoten und Missbrauchsschutz auch
  bei Nebenläufigkeit, Wiederholungen, API-/MCP-Zugang und Hintergrundarbeit.
- Echter Einstieg vom neuen Konto bis zum ersten freigegebenen Workflow-Lauf;
  ehrliche Zustände bei Fehler, vollem Budget und Sperrung.
- Vollständiger Lebenszyklus, getesteter Export/Löschweg und isoliert getesteter
  Restore; Monitoring und verantwortliche Person für Störungen.
- Konkrete Lovable-Entwürfe funktional geprüft, menschliche Sicht-/Rechtsabnahmen,
  tatsächliche Datenverarbeitung erklärt und eigener Cloud-Go erteilt.

## Offene Entscheidungen vor Umsetzung oder Öffnung

| Entscheidung | Planungsbasis | Wann festzulegen |
| --- | --- | --- |
| Mitgliedschaften | Bestätigt: höchstens ein eigener Tenant, mehrere eingeladene Mitgliedschaften und sicherer Wechsel; kein impliziter Fremdbeitritt | Integrierte Browser-/CLI-/Cloud-Abnahme vor Öffnung |
| KI-Budget und Quoten | Bestätigt: 5 USD/Tenant, 50 USD global, UTC-Kalendermonat; 10.000 metrierte Requests, gemeinsam 50 MB und 1.000 Datensätze je Typ | Modellfreigabe und echte Betriebs-/Parallelitätsabnahme vor Öffnung |
| Kapazität | Zunächst eine Replik als konservative Betriebsbasis | Vor C07: gemessene Kapazität; mehrere Repliken erst mit gemeinsam wirksamen Limits |
| Beta-Laufzeit | Kein Trial, kein zugesagtes Enddatum; bestätigt sieben Tage widerrufbare Löschung | Wiederaufnahme, Quotenerschöpfung und Löschweg integriert abnehmen |
| Aufbewahrung | Keine erfundenen Fristen | Vor C05/C08: aktive Daten, Auditmetadaten, alte Config-Revisions, Backups und Löschung eingeladener Mitglieder |
| Betriebsanbieter und Region | Private Umsetzung außerhalb dieses Repos | Vor C07/C08: Datenflüsse, Region, Unterauftragnehmer, Wiederanlauf-/Datenverlustziele und Incident-Verantwortung |
| Recht und Support | Menschliche Prüfung und realistische Zuständigkeiten | Vor Öffnung: Pflichttexte, Vereinbarungen, Ansprechpartner und Abnahmeverantwortliche |
| BrowserStack | Ergänzung zur bestehenden Browserprüfung | Vor Nutzung: Konto, Tarif, Browserverfügbarkeit, Datenschutz und kompatibles Bedienverfahren |
| Lokale Release-Images | Bestehende Artefakte erhalten | Vor gezielter Bereinigung entscheiden; keine automatische Löschung |

## Pflege und Übergabe

README beschreibt verfügbare Fähigkeiten und kennzeichnet Cloud als geplant.
Produkt-/Designprosa gehört ins Lovable-Briefing; operative Website-Aufgaben bleiben
in WEBSITE-TODO. Technische Referenzen und llms-Assets entstehen weiter aus README
und Code; diese Planungsdokumente sind kein zweiter API-Referenzbaum.

Neue Ergebnisse mit Quelle, Zeitpunkt, Quell-/Runtimeversion, Verfahren, Resultat,
Nachweisgrenze und Cleanup erfassen. Lokale Simulation, echter Provider, echter
Cloud-Browser und veröffentlichter Betrieb sind getrennte Belegklassen.
