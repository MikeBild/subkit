# SubKit Launch-Status

Plan: [LAUNCH.md](LAUNCH.md) · Arbeitsvertrag: [LAUNCH_SYNC.md](LAUNCH_SYNC.md) ·
Prüfhistorie: [LAUNCH_EVIDENCE.md](LAUNCH_EVIDENCE.md), E01–E290.

## Aktueller Checkout-Abgleich

Integrierter Hosted-Stand `175901a0f` normal gepusht; Checkoutversion **10.1.3**.
Bestehende lokale Engine auf Loopback antwortet separat **9.11.2**, HTTP 200;
sie wurde nicht ersetzt. Lokaler Hosted-Arbeitsstand gesichert und wiederhergestellt;
Migrationskonflikt gelöst: veröffentlichte Historie unverändert, 49 fokussierte
Tests PASS (E262). Native Engine/CLI gebaut, native Prozessabnahme zwei PASS/27 Assertions (E272); Typecheck und 22 Invarianten PASS. Vollständiger Gesamtgate und weitere Scheduler-Grenzen offen.
Alle acht Pre-Push-Gates bestanden für den gepushten Stand (E276). Neuer lokaler nativer Lifecycle-Zwischenstand zwei PASS/31 Assertions (E288); Container-URI-Korrektur acht PASS/24 Assertions (E289). Vier aktuelle PostgreSQL-Dateien 30 PASS/140 Assertions (E290); abschließender Engine-/Cockpit-Typecheck Exit 0. Begrenzte Scheduler- und Datei-Referenzarbeit lokal implementiert;
kein Release, Deploy oder Signup-Go aus dieser Integration.

## Historischer Release- und Planungsstand

- Letztes Update: **2026-10-19T05:27:39+00:00**; Planung in Europe/Berlin.
- Zuletzt bestätigter gemeinsamer Stand: **0a2b4312a**, `main`, Version **10.0.1** vorbereitet.
  E220–E230 normal geprüft gepusht; alle acht Hooks bestanden. Historisches Gesamtgate E224 einschließlich Queue-Adapter bestanden; die damaligen Produktquellen waren identisch zum gepushten Stand.
- Hosted-Integration bis **175901a0f gepusht**, neue Scheduler-Änderungen **LOCAL_ONLY**; E224 ist ein historischer Nachweis des vorherigen Quellstands und kein Gesamt-PASS für diese Änderungen.
- Countdown am 18.10.: **9/10 Tage bis Beta am 27./28.10.**, **28 Tage bis GA am 15.11.**
- Beta-Freigabe **ROT**, Terminprognose **GELB**: bedingt erreichbar.
- GA-Freigabe **ROT**, Terminprognose **GELB**: insbesondere externe Store-Freigabe offen.

**Historische Übergabe vor Start des Hosted-Goals, E231:** Drei aufeinanderfolgende
Prüfungen ohne neue Voraussetzungen. Geeignete Linux-x64-Testumgebung, passender
Signing-Key-Pfad und Lovable-Verbindung fehlen; Rechts-/Verarbeitungsangaben sowie
menschliche Abnahmen bleiben offen. Lokales CLI-Profil um 18:23 UTC erneut mit
Exit 2/unauthorized geprüft. Keine neuen Tests gestartet oder Fachaufgaben auf DONE
gesetzt; nächste Schritte und benötigte Eingaben stehen unten.

## Aktive Cloud-Arbeit

Den operativen Cloud-Status einschließlich H01–H09 führt ausschließlich
[docs/TODO.md](docs/TODO.md#aktueller-implementierungsstand-und-nachweise).
main-Integration abgeschlossen; E271–E273 beschreiben Matrixabschnitte, nativen Kandidaten
und aktuelle Komponentenchecks. Ein neuer vollständiger Gesamtgate ist weiterhin offen.

**L13: historisches vollständiges Gate PASS für den vorherigen Quellstand, E224.** `bun run verify` am 18.10.
16:32–17:41 UTC mit Exit 0 abgeschlossen: **2.051 isolierte Dateien, 19.692 PASS/
0 FAIL/37 SKIP/5 TODO**; danach AI-Eval, nativer Build, Clipper-Binärprüfung und
**42 E2E-Dateien, 257 PASS/0 FAIL/20 SKIP/3 TODO** bestanden.
Quellhashes während des gesamten Laufs unverändert und nach Abschluss mit aktuellem
main abgeglichen. Basis 52bd51127 plus Queue-Patch, inzwischen als 09024fdd3 gepusht;
45e58f53d enthält dieselben Produktquellen. Receipt/Log und kompakte Zusammenfassung:
`.artifacts/launch/queue-error-fields-full-verify.{json,log}` und `-summary.json`.
Keine gesamte Release-/Security-/Launch-Freigabe und kein Linux-x64-Referenzbenchmark.

**Separate Opt-in-Nachweise:** E216 zehn echte lokale Modelltests, E217 zwölf
native CLI-PTY-Tests und E222 sieben echte Gesprächs-E2E-Tests jeweils PASS/0 FAIL/
0 SKIP. E222 prüft Connector-/Workflow-Erstellung samt Audit, Mehrfachdialog,
kompilierte CLI-Wiederaufnahme und Ablehnung. Fixtures bereinigt; Providerkey nicht
im Log. Damit sind acht Modell-, zehn PTY- und sechs Real-LLM-Skips separat geschlossen.
Verbleibend: 29 optionale Connector-URL-Checks, vier private AppSync-/Cognito-Fälle,
fünf isolierte und drei E2E-TODOs. Keine neue pauschale Releasefreigabe daraus ableiten.

**Knowledge-Journey E219 funktional bestanden, Laufzeit nur PARTIAL:** echtes
Modell → Vorschlag → explizite Browserbestätigung → Suche/MCP/CLI/gemeinsame
Hook-Discovery, 21 Nachweisprüfungen. Vor Bestätigung kein normaler Suchtreffer;
Inhalt, Ziel und Provenienz geprüft. Source-Runtime 0.0.0-dev, CLI separat 10.0.1;
kein aktueller Docker-/Kanal-/nativer Codex-/Claude-Dispatch-Nachweis.

**Queue-Ursache UNKNOWN:** fünf nichtfatale opake Fehler aus E219 in zwei isolierten
Wiederholungen und E222 nicht reproduziert. E220/E221 sichern den tatsächlichen
Listener ab: Plain-Record-Meldungen bleiben klassifiziert; SQL-/Parameter-/Jobdaten
und Token werden redigiert. 101 gezielte Tests sowie injizierte Listener-Proben
bestanden. Keine Queue-/Timeout-/Execution-Semantik geändert und keine behobene
Ursache behauptet. Der JSON-Parse-Text im Gesamtlog stammt aus einem bestandenen
Negativtest für ungültige globale Hook-Konfiguration.

**Nächster Codex-Schritt:** ausreichend versorgte isolierte Linux-x64-Umgebung
prüfen, aktuellen Kandidatenstart sowie Installation/Upgrade/Restore und Kategorie-/
RBAC-Parität nachweisen. E225: Docker-VM nach Gate-Ende erneut ohne ausreichende
Reserve. Geeigneter Host und lokaler Pfad zum passenden bestehenden Signing-Key
angefragt, Antwort ausstehend. E224 wiederverwenden; keine blinden
Docker-Vollstarts, fremden Demoänderungen oder Veröffentlichungen.

## Aufgaben

Nur diese Tabelle führt die L-Aufgabenstatus; der Snapshotstand ist oben datiert. Rollen, Fristen und DoD: LAUNCH.md.
DONE setzt einen passenden Nachweis voraus; bestehende gültige Ergebnisse wiederverwenden.

| ID | Status | Belegter Fortschritt und verbleibendes Ergebnis |
| --- | --- | --- |
| L01 | DONE | Bestandsaufnahme und Scope, E01–E10; kein vollständiges Security-Audit. |
| L02 | DONE | Launch-Dateien/AGENTS-Verweis erstellt und geprüft, E11; 01257eb8a gepusht, E15. |
| L03 | DONE | Clipper-Generator korrigiert, macOS/Linux identisch; 63 Tests bestanden, E12; 61ee865d3 gepusht, E15. Aktuelle Versionsartefakte separat E202. |
| L04 | IN_PROGRESS | Notice-Auslieferung geprüft, E106/E168. Drei JS-Zuordnungen, Modellrechte, Plattform-/Quell-/Relink-Abdeckung und juristische Freigabe offen. Historischer Firebase-Clientkey: Einschränkung/Stilllegung menschlich belegen, E19/E27. |
| L05 | IN_PROGRESS | Lokaler Release-Weg, Signaturprüfung, Installer, Lizenzdownload und Retention/Rollback implementiert/geprüft, E13–E21/E51/E127–E133. E229: aktuelle Linux-x64-Engine und fünf CLI-Plattformbinaries intern gebaut, zweimal im gleichen Checkout hashidentisch. Echter signierter Kandidatenlauf und öffentliche Distribution offen; passender privater Schlüssel fehlt. |
| L06 | BLOCKED | Betreiber/Kontakt bestätigt, E176. Tatsächliche Hosting-/Versandverarbeitung, vollständige Pflichttexte und juristische Freigabe fehlen. |
| L07 | DONE | Quickstart/Backup/Recovery mit frischer Linux-amd64-Installation, Neustart und Restore geprüft, E22; 765a2fe26 gepusht. Öffentlicher Test L15 und aktuelles Upgrade L18 bleiben separat. |
| L08 | IN_PROGRESS | QuickJS-Worker-/Container-Fix geprüft, E158. Operator-/Tenant-Grenzen: 142 Tests und browser-use bestanden, E206. Imageaudit E190 ohne HIGH/CRITICAL. E227/E229: QuickJS-WASM und sieben Embedding-/ONNX-Assets in nativer sowie cross-kompilierter Linux-x64-Engine bytegenau identifiziert. E228: Patch-Provenienz und echte native Worker-Regression PASS. Linux-Ausführung, Docker-/übrige Native-Abdeckung und finale Security-Freigabe offen. |
| L09 | IN_PROGRESS | Lovable-Entwurf, acht Seiten DE/EN, Systemtheme/-sprache, Social/Consent vorbereitet; Build und 41 Tests laut E176 bestanden. Texte, Produktbilder, tatsächlicher Formularversand, Pflichttexte, öffentliche Downloads, Domain und Abnahmen offen. WEBSITE-TODO.md ist maßgeblich. |
| L10 | IN_PROGRESS | ZIP 10.0.1: Versions-/Drift-/Archivprüfung bestanden, E202. Listing, Icons, historische Medien und private Übergabe vorbereitet, E147–E152/E166. Pflichtlinks, Medienabnahme und menschliche Zertifizierung offen. |
| L11 | IN_PROGRESS | Nutzer hat 9.15.2 eingereicht; letzter Store-Handoff PENDING_REVIEW, E186. E223: konkrete Listing-ID im anonymen Browser zeigt Item not available; aktueller Dashboard-Status UNVERIFIED. Öffentliche Clipper-Privacy fehlt. Keine automatische erneute Einreichung des lokalen 10.0.1-Pakets. |
| L12 | IN_PROGRESS | **E219: echtes Modell → Knowledge-Vorschlag → Browserbestätigung → Suche/MCP/CLI/Hook-Discovery funktional bestanden; fünf opake Queue-Fehler bleiben unaufgeklärt.** Reale Browser-/Provider-Skill-Journey E185; Knowledge E193; Browser→CLI/MCP/Hook-Handler E200; Clipper→Admission E203; persistierter Chat→Proposal→Bestätigung E205 jeweils begrenzt bestanden. Aktueller Gesamt-/Kategorie-/RBAC-/Kanalnachweis und zuverlässiger Kandidatenstart offen, E194–E196/E201. |
| L13 | IN_PROGRESS | **Historisches vollständiges Gate E224 PASS (vor Hosted-Änderungen):** 2.051 isolierte Dateien/19.692 Tests, AI-Eval, nativer Build, Clipper-Binärprüfung und 42 E2E-Dateien/257 Tests; Exit 0, Produktquellhashes unverändert. E216/E217/E222 schließen acht Modell-, zehn PTY- und sechs Real-LLM-Skips separat. Historische Läufe E207–E215 bleiben in der Prüfhistorie. E229: interne Plattform-Builds lokal zweimal identisch. Referenzbenchmark, signierter Kandidat und finale Release-Route offen. |
| L14 | BLOCKED | L04/L05/L13 und Freigaben für Repository-Öffnung/Artefaktpublikation fehlen. |
| L15 | TODO | Installation durch externen Nutzer aus öffentlichen Kandidatenartefakten. |
| L16 | BLOCKED | Website-/Rechtsabnahme und Veröffentlichungsfreigabe fehlen. |
| L17 | TODO | Beta-Go nach vollständigen P0-Nachweisen. |
| L18 | IN_PROGRESS | Begrenztes Upgrade 9.9.0→lokaler 9.15.2-Kandidat und Restore bestanden, E72. Aktuelle Beta→GA-/Migrations-/Provenienzstrecke offen. |
| L19 | BLOCKED | Erfolgreiche öffentliche Release-Strecke fehlt; bekannte Actions-Verfügbarkeit extern, keine Billing-Aufgabe. |
| L20 | TODO | Beta-Befunde/Security und Betriebsdokumentation. |
| L21 | BLOCKED | Öffentliche Store-Installation und vollständige Clipper-Privacy fehlen. E223: konkretes Listing anonym nicht verfügbar; aktueller interner Reviewstatus nicht verifiziert. |
| L22 | TODO | Finale GA-Gates und menschliche Abnahme. |
| L23 | TODO | Öffentliche GA, Kommunikation und Supportübernahme. |
| L24 | TODO | P2-Roadmap bis nach Launch zurückgestellt. |
| L25 | BLOCKED | **E230: SubKit-App in dieser Session authentifiziert, domänenbegrenzte Knowledge-Suche mit drei quellreferenzierten Treffern.** Kein nativer Clientdispatch daraus abgeleitet. Isoliertes CLI-/Hook-Handler-Briefing und permission-scoped Reminder bestanden, E38/E199/E200. E219 ergänzt Discovery der realmodellgestützt aufgenommenen Quelle über gemeinsame Hook-Handler, weiterhin kein nativer Clientdispatch. Nutzerprofil am 18.10. 18:23 UTC erneut lesend geprüft: Exit 2/unauthorized, E231 (vorher E213/E32). Tatsächlicher Clientdispatch, freigegebener Datenfluss und Daily-/Weekly-Lesezugriff fehlen; E150/E180. Keine globale Konfiguration geändert. |

## Fünf dominante Blocker / kritischer Pfad

1. **Zuverlässiger aktueller Kandidat:** intermittierende DB-Timeouts in `queue_start`,
   E194/E196. Weitere Gegenprobe E201 scheitert bereits bei Migrationen unter hoher
   Memory-PSI. Ursache nicht abschließend bewiesen. E219 zeigt zusätzlich fünf opake Queue-Fehler
   in der Source-Fixture bei funktionierendem Realmodell-Review. Vollständiges
   Host-Gate E224 bestanden; aktuelles Image samt Operator-Migration fehlt.
2. **Öffentliche Distribution:** signierte 10.0.1-Artefakte, passende Schlüssel,
   Referenzbenchmark und extern installierbare Kandidaten nicht vollständig belegt.
3. **Sicherheit/Rechte:** öffentliche Historien-/Lizenzfreigabe, drei bekannte
   Lizenzzuordnungen, Modell-/Quell-/Relink-Fragen und finale Security-Abnahme offen.
4. **Website/Recht/Support:** Entwurf vorhanden, tatsächliche Verarbeitung,
   Pflichttexte, Formularzustellung und gemeinsame Abnahme/Publikation fehlen.
5. **GA:** Google-Freigabe und öffentliche Store-Installation, erfolgreiche
   Release-Strecke sowie finale Upgrade-/Rollback-/Produktabnahme fehlen.

Kritischer technischer Pfad: Diagnosefehler schließen → vollständiges Gate →
aktuellen Kandidaten bauen und sicher installieren → Startzuverlässigkeit und
Upgrade/Restore abnehmen → signierte Distribution → externe Installation → Beta-Go.
Website/Recht und Google-Review laufen unabhängig davon, soweit Zugang/Freigaben vorliegen.

## Letzte abgeschlossene Nachweise und ihre Grenzen

| Prüfung | Belegter Stand |
| --- | --- |
| Vollständiges lokales Gate | **E224: historisches PASS vor Hosted-Änderungen**, Exit 0, Produktquellhashes unverändert und identisch zu main. 2.051 isolierte Dateien: 19.692 PASS/0 FAIL/37 SKIP/5 TODO; AI-Eval, nativer Build, Clipper-Binärprüfung und 42 E2E-Dateien: 257 PASS/0 FAIL/20 SKIP/3 TODO. E215 und E181 sind historische Vorgänger. |
| Historische Gate-Fehler | E207: S3-Fixture bei voller Docker-Platte; E209: Issuer-Recovery; E210: historischer ORM-Insert. Jeweils gezielt korrigiert und anschließend im vollständigen E224 bestanden. E212 bleibt eine historische Diagnosefortsetzung. Frühere Logs erhalten; E224 ist der spätere eigenständige Gesamt-PASS. |
| Reale Modelle | **E222: aktuelle HTTP-/CLI-Gesprächssuite 7 PASS/0 FAIL**, Workflow/Audit und Ablehnung geprüft. E216: zehn lokale Embedding-/Retrieval-/Routingtests PASS. E219: reale Browser-Knowledge-Journey funktional bestanden, Queue-Ursache offen. E169/E170/E185 historisch; keine Abnahme aller Kanäle oder erneute Bestätigung der Produktions-Fallbackroute. |
| Interne Cross-Builds | **E229:** Linux-x64-Engine und fünf CLI-Binaries für macOS ARM64/x64, Linux ARM64/x64, Windows x64 auf 80a9f9063 gebaut. Zwei Durchläufe im selben Checkout/Cache hashidentisch, sechs Dateiheader und CLI-Prüfsummen korrekt. Native macOS-CLI nach bestehendem lokalen Ad-hoc-Schritt: --version 10.0.1. Kein signierter Release oder Fremdplattform-Lauf. |
| ARM64-Image/Installation | E184/E185: 10.0.0 auf d2eeb2aaa bestanden. Aktualisiertes Image beba30b7196f auf 48f07dabf gebaut, E187; elf Installationschecks mit Host-Datenspeicher bestanden, E189. Kein aktuelles 10.0.1-/Operator-Image. |
| Sicherheit | E158: QuickJS-Worker-Regression einschließlich damaligem Gesamtgate bestanden. E190: historisches Image mit Trivy 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW, 176 Advisories; WASM nicht separat gescannt. E227/E228: native Asset-Identität, gepatchter Build und echte native Worker-Regression PASS/Cleanup. E229 ergänzt vollständige QuickJS-/Embedding-Payload-Identität im cross-kompilierten Linux-x64-ELF. Keine vollständige Schwachstellenbewertung oder aktuelle Linux-/Docker-Abnahme. |
| Lizenzen | E168: 495 erfasste Texte plus Produktlizenz im Image/Installer bestätigt. Rechte-/Zuordnungs-/Plattformfragen bleiben separat offen. |
| Upgrade/Restore | E72: begrenzte Strecke 9.9.0→9.15.2 und Restore bestanden; keine finale Beta→GA-Abnahme. |
| SubKit-App-Zugang | **E230:** lesendes whoami und Knowledge-Suche mit domain:subkit erfolgreich; drei Treffer, alle Domänen-Tags und Quellenreferenzen korrekt. Kein Schreibaufruf; im Nachweis keine Inhalte/Identifikatoren gespeichert. Lokales CLI-Profil, native Hooks, Daily/Weekly und vollständiger ChatGPT-Kontext bleiben separat unbestätigt. |
| Öffentlich | Aktuelle Beta/GA und Produktwebsite nicht nachgewiesen/freigegeben. Eingereicht ist nicht Store-veröffentlicht. Lokales PASS und Push ersetzen keine Veröffentlichung. |

Image E187 wurde nur aus dem Docker-Cache entfernt, E208. Geprüftes Archiv und
Nachweise bleiben erhalten: `.artifacts/launch/integrated-candidate-image.tar`.
Bei Bedarf gezielt laden oder neuen Kandidaten bauen. Keine fremden Ressourcen bereinigen.

## Produkt-, Test- und Nutzerentscheidungen

- Self-Hosting-Launch vor neuen Features in seinem Scope; zusätzliche Cloud-Planung
  nach docs/PRODUCT-ROADMAP.md. Kostenloses Self-Hosting; Website ausschließlich in
  Lovable, vollständig DE/EN. Bestätigte Betreiber-/Kontakt-/Domainangaben nicht erneut erfragen.
  Der Nutzer stellt täglich 1–2 Stunden für Entscheidungen und Abnahmen bereit.
- Autonome Launch-Umsetzung und Commit/Push mit normalen Hooks sind freigegeben.
  Release, Tags, Deployment, Repository-Öffnung und Store-Einreichung bleiben separat freizugeben.
- Nutzerentscheidung 18.10.: Playwright-/Screenshot-Testprogramme entfernt, E204,
  75b70bc45 gepusht. Browserabnahme nur browser-use mit Codex/Claude Code;
  keine Screenshotmatrizen. API-/Domänen-/Security-/Contract-/Build-Gates bleiben.
  Historische Browsernachweise bleiben historisch gültig, gelöschte Runner nicht wiederherstellen.
- Aktuelle Intake-Scopeänderung in LAUNCH.md: Session-Learnings sind Sammelgut;
  nur eine berechtigte Person bestätigt im Browser Wissen oder Skill. Die entfernten
  Learning-Skill-Kandidaten, `create_skill`/`propose_skill` und `sk learnings` nicht wieder einführen.
  Vorbereitende PROD-Bereinigung war separat einzeln freigegeben; Wiederherstellung
  fälschlich verworfener Vorschläge folgt erst nach gesondert freigegebenem Deploy.
- Nicht-Operator-Tenants sehen Cockpit-Einstellungen derzeit schreibgeschützt;
  eigene Werte ändern sie per CLI mit explizitem Tenant, README/E206.
- Keine produktiven Daten oder globalen Agent-Konfigurationen in dieser Prüfstrecke verändert.

## Offene menschliche Entscheidungen und externe Voraussetzungen

- Passender bestehender Signing-Key; Referenzsystem Linux x64, 4 CPU, mindestens 8 GiB.
- Nachweis zur Einschränkung/Stilllegung des historischen Firebase-Keys und offene Lizenzrechte.
- Hosting-/Formular-/Retention-Datenfluss und juristische Freigabe der Pflichttexte.
- Manuelle Produkt-/Website-/Store-Medienabnahme; gesonderte Publikationsfreigaben.
- Authentifiziertes CLI-Profil, echte Kanalzugänge und Freigabe des Hook-/Transkript-Datenflusses.
  Der separate SubKit-App-Lesezugang ist mit E230 geprüft und muss nicht neu eingerichtet werden.
  Codex CLI 0.163.0 und Claude Code 2.1.296 installiert; lesender Refresh in
  `.artifacts/launch/native-client-readiness.json`. Nativer Lifecycle weiterhin UNVERIFIED;
  neue Codex-Hooks benötigen [Prüfung und Vertrauen](https://learn.chatgpt.com/docs/hooks).
- Daily/Weekly laut Nutzer vorhanden; tatsächliche Läufe/Lesezugriff UNVERIFIED, E180.
  Keine automatische Verbindung zum gesamten ChatGPT-Projekt behaupten.
- Offizielles Lovable-Plugin gefunden, aber nicht verbunden; Tools nicht verfügbar.
  Bereits bestehende Verbindungsaufforderung nicht erneut gestellt. Website-Entscheidungen und
  privater Handoff in WEBSITE-TODO.md; kein neuer Projekt-/Deploymentstatus behauptet.
- Store 9.15.2 zuletzt laut Handoff PENDING_REVIEW, E186; E223 bestätigt anonym
  nicht abrufbares Listing, kein aktueller interner Reviewstatus. DE/EN-Clipper-Privacy
  in Lovable vorbereitet, unveröffentlicht; geprüfte vorläufige öffentliche Privacy deckt
  bislang nur die Website ab. Keine erneute Einreichung ohne gesonderte Freigabe.

## Nächste drei Aufgaben

1. **L12/L18 P0/P1:** auf ausreichend versorgtem isoliertem System aktuellen
   Kandidatenstart, Installation/Upgrade/Restore und Kategorie-/RBAC-Parität prüfen.
   E195 ist Teilnachweis; ursprüngliche Queue-Ursache offen. E225 bestätigt am 18.10. 17:44 UTC erneut die
   Docker-VM-Grenze: etwa 353 MiB MemAvailable, 176 KiB SwapFree, Platte 98 %.
   Keine blinden Vollstarts und keine Eingriffe in fremde Demos; Host angefragt.
2. **L05/L13 P0:** passenden bestehenden Signing-Key und Linux-x64-Referenzsystem
   (4 CPU, mindestens 8 GiB) bereitstellen; danach fehlende signierte Kandidaten-
   und Benchmarknachweise innerhalb der bestehenden Release-Grenzen erbringen.
   E224 und gültige Modell-/PTY-/Live-Nachweise wiederverwenden; keine Tags als Abkürzung.
3. **L04/L06/L09/L10/L25:** fehlende Rechte-/Hosting-/Formular-/Privacy-Angaben,
   offizielle Lovable-Verbindung, authentifiziertes Nutzerprofil und menschliche
   Abnahmen ergänzen. L11/L21: konkretes Store-Listing anonym nicht verfügbar, E223;
   aktueller interner Reviewstatus UNVERIFIED. Keine automatische Veröffentlichung.

Bekannte Lizenzrecherchen E137–E143 nicht wiederholen: alle 103 Polyfill-Versionen
haben Originaltexte. Vier lokale Source-Archive E144 vorhanden; fehlende Toolchains
in E145. Kein Wiederaufbau und keine öffentliche Quellauslieferung behauptet.

## Historischer Dokumentationsabgleich auf origin/main

Aktuelle Dokumentfortschreibung vom **19.10.2026**, **LOCAL_ONLY**. Neuer Auftrag:
zusätzliche kostenlose begrenzte Cloud-Self-Service-Beta planen, Dokumentation
konsolidieren und per passenden MCPs gegenprüfen. [Roadmap](docs/PRODUCT-ROADMAP.md)
führt Zielbild und Quellen; [Produktaufgaben](docs/TODO.md) führt C01–C09.
Bestehende L-Status und E01–E231 bleiben historische Nachweise mit ihrem Geltungsbereich.

- Main vor Bearbeitung sauber; `git pull --ff-only origin main` erfolgreich,
  Basis b5d8c6a5e. Checkoutversion **10.1.1**, lokale Engine /health **9.15.2**.
  Keine Änderung oder Abnahme der lokalen Installation und kein Cloud-Runtime-Nachweis.
- Offizieller Lovable-MCP erneut lesend: bestehendes Projekt bereit/unveröffentlicht,
  gleicher Commit wie beim Planungsabgleich der Projektdateien. Damit ist der
  historische Blocker „Lovable-Verbindung fehlt“ für diese Session aufgehoben;
  Rechts-/Sichtabnahme, Mailzustellung und öffentliches Hosting bleiben offen.
- SubKit-Domänensuche liefert bisherige Positionierung, keinen belastbaren SaaS-
  Betriebsplan. BrowserStack-Werkzeuge nicht verfügbar; Plugin-Suche im
  Planungsabgleich ohne Treffer. Kein BrowserStack-Konto, Tarif oder Lauf verifiziert.
- Roadmap, vollständige bisherige Root-TODO, BrowserStack-Strategie und Lovable-
  Briefing/Setup konsolidiert; README/AGENTS/Launch-Quellen zugeordnet. Die frühere
  SaaS-Ausschlussentscheidung ist abgelöst, Self-Hosting-Launchtermine bleiben getrennt.
- E260: 90 lokale Markdown-Verweise einschließlich Ankern in 13 Dokumenten geprüft;
  `git diff --check` bestanden. `bun run gen:llms-txt` erfolgreich; erneute Generierung
  über beide Assets byte-identisch, aktueller README-Inhalt eingebettet.
- `bun test packages/shared/src/tests/llms-index.test.ts apps/engine/src/http/routes/llms-txt.test.ts`:
  **9 PASS, 0 FAIL, 26 Assertions**. `bun run lint`: Exit 0, 4.467 Dateien,
  58 bestehende Warnungen und 17 Hinweise in unverändertem Code; keine Fixes angewandt.
- Toolchain dieser gezielten Prüfungen: Bun **1.3.13**, abweichend von .bun-version
  **1.4.0**. Kein Release-Nachweis. Vollständiges verify, Build, lokale Demo-/Browser-
  und Cloud-Live-Gates wegen reinem Dokumentationsumfang nicht ausgeführt. Das normale
  Git-basierte Driftgate vergleicht gegen HEAD; für die noch uncommitteten beabsichtigten
  Assetänderungen stattdessen identische Wiederholung des Generators geprüft.
  Kein Release, kein Deploy oder Publishing.

Damals vorgesehene nächste Schritte: offene Entscheidungen der Roadmap festlegen, danach C01–C03
als fokussierte technische Inkremente beauftragen; C04–C09 vor Registrierungseröffnung
abschließen. Website-Änderungen erst anhand konkreter Lovable-Zustände umsetzen.
