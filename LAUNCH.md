# SubKit Public Launch

Planfreigabe: Der Nutzer hat diesen Plan am 17.10.2026 zur Umsetzung der
Planungs- und Synchronisationsdateien angenommen. Dies ist keine Freigabe für
Produktänderungen, Commit, Push, Repository-Öffnung, globale Agent-Konfiguration,
Release, Deployment oder Store-Einreichung. Aktueller Nachweisstand:
[LAUNCH_STATUS.md](LAUNCH_STATUS.md). Arbeitsvertrag: [LAUNCH_SYNC.md](LAUNCH_SYNC.md).
Die bestehenden Regeln in [AGENTS.md](AGENTS.md) bleiben maßgeblich.

Folgefreigabe am 17.10.2026: Der Nutzer beauftragt autonome Launch-Vorbereitung als Goal
einschließlich normal geprüfter Commits und Pushes. Diese Freigabe gilt fortlaufend für
den vereinbarten Scope; keine erneute Commit-/Push-Rückfrage. Gesonderte menschliche
Rechts-/Sichtabnahmen sowie Release-, Deployment-, Repository-Öffnungs- und Store-Freigaben
bleiben bestehen.

## Ziel und verbindliche Entscheidungen

SubKit ist eine selbst hostbare Plattform für kontrollierte, versionierte und
auditierbare KI-gestützte Workflows gegen verbundene Systeme. Ein Team beschreibt
Arbeit, prüft die vorgeschlagene Wirkung, gibt sie menschlich frei und kann die
Ausführungen nachvollziehen. KI-Unterstützung ersetzt keine Ausführungsfreigabe.

- Öffentliche, extern installierbare Beta: 27./28.10.2026.
- General Availability (GA): möglichst bis 15.11.2026; früher, sobald alle Gates erfüllt sind.
- Veröffentlichung hat Vorrang vor neuen Features, Refactorings und Architekturarbeit.
- Kostenloses Self-Hosting, kein SaaS, kein Checkout und kein kostenpflichtiges B2C-Angebot.
- SubKit-Website in Framer vorbereiten; Deutsch zuerst, Englisch später. Quellrepository nach Prüfung öffentlich machen.
- Clipper einschließlich späterer öffentlicher Chrome-Web-Store-Version gehört zum Launch.
- Praktisch getestete Installation, menschliche Freigaben und Release-Gates sind zwingend.
- Deutsche rechtliche Anforderungen anhand des tatsächlichen Angebots prüfen und freigeben.
- Der Nutzer stellt täglich 1–2 Stunden für Entscheidungen und Abnahmen bereit.
- GitHub main ist der gemeinsame freigegebene Stand; Codex dokumentiert lokalen Fortschritt.
- Daily/Weekly priorisieren anhand desselben Stands; SubKit liefert ergänzendes Domänenwissen.
- Keine automatische Gleichsetzung von Knowledge, Gesprächsaussagen und Release-Nachweisen.
- Actions-Verfügbarkeit gilt laut Nutzer bis zum erwarteten 01.11.2026 als externer Blocker.
  Keine Billing-Analyse und keine tägliche Wiederholung dieses bekannten Sachverhalts.

### Übernommene freigegebene Scopeänderung

Der Remote-Stand b6f6df211 dokumentiert die Nutzerentscheidung, Sitzungs-Lernvorschläge
und `save_learning` vor der Beta über Intake zu führen. Sammelgut mit Origin `session`
ist noch kein Wissen und kein aktiver Skill. Fakten/Referenzen werden Wissen in ihrer
Domäne; wiederverwendbare Praktiken werden Skills. Bestätigen darf ausschließlich eine
Person in einer authentifizierten Browser-Sitzung mit den Rechten des Ziels. API-Key,
MCP OAuth, Token Exchange und Chatkanäle bereiten vor und verweisen auf diese Reviewseite.
Skill-Änderungen sind an die überprüften Versionen gebunden. Lernvorschläge werden vor
Speicherung redigiert und kategorisiert; Statusereignisse und geheimnisnahe Notizen sind
kein Sammelgut. Diese freigegebene Ausnahme vom Scope-Freeze erfordert eine neue L12-Abnahme
und Prüfung des gemeinsamen Kandidaten. Historische E37–E46 und E158 decken den neuen
Gesamtstand nicht ab. Major-Release und Deployment bleiben separat freizugeben.

## Scope und Abnahme

### Public Beta

Engine, sk CLI, Cockpit, Chat/MCP, Workflow-Ausführung mit RBAC, Approval und Audit,
Knowledge-Intake, Clipper, öffentliche Website, Quickstart, Downloads, Pflichtinformationen,
Kontakt und Versionsinformationen sind enthalten. Eine lokale Entwicklungsversion genügt nicht.

- Docker-Engine zunächst Linux amd64 entsprechend der bestehenden Release-Pipeline.
- Bestehende CLI-Buildziele: macOS ARM64/x64, Linux ARM64/x64, Windows x64.
  Ein als unterstützt ausgelobtes Ziel braucht echte Installations- und Startnachweise.
  Fehlender Zugang zu einem Zielsystem ist eine offene Entscheidung, keine implizite Abnahme.
- Clipper als öffentliches ZIP mit Version/Prüfsumme, dokumentierter entpackter Installation
  und manuellem Updateweg. Store-Verfügbarkeit darf während der Beta ausstehen.
- Kernpfade einschließlich verpflichtender Client-Handoffs funktionieren auf einer echten
  isolierten Testinstallation mit der ausgewiesenen Kandidatenversion.
- Sicherheitskritische Prüfungen und notwendige rechtliche Freigaben gelten bereits vor Beta.
- Vor empfohlenen Beta-Updates muss ein geprüfter Backup-/Wiederherstellungsweg vorliegen.

### General Availability

Zusätzlich: reproduzierbare Builds, verifizierte signierte Artefakte, erfolgreiche öffentliche
Release-Strecke, stabile Installation/Updates, getesteter Restore, abgeschlossene relevante
Dokumentation, öffentliche Store-Installation, finale Produktabnahme und Supportbetrieb.

### Nicht-Ziele

Neue Connectoren, Slack-/Teams-Adapter, SaaS, Abrechnung, Marketplace, Kubernetes,
zusätzliche Engine-Architekturen und Produkt-UI-Redesign sind P2. Framer ist durch die
Nutzerentscheidung für die öffentliche SubKit-Website im Launch-Scope.
Vorhandene Roadmap-Issues werden nicht automatisch Launch-Blocker. Das ältere GitHub-Issue
#318 zur ChatGPT-Katalogauffindbarkeit wird nur anhand eines aktuellen Pflichtpfads bewertet;
kein vorsorglicher Katalog- oder Architekturumbau. Issues #305, #278 und #264–#272 bleiben
außerhalb des Launch-Scope, solange keine konkrete Pflichtfunktion davon abhängt.

## Komponenten und noch erforderliche Nachweise

Dies ist eine Quellen- und Nachweisbestandsaufnahme, kein vollständiges Code- oder Security-Audit.
Vorhandener Code und Testdateien sind keine bestandene Produktabnahme. Aktuelle Ergebnisse,
öffentliche Verfügbarkeit und Prüfzeitpunkte stehen ausschließlich im Statusdokument.

| Komponente | Implementierung und vorhandene Prüfmittel | Beta-Nachweis | GA-Zusatz | Unnötiger Scope |
| --- | --- | --- | --- | --- |
| Engine | Bootstrap, Tenant-Modell, Queue, Scheduler, Connectoren, Execution, RBAC, Approval, Audit, Credentials, Sandbox, Health/Readiness; Tests/Benchmarks vorhanden | Kandidatenstart, Fehler-/Neustartverhalten, Sicherheitsgrenzen, echte Ausführung, Kapazität | Betriebsdiagnose, Upgrade/Restore und dokumentierte Grenzen | Neue Subsysteme/Connectoren |
| CLI | Init/Login, Workflows, MCP, Clipper, Agent-Befehle, Updates und fünf Buildziele | Installation, Anmeldung, Kernaktionen und Fehlermeldungen auf ausgelobten Zielen | Updatepfad und Plattformregressionen | Neue Paketmanager |
| Cockpit | Onboarding, Login, Navigation, Chat, Workflows, Runs, Connectoren, Approval, Knowledge, Intake, Settings, Rollen | Reale Journeys auf passender Runtime, Fehler-/Berechtigungsfälle, menschliche Sichtabnahme | Beta-Befunde schließen | Redesign |
| Clipper | MV3, Capture/YouTube, Drafts, Kategorien, API-Verbindung, ZIP und Tests | Reproduzierbarkeit, Installation, Capture und vollständiger Intake-Pfad | Store-Installation/Update | Weitere Browser |
| Knowledge | Review, Proposal, Admission, Provenienz, Retrieval und Prüfer vorhanden | Vor Bestätigung ausgeschlossen; danach domänenrichtig auffindbar | Dokumentation und Regressionen | Neue Wissensarchitektur |
| Distribution | Compose/Dockerfile, Binary-Staging, Checksummen, Signierung, Gate-Provenance | Anonym abrufbarer konsistenter Kandidat und frische Installation | Vollständige Release-Pipeline, Upgrade/Restore | Neue Deploymentplattform |
| Website/Recht | Bestehender redaktioneller Kanal; MIT und einzelne Drittanbieterhinweise | Freigegebener Produktbereich, Quickstart, Recht und Support | Finale Vollständigkeits-/Produktabnahme | Neue Website-Engine |
| Integrationen | MCP, Chat/Provider, Google Chat, Coding-Agent-Befehle und Hooks | Reale Pflichtpfade; native Grenzen mit funktionierendem Handoff | Dokumentierte Clientgrenzen | Neue Adapter |

## Meilensteine, Kapazität und kritischer Pfad

| Phase | Zeitraum | Abschlussziel |
| --- | --- | --- |
| Scope und Blocker | 17.–20.10. | Gemeinsame Dateien, Scope-Freeze, Buildursache, sichere Distribution und Installationsweg |
| Öffentliche Voraussetzungen | 20.–22.10. | Website-/Rechtsentwürfe, Store-Paket, gesondert freigegebene Einreichung |
| Beta | 23.–28.10. | Reale Tests, Gates, öffentliche Artefakte, externer Installationstest, Beta-Go |
| Härtung | 29.10.–08.11. | Upgrade/Restore, Pipeline, Beta-Befunde, Store-Review |
| GA | 09.–15.11. | Finaler Kandidat, Abnahme, Veröffentlichung, Support und Monitoring |

Beta-Pfad: **L03 → L07/L08 → L12 → L13 → L14 → L15 → L16/L17**.
Zusätzliche Voraussetzungen vor Publikation: **L04/L05 → L14**.
Parallel: **Betreiberangaben → L06 → L09 → L16**.
GA-Pfad: **L17 → L18/L19/L20 → L22 → L23**.
Externer GA-Pfad: **L10 → L11 → Google → L21 → L22**.

Planungsannahme: ein technischer Hauptstrom, tägliche menschliche Entscheidungen und
rechtzeitig verfügbare Rechtsprüfung. Bis Beta ungefähr 60–80 technische Stunden inklusive
Fehlerreserve, zusätzlich 10–16 menschliche Stunden; bis GA weitere 35–55 technische Stunden.
Spannen sind Schätzungen, keine gemessenen Laufzeiten. Aktive Stunden und externe Wartezeit
werden getrennt geführt. Am 20.10. anhand Befunden und verbleibender Arbeit neu prognostizieren.

Beta am 27./28.10. ist bedingt erreichbar; frühestens 26.10. bei vollständig erfüllten Gates.
Interne GA-Fertigstellung für 11.–13.11. planen, 15.11. als Reserve. Google kann den Termin
überschreiten. Keine Phase künstlich abwarten, keine Pflichtprüfung zugunsten eines Datums streichen.

WIP: höchstens **ein aktives technisches Umsetzungspaket und ein menschliches/externes Paket**.
Konfliktfreie Tests und lesende Reviews dürfen parallel laufen. Im gemeinsamen Checkout nur
eine schreibende Hauptsession. Zuerst abschließen, dann Neues beginnen.

## Arbeitspakete

P0 verhindert sichere Beta/Veröffentlichung; P1 ist für GA erforderlich; P2 ist verschiebbar.
C = Codex, M = Mensch, E = extern. ★ = kritischer Beta-Pfad, ◆ = kritischer GA-Pfad.
Aufwände sind aktive Stunden, sofern nicht anders angegeben. Die folgenden IDs sind stabil.
Der aktuelle Status aller Aufgaben steht in LAUNCH_STATUS.md, damit keine zweite Statusliste driftet.
Jede Aufgabe besteht aus ihrer Planzeile, der DoD-Zeile und ihrem Status-/Nachweiseintrag.

| ID | Prio | Komponente | Ergebnis / Meilenstein | Rolle | Abhängigkeiten | Aufwand | Deadline |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L01 | P0 | Planung | Belegte Ausgangslage und Scope / Planung | C/M | — | erfolgt | 17.10. |
| L02 ★ | P0 | Synchronisation | Drei Launchdateien und kurzer AGENTS-Verweis / Planung | C | Planannahme | 2 h | 18.10. |
| L03 ★ | P0 | Clipper-Build | Driftursache beheben, Builds reproduzieren / Beta | C | L01 | 3–6 h | 18.10. |
| L04 ★ | P0 | Öffentlichkeit | Historien-, Geheimnis- und Lizenzprüfung / Beta | C/M | L01 | 4–6 h | 19.10. |
| L05 ★ | P0 | Distribution | Kontrollierte Publikation ohne privaten Deploy-Zwang / Beta | C | L01 | 5–8 h | 20.10. |
| L06 ★ | P0 | Recht | Betreiber-/Datenschutzunterlagen freigeben / Beta | C/M/E | Betreiberangaben | 7–12 h verteilt | 21.10. |
| L07 ★ | P0 | Installation | Sicherer persistenter Quickstart, Backup-Rückweg / Beta | C | L03 | 4–6 h | 20.10. |
| L08 ★ | P0 | Security | Launchrelevante Sicherheitsbefunde schließen / Beta | C | L03 | 6–10 h | 22.10. |
| L09 ★ | P0 | Website | Produktbereich, Dokumentation, Support vorbereiten / Beta | C/M | L06/L07; Entwurf parallel | 6–8 h | 22.10. |
| L10 ◆ | P1 | Store | Listing, Privacy, Icons, Screenshots, ZIP / GA | C/M | L03/L06 | 5–7 h | 21.10. |
| L11 ◆ | P1 | Store | Freigegebene Einreichung / GA | M/E | L10, öffentliche Pflichtlinks, Freigabe | 1–2 h | 20.–22.10. |
| L12 ★ | P0 | Produktprüfung | Reale Kern-, Intake- und Client-Journeys / Beta | C/M | L07/L08 | 7–10 h | 24.10. |
| L13 ★ | P0 | Release | Beta-Kandidat mit vollständigen Gates / Beta | C | L03/L04/L05/L06/L07/L08/L12 | 3–5 h plus Laufzeit | 25.10. |
| L14 ★ | P0 | Distribution | Repository und Beta-Artefakte veröffentlichen / Beta | C/M | L04/L05/L13, Freigabe | 2–3 h | 25.10. |
| L15 ★ | P0 | Installation | Externer Nutzer installiert öffentliche Artefakte / Beta | C/M | L14 | 5–7 h | 26.10. |
| L16 ★ | P0 | Website | Website, Recht und Support öffentlich abnehmen / Beta | C/M | L06/L09/L15, Freigabe | 3–4 h | 26.10. |
| L17 ★ | P0 | Beta | Beta-Go und Kommunikation / Beta | M/C | L12/L13/L14/L15/L16 | 1 h | 27./28.10. |
| L18 ◆ | P1 | Betrieb | Upgrade, Backup und vollständigen Restore prüfen / GA | C | L17 | 8–12 h | 03.11. |
| L19 ◆ | P1 | Release | Öffentliche Release-Pipeline erfolgreich / GA | C | L05, verfügbare Ausführung | 4–8 h plus Laufzeit | 05.11. |
| L20 ◆ | P1 | Qualität | Beta-Befunde, Security, Betriebsdokumentation / GA | C/M | L17/L18; Triage parallel | 10–16 h | 08.11. |
| L21 ◆ | P1 | Store | Google-Freigabe und öffentliche Installation / GA | C/M/E | L11, Google | 2–6 h plus Wartezeit | Ziel 08.11. |
| L22 ◆ | P1 | GA | GA-Kandidat und finale Abnahme / GA | C/M | L18/L19/L20/L21 | 6–8 h | 11.–13.11. |
| L23 ◆ | P1 | GA | GA veröffentlichen, Support/Monitoring übernehmen / GA | C/M | L22, Freigabe | 2–3 h | spätestens 15.11. |
| L24 | P2 | Roadmap | Nicht launchrelevante Features zurückstellen / nach Launch | M | L23 | kein Launchbudget | nach Launch |
| L25 | P1 | Agent-Kontext | Lokale Hooks und Daily-/Weekly-Handoff verifizieren / GA | C/M | L02, CLI, Zugang, Datenflussfreigabe | 3–5 h | Ziel 23.10. |

L25 ist Komfort-/Arbeitsprozess-Einrichtung und kein Anlass, die Beta zu verschieben.
Die sichere beworbene Hook-Produktfunktion bleibt Teil von L12. Bis zur Einrichtung funktioniert
die manuelle Repository-Übergabe. Eine Aufgabe darf nach Nachweisen früh fertig werden,
ohne dass ihr Zielmeilenstein bereits veröffentlicht ist.

### Definition of Done und Prüfnachweise

| ID | Definition of Done | Prüfnachweis |
| --- | --- | --- |
| L01 | Tatsachen, Annahmen, unbekannte Zustände und Nutzerentscheidungen getrennt | Status-Evidenzregister; begrenzten Prüfumfang benennen |
| L02 | Drei konsistente Dateien; gültige IDs/Links; nur kurzer AGENTS-Verweis; keine privaten Daten | Geprüfter Diff und Dokumentvalidierung; zunächst LOCAL_ONLY |
| L03 | Ursache erklärt; zweimal identischer ZIP-Build unter Release-Toolchain; Driftcheck erfolgreich | Toolchain, Lockfile-/ZIP-Hashes, Exitcodes, betroffene Vertragstests |
| L04 | Gesamte zur Veröffentlichung vorgesehene Historie und Artefakte geprüft; Lizenzpflichten erfüllt | Bereinigter Scanbericht, Lizenzinventar, menschliche Freigabe; keine Historienumschreibung ohne Freigabe |
| L05 | Publikation bewahrt Gates und Signaturen; kein privater Deploy-Zwang | Ablauf/Diff, Vertragsprüfungen, Ablehnung fehlender Gate-Evidenz; Probe ohne Publikation |
| L06 | Texte stimmen mit Betreiber, Angebot und Datenflüssen überein | Freigabe konkreter Textrevision und juristische Prüfung |
| L07 | Frische Installation, Neustart und Wiederherstellung ohne Schlüsselverlust; sichere Defaults | Protokoll mit verschlüsselten Testdaten, persistierten Schlüsseln, dokumentiertem Backup-Rückweg |
| L08 | Keine offenen kritischen/hohen ausnutzbaren Befunde im Launchpfad | Befundregister, Reproduktion und Gegenprüfung; verbleibende Risiken benannt |
| L09 | Website-Inhalte, Downloads, Recht, Support und technische Doku konsistent vorbereitet | Vorschau, Claim-/Linkprüfung, menschlicher Inhaltsreview |
| L10 | Store-Paket und Listing vollständig; realer Installations-/E2E-Test | Paket-Hash, Permission-/Privacy-Matrix, Assets, Testreport |
| L11 | Einreichung konkret freigegeben und tatsächlich erfolgt | Nutzerfreigabe, Paket-Hash, bereinigter Einreichungsbeleg; keine Publikationsbehauptung |
| L12 | Pflichtjourneys und Negativfälle erfüllt; Mock und Live getrennt | Kandidaten-/Runtimebindung, Cross-Surface-Report, Fixture-Cleanup, menschliche Sichtabnahme |
| L13 | Exakter Kandidat besteht sämtliche bestehenden Release-Gates | Numerische Exits, Commit-/Source-/Lockfilebindung, Runtimevergleich, Live-Modellresultat |
| L14 | Freigegebenes Repository und geprüfte Artefakte öffentlich abrufbar | Öffentliche Links, Digests, Signaturprüfung und Versionszuordnung |
| L15 | Außenstehender installiert ohne privaten Zugang und nutzt Kernpfad | Sauberes Testsystem, Download-/Installationsbericht, echte Ausführung, Hindernisliste |
| L16 | Öffentliche Website und Support erreichbar, Pflichttexte und Darstellung abgenommen | Öffentliche Seiten, Kontaktprobe, manuelle Abnahme |
| L17 | Alle Beta-P0 erfüllt; Einschränkungen klar; Beta freigegeben | Menschliches Go, öffentliche Artefakte/Website, freigegebene Kommunikation |
| L18 | Unterstützte Upgrade-/Restore-Strecke erhält Daten, Schlüssel, Rollen und Provenienz | Vorher-/Nachher-Prüfungen, gemessene Dauer und Datenverlustgrenze |
| L19 | Vollständige öffentliche Pipeline produziert abrufbare gültige Artefakte | Erfolgreicher Lauf, Provenance, Signaturen, anonymer Download/Pull |
| L20 | Launchrelevante Beta-Bugs und Security-Restbefunde geschlossen; Doku stimmt | Fehlerregister, gezielte Regressionen, Betriebsdokumentationsreview |
| L21 | Listing öffentlich; Store-Installation und unterstützter Updatepfad funktionieren | Öffentlicher Listinglink, Version und realer Test |
| L22 | GA-Gates, Plattformen und Produktumfang final abgenommen | Versionsgebundene technische und menschliche Abnahme |
| L23 | GA-Artefakte/Website/Notes öffentlich; Support und Monitoring übernommen | Öffentliche Nachweise, Kommunikation, Kontakt und Zuständigkeiten |
| L24 | Nach-Launch-Arbeit getrennt priorisiert, ohne Launch-Gates aufzuweichen | Nutzerentscheidung und spätere Roadmap |
| L25 | Lokale Hooks ausgelöst, Briefing/MCP geprüft, Daily/Weekly lesen gepushten Stand | Bereinigte Client-Lifecycle-Nachweise und erste beobachtete Automationsläufe |

## Technische Release- und Sicherheitsgates

### Kandidat und Distribution

1. Arbeitsstand sichern, main nach AGENTS.md synchronisieren; Checkout und Runtime separat feststellen.
2. Toolchain, Lockfile und exakten Kandidaten festhalten; keine verwendete Version ungeprüft wiederverwenden.
3. Gezielt prüfen; Architektur-, Implementierungs-, Review- und Testprüfung gemäß AGENTS.md abschließen.
4. Bestehende Runtime-Baseline/Kandidatenprüfung mit Source- und Lockfilebindung bestehen lassen.
5. Vollständiges `bun run verify` sowie verpflichtendes `verify:llm-live` im bestehenden Release-Verfahren.
6. Artefakte aus demselben Kandidaten bauen, Checksummen/Signaturen prüfen, frische Installation testen.
7. Erst nach eigener Publikationsfreigabe veröffentlichen; anschließend anonyme Verfügbarkeit prüfen.

Bestehende Gates umfassen Lint, Typecheck, Invarianten, Determinismus, Contracts, funktionales
Cockpit, Clipper/Intake, E2E und generierte Assets einschließlich OpenAPI und Release Notes.
Docker-Journeys zusätzlich passend zur Distributionsänderung verwenden. `verify:release`
ersetzt keine Produktjourneys; übersprungene authentifizierte Checks bleiben UNVERIFIED.
Keine automatischen visuellen Matrizen. Funktionale Browserprüfungen bleiben automatisiert.

Lokal bestanden, Release-Workflow bestanden, Deployment bestanden und produktiver Smoke
bestanden werden getrennt geführt. Kein neues allgemeines CI-Projekt als Launch-Voraussetzung.
Keine Produktionskontakte mit Schreibwirkung ohne ausdrücklich ausgewählten Testumfang.

Der private Deployment-Dispatch wurde aus dem öffentlichen Release-Workflow entfernt.
Während Actions fehlen, lokale Builds, Gates und Proben fortsetzen. Für Beta wird eine lokal
geprüfte Publikationsstrecke mit denselben Sicherheitskontrollen benötigt; keine gefälschten
Statusbelege, Signaturauslassung oder manuellen Tags als Abkürzung. Fehlt bis 23.10. ein geprüft
gleichwertiger Weg, Beta-Termin offen korrigieren. Veröffentlichung selbst bleibt freigabepflichtig.

### Lokaler Release-Weg

`bun run release:local` implementiert drei getrennte Schritte. Implementiert bedeutet noch
nicht praktisch abgenommen; den aktuellen Nachweisstand von L05 in LAUNCH_STATUS.md lesen.

1. Den Kandidaten über das bestehende Release-Verfahren freigeben. Der normale Tagger bleibt
   für Vollgate, Live-Modelle, Runtime-Benchmarks und unveränderliche Tags zuständig. Das
   Schneiden/Pushen eines Release-Tags benötigt weiterhin die eigene Veröffentlichungsfreigabe.
2. `bun run release:local check <tag>` prüft sauberes main, gepinnte Bun-Version,
   Paketversion, lokalen/Remote-Tag, Remote-main und den exakten GitHub-Gatestatus.
3. `bun run release:local prepare <tag> --signing-key-file <datei-außerhalb-des-repos>`
   baut einen Git-Snapshot für linux/amd64. Voraussetzung: vorhandener passender privater
   Release-Schlüssel mit reinen Besitzerrechten, Docker/Buildx/Compose, GitHub-Lesezugriff,
   erreichbare Registries und mindestens 12 GiB freier Docker-Speicher. Der Schlüssel wird
   weder erzeugt noch protokolliert. Das gepinnte Builder-Image muss lokal verfügbar sein.
   Eigene Loopback-Ports 43180/43181 müssen frei sein. Bereits vorhandene Ressourcen des
   vorgesehenen Smoke-Projekts werden nicht übernommen.
4. Vor Veröffentlichung Artefakte unter `.artifacts/local-release/<tag>/assets` prüfen und
   menschlich freigeben. Der lokale Weg signiert zusätzlich `release-provenance.json` und
   `release-notes.md`; die Signatur umfasst sämtliche zehn Nutzdateien. Der Nachweis bindet
   Commit, Plattform, Image-ID, Gate-Kontext und erfolgreichen Smoke-Test. Der Smoke-Test
   ersetzt nicht die vollständigen Produkt-, Installations- und Restore-Journeys.
5. Nur nach separater Freigabe:
   `bun run release:local publish <tag> --confirm-publish <tag>`.
   Dieser Schritt verlangt ein bereits öffentlich freigegebenes Repository und vorhandene
   Docker-/GitHub-Schreibberechtigungen, prüft Gate/Refs/Signatur/Hashes erneut, publiziert
   unverwendete Versionstags, verifiziert zurückgeladene Images und GitHub-Artefakte und
   aktualisiert anschließend latest. Es erfolgt kein Deployment und keine Store-Einreichung.

Für einen Tag genau einen Publisher verwenden: lokalen Weg oder GitHub-Workflow, niemals
parallel. Bestehende GitHub-Releases und Registry-Versionstags werden lokal nicht überschrieben.
Ein Teilfehler nach einem Upload kann bereits öffentliche Artefakte hinterlassen: Befund
prüfen und dokumentieren, nicht blind wiederholen oder Tags verschieben. Vorhandene
Vorbereitungsverzeichnisse werden nicht überschrieben; gescheiterte Versuche erst nach
Nachweis-/Ressourcenprüfung gezielt bereinigen. Anonyme Downloads und externe Installation
bleiben eigene Freigabenachweise nach der Publikation.

### Sicherheits- und Kernjourneys

- Tenant-Isolation für Reads, Writes, Deletes und indirekte Chat-/MCP-Pfade; der bestehende
  AST-Scan allein deckt laut Engine-Guide nicht sämtliche Schreibpfade ab.
- RBAC-Verweigerung; Wirkungserweiterung erfordert neue Approval; Widerruf wirkt; Audit mit Actor.
- Credential-Verschlüsselung, keine Secrets in Logs/Reports; Sandboxbudgets, Egress/SSRF und untrusted Input.
- Queue-/Scheduler-Neustart, Fehlerpfade und Wiederholungen; Health/Readiness und Kapazitätsgrenzen.
- Installieren, initialisieren, anmelden, Workflow erstellen/versionieren, freigeben und wirklich ausführen.
- Bestehende akzeptierte Sicherheitsgrenzen wie fehlende aktive AV-Prüfung dokumentieren und anhand
  des Launch-Threat-Models bewerten; keine neue Infrastruktur ohne konkreten Blocker.

### Clipper-/Intake-Abnahme

- Installation, Login, Capture einschließlich unterstütztem YouTube-Pfad, Drafts und Fehlerzustände.
- Kategorien wählen/umbenennen/wechseln, ohne Wissen aufzunehmen.
- Unbestätigter Clip: **null normale Knowledge-Suchtreffer**.
- Review, Discard/Restore, Vorschlag für Wissen oder Skill, authentifizierter Browser-Handoff.
- Bestätigung nur in einer menschlichen Browser-Sitzung mit Zielberechtigung; API-Key,
  MCP OAuth und Token Exchange werden abgewiesen. Skill-Proposals an geprüfte Versionen binden.
- Sitzungs-Lernvorschläge vor Speicherung redigieren, nach Domäne kategorisieren und bei
  gleichem Titel Belege ergänzen; Statusereignisse/geheimnisnahe Notizen nicht sammeln.
- Identische wiederholte Bestätigung: **genau eine Admission**.
- Veraltete Vorschläge und eingeschränkte Berechtigungen negativ prüfen.
- Jede vorgeschlagene Quelle nachvollziehbar; Original und Provenienz erhalten.
- Bestätigte Quellen in vorgesehener Domäne auffindbar; beide Coding-Agent-Hooks entdecken sie.
- Briefings enthalten keine rohen Clipbodies, nur begrenzte berechtigte Review-Hinweise.
- Clipper, sk, HTTP, MCP, Cockpit und Google Chat real prüfen. Unsupported native Aktionen
  brauchen funktionierende Fortsetzung, keine falsche Erfolgsmeldung.
- Echte Providerantwort getrennt von deterministischen Vertrags-/Mocktests dokumentieren.
- Isolierte Testtenants/Fixtures, exakte IDs und Cleanup; manuelle Nutzer-Inbox nicht befüllen.
- Discovery, Review, Bestätigung, Provenienz und Retrieval getrennt messen; vorhandene Auditdaten
  verwenden und einen begrenzten Realmodell-Test vom deterministischen Vertragstest trennen.

### Installation, Upgrade und Rollback

Quickstart braucht dauerhaft gesicherten MASTER_KEY, sichere Zugangsdaten, persistente
PostgreSQL-/Objektdaten, HTTPS-Hinweise und reproduzierbare Bootstrap-/Login-Schritte.
Temporär gesetzte Schlüssel ohne Sicherung sind keine fertige Betriebsanleitung.

Vor Beta-Updateempfehlungen Backup/Restore prüfen. Für GA die unterstützte Strecke vom
geeigneten öffentlichen Ausgangsstand über Beta zum GA-Kandidaten festlegen und testen;
notwendige Zwischenversionen explizit dokumentieren. Bei inkompatiblen Migrationen ist ein
altes Image kein Rollback: passende Anwendung, DB, Objektbestand und Schlüssel gemeinsam
wiederherstellen. Wiederherstellungsdauer und möglicher Datenverlust werden gemessen.

## Website und Recht

Aktuelle Nutzerentscheidung: Die öffentliche SubKit-Website wird in Framer vorbereitet,
auf Deutsch, Englisch später. Die frühere ContentKit-Zielzuordnung unten ist historischer
Kontext. Das Framer-Arbeitspaket am Ende dieser Datei führt Inhalte und Übergabe weiter.
Veröffentlichung, Betreiberangaben und menschliche Sicht-/Rechtsabnahme bleiben offen.

Historische redaktionelle Quelle: `MikeBild/mikebild-dev-content`; sie ist von diesem Repo
getrennt. README/AGENTS dieses Repositories wurden in der Bestandsaufnahme gelesen. ContentKit
ist dort das Publikationssystem. Für die hier beauftragte SubKit-Website ist nun Framer vorgesehen;
Inhaltsreview und ausdrückliche Publikationsfreigabe bleiben erforderlich.
Der tatsächliche Website-Runtime-/Hosting-Code ist noch nicht vollständig verifiziert.
Konkrete Hosts und private Infrastruktur bleiben außerhalb dieser Dateien.

| Website-Bereich | Beta-Ergebnis |
| --- | --- |
| Landingpage | Kundennutzen, Zielgruppe, Beta-/GA-Status; primär Self-Hosting starten, sekundär Downloads/Quellcode |
| Features/Use Cases | Nur belegte Fähigkeiten: kontrollierte Workflow-Wirkung, menschliche Freigabe, Versionen und Audit |
| Quickstart | Docker → Bootstrap → Cockpit → sk → freigegebener Workflow |
| Self-Hosting | Voraussetzungen, persistente Schlüssel/Daten, Provider, HTTPS, Backup, Update, Diagnose |
| Downloads | Version, Plattform, Prüfsumme, Signaturprüfung, Release Notes |
| Clipper | Installation, manuelles Beta-Update, Collect → Review → Confirm → Knowledge |
| Sicherheit/Privacy | Verantwortlichkeiten, Datenflüsse, Provider, Grenzen und Meldestelle |
| Support | Funktionierender Kontakt, Feedbackkanal, Zuständigkeit und realistische Reaktionszeiten |
| Recht/Lizenzen | Freigegebenes Impressum, Datenschutzhinweise und erforderliche Drittanbieterhinweise |

Technische Dokumentation bleibt aus README/Code und bestehenden Generatoren abgeleitet;
keine zweite unabhängig gepflegte technische Dokumentationsstruktur. Website verlinkt oder
übernimmt versioniert diese Inhalte. Neue Produktseiten erhalten kein zusätzliches Tracking;
bestehende Dienste dennoch inventarisieren. Manuelle Sichtabnahme und funktionale Link-/Downloadtests.

### Rechtliche Launch-Checkliste

Dies ist ein Prüfauftrag, keine juristische Freigabe. Entwürfe bleiben als solche markiert.

| Bereich | Technischer Beitrag | Menschliche/juristische Freigabe |
| --- | --- | --- |
| Kostenlose Open-Source-Software | MIT, Abhängigkeiten, eingebettete Ressourcen und Hinweise inventarisieren | Rechte, Lizenzpflichten, konkrete vertragsrechtliche Einordnung |
| Produktwebsite / DDG § 5 | Dauerhaft erreichbare Anbieter-/Kontaktinformationen | Betreiber, Anschrift, gegebenenfalls Register-/Steuerangaben und Anwendbarkeit |
| DSGVO | Website-Logs, Kontakt/Support, Clipper, Engine, Hooks, Provider/Connectoren erfassen | Zwecke, Rechtsgrundlagen, Empfänger, Retention, Rechte, Transfers und TOMs |
| Auftragsverarbeitung | Tatsächlichen Zugang zu Kundendaten und Dienstleister erfassen | Rollen/Verträge prüfen; Self-Hosting macht den Softwareautor nicht automatisch zum Auftragsverarbeiter |
| TDDDG § 25 | Cookies, Storage und eingebundene Dienste erfassen | Erforderlichkeit oder notwendige Einwilligung beurteilen |
| BFSG | Tastatur, Fokus, Semantik und Kontraste berücksichtigen | Angebot und Betreiberstatus prüfen; keine pauschale Ausnahme behaupten |
| Browser Extension | URLs, Inhalte, Autoren/Zeitangaben, Drafts, Schlüssel, Origins und Übertragungen dokumentieren | Privacy Policy und Store-Disclosures stimmen mit realem Verhalten überein |
| Self-Hosting | Betreiberverantwortung, Retention, Löschung, Providerkonfiguration erklären | Tatsächliche Verantwortlichkeiten und erforderliche Vertragsgrundlagen |
| Kostenpflichtige Angebote | Kein Checkout im Launch | Bei späterem Angebot Preisangaben, AGB, Widerruf und Verbraucherrecht neu prüfen |

Kostenlos bedeutet nicht automatisch frei von Informations- oder Datenschutzpflichten.
Auch kostenlose digitale Angebote und die besondere Open-Source-Ausnahme sind konkret zu prüfen.
Keine fiktiven Anbieterangaben. Persönliche Entwürfe nicht im öffentlichen Launchtracker sammeln.

Offizielle Prüfgrundlagen, recherchiert am 17.10.2026:

- [DDG](https://www.gesetze-im-internet.de/ddg/BJNR0950B0024.html)
- [DSGVO](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32016R0679)
- [TDDDG](https://www.gesetze-im-internet.de/ttdsg/BJNR198210021.html)
- [BFSG: E-Commerce](https://www.bundesfachstelle-barrierefreiheit.de/DE/Barrierefreiheitsstaerkungsgesetz/E-Commerce/online-shops_node.html)
- [BGB § 327](https://www.gesetze-im-internet.de/bgb/__327.html)

## Chrome Web Store

Einreichung möglichst 20.–22.10.; tatsächliche Einreichung nur nach gesonderter Nutzerfreigabe.
Öffentliche Datenschutz-/Supportseiten dürfen als separat freigegebene Vorabseiten vor dem
vollständigen Beta-Produktauftritt erscheinen; dadurch entsteht keine Abhängigkeit von L16.

- Entwicklerkonto, Identitäts-/Kontaktstatus und gegebenenfalls bestehende Listing-ID prüfen.
- MV3, Single Purpose, Remote-Code-Policy und jede Berechtigung prüfen; MV3 allein beweist keine Policy-Konformität.
- `activeTab`, `scripting`, `contextMenus`, `storage` einzeln begründen. Breite optionale
  HTTPS-Origins durch frei wählbares Self-Hosting begründen, tatsächliche Freigabe minimal halten.
- Lokale API-Schlüssel/Drafts und Übertragung an gewählte Engine offenlegen; spätere
  Chatverarbeitung durch konfigurierte Provider erklären. Kein pauschales „keine Datenverarbeitung“.
- Generierte Paket-Icons visuell freigeben; Listing-Icon, echte Screenshots und benötigte Werbegrafik fertigstellen;
  aktuelle Store-Abmessungen bei Erstellung anhand offizieller Vorgaben prüfen.
- Name, Kurz-/Langtext, Privacy-Disclosures, Support und öffentliche Privacy Policy fertigstellen.
- Reproduzierbares ZIP ohne Schlüssel, lokale Konfiguration oder Testdaten; Versionsbindung.
- Installations-/E2E-Test gegen reale isolierte Instanz und nachvollziehbare Reviewer-Anleitung.
- Falls Reviewerzugang nötig: eingeschränkter Testzugang separat, niemals im Repository.

Zustände getrennt protokollieren: vorbereitet → zur Einreichung freigegeben → eingereicht →
Google-freigegeben → öffentlich → Installation verifiziert. Kein Store-Badge vor öffentlicher
Verfügbarkeit. Google nennt wenige Tage bis mehrere Wochen; keine Termingarantie.

- [Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Bilder](https://developer.chrome.com/docs/webstore/images)
- [Reviewprozess](https://developer.chrome.com/docs/webstore/review-process)

## Menschliche Entscheidungen, Risiken und nächste Tage

Noch erforderlich: Betreiber-/Supportangaben, juristische Freigabe, Store-Konto und Einreichung,
Testzugänge/Zielsysteme, globale Hooks und Transkript-Datenfluss, visuelle Abnahme sowie
gesonderte Freigaben für Repository-Öffnung, Website, Beta und GA.
Commit/Push für die autonome Launch-Arbeit sind bereits fortlaufend autorisiert;
reguläre Hooks und die getrennten Veröffentlichungsfreigaben bleiben verbindlich.

| Risiko | Auslöser / Reaktion |
| --- | --- |
| Publikationsweg nicht bereit | Bis 23.10. keine gleichwertig geprüfte lokale Strecke: Beta neu terminieren, keine Gates umgehen |
| Google verzögert/ablehnt | Beanstandung gezielt bearbeiten; Beta-ZIP bleibt möglich, GA wartet auf öffentliche Store-Version |
| Recht/Betreiber fehlt | Öffentliche Pflichtseiten und Launch warten auf echte Angaben/Freigabe |
| Security-/Datenverlustbefund | Publikation stoppen, Befund beheben, betroffene Nachweise erneuern |
| Kapazität oder Zielsystem fehlt | P2 bleibt ausgeschlossen; Pflichtnachweis offen halten, Termin transparent korrigieren |
| Versionsdrift | Runtime/Artefakt vor jedem realen Abnahmelauf prüfen; alte Erfolge nicht umetikettieren |
| Fehlende Automation/Hook | Manuelle Repository-Übergabe verwenden; keine automatische Synchronisation behaupten |

### Nächste drei Tage

Operativ aktualisiert am 18.10.; aktuelle Aufgabenstatus und Nachweise ausschließlich
in LAUNCH_STATUS.md. L02, L03 und L07 sind abgeschlossen und werden nicht erneut geplant.

| Tag | Technischer Hauptstrom | Menschlicher/externer Parallelstrom |
| --- | --- | --- |
| 18.10. | Bestandenes Gesamtgate E158 dokumentieren; QuickJS-Fix 0c61b8bc6 regulär pushen; anschließend verbleibende konkrete P0-Nachweise | Betreiber-/Supportangaben, Store-Kontostatus, Signing-Key und Benchmark-Zielsystem bereitstellen |
| 19.10. | Verbleibende konkrete L04/L08-Rechte-/Security-Nachweise bearbeiten; L05/L13 signierte Vorbereitung nur bei erfüllten Voraussetzungen | Rechtstexte prüfen, Website-Inhalte und Store-Medien abnehmen |
| 20.10. | Website-/Store-Entwürfe mit freigegebenen Pflichtlinks vervollständigen; L12 verbleibende echte Kanalprüfungen bei verfügbaren Zugängen; Terminprognose aktualisieren | Reviewerzugang, Pflichtlinks und konkrete Einreichungsfreigabe vorbereiten |

### Nächster technischer Auftrag: verbleibende P0 abschließen

Aktuellen Git-Stand und Remote-Synchronisation prüfen. Der QuickJS-Fix ist als
0c61b8bc6 committed; vollständiges Gate, gezielte Regression, reproduzierbarer
Build und frische Containerinstallation sind in E158 belegt, jeweils vor Integration
der neuen Intake-Erweiterung. Den bereits gestarteten Gesamtcheck für dbe8d7012
auswerten; nicht parallel neu starten. Erst danach den normalen Push mit Hooks abschließen. Danach die nächste ausführbare offene
P0-Aufgabe aus LAUNCH_STATUS.md wählen; konkrete verbleibende Security-/Rechtefragen
bearbeiten, fehlende menschliche Voraussetzungen ausdrücklich belassen.
Keine erledigten L02/L03/L07-Aufgaben wiederholen. Keine Tags, Veröffentlichungen,
Deployments oder Store-Einreichung aus der Commit-/Push-Freigabe ableiten.

Erfolg des Gesamtplans: Ein externer Nutzer kann SubKit aus öffentlichen Kanälen installieren
und die freigegebenen Produktpfade sicher tatsächlich verwenden.

## Vorbereiteter Chrome-Store-Einreichungsentwurf

Dieser Anhang ist ein überprüfbarer Arbeitsentwurf für L10, keine Freigabe zur Einreichung.

Internal preparation only. Not submitted, not approved by Google, not legally approved.
Source: apps/clipper/public/manifest.json, src/api.ts, src/options.ts,
src/service-worker.ts, src/types.ts and src/capture.ts. Recheck against the final ZIP.
All placeholders below must be replaced with verified public information before submission.

### Listing text

Name: SubKit Clipper

Short description (English):
Save web pages and selections to your own SubKit Inbox for review.

Kurzbeschreibung (Deutsch):
Speichere Webseiten und Textauswahlen zur Prüfung in deiner eigenen SubKit-Inbox.

English description:
SubKit Clipper collects web content for your self-hosted SubKit installation.
Capture the current page or selected text, check the draft, choose a category,
and save the item with its source URL. Local drafts let you return to an unfinished
capture or retry a failed save.

You need a reachable SubKit installation and a personal API key with intake access.
Enter your engine address in the extension settings and grant access to that origin.
The extension does not install or host the SubKit engine for you.

Capturing an item is separate from admitting it as confirmed knowledge. Review and
knowledge admission take place in SubKit, with explicit human confirmation. Publish
this paragraph only after the complete current intake/knowledge journey passes L12.

Some browser-internal pages and protected content cannot be captured. Source metadata
and video transcripts are available only when the source provides them; availability
is not guaranteed. Do not use the extension to collect content you are not permitted
to process.

German description:
SubKit Clipper sammelt Webinhalte für deine selbst gehostete SubKit-Installation.
Erfasse die aktuelle Seite oder eine Textauswahl, prüfe den Entwurf, wähle eine
Kategorie und speichere den Eintrag mit seiner Quelladresse. Lokale Entwürfe helfen
dir, eine Erfassung fortzusetzen oder einen fehlgeschlagenen Speichervorgang erneut
zu versuchen.

Du benötigst eine erreichbare SubKit-Installation und einen persönlichen API-Schlüssel
mit Intake-Zugriff. Trage die Engine-Adresse in den Einstellungen ein und erlaube den
Zugriff auf diese Adresse. Die Erweiterung installiert oder betreibt keine Engine.

Das Sammeln eines Eintrags und die Übernahme als bestätigtes Wissen sind getrennte
Schritte. Prüfung und Wissensübernahme erfolgen in SubKit mit ausdrücklicher
menschlicher Bestätigung. Diesen Absatz erst nach bestandener L12-Abnahme veröffentlichen.

Browserinterne Seiten und geschützte Inhalte lassen sich teilweise nicht erfassen.
Quellmetadaten und Video-Transkripte stehen nur zur Verfügung, wenn die Quelle sie
bereitstellt. Erfasse nur Inhalte, die du verarbeiten darfst.

### Single purpose and permission justifications

Single purpose:
Collect a user-selected web page or selection as a reviewable item in the user's
configured self-hosted SubKit installation, retaining the source reference.

| Permission | Reviewer explanation |
| --- | --- |
| activeTab | Temporary access to the current page after the user invokes capture; used to read the selected text or page content and source metadata. |
| scripting | Runs the packaged capture code in the user-selected tab; no downloaded executable code is needed for capture. Verify this against the final ZIP before certification. |
| contextMenus | Provides an explicit capture action in the page/selection context menu. |
| storage | Saves engine settings, the personal API key, pending drafts and retry state in chrome.storage.local. Access is restricted to trusted extension contexts. Local storage is not claimed to be encrypted. |
| Optional HTTPS hosts | The user may run SubKit on any HTTPS origin. Setup requests the selected engine origin, not blanket permission for every site. Previous engine-origin permission is removed when changed. |
| Optional loopback HTTP hosts | Supports a locally self-hosted engine on localhost, 127.0.0.1 or ::1. Public remote engines require HTTPS. |

### Privacy disclosure worksheet — requires final human certification

Collected/processed: selected page content, page URL/title, available author/publication
metadata, capture time, category and user-edited draft content; personal API key and
configured engine address. User-selected content can itself contain personal or
sensitive information. Do not certify that the extension processes no user data.

Local storage: settings/API key and drafts, including original capture snapshots and
retry state. Key removal is available in settings. Inspect each draft deletion path
and uninstall behavior before specifying exact retention guarantees.

Network destinations: chosen SubKit engine for authenticated categories/preferences
and intake submission. YouTube capture may additionally request the selected source
page and transcript data; do not describe traffic as exclusively engine-bound.
Subsequent review in the engine can use providers configured by that engine's operator.
Distinguish extension capture from later server-side model processing in the privacy policy.

Dashboard categories to review against Google's actual current form: website content,
authentication information and web-history-related data (selected source URLs, not a
claim of background browsing-history collection). Classify personal information
contained in captured content according to the current definitions; operator/legal
review remains required. Limited-use and no-sale certifications require an authorized
person's confirmation of actual practices.

Required public fields: [PRIVACY_POLICY_URL], [SUPPORT_URL], [SUPPORT_EMAIL],
[PRODUCT_URL], [PUBLISHER_IDENTITY]. No contact/address values have been invented.

### Reviewer procedure

1. Provide the final ZIP and a dedicated, nonproduction reviewer installation with
   synthetic content. Deliver its limited test credential through the private reviewer
   channel only; never embed it in the extension or this document.
2. Install, open settings, enter the reviewer engine URL/key, grant that origin and
   verify the connection. Verify failure behavior with an invalid key separately.
3. Capture a supplied public sample page and a text selection. Inspect title, source,
   content and category before saving. Confirm the item in the engine's Intake view.
4. Simulate a temporary connection failure, retain/reopen the local draft and retry;
   verify the submission is not duplicated.
5. In the engine, confirm that an unreviewed item is absent from ordinary knowledge
   retrieval; prepare and explicitly confirm a proposal, then check source provenance.
6. Record the exact tested ZIP hash, engine version, results and cleanup. These are
   instructions for a pending real acceptance run, not a claim that it has passed.

### Assets and submission blockers

The package now generates PNG icons at 16/32/48/128 px from the existing Cockpit
artwork, declares them in the manifest and includes the Lucide license. Technical
package and reproducibility evidence is recorded in LAUNCH_STATUS.md; manual visual
acceptance remains open. Google requires a 128x128 extension icon, a 440x280 small promotional
image and at least one screenshot. Create screenshots from the real isolated accepted
installation, without personal data or credentials. No automatic visual matrix.

Prepared media: two real screenshot drafts and a small promotional graphic are linked below.
Open: manual approval of icons/screenshots/promotional image, public privacy/support URLs,
publisher identity/account access, final reviewer end-to-end acceptance, authorized
privacy certification and explicit submission approval. Review timing is external.
Submission is not publication.

Official sources checked during preparation:
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/images

## Website-Inhaltsentwurf für den bestehenden Produktbereich

Status: redaktioneller Entwurf, nicht veröffentlicht. Zielquelle nach Review:
`MikeBild/mikebild-dev-content`, `content/site/projects/subkit.md`.
Der gelesene main-Baum enthält noch keine SubKit-Projektseite. Keine vorhandene Seite
wurde ersetzt. Editorial voice, anti-slop und maintenance-policy wurden berücksichtigt.
Dieser frühere Entwurf wird durch das Framer-Arbeitspaket am Ende dieser Datei fortgeführt.
Die bisherige ContentKit-Zielzuordnung ist durch die Nutzerentscheidung ersetzt.

### Claim Map vor der Prosa

| Aussage | Quelle und Klasse | Freigabegrenze |
| --- | --- | --- |
| Selbst hostbare Engine mit Cockpit, sk und MCP | README, Architektur; lokale Installation E22 | Öffentliche Installierbarkeit erst nach L14/L15 behaupten |
| RBAC, Ausführungsfreigabe und Protokollierung sind getrennte Kontrollen | README Execution identity and permission; Security E23 | Kein pauschales Sicherheits-, Compliance- oder Vollständigkeitsversprechen |
| Sammlung wird erst nach bestätigter Übernahme zu Wissen | AGENTS/README Clippings; Produktvertrag | Für die Beta-Fassung erst nach realer L12-Abnahme als verfügbar darstellen |
| Docker-Quickstart und Wiederherstellung | README Run the engine / Backup and recovery, E22 | Versionsupgrade und ältere Binärversionen nicht als geprüft darstellen |
| Clipper wird als Paket bereitgestellt | E12, README Collect ideas | Store-Link erst nach öffentlicher Google-Freigabe; ZIP erst nach L14 |
| Kostenloses Self-Hosting, externe Provider separat | Nutzerentscheidung, README Providerkonfiguration | Keine Zusage kostenlosen Hostings oder kostenloser Modellaufrufe |

Gliederung: konkretes Teamproblem → Produktgrenzen → Arbeitsablauf → Self-Hosting →
Clipper → Verfügbarkeit → Dokumentation, Sicherheit und Kontakt.

### Seitenentwurf

#### SubKit

KI-gestützte Workflows ausführen, ihre Berechtigungen begrenzen und Entscheidungen nachvollziehen.

Ein Team verbindet mit einem Workflow oft mehrere Systeme. Dabei muss klar bleiben,
welche Daten gelesen werden dürfen, welche Änderungen erlaubt sind und wer einen Lauf
ausgelöst hat. SubKit bündelt dafür Workflow-Ausführung, menschliche Freigaben und
Protokollierung in einer selbst hostbaren Plattform.

Die Engine führt Workflows aus. Im Cockpit verwaltet das Team Abläufe und prüft
Ergebnisse. Die sk CLI und MCP machen dieselben Produktfunktionen für Skripte und
angebundenen KI-Assistenten zugänglich. Die jeweilige Identität und ihre Rechte
bestimmen, welche Aktionen verfügbar sind.

### Arbeit vorbereiten und Wirkung freigeben

Ein Workflow hat eine Version. Eine Person prüft, welche Systeme und Adressen er in
einer Umgebung erreichen und ob er dort lesen oder schreiben darf. Wird diese
Wirkungsgrenze erweitert, braucht es eine neue Freigabe. Eine bestehende Freigabe
kann widerrufen werden.

Zugangsdaten, Benutzerrechte und Freigaben erfüllen unterschiedliche Aufgaben.
Ein gespeicherter API-Schlüssel allein erlaubt keine beliebige Ausführung. Zu einem
Lauf lassen sich unter anderem Status, Workflow-Version und Ausführungsnachweise prüfen.

### Im eigenen Betrieb

SubKit wird mit Docker Compose installiert. Datenbank, Objektablage und die Schlüssel
für gespeicherte Zugangsdaten gehören zur Installation und zu ihrem Backup. Der Betreiber
entscheidet, welche Connectoren und Modellanbieter verwendet werden.

Self-Hosting bedeutet dabei nicht automatisch, dass alle Daten lokal bleiben.
Ein freigegebener Workflow kann Daten an angebundene Dienste senden; Modellaufrufe
verwenden die konfigurierten Anbieter. Deren Datenverarbeitung gehört zur eigenen
Betriebsentscheidung. Das kostenlose Self-Hosting-Angebot umfasst weder Infrastruktur
noch Nutzungsgebühren externer Anbieter.

### Seiten sammeln und gezielt übernehmen

Der SubKit Clipper ist für die Sammlung von Webseiten und markierten Texten vorgesehen.
Der anschließende Weg führt von der Inbox über die Prüfung im Chat zur ausdrücklich
bestätigten Übernahme in Knowledge. Eine Kategorie oder das bloße Sammeln ersetzt diese
Inhaltsentscheidung nicht. Die ursprüngliche Quelle bleibt mit dem Ergebnis verbunden.

Der Clipper benötigt eine eigene SubKit-Installation und einen passend berechtigten
API-Schlüssel. Für die Beta ist ein installierbares Paket vorgesehen. Die Veröffentlichung
im Chrome Web Store ist ein gesonderter Schritt und hängt von Googles Freigabe ab.

### Verfügbarkeit

Die öffentliche Beta wird vorbereitet. Installationspakete, Versionsinformationen und
der Quickstart werden hier verlinkt, sobald der Kandidat freigegeben und die öffentliche
Installation geprüft ist. Eine lokale Entwicklungsfassung ist noch keine öffentliche Beta.

### Redaktionelle Linkplätze, vor Veröffentlichung auflösen

- **Self-Hosting starten:** Quickstart der tatsächlich freigegebenen Release-Version,
  aus README abgeleitet; keine zweite separat gepflegte Installationsanleitung.
- **Downloads:** exakte Version, unterstützte Plattformen, Prüfsummen, Signaturprüfung
  und Release Notes; kein Verweis auf einen unfertigen latest-Kanal.
- **Clipper:** freigegebenes ZIP mit Installationsanleitung; Store-Link nur bei Veröffentlichung.
- **Sicherheit und Datenschutz:** tatsächliche Datenflüsse, Betreiberverantwortung,
  bestätigter Kontakt für Sicherheitsmeldungen und freigegebene Datenschutzhinweise.
- **Kontakt/Support und Impressum:** vom Betreiber bestätigte Angaben. Keine erfundene
  Adresse, Reaktionszeit oder Service-Level-Zusage.

### Getrennte Kritik und Übergabe

Die Produktbeschreibung ist an README und lokale Nachweise gebunden. Vor Übernahme
sind drei kleine, zwingende Anpassungen nötig: den Knowledge-Abschnitt anhand L12
bestätigen, die Verfügbarkeit auf den tatsächlich freigegebenen Meilenstein setzen
und alle Linkplätze durch geprüfte öffentliche Ziele ersetzen. Bis dahin bleibt
auch dieser Entwurf unveröffentlicht. Keine Tracking-Pixel oder zusätzlichen externen
Badges aufnehmen. Finaler Fakten-/Stimmenreview, konkrete Preview-Revision und die
Veröffentlichungsfreigabe werden separat dokumentiert.

## L04: Quell-/Relink-Auslieferung konkret abnehmen

Status: technischer Prüfentwurf, keine juristische Freigabe und kein zusätzlich implementiertes Release-Gate. Der notwendige Lieferumfang und geeignete Nachweis sind anhand der tatsächlich verwendeten Lizenzen freizugeben. Die bestehende
Release-Strecke liefert Binärdateien und Notices; ein entsprechendes öffentliches
Quell-/Relink-Paket und ein erfolgreicher Wiederaufbau sind noch nicht belegt.
Buns eigene LICENSE.md beschreibt statisch eingebundenes WebKit/JavaScriptCore
und einen Wiederaufbau mit ausgetauschter Bibliothek. TinyCC wird aus einem
gebundenen Fork einschließlich Bun-Patch gebaut. Die konkrete rechtliche
Anwendbarkeit und Auslieferungsform muss der Betreiber freigeben lassen.

Der nächste technische Auftrag bleibt innerhalb L04/L05:

1. Den tatsächlichen Release-Commit und die Binär-/Image-Hashes an ein
   Quellmanifest binden. SubKit, Bun, WebKit und TinyCC samt angewendeten Patches,
   Generatoren und Buildkonfiguration erfassen; weitere relevante Abhängigkeiten
   anhand des Builds ergänzen. Ein Snapshot allein beweist keine Vollständigkeit.
2. Vorhandene Quellen wiederverwenden und deren vollständige Archive mit Hashes
   lokal bereitstellen. Keine Secrets oder ungetrackten Nutzerdateien aufnehmen.
   Externe Downloadlinks allein nicht als bereits ausgelieferte Quellen melden.
3. Auf einer isolierten, geeigneten Buildmaschine den dokumentierten Wiederaufbau
   mit geänderter relevanter Bibliothek tatsächlich durchführen. Engine-Start,
   CLI und einen synthetischen Workflow prüfen. Abweichende Toolchain-Provenienz
   ehrlich ausweisen; normale Release-Gates nicht für den Versuch umgehen.
4. Der juristischen Prüfung ein konkretes Paket vorlegen: Inventar, Originaltexte,
   Änderungen, Buildanleitung, Testnachweis und vorgesehene öffentliche Bezugswege.
   Keine freie Umverteilbarkeit unbekannter Modelle oder Pakete unterstellen.
5. Erst nach Abnahme den gewählten Lieferumfang in Checksummen, Signatur,
   Release-Assets und Downloads aufnehmen und anonymen Abruf prüfen. Veröffentlichung
   bleibt separat freizugeben. Ein lokales Paket oder ein GitHub-Push erfüllt diesen
   öffentlichen Auslieferungsnachweis nicht.

DoD: bestätigter Lieferumfang, zum Release passende Inhalte, reproduzierbare
Anleitung mit echtem Austausch-/Wiederaufbaunachweis, sichere Artefaktbindung und
nach Veröffentlichung erreichbare Bezugswege. Bis dahin bleiben L04/L05 offen.
Keine pauschale neue Architektur oder Produktfunktion dafür einführen.

### Vorhandene Buildvoraussetzungen für den Prüfentwurf

Lokale Prüfung E145: macOS ARM64 mit Xcode, CMake und Ninja vorhanden; ICU 78
ist installiert, benötigt jedoch einen expliziten Suchpfad. Go und rustup fehlen.
Bun bindet Rust `nightly-2026-07-20`; das Buildskript akzeptiert LLVM 21.1.x
mit Referenzversion 21.1.8. Apple Clang 21.0 und Homebrew LLVM 23.1 erfüllen
seine Versionsbedingung nicht. Keine globale Toolchain geändert.

Ein lokaler Versuch braucht daher eine getrennte Toolchain-Umgebung mit
expliziten Pfaden und begrenzten Buildressourcen. Das ist noch kein ausgeführter
Build. Die aktuelle Source-Vorbereitung bleibt als Prüfmaterial nutzbar. Der
juristisch geeignete Lieferweg ist zu entscheiden, bevor aus diesem Entwurf
pauschal eine neue Freigabebedingung für jede Plattform gemacht wird. Bereits
bestehende Release-Gates bleiben unverändert. Unabhängig davon aktuelle
SubKit-Artefakte, Notice-Inhalte und Installationsabläufe weiter fertigstellen.

## L10: Vorbereitete Store-Screenshot-Entwürfe

- [Vor dem Sammeln](assets/clipper-store/capture.jpg)
- [Gesammelt, noch nicht als Wissen übernommen](assets/clipper-store/collected.jpg)
- [Herkunft, Prüfsummen und Grenzen](assets/clipper-store/capture-evidence.json)

Die Bilder zeigen echte unveränderte Oberflächen mit isolierten Beispieldaten,
je 1280×800 JPEG. Sie sind ausdrücklich Entwürfe. Breite Tabdarstellung,
Freiraum und lokale Beispieladresse müssen vor finaler Verwendung visuell
abgenommen werden. Keine Google-Freigabe behaupten. Die erforderliche kleine
Promografik (440×280) liegt ebenfalls als Entwurf vor: [PNG](assets/clipper-store/promo.png),
[editierbare eigenständige HTML-Quelle](assets/clipper-store/promo.html) und
[Herkunft/Prüfsummen](assets/clipper-store/promo-evidence.json). Das vorhandene Logo
ist eingebettet; [Lucide-Lizenz](assets/clipper-store/lucide.txt) liegt bei.
Zur erneuten Ausgabe die HTML-Datei mit Chromium bei 440×280 CSS-Pixeln,
Device Scale Factor 1 und hellem Farbschema öffnen und als PNG ohne Transparenz
exportieren. Keine externen Ressourcen erforderlich.
Der ZIP-Generator erzeugt das 128px-Store-Icon mit 96px-Motiv und 16px
transparentem Rand; die Pixelgrenzen sind automatisiert geprüft (E148).
Menschliche Medienabnahme und Google-Freigabe bleiben offen. Grundlage:
[offizielle Google-Bildvorgaben](https://developer.chrome.com/docs/webstore/images).

## L10: Konkrete lokale Einreichungsübergabe

Das lokale Arbeitsarchiv `.artifacts/launch/store-handover.zip` bündelt die
vorbereiteten Texte, Medien, Reviewer-/Privacy-Arbeitsblätter und das unveränderte
Extension-ZIP. Es ist **nicht einreichungsbereit** und selbst keine installierbare
Erweiterung. Nur die darin enthaltene `subkit-clipper.zip` gehört später in den
Extension-Upload. `READ-FIRST.md` erklärt den Ablauf; `SHA256SUMS` und
`handover-manifest.json` erlauben den Integritätsabgleich.

Der bereinigte gemeinsame Nachweis mit Dateihashes und acht offenen Voraussetzungen
steht in [handover-evidence.json](assets/clipper-store/handover-evidence.json).
Das Arbeitsarchiv bleibt lokal; es ist kein veröffentlichter Download und wird
nicht durch den Git-Push ausgeliefert. Die Listing-Quelle bleibt dieser Masterplan,
die Medienquelle `assets/clipper-store/`; bei Änderungen muss die Übergabe neu
zusammengestellt und erneut geprüft werden. Keine zweite Aufgabenliste pflegen.

Offen bleiben Publisher-/Versionsprüfung, Pflichtlinks, Recht/Zertifizierung,
Medienabnahme, Reviewer-Zugang, finale Journey-Abnahme und Einreichungsfreigabe.
Screenshots behalten ihre ursprüngliche ZIP-Provenienz; keine neue Abnahme aus der
aktuellen Icon-Korrektur ableiten. Die Beschreibungsabsätze zur Wissensübernahme
setzen die vollständige L12-Abnahme voraus.

## Framer-Arbeitspaket

### Redaktioneller Stand und Verwendung

Nutzerentscheidung: Framer für die SubKit-Website; Deutsch zuerst, Englisch später.
Ton: zurückhaltend, erwachsen, ehrlich und direkt. Die Website erklärt konkrete Arbeit,
Zuständigkeiten und Grenzen. Sie verwendet keine unbelegten Leistungszahlen, Kundenlogos,
Kundenstimmen, Sicherheitsversprechen oder Vergleiche mit benannten Wettbewerbern.

Inhaltsreferenz: https://claude.ai/artifact/7u5YLz56h152Q4xUHwiGCo.
Die bestätigte Wissensquelle „SubKit: Zielgruppen, Positionierung, Nutzen“ nennt dafür
Start, Anwendungsfälle, Loslegen und Vergleiche sowie deren Gliederung. Der vollständige
Artifact-Inhalt war nicht abrufbar. Die folgenden Texte sind ein neuer Arbeitsentwurf
auf Basis dieser Gliederung, der README und der vorhandenen Launch-Claim-Map. Sie sind
keine behauptete Übernahme oder Abnahme des vollständigen Artifacts.

Die vom Nutzer gelieferte Gemini-Analyse ist strategischer Input. Daraus werden
Käuferfragen abgeleitet, keine bestätigten Wettbewerberfakten oder Überlegenheitsclaims.
Die Framer-Texte sind ebenfalls keine automatisch bestätigte Knowledge-Quelle.

### Freigegebene Umsetzung und Abnahmen

Der Nutzer hat den Aufbau bis zur veröffentlichten deutschen Vorabwebsite beauftragt.
Heller Hintergrund, dunkle Schrift, zurückhaltender blauer Akzent, großzügige Abstände
und eine einfache Ablaufgrafik bilden die gestalterische Richtung. Gemeinsame Navigation,
Footer, Buttons und Textstile bleiben in Framer bearbeitbar. Zuerst die Startseite
einschließlich mobiler Darstellung zur menschlichen Sichtabnahme vorlegen, anschließend
die bestätigte Gestaltung auf die übrigen drei Seiten übertragen. Der Claude Artifact
ist eine inhaltliche Vorlage; sein vollständiger Abgleich bleibt vor Veröffentlichung
erforderlich. Eine Vorabwebsite darf den Produktstand ehrlich als in Vorbereitung
beschreiben, ohne den Produktrelease abzuwarten. Veröffentlichung erfordert echte
Betreiber-/Pflichtangaben, geprüfte Zieladressen und eine separate Freigabe der fertigen
Vorschau. Keine automatische visuelle Matrix. Englisch, Formulare und zusätzliche
Tracking-Funktionen sind in diesem Durchlauf nicht vorgesehen.

Ein Hauptagent schreibt in Framer und in die Launch-Unterlagen. Ein Inhaltsprüfer und
ein Funktions-/Veröffentlichungsprüfer prüfen unabhängig und lesend. Die Goal-Abnahme
setzt öffentliche Erreichbarkeit, geprüfte Funktionen und die Bearbeitungshilfe voraus.

### Positionierung für Interessenten

Zielgruppen sind Einzelpersonen, Soloselbstständige, kleine Unternehmen mit 1–10
Mitarbeitern und Abteilungen. Zusammenarbeit ist ein zusätzlicher Nutzen. Der gemeinsame
Anlass: wiederkehrende Arbeit mit weniger Handarbeit als nachvollziehbaren Ablauf
einrichten und nutzen. Berechtigungen, Freigaben und Verlauf erklären, wie das möglich
wird; Betriebsaufwand und Grenzen gehören zur Entscheidung dazu.

| Käuferfrage | SubKit-Antwort | Grenze der Aussage |
| --- | --- | --- |
| Welche Arbeit fällt im Alltag weg? | Konkrete, wiederkehrende Übergaben zwischen bestehenden Systemen beschreiben und prüfen. | Keine Zeitersparnis oder Produktivitätsquote ohne Vorher-/Nachher-Messung. |
| Können Fachbereiche mitarbeiten? | Fachwissen in normalen Sätzen beschreiben, Entwurf und Wirkung gemeinsam prüfen. | Komplexe Datenmodelle, Rechte und Integrationen brauchen technische Arbeit. |
| Behält die IT die Übersicht? | Benutzerrechte, Connector-Zugänge, erlaubte Wirkung und Ausführungsverlauf getrennt erklären. | Keine pauschale Compliance- oder Sicherheitsgarantie. |
| Können wir vorhandene Systeme weiter nutzen? | Dokumentierte Schnittstellen und unterstützte Verbindungen verwenden. | Keine vollständige Abdeckung aller Unternehmenssysteme behaupten. |
| Können wir Wissen berücksichtigen? | Bestätigte Quellen und Regeln mit Herkunft in die Vorbereitung einbeziehen. | Keine allgemeine Unternehmenssuche behaupten; Intake-Verfügbarkeit bleibt an L12 gebunden. |
| Können mehrere Personen denselben Ablauf nutzen? | Gemeinsame Abläufe mit den jeweiligen Rechten starten und Ergebnisse nachvollziehen. | Keine unbelegte Unternehmensskalierung oder Verfügbarkeitszusage. |
| Lohnt sich der Betrieb? | Prozessaufwand, Nacharbeit, Infrastruktur und Anbietergebühren am eigenen Fall messen. | Modellkosten sind nicht die vollständigen Prozesskosten; kein garantierter ROI. |

### Framer-Gesamtauftrag

BEGIN FRAMER AUFTRAG

Bereite die deutsche SubKit-Website als bearbeitbaren Entwurf mit vier Seiten vor:
Start (/), Anwendungsfälle (/anwendungsfaelle), Loslegen (/loslegen) und Vergleiche
(/vergleiche). Englisch folgt später.

SubKit ist eine selbst hostbare Engine für KI-gestützte Workflows. Zielgruppen sind
Einzelpersonen, Soloselbstständige, kleine Unternehmen mit 1–10 Mitarbeitern und Abteilungen.
Erkläre zuerst die konkrete Arbeit und den Nutzen. Erkläre Technik dort, wo sie hilft,
eine Entscheidung zu treffen. Schreibe in der Du-Form, ruhig, präzise und ohne Superlative.

Verwende die nachfolgenden Seitentexte. Ergänze keine Produkteigenschaften, Zahlen,
Kundenstimmen, Markenlogos, Marktführerschaft oder Rechtsversprechen. Die im Auftrag
enthaltenen Beispiele sind entworfene Abläufe, keine veröffentlichten Kundenberichte.
Kennzeichne sie entsprechend. Stelle SubKit nicht als völlig autonome Agentenplattform dar.

Inhaltsreferenz ist https://claude.ai/artifact/7u5YLz56h152Q4xUHwiGCo.
Die vierseitige Gliederung ist bekannt; der vollständige Inhalt muss noch abgeglichen
werden. Behaupte keinen erfolgten Import dieses Artifacts. Die hier gelieferten Texte
sind ein eigenständiger Arbeitsentwurf. Wenn die Referenz zugänglich ist, prüfe die
Unterschiede vor einer Übernahme. Widersprüche zu aktuellen Produktnachweisen offenlegen.

Prüfe eine vorhandene konkrete Design-Vorlage einschließlich Komponenten und Zuständen
vor Gestaltungsänderungen und übernimm sie originalgetreu. Das Artifact ist ausdrücklich
als Inhaltsvorlage gewählt. Bei einem leeren Framer-Projekt zunächst einen ruhigen,
gut lesbaren Gestaltungsvorschlag zur Sichtabnahme erstellen. Unterstütze die Inhalte
mit echten freigegebenen Produktaufnahmen, sobald sie vorliegen. Verwende keine
erfundenen Cockpit-Screenshots oder dekorativen Zahlen.

Halte Texte, Navigation und wiederkehrende Elemente in Framer editierbar. Die Navigation
verlinkt die vier vorhandenen Seiten. Der Hauptlink lautet „Einstieg ansehen“ und führt
zu /loslegen; der ergänzende Link „Anwendungsfälle ansehen“ führt zu /anwendungsfaelle.
Keine Anmelde-, Kauf- oder Demo-Buchungsschaltfläche ohne funktionierendes Ziel einbauen.

Der sichtbare Verfügbarkeitstext lautet zunächst: „Die öffentliche Beta wird vorbereitet.
Installationspakete und Anleitung folgen nach der Freigabe.“ Die Website wird erst nach
Prüfung auf den tatsächlich veröffentlichten Stand umgestellt. Unbekannte Download-,
Support-, Impressums- und Datenschutzadressen sind offene redaktionelle Aufgaben;
keine erfundenen Links und keine scheinbar funktionierenden Formulare einsetzen.

Interne Quellenhinweise, Freigabeaufgaben und die unten stehende Linkliste gehören in
die Arbeitsunterlagen, nicht in die Besuchertexte. Veröffentliche das Projekt nicht.

END FRAMER AUFTRAG

### Startseite

BEGIN FRAMER START

Pfad: /
Seitentitel: SubKit – weniger Handarbeit im Alltag
Suchbeschreibung: KI-gestützte Workflows vorbereiten, ihre Wirkung prüfen und Ausführungen nachvollziehen. Für Einzelpersonen, kleine Unternehmen und Abteilungen.

FÜR DICH. FÜR DEIN TEAM.

# Weniger Handarbeit im Alltag.

SubKit hilft dir, wiederkehrende Aufgaben als nachvollziehbare Abläufe einzurichten. Du beschreibst die Arbeit, prüfst den vorgeschlagenen Ablauf und legst fest, was er tun darf. Für dich selbst oder gemeinsam im Team.

Einstieg ansehen → /loslegen
Anwendungsfälle ansehen → /anwendungsfaelle

Die öffentliche Beta wird vorbereitet. Installationspakete und Anleitung folgen nach der Freigabe.

## Aus einer Aufgabe wird ein Ablauf.

Einzelne Aufgaben erledigst du heute vielleicht jedes Mal neu. SubKit hilft dir, die Schritte vorzubereiten und wiederzuverwenden. Die beteiligten Systeme und die erlaubte Wirkung bleiben dabei überprüfbar.

01

### Beschreiben

Erkläre die Aufgabe, die beteiligten Werkzeuge und das gewünschte Ergebnis.

02

### Prüfen

Schau dir den Entwurf an: Stimmen Daten, Schritte und vorgesehene Änderungen?

03

### Freigeben

Eine berechtigte Person legt fest, welche Systeme der Ablauf erreichen und was er verändern darf.

04

### Ausführen

Nutze den freigegebenen Ablauf und sieh im Verlauf, welche Fassung lief und wie sie ausging.

## Für deine Arbeit. In deiner Größe.

### Für dich selbst

Als Einzelperson oder Soloselbstständiger kannst du wiederkehrende Arbeit vorbereiten und Abläufe wiederverwenden. Du behältst den Überblick darüber, was ausgeführt wurde und wo du nachsehen musst.

### Für kleine Teams und Abteilungen

Nutzt gemeinsam eingerichtete Abläufe mit den jeweiligen Berechtigungen. Fachliche Regeln, Zugänge und Freigaben werden bewusst eingerichtet; Ergebnisse und Fehler bleiben nachvollziehbar.

## Mit einer überschaubaren Aufgabe anfangen.

Mögliche Abläufe, die du für deine Werkzeuge und Regeln einrichtest. Keine fertigen Vorlagen oder Kundenberichte.

Informationen für einen regelmäßigen Bericht zusammentragen. Eingehende Anfragen nach festgelegten Regeln zuordnen. Dokumente aus einer unterstützten Quelle übernehmen und strukturiert ablegen.

Welche Verbindungen möglich sind, hängt von den Schnittstellen deiner Anwendungen und den eingerichteten Berechtigungen ab.

## Du legst fest, was passieren darf.

Ein gespeicherter Zugang allein erlaubt noch keine Änderungen. Die Freigabe bestimmt für eine Umgebung, welche Systeme und Adressen ein Workflow erreichen und ob er dort lesen oder schreiben darf. Wächst diese Reichweite, braucht es eine neue Freigabe. Eine Freigabe lässt sich widerrufen.

## Deine Installation. Auch deine Verantwortung.

SubKit ist selbst hostbar. Du entscheidest, welche Dienste und Modellanbieter du verbindest. Bei freigegebenen Aufrufen können Daten an diese Anbieter gesendet werden. Einrichtung, Updates und Datensicherung gehören zum Betrieb dazu.

Das Self-Hosting-Angebot ist kostenlos. Infrastruktur und externe Anbieter können Kosten verursachen. Für den Einstieg lohnt sich eine Aufgabe mit klarem Ergebnis und wenigen beteiligten Systemen.

Die öffentliche Beta wird vorbereitet. Die geprüfte Installationsanleitung und die freigegebenen Pakete folgen.

END FRAMER START

### Anwendungsfälle

BEGIN FRAMER ANWENDUNGSFAELLE

Pfad: /anwendungsfaelle
Seitentitel: Anwendungsfälle – SubKit
Suchbeschreibung: Berichte, Anfragen und Dokumente: Beispiele für wiederkehrende Abläufe, die ein Team mit SubKit vorbereiten und prüfen kann.

# Mit einer konkreten Aufgabe beginnen

Gute Einstiegsfälle haben ein klares Ergebnis, wenige beteiligte Systeme und jemanden,
der beurteilen kann, ob der Ablauf stimmt. Die folgenden Beispiele zeigen mögliche
Entwürfe. Welche Teile eine veröffentlichte Fassung bereits mitbringt, wird im
jeweiligen Installationsangebot ausgewiesen.

## Einen regelmäßigen Bericht vorbereiten

„Stelle jeden Montag die vereinbarten Kennzahlen der vergangenen Woche zusammen.“

Der Ablauf liest die vorgesehenen Quellen und bereitet die Übersicht auf. Vor der
Freigabe klärt das Team, welche Kennzahlen gelten, wie fehlende Werte behandelt werden
und wer das Ergebnis erhalten darf.

Der Nutzen: Die Zusammenstellung muss nicht jedes Mal neu organisiert werden.
Ob tatsächlich Zeit gespart wird, lässt sich am eigenen Bericht messen.

Herkunft: Beispiel für einen zu entwerfenden Ablauf.

## Eingehende Anfragen zuordnen

„Prüfe neue Anfragen auf vorhandene Kontakte und bereite die Übergabe an den Vertrieb vor.“

Der Entwurf macht sichtbar, woher die Anfrage kommt, wie ein vorhandener Kontakt erkannt
wird und welche Informationen weitergegeben werden. Schreiben ins Kundensystem und
Benachrichtigungen brauchen passende Rechte und eine geprüfte Freigabe.

Der Nutzen: Die Übergabe folgt einer vereinbarten Regel und bleibt nachvollziehbar.

Herkunft: Beispiel für einen zu entwerfenden Ablauf.

## Dokumente nach einer festen Regel ablegen

„Lege passende Anhänge aus dem vereinbarten Postfach im vorgesehenen Ordner ab.“

Vor dem ersten Lauf wird geklärt, welche Anhänge dazugehören, wer Zugriff auf den Ordner
hat und wie mit mehrfach eingegangenen Dateien umgegangen wird. Eine automatische
Ablage ersetzt keine Prüfung auf Vollständigkeit oder eine rechtliche Archivlösung.

Der Nutzen: Die wiederkehrende Ablage wird als überprüfbarer Prozess beschrieben.

Herkunft: Beispiel für einen zu entwerfenden Ablauf.

## Änderungen vor der Übernahme sichtbar machen

„Vergleiche die neue Lieferantenliste mit unseren Daten und zeige die Unterschiede.“

Ein lesender Abgleich kann der erste Schritt sein. Wenn später Daten übernommen werden
sollen, wird diese zusätzliche Schreibwirkung gesondert geprüft. Fachliche Regeln und
Sonderfälle müssen aus dem eigenen Betrieb kommen.

Der Nutzen: Das Team kann die vorgeschlagenen Änderungen beurteilen, bevor es eine
weitergehende Automatisierung freigibt.

Herkunft: Beispiel für einen zu entwerfenden Ablauf.

## Den Zustand gemeinsamer Abläufe zusammenstellen

„Zeige uns regelmäßig, welche Abläufe liefen und welche Aufmerksamkeit brauchen.“

Eine Übersicht kann erfolgreiche und fehlgeschlagene Ausführungen zusammenführen.
Das Team legt fest, wer auf welche Befunde reagiert. Eine Meldung allein behebt keinen
Fehler; sie macht ihn für die zuständige Person sichtbar.

Der Nutzen: Die Verantwortung für wiederkehrende Arbeit lässt sich konkret zuordnen.

Herkunft: Beispiel für einen zu entwerfenden Ablauf.

## Woran sich ein erster Versuch messen lässt

Vergleiche den bisherigen Aufwand mit Vorbereitung, Betrieb und Nacharbeit des neuen
Ablaufs. Berücksichtige Fehler, Ausnahmen, Infrastruktur und Anbietergebühren.
Erst diese Beobachtung zeigt, ob sich die Automatisierung für euch lohnt.

Einstieg ansehen → /loslegen

END FRAMER ANWENDUNGSFAELLE

### Loslegen

BEGIN FRAMER LOSLEGEN

Pfad: /loslegen
Seitentitel: Loslegen – SubKit selbst hosten
Suchbeschreibung: Bereite deinen Einstieg mit SubKit vor: Betrieb klären, eine Aufgabe auswählen und den ersten Workflow gemeinsam prüfen.

# Den ersten Ablauf überschaubar halten

SubKit wird selbst gehostet. Für den Einstieg brauchst du eine Installation, passende
Zugänge zu den beteiligten Diensten und eine Person, die die Aufgabe fachlich prüfen kann.

Die öffentliche Beta wird vorbereitet. Installationspakete und Anleitung folgen nach der Freigabe.

## Drei Wege zur ersten Aufgabe

**Du kennst den Arbeitsablauf.** Beschreibe, was heute von Hand passiert, welche Daten
verwendet werden und woran du ein richtiges Ergebnis erkennst. Beziehe die IT früh ein,
wenn Zugänge oder der Betrieb eingerichtet werden müssen.

**Du betreust die Systeme.** Kläre Installation, Backups, Updates und den Zugriff auf
verbundene Dienste. Beginne mit einer getrennten Testumgebung und überschaubaren Rechten.

**Du entwickelst mit KI-Werkzeugen.** Nutze die dokumentierten Zugänge von SubKit, um
Workflows vorzubereiten und Ergebnisse zu prüfen. Ein Coding-Agent arbeitet dabei mit
den Rechten seiner Identität. Seine Anbindung ersetzt keine Ausführungsfreigabe.

## Fünf Schritte für den Einstieg

1. **Aufgabe auswählen:** ein klares Ergebnis, wenige Systeme, eine zuständige Person.
2. **Betrieb vorbereiten:** Installation, Sicherung, Zugänge und Anbieter klären.
3. **Entwurf prüfen:** Daten, Bedingungen, Ausnahmen und erlaubte Wirkung durchgehen.
4. **Kontrolliert erproben:** mit geeigneten Testdaten prüfen, ob Ergebnis und Verlauf stimmen.
5. **Verantwortung festlegen:** erst dann den vereinbarten Einsatz freigeben und festhalten,
   wer Läufe beobachtet, Fehler bearbeitet und Änderungen prüft.

Das ist eine sinnvolle Reihenfolge, kein Versprechen einer bestimmten Einführungsdauer.

## Installation und Downloads

Mit der freigegebenen Beta werden hier die passende Installationsanleitung,
Downloadpakete, unterstützten Plattformen und Prüfsummen verlinkt. Verwende Anleitung
und Artefakte derselben freigegebenen Fassung.

Die technische Anleitung bleibt mit der Produktdokumentation abgestimmt. Zu einer
Installation gehören auch dauerhaft gesicherte Schlüssel und ein geprüfter
Wiederherstellungsweg.

## Quellen sammeln und prüfen

Für den Clipper ist ein Weg von der Sammlung über die Prüfung im Chat zur ausdrücklich
bestätigten Übernahme als Wissen oder Regel vorgesehen. Die ursprüngliche Quelle bleibt
Teil des Zusammenhangs. Der konkrete Lieferumfang und die Installationsmöglichkeiten
werden mit der freigegebenen Fassung beschrieben.

## Kosten und Betrieb

Das kostenlose Self-Hosting umfasst die Software, nicht deine Infrastruktur oder
Gebühren externer Anbieter. Du verantwortest die Installation, ihre Updates und Backups.
Prüfe außerdem, welche Daten ein freigegebener Ablauf an verbundene Dienste übermittelt.

## Kontakt und Unterstützung

Mit dem öffentlichen Start werden der Kontaktweg und die Zuständigkeit für Fragen,
Fehlerberichte und Sicherheitsmeldungen ausgewiesen.

END FRAMER LOSLEGEN

### Vergleiche

BEGIN FRAMER VERGLEICHE

Pfad: /vergleiche
Seitentitel: Wann SubKit passt – und welche Arbeit andere Werkzeuge übernehmen
Suchbeschreibung: Ordne SubKit ein: persönliche Assistenten, visuelle Automatisierung, autonome Agenten und der Betrieb geprüfter Workflows.

# Welches Werkzeug passt zur Aufgabe?

Die entscheidende Frage ist, wie die Arbeit später laufen soll. Musst du eine einmalige
Aufgabe lösen, jede Verzweigung selbst gestalten oder einen vereinbarten Ablauf für dein
Team betreiben? Die Grenzen sind nicht bei jedem Produkt gleich. Prüfe die konkrete
Lösung anhand deiner Anforderungen.

## Ein persönlicher Assistent

Er hilft bei Recherche, Entwürfen und einzelnen Aufgaben. Das passt, wenn du mitarbeitest
und das Ergebnis direkt beurteilst. Prüfe für wiederkehrende Teamarbeit zusätzlich,
wie Zuständigkeiten, Ausführungsrechte und Verlauf geregelt sind.

## Ein visuelles Automatisierungswerkzeug

Es passt, wenn du Schritte und Verzweigungen selbst zusammensetzen möchtest.
Wie gut der Betrieb funktioniert, hängt auch davon ab, wie Fehlerbehandlung,
Berechtigungen und Wartung für deinen Ablauf eingerichtet werden.

## Eine Plattform für autonome Agenten

Sie kann passen, wenn ein System innerhalb vereinbarter Grenzen selbst weitere Schritte
planen soll. Prüfe, wie Entscheidungen, Zugriffe und mögliche Änderungen nachvollzogen
und begrenzt werden. Die Fähigkeiten unterscheiden sich zwischen den Angeboten.

## SubKit

SubKit konzentriert sich auf den Betrieb vorbereiteter Workflows. KI unterstützt die
Vorbereitung. Eine Person prüft die erlaubte Wirkung. Ausgeführt wird die aktivierte
Workflow-Fassung innerhalb ihrer Rechte und Freigaben.

Auch ein festgelegter Workflow kann einen Modellaufruf enthalten. Dessen Antwort kann
variieren. Ein geprüfter Ausführungsweg garantiert deshalb nicht automatisch die
fachliche Richtigkeit jedes erzeugten Inhalts.

## Acht Fragen vor der Entscheidung

- Wer beschreibt den Ablauf und wer prüft ihn?
- Was ist beim nächsten Lauf festgelegt und was kann sich ändern?
- Welche Systeme und Daten darf der Ablauf erreichen?
- Kann eine Kollegin ihn starten, ohne ihn verändern zu dürfen?
- Wer bemerkt Fehler und wer bearbeitet sie?
- Welche Kosten entstehen für Einrichtung, Läufe und Betrieb?
- Wo liegen Daten und Zugänge, und wohin werden Daten übertragen?
- Können wir hinterher nachvollziehen, was passiert ist?

Lass dir diese Fragen an einer eigenen Aufgabe beantworten. Ein allgemeiner
Funktionsvergleich ersetzt diese Prüfung nicht.

## Mit einem Coding-Agent arbeiten

Ein Coding-Agent kann Software entwickeln und bei der Vorbereitung eines Workflows
helfen. SubKit stellt den gemeinsamen Betrieb mit Rechten, Freigaben und Verlauf bereit.
Eigene Skripte können ebenfalls sinnvoll sein; dann muss das Team deren Betrieb,
Zugänge, Änderungen und Fehlerbehandlung selbst gestalten.

## Wann SubKit weniger gut passt

Für eine einzelne lokale Aufgabe kann der zusätzliche Betrieb zu aufwendig sein.
Wenn du freies Arbeiten am Dateisystem, beliebige Shell-Aufrufe oder eine umfangreiche
Datenmigration brauchst, prüfe dafür geeignete Entwicklungs- und Datenwerkzeuge.
SubKit bietet kein gehostetes SaaS-Angebot.

Anwendungsfälle ansehen → /anwendungsfaelle

END FRAMER VERGLEICHE

### Link- und Abnahmeregister

| Bereich | Ziel vor Veröffentlichung | Aktueller Umgang im Entwurf |
| --- | --- | --- |
| Hauptnavigation | /, /anwendungsfaelle, /loslegen, /vergleiche | Erst nach Anlage der Zielseiten verlinken. |
| Quickstart | Anleitung der öffentlich geprüften Release-Fassung | Noch kein externer Button; Verfügbarkeit erklären. |
| Downloads und Quellcode | Freigegebene öffentliche Artefakte und Repository | Keine private Adresse und keinen ungeprüften latest-Link einsetzen. |
| Clipper | Freigegebenes ZIP und Installationsanleitung | Store-Badge erst nach öffentlicher Store-Verfügbarkeit. |
| Impressum und Datenschutz | Betreiberbestätigte, rechtlich geprüfte Seiten | Pflichtinhalt offen; Veröffentlichung bleibt gesperrt. |
| Support und Sicherheitsmeldungen | Bestätigte, funktionierende Kontaktwege | Keine erfundene E-Mail-Adresse oder Reaktionszeit. |
| Produktabbildungen | Freigegebene Aufnahmen mit isolierten Beispieldaten | Keine erfundenen Produktzustände zeigen. |

Der vollständige Artifact-Abgleich bleibt offen. Das Inhaltspaket ist bereits für
redaktionelle Arbeit nutzbar; es ersetzt weder diesen Abgleich noch Produkt-, Rechts-
oder Sichtabnahmen. Framer-Vorschau, Links und tatsächliche Website-Funktionen werden
nach dem Seitenaufbau geprüft. Automatische visuelle Matrizen werden nicht ausgeführt.

Die aktuelle L09-Einordnung und nächsten Schritte stehen ausschließlich in LAUNCH_STATUS.md.
Die allgemeinen Launch-Prioritäten bleiben bestehen.
