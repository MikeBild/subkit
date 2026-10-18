# SubKit Launch-Status

Plan: [LAUNCH.md](LAUNCH.md) · Arbeitsvertrag: [LAUNCH_SYNC.md](LAUNCH_SYNC.md)

- Letzte Aktualisierung: **2026-10-18T10:28:34.827974+00:00**; Planung in Europe/Berlin.
- Produkt-/Remote-Nachweis-Refresh: **2026-10-17T15:56:46Z**; Dokumentprüfung siehe E11.
- Geprüfter Produktstand vor Remote-Integration: **0c61b8bc6**, Version **9.15.2**. QuickJS-Fix und korrigierte Hook-Dokumentationsassertion committed; vollständiges Gesamtgate PASS, unveränderte Quellhashes. ARM64-Image, Installation, Regression und Notice-Auslieferung bestanden (E158).
- Letzter bestätigter Remote-Stand: **f7e57030a**, main, nach Fast-forward synchronisiert. Enthält vorbereitete Version **10.0.0** und Website-Entscheidungen. Vollständiges Gate auf Vorgänger f489823b1 PASS (E181); neuer Image-/Versionsnachweis offen. Diese Fortschreibung LOCAL_ONLY bis Push.
- Vollständige Prüfhistorie: [LAUNCH_EVIDENCE.md](LAUNCH_EVIDENCE.md), E01–E181. IDs in dieser Datei verweisen dorthin. Keine bereits bestandenen unveränderten Prüfungen wiederholen.
- Countdown am 18.10.: **9/10 Kalendertage bis Beta**, **28 bis GA**; bei jedem Refresh neu berechnen.
- Beta-Freigabe **ROT**, Terminprognose **GELB**: 27./28.10. bedingt erreichbar.
- GA-Freigabe **ROT**, Terminprognose **GELB**: Ziel 15.11.; externe Store-Freigabe offen.

## Aufgaben

Nur diese Tabelle führt den aktuellen Status. Definitionen, Rollen, Fristen und DoD stehen im Plan.

| ID | Status | Ergebnis, Blocker oder nächster Nachweis |
| --- | --- | --- |
| L01 | DONE | Begrenzte Bestandsaufnahme und Scopeentscheidungen; E01–E10. Kein vollständiges Security-Audit. |
| L02 | DONE | Drei Dateien und kurzer AGENTS-Verweis erstellt; Dokumentvalidierung E11 bestanden. Commit 01257eb8a gepusht, E15. |
| L03 | DONE | Veraltetes generiertes ZIP mit bestehendem Generator erneuert; Bun 1.4.0 macOS/Linux identisch; 63 Tests und funktionaler Chromium-Lauf PASS, E12. Commit 61ee865d3 gepusht, E15. |
| L04 | IN_PROGRESS | Historienscan E19/E27: derselbe historische Firebase-Clientkey in acht Vorkommen; Einschränkung/Stilllegung menschlich nachzuweisen. Notice-Entwurf für 465 Paketversionen vorhanden, drei Zuordnungen offen (E108). Auslieferungspfad implementiert und gezielt geprüft (E106); juristische Freigabe und vollständige Artefaktabdeckung fehlen. |
| L05 | IN_PROGRESS | Privaten Deployment-Dispatch entfernt; Commit e6f6b68bf, 6 Release-/Provenance-Tests PASS, E13. Compose und Clipper als signierte Release-Artefakte ergänzt, E17; Signatur gegen Updater-Schlüssel vor Upload geprüft, E18. GitHub-Installer mit Signaturprüfung und lokalem Alias korrigiert, E20; signierte Lizenzdateien werden nun mitinstalliert, E127. Updater-Manifestparser weist Mehrdeutigkeiten ab, E128; signierter Lizenzdownload und Retention/Rollback ergänzt, E129. Engine-Installer einschließlich beider Notice-Dateien gegen finales Image real bestanden, E130/E133. Lokaler check/prepare/publish-Weg implementiert, 18 Prüfungen PASS, E21; echter Vorbereitungs-/Publikationslauf weiterhin UNVERIFIED. Modell-/Runtime-Assetbindung korrigiert und als a6d8b758d gepusht, E51. |
| L06 | BLOCKED | Betreiber- und Kontaktangaben für die Website bestätigt und übernommen (E176). Tatsächliche Hosting-/Versandverarbeitung, vollständige Pflichttexte und juristische Abnahme bleiben offen. |
| L07 | DONE | Persistenter Quickstart und Backup-/Recovery-Anleitung; Linux-amd64-Build, frische Installation, Engine-Neustart und Restore in getrennte leere Volumes mit verschlüsselten Testdaten PASS, E22. Commit 765a2fe26 gepusht, alle acht Pre-Push-Gates bestanden. Öffentliche Installation bleibt L15, Versionsupgrade L18. |
| L08 | IN_PROGRESS | **P0 E153: im echten Sandbox-Worker reproduziert; offizieller Fix als lokal reproduzierter Bun-Patch umgesetzt. 185 Sandbox-Tests und frische Linux-Patchinstallation PASS. Kompilierter Worker und finaler Container bestehen die Regression; frische Compose-Installation inklusive Neustart/Persistenz und Cleanup PASS (E158). Erster Gesamtcheck scheiterte an veralteter Hook-Dokumentationsassertion; Test korrigiert, 9 Tests PASS. Vollständige Wiederholung PASS: Exit 0, Quellen unverändert (E158). Commit 0c61b8bc6 über Merge 0f25ede2c gepusht (E162).**  Konkrete SDK/Issuer-, Hono-, Parser-, Transport-, Sharp- und Containerbefunde korrigiert und gezielt geprüft (E25/E30/E54–E60/E68/E78). Aktueller lokaler ARM64-Imageaudit E168: 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW. ONNX-Modelleingang statisch eingegrenzt; echte Provider-Inferenz ohne Netzwerk liefert 384 endliche Werte (E155), keine Gesamtfreigabe. Native/WASM-/Artefaktabdeckung, übrige Befunde und finale Sicherheitsfreigabe offen. Kein Schluss auf Gesamtfreigabe aus Paketcounts. |
| L09 | IN_PROGRESS | Aktuelle Website in Lovable, acht Seiten DE/EN, automatische Sprache/Systemtheme ohne Schalter, Social-Metadaten und einwilligungsgebundene GA4-Vorbereitung. Betreiber/Kontakt/Zieldomain bestätigt. Lovable: Build und 41 fokussierte Tests bestanden; keine reale Zustellung/Analytics oder Veröffentlichung (E176). Frühere Website-Entscheidungen erhalten (E173–E175). Verbleibende Textkorrekturen, Produktbilder, Formularversand, öffentliche Installation, vollständige Pflichttexte, Domainanbindung und finale Abnahme offen. Fortsetzung über WEBSITE-TODO.md. |
| L10 | IN_PROGRESS | Zweisprachige Listing-Texte, Berechtigungsbegründungen, Datenfluss-/Privacy-Arbeitsblatt und Reviewer-Ablauf als Entwurf in LAUNCH.md vorbereitet. Vier PNG-Icons werden aus bestehendem Cockpit-Logo generiert und mit Lucide-Lizenz im Manifest/ZIP ausgeliefert, E53. Paket-/Browser-/Binärprüfungen und macOS/Linux-Reproduzierbarkeit bestanden. Zwei echte Screenshot-Entwürfe mit isolierten Beispieldaten vorbereitet (E147); Kleine Promografik als lokaler Entwurf ergänzt; 128px-Store-Icon auf 96px-Motiv plus 16px transparenten Rand korrigiert und im ZIP geprüft (E148). Linux-amd64/macOS-ZIP byte-identisch; aktuelle kompilierte Engine/CLI liefern/installieren dasselbe Paket, E149. Lokale Einreichungsübergabe mit Listing-Texten, Medien, unverändertem ZIP und Prüfsummen erstellt; Integritäts-/Secret-Scan PASS, acht Freigabevoraussetzungen offen (E152). Übergabe lokal mit aktuellem ZIP erneuert, Integrität/Secret-Scan PASS; historische Medien ausdrücklich begrenzt (E166). Visuelle Abnahme aller Medien, Pflichtlinks und menschliche Zertifizierung offen. ENTWURF, nicht veröffentlicht. |
| L11 | BLOCKED | L10, öffentliche Pflichtlinks, Publisherstatus und explizite Einreichungsfreigabe fehlen. |
| L12 | IN_PROGRESS | Isolierter aktueller Kandidat: API-/Browser-/Intake-Prüfungen PASS, E37–E39; MCP-Cockpit-Handoff und echter Clipper gegen Engine PASS, E42/E43. Mock-Läufe und begrenzter echter Provider-Chat E45 getrennt belegt; vollständige Cross-Surface-Abnahme weiterhin offen. E172: HTTP-400-Ursache bei mandantenspezifischer LLM-Konfiguration reproduziert und lokal korrigiert; 126 Konfigurations-/19 Modellinitialisierungstests sowie PostgreSQL-Runtime-Integration (1 Test/14 Assertions) und Typecheck PASS. E177: echte lokale Browser-/Modell-Journey auf f489823b1 PASS (8 deterministische und 4 Modellprüfungen), isolierte Quellen-Engine/MemoryObjectStore. E178: 11 aktuelle CLI-/MCP-/gemeinsame Hook-Handler-Checks PASS; Mock-Modell und tatsächlicher Transport getrennt ausgewiesen. Vollständiges Gate E181 PASS; neues Image nach Versionsvorbereitung offen. E171: aktuelle persönliche Browser-Anmeldung und acht deterministische Intake→Skill-Prüfungen PASS; Modell-Gesprächsstart HTTP 400, Gesamtjourney FAIL. Diagnoselauf mit Timeout/Verbindungsabbruch historisch; Modellkonfigurationsursache durch E172 korrigiert und E177 gegengeprüft. Aktueller separater echter HTTP-/CLI-Gesprächslauf einschließlich Authoring/Audit/Ablehnung: 7 PASS (E170), keine vollständige Intake-/Google-Chat-Abnahme. Manuelle Demo unverändert. **Neuabnahme erforderlich:** Die Scope-Erweiterung „Sitzungs-Lernvorschläge über Intake“ (Ziel Wissen oder Skill, Bestätigung nur per Browser-Sitzung) ändert die geprüften Abläufe; E37–E46 gelten nur für den Stand davor. Lokale Demo mit echtem Provider einschließlich neuer Journey „session learnings review“ (deterministisch und reales Modell getrennt) PASS. L12 läuft nach dem Deploy komplett neu: Clipper, sk, MCP, HTTP, Cockpit, Google Chat, Coding-Agent-Hooks; simuliert und live getrennt. |
| L13 | IN_PROGRESS | Vollständiges `bun run verify` auf f489823b1 PASS, Exit 0 und Quellen unverändert (E181): 2.051 isolierte Dateien, E2E 257 PASS/0 FAIL, 20 SKIP/3 TODO. Reale Modelle separat E169/E170/E177. Neu integrierte Versionsvorbereitung 10.0.0 noch ohne finalen Image-/Versionsnachweis. Referenzbenchmarks und endgültige Release-Route offen. |
| L14 | BLOCKED | L04/L05/L13 und Freigabe für Repository-Öffnung/Artefaktpublikation fehlen. |
| L15 | TODO | Externer Installationstest aus öffentlichen Kandidatenartefakten. |
| L16 | BLOCKED | Website-/Rechtsabnahme und Veröffentlichungsfreigabe fehlen. |
| L17 | TODO | Beta-Go nach vollständigen P0-Nachweisen. |
| L18 | IN_PROGRESS | Isoliertes Upgrade vom öffentlichen 9.9.0-Image auf lokalen 9.15.2-Kandidaten und Restore auf alten Stand mit Daten/Schlüsseln/Rollen/Audit PASS, E72. Finale Beta→GA-Strecke und vollständige Provenienzabnahme bleiben offen. |
| L19 | BLOCKED | Öffentliche Pipeline nicht erfolgreich belegt; bekannte Actions-Verfügbarkeit extern, keine Billing-Aufgabe. |
| L20 | TODO | Beta-Befunde/Security und Betriebsdokumentation. |
| L21 | BLOCKED | Einreichung/Google-Freigabe und öffentliche Store-Installation fehlen. |
| L22 | TODO | Finale GA-Gates und menschliche Abnahme. |
| L23 | TODO | Öffentliche GA, Kommunikation und Supportübernahme. |
| L24 | TODO | P2-Roadmap bleibt bis nach Launch zurückgestellt. |
| L25 | BLOCKED | Bestehendes Nutzerprofil weiterhin unauthorized, E32. Mit isolierter Fixture-Identität: echtes CLI-Briefing und gemeinsamer Codex-/Claude-Hook-Handler gegen aktuelle Engine PASS, E38. Hook-Setup-Anleitung an aktuelle offizielle Defaults/Trust/Policy angepasst; 44 Agent-Tests, 4.590 Unit-Tests und CLI-Build PASS, E150. Tatsächlicher Client-Hook-Dispatch, Nutzerzugang und Daily-/Weekly-Läufe fehlen. Lesende Pages-/Space-Suche liefert kein zuordenbares Briefing (E180); kein vollständiger Zugriff auf ChatGPT-Projekte oder Automationen behauptet. Keine globalen Änderungen. |

## Fünf dominante Blocker

**QuickJS-Fix E158 lokal vollständig geprüft.** Reale Worker-/Container-Regression
und vollständiges Gate bestanden; Fix in 0c61b8bc6 committed.
Der Container-Scanner erfasst diese eingebettete WASM-Komponente nicht separat.

1. Aktuelle Distribution nicht konsistent öffentlich nachgewiesen: Compose erwartet 9.15.2;
   Docker-Hub-API liefert dafür anonym 404, älteres Image vorhanden.
2. Öffentliche Historien-/Lizenzfreigabe fehlt. Clipper-Drift ist durch E12 behoben;
   für Builds muss die in .bun-version festgelegte Toolchain einschließlich Kindprozessen aktiv sein.
3. Vollständige aktuelle Produktabnahme fehlt. Isolierter Kandidat 9.15.2 besteht API-/Browser-/Intake-Prüfungen mit Mock-Provider, E37; die bestehende manuelle Demo ist davon getrennt.
4. Website, Pflichttexte und Support sind noch nicht gemeinsam freigegeben.
5. GA braucht öffentliche Store-Version und erfolgreiche Release-Strecke. Begrenztes Versionsupgrade/Restore bestanden (E72), finale Beta→GA-Abnahme offen.

## Letzter Verifikationsabschluss

**E181: vollständiges `bun run verify` auf f489823b1 PASS, Exit 0,
Quellhashes unverändert.** 2.051 isolierte Dateien und nachfolgende Verify-Stufen;
E2E 257 PASS/0 FAIL, 20 SKIP/3 TODO. Isolierte PostgreSQL-Datenbank, Mockprovider.
Lauf 18.10. 09:30–10:27 UTC; `.artifacts/launch/tenant-provider-full-verify-retry.{json,log}`.
E181 enthält Hash und Grenzen. Danach Version 10.0.0/Website-Stand von main integriert;
kein neuer vollständiger Nachweis für diesen integrierten Stand behauptet.

## Letzter abgeschlossener Image-Nachweis

**E168: ARM64-Image 585eb0b314bd auf f225cdfba, Build PASS,
5.339 Quellhashes unverändert.** Frische isolierte Compose-Installation,
Installer einschließlich Lizenzdateien, Bootstrap, Clipper-Download,
Neustart/Persistenz, Runtime-Smoke und Cleanup PASS. QuickJS-Regression im
echten Worker sowie 495 Notice-Texte/Prüfsummen PASS.
Trivy: 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW; keine gesamte Sicherheitsfreigabe.

Erster Build wegen Docker-Speicherreserve abgebrochen. Eigenes altes Image
archiviert/geprüft und gezielt eigene Cache-Einträge bereinigt; Wiederholung
bestanden. Nutzer-Demos und fremde Images/Volumes erhalten. Frühere
Last-Timeouts aus E157 bleiben historische Nachweise, damaliger serieller Lauf PASS.
E168 liegt vor der Produktkorrektur f489823b1. Das Image wurde geprüft archiviert;
der neue Container-Nachweis nach dieser Korrektur steht aus.

## Aktuelle Nachweise und Grenzen

| Prüfung | Belegter Stand |
| --- | --- |
| Vollständiges lokales Gate | E181: PASS auf f489823b1, Exit 0, Quellen unverändert. Isolierte DB/Mockprovider; E2E-SKIP/TODOs und neue Versionsartefakte gesondert offen. |
| Reale Modelle | E170: echte HTTP-/CLI-Gesprächssuite 7 PASS; E169: aktuelles Live-Gate, beide dokumentierten Modelle, 6 PASS/Exit 0, unveränderte Quellen. Keine erneute Bestätigung der Produktionsroute oder aller Chatkanäle. |
| Aktuelles ARM64-Image | E168: Image 585eb0b314bd auf f225cdfba; Build, Installer, frische Installation, Neustart/Persistenz, Smoke und Cleanup PASS. |
| Sicherheit | **E158: QuickJS-Fix einschließlich Gesamtgate lokal geprüft.** E168: 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW, 176 Advisories. Frühere Triage E123 bleibt relevant; keine gesamte Sicherheitsfreigabe. |
| Lizenz-Auslieferung | E168: alle 495 erfassten Texte und Produktlizenz im finalen Image/Installer bestätigt. Drei bekannte JS-Zuordnungen, Modellrechte, vollständige Build-/Plattformzuordnung, Quell-/Relink-Auslieferung und juristische Freigabe offen. |
| Upgrade/Restore | E72: begrenzte Strecke 9.9.0 → lokaler 9.15.2-Kandidat und Restore bestanden. Finale Beta→GA-/Provenienzabnahme offen. |
| Öffentlich | Aktuelle Beta/GA, Produktwebsite und Store-Veröffentlichung nicht belegt/freigegeben. Ein lokales PASS oder Push ersetzt keinen dieser Nachweise. |
| Daily/Weekly und Hooks | Zeitpläne laut Nutzer vorhanden; tatsächliche Läufe/Lesezugriff UNVERIFIED. Nutzerprofil unauthorized; isolierte Briefing-/Hookprüfungen bestanden, tatsächlicher Clientdispatch offen (E32/E38). |

## Nutzerentscheidungen

Bestätigt: kostenloses Self-Hosting, bestehender Website-Kanal, Repository nach Prüfung öffentlich, täglich 1–2 Stunden Mitarbeit, Launch vor neuen Features. Autonome Umsetzung und Commit/Push mit regulären Hooks sind autorisiert.

Offen: vollständige Pflichttexte und juristische Abnahme, Store-Publisherstatus und Einreichungsfreigabe; vorhandener passender Signing-Key, Referenzbenchmark-System und echte Channel-Testzugänge; Einschränkung/Stilllegung des historischen Firebase-Keys; globale Hooks/Transkript-Datenfluss; manuelle Sichtabnahme und gesonderte Publikations-/Deploymentfreigaben. Keine produktiven Daten oder globale Konfigurationen verändert.

Scope-Erweiterung vom Nutzer entschieden (gegen den Freeze 17.–20.10.): Lernvorschläge aus Coding-Agent-Sitzungen und `save_learning` laufen vor der Beta als Sammelgut mit Origin `session` über Intake. Ziel eines bestätigten Vorschlags ist Wissen oder ein Skill; Bestätigung nur durch eine Person in einer Browser-Sitzung mit den Rechten des Ziels. Der Umbau entfernt die Learning-Skill-Kandidaten, `create_skill`/`propose_skill` und `sk learnings`; die AGENTS.md-Ergänzung ist vom Nutzer freigegeben. Die vorbereitende PROD-Datenbereinigung (Archivieren erfundener Konsolidate und Testreste, Verwerfen titelbasierter Konsolidate) ist mit Einzelbestätigung erfolgt; die Wiederherstellung fälschlich verworfener Vorschläge folgt nach dem Deploy. Release/Deploy (Major) bleiben gesondert freizugeben.

## Nächste drei Aufgaben

1. **L08 P0:** Verbleibende konkrete Security-Nachweise abschließen; QuickJS-Fix 0c61b8bc6 ist lokal vollständig geprüft (E158). Bestandene Regression/Containerprüfungen wiederverwenden. Lizenzfreigaben L04 bleiben separat offen.
2. **L05/L13:** Signierte reale Release-Vorbereitung und Referenzbenchmarks, sobald passender Schlüssel und Zielsystem verfügbar sind. Erfolgreiche Gates wiederverwenden.
3. **L06/L09/L10:** Betreiberangaben und öffentliche Pflichtlinks in Website-/Store-Entwürfe übernehmen, anschließend menschliche Abnahmen. Keine Veröffentlichung ohne gesonderte Freigabe.

Nächster Codex-Schritt: **Nachweise E177–E181 regulär committen/pushen, dann den integrierten Stand als Kandidaten-Image bauen und prüfen.** Vorbereitete Skripte: `.artifacts/launch/run-tenant-runtime-container-build-capacity.py`, `verify-tenant-runtime-candidate.py` und `run-tenant-runtime-intake-browser.py`. Beide Abnahmen verlangen erfolgreichen Build, unveränderte Quellen und exakt passende Image-/Commitbindung. Noch nicht ausgeführt. Docker-Platzreserve wird bewacht; fremde Images/Volumes bleiben erhalten. E181 nicht ohne neue relevante Änderung wiederholen. Website-Entscheidungen aus f7e57030a und WEBSITE-TODO.md haben Vorrang vor früheren Framer-Entwürfen. Neue Nachweise sind LOCAL_ONLY bis regulärem Push.

L04 bleibt begrenzt auf bekannte offene Rechte-/Plattform-/Quellauslieferungsfragen
und menschliche Freigaben. Alle 103 Polyfill-Lockfile-Versionen haben Originaltexte;
uucode-Haupt-/Sekundärhinweise und breite Base64-Quellsuche sind belegt (E137–E143).
Diese Recherchen nicht wiederholen. Vier lokale Source-Archive E144 sind vorhanden;
E145 benennt fehlende Toolchains. Kein Wiederaufbau oder öffentliche Quellauslieferung
behauptet. Der aktuelle Image-/Installer-Nachweis E151 ist abgeschlossen.
