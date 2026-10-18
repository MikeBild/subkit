# SubKit Launch-Status

Plan: [LAUNCH.md](LAUNCH.md) · Arbeitsvertrag: [LAUNCH_SYNC.md](LAUNCH_SYNC.md)

- Letzte Aktualisierung: **2026-10-18T02:45:46.069465+00:00**; Planung in Europe/Berlin.
- Produkt-/Remote-Nachweis-Refresh: **2026-10-17T15:56:46Z**; Dokumentprüfung siehe E11.
- Geprüfter Produktcommit: **0eb49bf4c**, Version **9.15.2**. Vollständiges lokales Gate E131 bestanden, Quellen unverändert. Aktuelles finales ARM64-Image auf 31ed0a343 und echter Engine-Installationsablauf bestanden (E132/E133).
- Letzter bestätigter Remote-Stand: **31ed0a343**, main, 0/0 Divergenz; `git pull --ff-only origin main` ohne Änderungen. Diese Statusaktualisierung bis zum Push LOCAL_ONLY. Commit/Push sind autorisiert; Veröffentlichung bleibt separat freizugeben.
- Vollständige Prüfhistorie: [LAUNCH_EVIDENCE.md](LAUNCH_EVIDENCE.md), E01–E135. IDs in dieser Datei verweisen dorthin. Keine bereits bestandenen unveränderten Prüfungen wiederholen.
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
| L06 | BLOCKED | Betreiber-/Supportangaben und juristische Freigabe erforderlich. |
| L07 | DONE | Persistenter Quickstart und Backup-/Recovery-Anleitung; Linux-amd64-Build, frische Installation, Engine-Neustart und Restore in getrennte leere Volumes mit verschlüsselten Testdaten PASS, E22. Commit 765a2fe26 gepusht, alle acht Pre-Push-Gates bestanden. Öffentliche Installation bleibt L15, Versionsupgrade L18. |
| L08 | IN_PROGRESS | Konkrete SDK/Issuer-, Hono-, Parser-, Transport-, Sharp- und Containerbefunde korrigiert und gezielt geprüft (E25/E30/E54–E60/E68/E78). Aktueller lokaler ARM64-Imageaudit E122: 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW. Native/WASM-/Artefaktabdeckung, übrige Befunde und finale Sicherheitsfreigabe offen. Kein Schluss auf Gesamtfreigabe aus Paketcounts. |
| L09 | IN_PROGRESS | Claim Map, Gliederung, deutscher Produktseitenentwurf und getrennte Kritik in LAUNCH.md vorbereitet; E29. Bestehender redaktioneller Kanal bestätigt, kein SubKit-Projekttext im gelesenen main-Baum. Öffentliche Links, Rechtsangaben, Preview und Abnahme offen. ENTWURF, nicht veröffentlicht. |
| L10 | IN_PROGRESS | Zweisprachige Listing-Texte, Berechtigungsbegründungen, Datenfluss-/Privacy-Arbeitsblatt und Reviewer-Ablauf als Entwurf in LAUNCH.md vorbereitet. Vier PNG-Icons werden aus bestehendem Cockpit-Logo generiert und mit Lucide-Lizenz im Manifest/ZIP ausgeliefert, E53. Paket-/Browser-/Binärprüfungen und macOS/Linux-Reproduzierbarkeit bestanden. Visuelle Iconabnahme, Promo-Grafik/Screenshots, Pflichtlinks und menschliche Zertifizierung offen. ENTWURF, nicht veröffentlicht. |
| L11 | BLOCKED | L10, öffentliche Pflichtlinks, Publisherstatus und explizite Einreichungsfreigabe fehlen. |
| L12 | IN_PROGRESS | Isolierter aktueller Kandidat: API-/Browser-/Intake-Prüfungen PASS, E37–E39; MCP-Cockpit-Handoff und echter Clipper gegen Engine PASS, E42/E43. Mock-Läufe und begrenzter echter Provider-Chat E45 getrennt belegt; vollständige Cross-Surface-Abnahme weiterhin offen. Manuelle Demo unverändert. |
| L13 | IN_PROGRESS | Aktuelles vollständiges bun run verify für 0eb49bf4c PASS, Quellhashes unverändert (E131); einschließlich Installer-, Updater-/Rollback- und Notice-Änderungen. Live-Modellmatrix E73 PASS; aktuelle gepaarte Referenz-Benchmarks fehlen (E75/E80). |
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
| L25 | BLOCKED | Bestehendes Nutzerprofil weiterhin unauthorized, E32. Mit isolierter Fixture-Identität: echtes CLI-Briefing und gemeinsamer Codex-/Claude-Hook-Handler gegen aktuelle Engine PASS, E38. Tatsächlicher Client-Hook-Dispatch, Nutzerzugang und Daily-/Weekly-Läufe fehlen. Keine globalen Änderungen. |

## Fünf dominante Blocker

1. Aktuelle Distribution nicht konsistent öffentlich nachgewiesen: Compose erwartet 9.15.2;
   Docker-Hub-API liefert dafür anonym 404, älteres Image vorhanden.
2. Öffentliche Historien-/Lizenzfreigabe fehlt. Clipper-Drift ist durch E12 behoben;
   für Builds muss die in .bun-version festgelegte Toolchain einschließlich Kindprozessen aktiv sein.
3. Vollständige aktuelle Produktabnahme fehlt. Isolierter Kandidat 9.15.2 besteht API-/Browser-/Intake-Prüfungen mit Mock-Provider, E37; die bestehende manuelle Demo ist davon getrennt.
4. Website, Pflichttexte und Support sind noch nicht gemeinsam freigegeben.
5. GA braucht öffentliche Store-Version und erfolgreiche Release-Strecke. Begrenztes Versionsupgrade/Restore bestanden (E72), finale Beta→GA-Abnahme offen.

## Letzter Verifikationsabschluss

`bun run verify` auf **0eb49bf4c6a9bddde2f38ebc974294e25c6bff31** abgeschlossen: **Exit 0**, Quellen unverändert, keine Produktdiffs (E131). Bun 1.4.0, isolierte PostgreSQL-Fixture und Mockprovider. Receipt/Log: `.artifacts/launch/installer-notices-full-verify.{json,log}`. Kein erneuter Gesamtcheck für diese reine Statusaktualisierung erforderlich. Aktueller vollständiger Image-Build und realer Engine-Installationsablauf anschließend bestanden (E132/E133).

## Aktueller Image-Nachweis

E132/E133: vollständiger ARM64-Build auf **31ed0a343**, Quellhashes unverändert, Image **525c651a79cd**. Frische Compose-Installation, echter öffentlicher Engine-Installer im isolierten Netz vor Bootstrap, ausführbare CLI, identische Notices mit korrekten Dateirechten und wiederholte Installation PASS. Bootstrap, Workflow-/Dateipersistenz nach Neuerstellung der Engine und Runtime-Smoke PASS; eigene Testvolumes bereinigt. Alle 379 zum Buildzeitpunkt erfassten nativen Lizenztexte im Image bestätigt. Danach acht weitere revisionsgebundene Originaltexte ergänzt und gerendert (387 insgesamt, E134/E135); diese acht noch nicht im finalen Image geprüft. Keine öffentliche Veröffentlichung oder juristische Freigabe.

Erster Build wegen Speicherreserve beendet (Exit 130); nach Archivierung des früheren eigenen Kandidaten und gezielter Bereinigung seines Cache erfolgreiche Wiederaufnahme. Alle Fehler-/Bereinigungsnachweise erhalten. Nutzer-Demos/Volumes unverändert. Nach Abschluss rund 2,9 Millionen KiB Docker-Speicher frei; neue große Builds vorher kapazitiv prüfen.

## Aktuelle Nachweise und Grenzen

| Prüfung | Belegter Stand |
| --- | --- |
| Vollständiges lokales Gate | E131: Exit 0 auf 0eb49bf4c, Quellen unverändert; vollständige Verify-Kette einschließlich Cockpit, isolierter Tests, Build/Binär-/Browser-/E2E-Prüfungen bestanden. Mockprovider. |
| Reale Modelle | E73: getrennte Live-Modellmatrix bestanden; kein Nachweis aller Chatkanäle. |
| Aktuelles ARM64-Image | E132/E133: vollständiger Build, echter Engine-Installer, frische Compose-Installation, Bootstrap/Auth und Workflow-/Dateipersistenz nach Engine-Neuerstellung PASS; Testressourcen bereinigt. |
| Sicherheit | E122/E123: 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW; 176 Advisories, keine Fixversion im Scannerreport. Keine gesamte Sicherheitsfreigabe. |
| Lizenz-Auslieferung | E132/E133: 379 native Texte samt Hashes und Produktlizenz im finalen Image bestätigt; danach LLVM-/TigerBeetle-/WebKit-Texte auf 387 ergänzt, gezielt geprüft (E134/E135), neues Image dafür noch offen; echte Installer-Auslieferung und wiederholte Installation bestanden. Rust-Resttexte über AUTHORS/Quellhinweis aufgelöst (E126); Quellbereitstellung und Binary-Zuordnung offen. Drei JS-Zuordnungen sowie vollständige native/transitive/Modellabdeckung und juristische Abnahme offen. |
| Upgrade/Restore | E72: begrenzte Strecke 9.9.0 → lokaler 9.15.2-Kandidat und Restore bestanden. Finale Beta→GA-/Provenienzabnahme offen. |
| Öffentlich | Aktuelle Beta/GA, Produktwebsite und Store-Veröffentlichung nicht belegt/freigegeben. Ein lokales PASS oder Push ersetzt keinen dieser Nachweise. |
| Daily/Weekly und Hooks | Zeitpläne laut Nutzer vorhanden; tatsächliche Läufe/Lesezugriff UNVERIFIED. Nutzerprofil unauthorized; isolierte Briefing-/Hookprüfungen bestanden, tatsächlicher Clientdispatch offen (E32/E38). |

## Nutzerentscheidungen

Bestätigt: kostenloses Self-Hosting, bestehender Website-Kanal, Repository nach Prüfung öffentlich, täglich 1–2 Stunden Mitarbeit, Launch vor neuen Features. Autonome Umsetzung und Commit/Push mit regulären Hooks sind autorisiert.

Offen: Betreiber-/Supportangaben, juristische Abnahme, Store-Publisherstatus und Einreichungsfreigabe; vorhandener passender Signing-Key, Referenzbenchmark-System und echte Channel-Testzugänge; Einschränkung/Stilllegung des historischen Firebase-Keys; globale Hooks/Transkript-Datenfluss; manuelle Sichtabnahme und gesonderte Publikations-/Deploymentfreigaben. Keine produktiven Daten oder globale Konfigurationen verändert.

## Nächste drei Aufgaben

1. **L04/L08:** Verbleibende Lizenzabdeckung und nachgewiesene Sicherheitsrisiken klären; keine pauschale Beseitigung aller MEDIUM/LOW-Meldungen als neuen Launch-Scope einführen.
2. **L05/L13:** Signierte reale Release-Vorbereitung und Referenzbenchmarks, sobald passender Schlüssel und Zielsystem verfügbar sind. Erfolgreiche Gates wiederverwenden.
3. **L06/L09/L10:** Betreiberangaben und öffentliche Pflichtlinks in Website-/Store-Entwürfe übernehmen, anschließend menschliche Abnahmen. Keine Veröffentlichung ohne gesonderte Freigabe.

Nächster Codex-Schritt: E127/E129/E130 implementieren Notice-Auslieferung für GitHub-Installer, Updater/Rollback und Engine-Installer. Gesamtgate E131 bestanden. Aktuelles Image und echter Engine-Installer E132/E133 ebenfalls bestanden; E130 technisch abgeschlossen. Nächster Schritt: separat gebaute ICU-Komponenten, libbase64 und eingebettete Polyfills anhand der gebundenen Buildquellen eingrenzen; danach verbliebene Quellbereitstellungsanforderungen konkret dokumentieren. LLVM-/TigerBeetle-Originaltexte und sechs WebKit-Texte einschließlich simdutf und vendortem ICU-Quelltext sind in E134/E135 ergänzt; nicht erneut recherchieren. Rechtliche Freigabe und offene Lizenz-/Plattformnachweise bleiben separat.
