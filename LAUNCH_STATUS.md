# SubKit Launch-Status

Plan: [LAUNCH.md](LAUNCH.md) · Arbeitsvertrag: [LAUNCH_SYNC.md](LAUNCH_SYNC.md) ·
Prüfhistorie: [LAUNCH_EVIDENCE.md](LAUNCH_EVIDENCE.md), E01–E211.

- Letztes Update: **2026-10-18T14:04:57.124970+00:00**; Planung in Europe/Berlin.
- Zuletzt bestätigter gemeinsamer Stand: **57ff2f530**, `main`, Version **10.0.1** vorbereitet.
  Lokal und origin/main waren vor Diagnosestart gleich; alle acht normalen Push-Gates bestanden.
- Aktuelle Dokumentfortschreibung: **LOCAL_ONLY bis Push**. Produktquellen während der Diagnose unverändert.
- Countdown am 18.10.: **9/10 Tage bis Beta am 27./28.10.**, **28 Tage bis GA am 15.11.**
- Beta-Freigabe **ROT**, Terminprognose **GELB**: bedingt erreichbar.
- GA-Freigabe **ROT**, Terminprognose **GELB**: insbesondere externe Store-Freigabe offen.

## Aktive Arbeit und nächster Codex-Schritt

**L13:** Diagnose der übrigen isolierten Testdateien auf 57ff2f530 läuft seit
2026-10-18T13:52:03.527923+00:00, Tool-Prozess **86219**.
Letzte Live-Beobachtung: Datei 329/1282 (providers.test.ts); 2358 Tests PASS, 0 FAIL.
Receipt/Log: `.artifacts/launch/operator-post-migration-diagnostic.{json,log}`.
Dieser `--start-after`-Lauf ist **kein vollständiges Release-Gate**.

Denselben Prozess bis zum autoritativen Exit verfolgen; nicht wegen eines
Beobachtungs-Timeouts neu starten. Weitere Fehler gezielt beheben und prüfen.
Anschließend das vollständige `bun run verify` von Beginn an ausführen.
Nur eine aktive technische Prüfstrecke; keine konkurrierenden Produktänderungen.

## Aufgaben

Nur diese Tabelle führt den aktuellen Aufgabenstatus. Rollen, Fristen und DoD: LAUNCH.md.
DONE setzt einen passenden Nachweis voraus; bestehende gültige Ergebnisse wiederverwenden.

| ID | Status | Belegter Fortschritt und verbleibendes Ergebnis |
| --- | --- | --- |
| L01 | DONE | Bestandsaufnahme und Scope, E01–E10; kein vollständiges Security-Audit. |
| L02 | DONE | Launch-Dateien/AGENTS-Verweis erstellt und geprüft, E11; 01257eb8a gepusht, E15. |
| L03 | DONE | Clipper-Generator korrigiert, macOS/Linux identisch; 63 Tests bestanden, E12; 61ee865d3 gepusht, E15. Aktuelle Versionsartefakte separat E202. |
| L04 | IN_PROGRESS | Notice-Auslieferung geprüft, E106/E168. Drei JS-Zuordnungen, Modellrechte, Plattform-/Quell-/Relink-Abdeckung und juristische Freigabe offen. Historischer Firebase-Clientkey: Einschränkung/Stilllegung menschlich belegen, E19/E27. |
| L05 | IN_PROGRESS | Lokaler Release-Weg, Signaturprüfung, Installer, Lizenzdownload und Retention/Rollback implementiert/geprüft, E13–E21/E51/E127–E133. Echter signierter Kandidatenlauf und öffentliche Distribution offen; passender privater Schlüssel fehlt. |
| L06 | BLOCKED | Betreiber/Kontakt bestätigt, E176. Tatsächliche Hosting-/Versandverarbeitung, vollständige Pflichttexte und juristische Freigabe fehlen. |
| L07 | DONE | Quickstart/Backup/Recovery mit frischer Linux-amd64-Installation, Neustart und Restore geprüft, E22; 765a2fe26 gepusht. Öffentlicher Test L15 und aktuelles Upgrade L18 bleiben separat. |
| L08 | IN_PROGRESS | QuickJS-Worker-/Container-Fix geprüft, E158. Operator-/Tenant-Grenzen: 142 Tests und browser-use bestanden, E206. Imageaudit E190 ohne HIGH/CRITICAL; Native/WASM-/Artefaktabdeckung, übrige Befunde und finale Security-Freigabe offen. |
| L09 | IN_PROGRESS | Lovable-Entwurf, acht Seiten DE/EN, Systemtheme/-sprache, Social/Consent vorbereitet; Build und 41 Tests laut E176 bestanden. Texte, Produktbilder, tatsächlicher Formularversand, Pflichttexte, öffentliche Downloads, Domain und Abnahmen offen. WEBSITE-TODO.md ist maßgeblich. |
| L10 | IN_PROGRESS | ZIP 10.0.1: Versions-/Drift-/Archivprüfung bestanden, E202. Listing, Icons, historische Medien und private Übergabe vorbereitet, E147–E152/E166. Pflichtlinks, Medienabnahme und menschliche Zertifizierung offen. |
| L11 | IN_PROGRESS | Nutzer hat 9.15.2 eingereicht; synchronisierter Store-Handoff meldet PENDING_REVIEW, E186. Öffentliche Clipper-Privacy fehlt. Keine automatische erneute Einreichung des lokalen 10.0.1-Pakets. |
| L12 | IN_PROGRESS | Reale Browser-/Provider-Skill-Journey E185; Knowledge E193; Browser→CLI/MCP/Hook-Handler E200; Clipper→Admission E203; persistierter Chat→Proposal→Bestätigung E205 jeweils begrenzt bestanden. Aktueller Gesamt-/Kategorie-/RBAC-/Kanalnachweis und zuverlässiger Kandidatenstart offen, E194–E196/E201. |
| L13 | IN_PROGRESS | Gesamtgate E207/E209 fehlgeschlagen; S3-Fixture und Issuer-Recovery gezielt korrigiert. E210: zehn historische Fixtures korrigiert, alle 25 Migrationsdateien/88 Tests und Typecheck bestanden. Diagnose läuft; kein aktuelles Gesamt-PASS. Referenzbenchmarks und finale Release-Route offen. |
| L14 | BLOCKED | L04/L05/L13 und Freigaben für Repository-Öffnung/Artefaktpublikation fehlen. |
| L15 | TODO | Installation durch externen Nutzer aus öffentlichen Kandidatenartefakten. |
| L16 | BLOCKED | Website-/Rechtsabnahme und Veröffentlichungsfreigabe fehlen. |
| L17 | TODO | Beta-Go nach vollständigen P0-Nachweisen. |
| L18 | IN_PROGRESS | Begrenztes Upgrade 9.9.0→lokaler 9.15.2-Kandidat und Restore bestanden, E72. Aktuelle Beta→GA-/Migrations-/Provenienzstrecke offen. |
| L19 | BLOCKED | Erfolgreiche öffentliche Release-Strecke fehlt; bekannte Actions-Verfügbarkeit extern, keine Billing-Aufgabe. |
| L20 | TODO | Beta-Befunde/Security und Betriebsdokumentation. |
| L21 | BLOCKED | Eingereichte 9.15.2 wartet auf Google-Freigabe; öffentliche Store-Installation und vollständige Clipper-Privacy fehlen. |
| L22 | TODO | Finale GA-Gates und menschliche Abnahme. |
| L23 | TODO | Öffentliche GA, Kommunikation und Supportübernahme. |
| L24 | TODO | P2-Roadmap bis nach Launch zurückgestellt. |
| L25 | BLOCKED | Isoliertes CLI-/Hook-Handler-Briefing und permission-scoped Reminder bestanden, E38/E199/E200. Nutzerprofil zuletzt unauthorized, E32. Tatsächlicher Clientdispatch, freigegebener Datenfluss und Daily-/Weekly-Lesezugriff fehlen; E150/E180. Keine globale Konfiguration geändert. |

## Fünf dominante Blocker / kritischer Pfad

1. **Zuverlässiger aktueller Kandidat:** intermittierende DB-Timeouts in `queue_start`,
   E194/E196. Weitere Gegenprobe E201 scheitert bereits bei Migrationen unter hoher
   Memory-PSI. Ursache nicht abschließend bewiesen. Neues vollständiges Gate und
   aktuelles kompiliertes Image einschließlich Operator-Migration fehlen.
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
| Vollständiges lokales Gate | **E181: PASS auf f489823b1**, Exit 0, unveränderte Quellhashes; 2.051 Dateien, E2E 257 PASS/0 FAIL/20 SKIP/3 TODO. Historischer Stand, nicht aktueller Operator-Kandidat. |
| Neuere Fehlversuche | E207: S3-HTTP-500 bei voller Docker-Platte; echte Host-Speicher-Gegenprobe 2 PASS/20.978 Assertions. E209: fehlender Issuer-Recovery-Hinweis, korrigiert mit 33 PASS. E210: historischer ORM-Insert, korrigiert mit 88 PASS. Kein zusammengesetztes Gesamt-PASS. |
| Reale Modelle | E169: Live-Gate 6 PASS; E170: HTTP-/CLI-Gesprächssuite 7 PASS. E185: reale Container-/Browser-/Provider-Skill-Journey. Keine Abnahme aller Kanäle oder erneute Bestätigung der Produktionsroute. |
| ARM64-Image/Installation | E184/E185: 10.0.0 auf d2eeb2aaa bestanden. Aktualisiertes Image beba30b7196f auf 48f07dabf gebaut, E187; elf Installationschecks mit Host-Datenspeicher bestanden, E189. Kein aktuelles 10.0.1-/Operator-Image. |
| Sicherheit | E158: QuickJS-Worker-Regression einschließlich damaligem Gesamtgate bestanden. E190: Trivy 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW, 176 Advisories; eingebettete WASM nicht separat erfasst. Keine gesamte Sicherheitsfreigabe. |
| Lizenzen | E168: 495 erfasste Texte plus Produktlizenz im Image/Installer bestätigt. Rechte-/Zuordnungs-/Plattformfragen bleiben separat offen. |
| Upgrade/Restore | E72: begrenzte Strecke 9.9.0→9.15.2 und Restore bestanden; keine finale Beta→GA-Abnahme. |
| Öffentlich | Aktuelle Beta/GA und Produktwebsite nicht nachgewiesen/freigegeben. Eingereicht ist nicht Store-veröffentlicht. Lokales PASS und Push ersetzen keine Veröffentlichung. |

Image E187 wurde nur aus dem Docker-Cache entfernt, E208. Geprüftes Archiv und
Nachweise bleiben erhalten: `.artifacts/launch/integrated-candidate-image.tar`.
Bei Bedarf gezielt laden oder neuen Kandidaten bauen. Keine fremden Ressourcen bereinigen.

## Produkt-, Test- und Nutzerentscheidungen

- Launch vor neuen Features; kostenloses Self-Hosting; Website ausschließlich in
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
  Codex CLI 0.163.0 und Claude Code 2.1.296 installiert; lesender Refresh in
  `.artifacts/launch/native-client-readiness.json`. Nativer Lifecycle weiterhin UNVERIFIED;
  neue Codex-Hooks benötigen [Prüfung und Vertrauen](https://learn.chatgpt.com/docs/hooks).
- Daily/Weekly laut Nutzer vorhanden; tatsächliche Läufe/Lesezugriff UNVERIFIED, E180.
  Keine automatische Verbindung zum gesamten ChatGPT-Projekt behaupten.
- Offizielle Lovable-Werkzeuge aktuell nicht verfügbar. Website-Entscheidungen und
  privater Handoff in WEBSITE-TODO.md; kein neuer Projekt-/Deploymentstatus behauptet.
- Store 9.15.2 laut synchronisiertem Handoff PENDING_REVIEW, E186. DE/EN-Clipper-Privacy
  in Lovable vorbereitet, unveröffentlicht; geprüfte vorläufige öffentliche Privacy deckt
  bislang nur die Website ab. Keine erneute Einreichung ohne gesonderte Freigabe.

## Nächste drei Aufgaben

1. **L13 P0:** laufende Diagnose abschließen, Fehler gezielt beheben, danach vollständiges
   Gate. Quellhashes und terminalen Exit festhalten; gültige Teilnachweise wiederverwenden.
2. **L12/L18 P0/P1:** auf messbar ausreichend versorgtem System aktuellen Kandidatenstart,
   Kategorie-/RBAC-Parität und Upgrade/Restore prüfen. E195 ist Teilnachweis, kein Gesamtergebnis.
   Keine blinden Vollstart-Wiederholungen oder Eingriffe in fremde Demos.
3. **L04/L05/L06/L09/L10:** vorhandene technische Vorbereitungen mit fehlenden Schlüsseln,
   Systemzugängen, Rechte-/Website-/Privacy-Angaben und menschlichen Freigaben abschließen.
   Websitearbeit nur über Lovable; keinerlei automatische Veröffentlichung.

Bekannte Lizenzrecherchen E137–E143 nicht wiederholen: alle 103 Polyfill-Versionen
haben Originaltexte. Vier lokale Source-Archive E144 vorhanden; fehlende Toolchains
in E145. Kein Wiederaufbau und keine öffentliche Quellauslieferung behauptet.
