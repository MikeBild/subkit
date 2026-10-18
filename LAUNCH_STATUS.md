# SubKit Launch-Status

Plan: [LAUNCH.md](LAUNCH.md) · Arbeitsvertrag: [LAUNCH_SYNC.md](LAUNCH_SYNC.md)

- Letzte Aktualisierung: **2026-10-18T05:55:36.802007+00:00**; Planung in Europe/Berlin.
- Produkt-/Remote-Nachweis-Refresh: **2026-10-17T15:56:46Z**; Dokumentprüfung siehe E11.
- Geprüfter Produktstand vor Remote-Integration: **0c61b8bc6**, Version **9.15.2**. QuickJS-Fix und korrigierte Hook-Dokumentationsassertion committed; vollständiges Gesamtgate PASS, unveränderte Quellhashes. ARM64-Image, Installation, Regression und Notice-Auslieferung bestanden (E158).
- Letzter bestätigter Remote-Stand: **87fe1615c**, main. Remote enthält Intake-Recovery-Fix und Framer-Fortschritt; lokal integriert. Vorheriger Push E160 bestätigt. Diese Aktualisierung LOCAL_ONLY bis Push; kein Release-Go.
- Vollständige Prüfhistorie: [LAUNCH_EVIDENCE.md](LAUNCH_EVIDENCE.md), E01–E161. IDs in dieser Datei verweisen dorthin. Keine bereits bestandenen unveränderten Prüfungen wiederholen.
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
| L08 | IN_PROGRESS | **P0 E153: im echten Sandbox-Worker reproduziert; offizieller Fix als lokal reproduzierter Bun-Patch umgesetzt. 185 Sandbox-Tests und frische Linux-Patchinstallation PASS. Kompilierter Worker und finaler Container bestehen die Regression; frische Compose-Installation inklusive Neustart/Persistenz und Cleanup PASS (E158). Erster Gesamtcheck scheiterte an veralteter Hook-Dokumentationsassertion; Test korrigiert, 9 Tests PASS. Vollständige Wiederholung PASS: Exit 0, Quellen unverändert (E158). Commit 0c61b8bc6 über Merge 0f25ede2c gepusht (E160).**  Konkrete SDK/Issuer-, Hono-, Parser-, Transport-, Sharp- und Containerbefunde korrigiert und gezielt geprüft (E25/E30/E54–E60/E68/E78). Aktueller lokaler ARM64-Imageaudit E151: 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW. ONNX-Modelleingang statisch eingegrenzt; echte Provider-Inferenz ohne Netzwerk liefert 384 endliche Werte (E155), keine Gesamtfreigabe. Native/WASM-/Artefaktabdeckung, übrige Befunde und finale Sicherheitsfreigabe offen. Kein Schluss auf Gesamtfreigabe aus Paketcounts. |
| L09 | IN_PROGRESS | Deutsche Framer-Vorabwebsite für Einzelpersonen, Soloselbstständige, Unternehmen mit 1–10 Mitarbeitern und Abteilungen freigegeben. Erste Startseite mit gemeinsamem Layout-Template, Button, Farben/Textstilen und Desktop-/Tablet-/Phone-Breakpoints aufgebaut; Inhalte/Anker unabhängig im Live-Tree geprüft, gezielte Desktop-/Phone-Ansichten manuell vom Agenten geprüft, technische Framer-Bereitschaft ohne Fehler/Warnungen, E159. Menschliche Sichtabnahme der Startseite steht aus; danach drei übrige Seiten und echte Routen. Vollständiger Artifact-Abgleich, Pflichtangaben, finale Funktions-/Sichtabnahme und separate Veröffentlichungsgenehmigung offen. Nicht veröffentlicht; dieser Fortschritt LOCAL_ONLY bis Push. |
| L10 | IN_PROGRESS | Zweisprachige Listing-Texte, Berechtigungsbegründungen, Datenfluss-/Privacy-Arbeitsblatt und Reviewer-Ablauf als Entwurf in LAUNCH.md vorbereitet. Vier PNG-Icons werden aus bestehendem Cockpit-Logo generiert und mit Lucide-Lizenz im Manifest/ZIP ausgeliefert, E53. Paket-/Browser-/Binärprüfungen und macOS/Linux-Reproduzierbarkeit bestanden. Zwei echte Screenshot-Entwürfe mit isolierten Beispieldaten vorbereitet (E147); Kleine Promografik als lokaler Entwurf ergänzt; 128px-Store-Icon auf 96px-Motiv plus 16px transparenten Rand korrigiert und im ZIP geprüft (E148). Linux-amd64/macOS-ZIP byte-identisch; aktuelle kompilierte Engine/CLI liefern/installieren dasselbe Paket, E149. Lokale Einreichungsübergabe mit Listing-Texten, Medien, unverändertem ZIP und Prüfsummen erstellt; Integritäts-/Secret-Scan PASS, acht Freigabevoraussetzungen offen (E152). Visuelle Abnahme aller Medien, Pflichtlinks und menschliche Zertifizierung offen. ENTWURF, nicht veröffentlicht. |
| L11 | BLOCKED | L10, öffentliche Pflichtlinks, Publisherstatus und explizite Einreichungsfreigabe fehlen. |
| L12 | IN_PROGRESS | Isolierter aktueller Kandidat: API-/Browser-/Intake-Prüfungen PASS, E37–E39; MCP-Cockpit-Handoff und echter Clipper gegen Engine PASS, E42/E43. Mock-Läufe und begrenzter echter Provider-Chat E45 getrennt belegt; vollständige Cross-Surface-Abnahme weiterhin offen. Manuelle Demo unverändert. **Neuabnahme erforderlich:** Die Scope-Erweiterung „Sitzungs-Lernvorschläge über Intake“ (Ziel Wissen oder Skill, Bestätigung nur per Browser-Sitzung) ändert die geprüften Abläufe; E37–E46 gelten nur für den Stand davor. Lokale Demo mit echtem Provider einschließlich neuer Journey „session learnings review“ (deterministisch und reales Modell getrennt) PASS. L12 läuft nach dem Deploy komplett neu: Clipper, sk, MCP, HTTP, Cockpit, Google Chat, Coding-Agent-Hooks; simuliert und live getrennt. |
| L13 | IN_PROGRESS | Aktuelles vollständiges bun run verify für QuickJS-Patch und korrigierte Dokumentationsassertion PASS, Quellhashes unverändert (E158). Integrierter Stand 0f25ede2c gepusht (E160); erstes Gesamtgate mit DB-Fixture-Timeout fehlgeschlagen (E156), unveränderter Einzeltest PASS. Serielle Wiederholung scheitert am fehlenden Recovery-Hinweis intake_items_changed (E161); Remote-Fix cfdc57b82 übernommen. Aktueller Gesamtstand UNVERIFIED. Live-Modellmatrix E73 PASS; aktuelle gepaarte Referenz-Benchmarks fehlen (E75/E80). |
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
| L25 | BLOCKED | Bestehendes Nutzerprofil weiterhin unauthorized, E32. Mit isolierter Fixture-Identität: echtes CLI-Briefing und gemeinsamer Codex-/Claude-Hook-Handler gegen aktuelle Engine PASS, E38. Hook-Setup-Anleitung an aktuelle offizielle Defaults/Trust/Policy angepasst; 44 Agent-Tests, 4.590 Unit-Tests und CLI-Build PASS, E150. Tatsächlicher Client-Hook-Dispatch, Nutzerzugang und Daily-/Weekly-Läufe fehlen. Keine globalen Änderungen. |

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

E158: `bun run verify` auf Basis **06353d31e plus QuickJS-Patch und korrigierter
Dokumentationsassertion** abgeschlossen: **Exit 0**, Quellhashes unverändert.
Bun 1.4.0, isolierte PostgreSQL-Fixture, Mockprovider; 2.046 isolierte Testdateien
und nachfolgende Evaluation/Build-/E2E-Prüfungen durchlaufen. Receipt/Log:
`.artifacts/launch/quickjs-patched-full-verify-retry.{json,log}`.
Erster Lauf mit veralteter Hook-Testassertion als Fehlnachweis erhalten.
Keine gesamte Security-/Rechtsfreigabe oder öffentliche Veröffentlichung.

## Aktueller Image-Nachweis

E157: integrierter ARM64-Build **dbe8d7012**, Image **14a2497304e9**,
5.339 Quellhashes unverändert. QuickJS-Regression und 495 erfasste Lizenztexte
im finalen Image/Installer PASS. Scan 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW.
Frische Installation, Bootstrap, Installer und initiale Persistenz PASS.
**Neustartprüfung FAIL:** Workflow-GET nach Neuerstellung überschreitet 60 Sekunden;
Ursache offen, Cleanup PASS. Wiederholung ohne parallelen Scanner scheitert ebenso;
Container laufen, kein OOM-Abbruch. Profiling-Diagnose PASS, Ursache weiter offen. Serieller regulärer Lauf ohne
Gesamtcheck/Scanner PASS einschließlich Neustart/Persistenz, Runtime-Smoke und Cleanup,
Timeout unverändert. Ressourcen-Konkurrenz plausibel, nicht endgültig bewiesen. E158 beschreibt das archivierte vorherige Image, nicht diesen Stand.

## Aktuelle Nachweise und Grenzen

| Prüfung | Belegter Stand |
| --- | --- |
| Vollständiges lokales Gate | E158: Exit 0, Quellen unverändert; vollständige Verify-Kette einschließlich korrigierter Hook-Assertion und neuer QuickJS-Regression bestanden. Isolierte DB, Mockprovider. |
| Reale Modelle | E73: getrennte Live-Modellmatrix bestanden; kein Nachweis aller Chatkanäle. |
| Aktuelles ARM64-Image | E157: Build/Installer/Installation und serieller Neustart/Persistenz PASS. Zwei Timeouts unter paralleler Last erhalten; Ursache nicht abschließend bewiesen. |
| Sicherheit | **E158: QuickJS-Fix einschließlich Gesamtgate lokal geprüft.** E157: 0 CRITICAL/0 HIGH, 558 MEDIUM/74 LOW, 176 Advisories. Frühere Triage E123 bleibt relevant; keine gesamte Sicherheitsfreigabe. |
| Lizenz-Auslieferung | E151: alle 495 erfassten Texte und Produktlizenz im finalen Image/Installer bestätigt. Drei bekannte JS-Zuordnungen, Modellrechte, vollständige Build-/Plattformzuordnung, Quell-/Relink-Auslieferung und juristische Freigabe offen. |
| Upgrade/Restore | E72: begrenzte Strecke 9.9.0 → lokaler 9.15.2-Kandidat und Restore bestanden. Finale Beta→GA-/Provenienzabnahme offen. |
| Öffentlich | Aktuelle Beta/GA, Produktwebsite und Store-Veröffentlichung nicht belegt/freigegeben. Ein lokales PASS oder Push ersetzt keinen dieser Nachweise. |
| Daily/Weekly und Hooks | Zeitpläne laut Nutzer vorhanden; tatsächliche Läufe/Lesezugriff UNVERIFIED. Nutzerprofil unauthorized; isolierte Briefing-/Hookprüfungen bestanden, tatsächlicher Clientdispatch offen (E32/E38). |

## Nutzerentscheidungen

Bestätigt: kostenloses Self-Hosting, bestehender Website-Kanal, Repository nach Prüfung öffentlich, täglich 1–2 Stunden Mitarbeit, Launch vor neuen Features. Autonome Umsetzung und Commit/Push mit regulären Hooks sind autorisiert.

Offen: Betreiber-/Supportangaben, juristische Abnahme, Store-Publisherstatus und Einreichungsfreigabe; vorhandener passender Signing-Key, Referenzbenchmark-System und echte Channel-Testzugänge; Einschränkung/Stilllegung des historischen Firebase-Keys; globale Hooks/Transkript-Datenfluss; manuelle Sichtabnahme und gesonderte Publikations-/Deploymentfreigaben. Keine produktiven Daten oder globale Konfigurationen verändert.

Scope-Erweiterung vom Nutzer entschieden (gegen den Freeze 17.–20.10.): Lernvorschläge aus Coding-Agent-Sitzungen und `save_learning` laufen vor der Beta als Sammelgut mit Origin `session` über Intake. Ziel eines bestätigten Vorschlags ist Wissen oder ein Skill; Bestätigung nur durch eine Person in einer Browser-Sitzung mit den Rechten des Ziels. Der Umbau entfernt die Learning-Skill-Kandidaten, `create_skill`/`propose_skill` und `sk learnings`; die AGENTS.md-Ergänzung ist vom Nutzer freigegeben. Die vorbereitende PROD-Datenbereinigung (Archivieren erfundener Konsolidate und Testreste, Verwerfen titelbasierter Konsolidate) ist mit Einzelbestätigung erfolgt; die Wiederherstellung fälschlich verworfener Vorschläge folgt nach dem Deploy. Release/Deploy (Major) bleiben gesondert freizugeben.

## Nächste drei Aufgaben

1. **L08 P0:** Verbleibende konkrete Security-Nachweise abschließen; QuickJS-Fix 0c61b8bc6 ist lokal vollständig geprüft (E158). Bestandene Regression/Containerprüfungen wiederverwenden. Lizenzfreigaben L04 bleiben separat offen.
2. **L05/L13:** Signierte reale Release-Vorbereitung und Referenzbenchmarks, sobald passender Schlüssel und Zielsystem verfügbar sind. Erfolgreiche Gates wiederverwenden.
3. **L06/L09/L10:** Betreiberangaben und öffentliche Pflichtlinks in Website-/Store-Entwürfe übernehmen, anschließend menschliche Abnahmen. Keine Veröffentlichung ohne gesonderte Freigabe.

Nächster Codex-Schritt: **Integrierten Recovery-Fix gezielt prüfen, danach vollständiges Gate seriell wiederholen.**
Session 19644 ist terminal, Exit 1: Katalogprüfung in Datei 696/2050 meldet fehlenden
Recovery-Hinweis `intake_items_changed` (E161). Früherer DB-Fixture-Fehler tritt im
seriellen Lauf nicht auf: neun MCP-Probe-Tests PASS. Remote cfdc57b82 enthält bereits
den passenden Hinweis; keine doppelte Implementierung. Neue Framer-Arbeit aus
87fe1615c bleibt erhalten, E159 bezeichnet Website, E160 den vorherigen Push.
Kein Gesamt-PASS und keine Übertragung historischer Image-/Store-Nachweise auf
geänderten Produktcode. Keine parallelen schweren Prüfungen.

L04 bleibt begrenzt auf bekannte offene Rechte-/Plattform-/Quellauslieferungsfragen
und menschliche Freigaben. Alle 103 Polyfill-Lockfile-Versionen haben Originaltexte;
uucode-Haupt-/Sekundärhinweise und breite Base64-Quellsuche sind belegt (E137–E143).
Diese Recherchen nicht wiederholen. Vier lokale Source-Archive E144 sind vorhanden;
E145 benennt fehlende Toolchains. Kein Wiederaufbau oder öffentliche Quellauslieferung
behauptet. Der aktuelle Image-/Installer-Nachweis E151 ist abgeschlossen.
