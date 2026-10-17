# SubKit Launch-Status

Plan: [LAUNCH.md](LAUNCH.md) · Arbeitsvertrag: [LAUNCH_SYNC.md](LAUNCH_SYNC.md)

- Letzte Aktualisierung: **2026-10-17T17:33:22Z**; Planung in Europe/Berlin.
- Produkt-/Remote-Nachweis-Refresh: **2026-10-17T15:56:46Z**; Dokumentprüfung siehe E11.
- Geprüfter Produktcommit: **7c00b46e7832e97f9c08613ce04b1e5540841bfe**, `main`, Version **9.15.2**.
- Checkout und origin/main waren nach `git pull --ff-only origin main` identisch; vor Dateierstellung sauber.
- Synchronisation: **431f49b369bd28600e30216307eab4ebf538541b auf origin/main bestätigt**; sauberer Checkout, Divergenz 0/0 nach Push. Neuere lokale Änderungen sind erst mit ihrem eigenen Push synchronisiert. Produkt-Baseline oben bleibt für historische Nachweise erhalten.
- Countdown am 17.10.: **10/11 Kalendertage bis Beta**, **29 bis GA**; bei jedem Refresh neu berechnen.
- Beta-Freigabe **ROT**, Terminprognose **GELB**: 27./28.10. bedingt erreichbar.
- GA-Freigabe **ROT**, Terminprognose **GELB**: Ziel 15.11.; externe Store-Freigabe offen.

## Aufgaben

Nur diese Tabelle führt den aktuellen Status. Definitionen, Rollen, Fristen und DoD stehen im Plan.

| ID | Status | Ergebnis, Blocker oder nächster Nachweis |
| --- | --- | --- |
| L01 | DONE | Begrenzte Bestandsaufnahme und Scopeentscheidungen; E01–E10. Kein vollständiges Security-Audit. |
| L02 | DONE | Drei Dateien und kurzer AGENTS-Verweis erstellt; Dokumentvalidierung E11 bestanden. Commit 01257eb8a gepusht, E15. |
| L03 | DONE | Veraltetes generiertes ZIP mit bestehendem Generator erneuert; Bun 1.4.0 macOS/Linux identisch; 63 Tests und funktionaler Chromium-Lauf PASS, E12. Commit 61ee865d3 gepusht, E15. |
| L04 | IN_PROGRESS | Historienscan abgeschlossen: 11 Treffer, davon 3 Dokumentationsbeispiele und 8 Vorkommen desselben historischen Firebase-Clientkeys. API-Einschränkungen/Stilllegung dieses Keys ungeprüft; Lizenz-/Publikationsprüfung offen, E19. |
| L05 | IN_PROGRESS | Privaten Deployment-Dispatch entfernt; Commit e6f6b68bf, 6 Release-/Provenance-Tests PASS, E13. Compose und Clipper als signierte Release-Artefakte ergänzt, E17; Signatur gegen Updater-Schlüssel vor Upload geprüft, E18. GitHub-Installer mit Signaturprüfung und lokalem Alias korrigiert, E20. Lokaler check/prepare/publish-Weg implementiert, 18 Prüfungen PASS, E21; echter Vorbereitungs-/Publikationslauf weiterhin UNVERIFIED. |
| L06 | BLOCKED | Betreiber-/Supportangaben und juristische Freigabe erforderlich. |
| L07 | IN_PROGRESS | Quickstart mit einmaliger geschützter .env, Wiederverwendung und Recovery-Grenzen korrigiert; Shell-/Compose-Prüfung E16. Commit 1c4c5d5cf gepusht. Echter Start/Restore offen; Docker hat nur 8,9 GiB frei gegenüber 12 GiB Build-Vorgabe. |
| L08 | TODO | Launch-Security-Prüfung und Befundregister. |
| L09 | TODO | Bestehenden Website-Kanal verwenden; Produktbereich/Links/Recht noch nicht abgenommen. |
| L10 | TODO | Store-Paket, Icons, Listing, Disclosures und echte Installation. |
| L11 | BLOCKED | L10, öffentliche Pflichtlinks, Publisherstatus und explizite Einreichungsfreigabe fehlen. |
| L12 | TODO | Aktuelle reale Cross-Surface-Abnahme fehlt; lokale Runtime abweichend, E05. |
| L13 | TODO | Neues Beta-Kandidatengate fehlt; vorhandener Status E02 nicht pauschal auf neuen Kandidaten übertragbar. |
| L14 | BLOCKED | L04/L05/L13 und Freigabe für Repository-Öffnung/Artefaktpublikation fehlen. |
| L15 | TODO | Externer Installationstest aus öffentlichen Kandidatenartefakten. |
| L16 | BLOCKED | Website-/Rechtsabnahme und Veröffentlichungsfreigabe fehlen. |
| L17 | TODO | Beta-Go nach vollständigen P0-Nachweisen. |
| L18 | TODO | Vollständige Upgrade-/Restore-Strecke für GA. |
| L19 | BLOCKED | Öffentliche Pipeline nicht erfolgreich belegt; bekannte Actions-Verfügbarkeit extern, keine Billing-Aufgabe. |
| L20 | TODO | Beta-Befunde/Security und Betriebsdokumentation. |
| L21 | BLOCKED | Einreichung/Google-Freigabe und öffentliche Store-Installation fehlen. |
| L22 | TODO | Finale GA-Gates und menschliche Abnahme. |
| L23 | TODO | Öffentliche GA, Kommunikation und Supportübernahme. |
| L24 | TODO | P2-Roadmap bleibt bis nach Launch zurückgestellt. |
| L25 | TODO | Lokale Hooks/CLI und tatsächliche Daily-/Weekly-Läufe noch verifizieren; E07–E10. |

## Fünf dominante Blocker

1. Aktuelle Distribution nicht konsistent öffentlich nachgewiesen: Compose erwartet 9.15.2;
   Docker-Hub-API liefert dafür anonym 404, älteres Image vorhanden.
2. Öffentliche Historien-/Lizenzfreigabe fehlt. Clipper-Drift ist durch E12 behoben;
   für Builds muss die in .bun-version festgelegte Toolchain einschließlich Kindprozessen aktiv sein.
3. Reale aktuelle Produktabnahme fehlt; lokale Engine meldet 9.11.2.
4. Website, Pflichttexte und Support sind noch nicht gemeinsam freigegeben.
5. GA braucht öffentliche Store-Version, Upgrade/Restore und erfolgreiche Release-Strecke.

## Nachweise und letzte Prüfungen

E01–E06 wurden am Produkt-/Remote-Refresh erneut geprüft. E07–E10 stammen aus der lesenden
Bestandsaufnahme derselben Sitzung am 17.10.; ihre Einschränkungen bleiben bestehen.
Keine privaten Rohlogs oder Credentials sind Bestandteil dieses Dokuments.

| ID | Bezug | Methode / Ergebnis | Geltungsgrenze |
| --- | --- | --- | --- |
| E01 | L01 | `git status --short`, Branch/HEAD und `git pull --ff-only origin main`: Exit 0, bereits aktuell; Commit siehe Kopf | Vor den lokalen Dokumentänderungen; kein Push |
| E02 | L01/L13 | GitHub Commit-Status für geprüften Commit: `subkit-release/v9.15.2 = success`; `gh release list`: v9.9.0 Latest, v9.11.1 Draft | Gespeicherter Gate-Erfolg, Vollgate nicht erneut ausgeführt; kein aktueller öffentlicher Release |
| E03 | L03 | `bun run check:clipper-drift`: Exit 1, `Clipper archive is stale`; Bun 1.3.12, macOS arm64 | Release-Workflow/Docker verwenden 1.4.0; Ursache noch offen, kein Archiv regeneriert |
| E04 | L01/L12/L25 | `bun test apps/sk/src/commands/tests/agent.test.ts apps/sk/src/agent-context.test.ts`: Exit 0, **45 pass, 0 fail, 170 assertions**, 250 ms, Bun 1.3.12 | Isolierte Vertrags-/Mockprüfungen; kein realer Hook-Lifecycle oder Providerlauf |
| E05 | L01/L12 | Lesender lokaler Health-Request: status ok, service subkit, version 9.11.2 | Keine aktuelle Kandidatenabnahme; keine PROD-Prüfung |
| E06 | L01/L14 | Öffentliche Docker-Hub-Tag-API: 9.15.2 HTTP 404; 9.9.0 vorhanden, aktualisiert 09.10. | Kein vollständiger Image-Pull/Start; GHCR nicht geprüft |
| E07 | L25 | Source/README und bereinigte lokale Konfigurationsprüfung: `.sk/agent.json` enthält subkit/Budget 4000; `sk` nicht im Shell-PATH; Codex 0.163.0; keine SubKit-Hooks in geprüften globalen Dateien | Effektiver GUI-PATH/Hook-Trust nicht geprüft; fehlendes Featureflag beweist keine Deaktivierung |
| E08 | L25 | Codex-MCP-Eintrag subkit vorhanden; lesender whoami-Aufruf über verbundene SubKit-App erfolgreich | App-Zugang ist nicht der lokale Codex-MCP-Zugang; keine vollständige Briefingabnahme |
| E09 | L01/L09 | Bestehende Website erreichbar; redaktionelles Repository MikeBild/mikebild-dev-content, README/AGENTS gelesen; ContentKit-Publikationsweg vorhanden | Produktbereich, Website-Runtime/Hosting und juristische Freigabe UNVERIFIED |
| E10 | L01/L24 | GitHub: keine offenen PRs; zusätzliche Connector-/Adapter-Issues und älteres ChatGPT-Katalogissue gelesen | Roadmap nicht automatisch Launch-Scope; historische Issue-Befunde nicht als aktuelle Fehler übernommen |
| E11 | L02 | Lokale Dokumentprüfung am 17.10., 16:03 UTC: 25 eindeutige Plan-IDs und 25 passende Statuszeilen, zulässige Statuswerte, lokale Links, Codeblöcke/Whitespace geprüft; AGENTS nach Entfernen des neuen Verweises bytegleich zu HEAD; `git diff --check` Exit 0 | Nur Dokumente geprüft; keine Produktfreigabe, kein Commit/Push. Drei neue Dateien und vier zusätzliche AGENTS-Zeilen. |
| E12 | L03 | Bun 1.4.0 (34cbb9a40): Build/Driftcheck Exit 0 auf macOS arm64 und Linux arm64; frische Frozen-Lockfile-Installation und veränderter Buildpfad liefern identische ZIP-Bytes. SHA-256 `2ac97e963ae6c71ca582d51a155478c0658eb1def34b35820d4d2b2f9c6252f2`. 63 Tests/195 Assertions in 9 Dateien PASS; scripts/verify-clipper-browser.ts Exit 0, reale Chromium-Installation und funktionale Capture/Draft/Retry-Prüfung | Eingangsarchiv war gegenüber kanonischem Build veraltet; historische Erzeugungsursache nicht belegt. Browser nutzt isolierte API-Fixtures, kein produktiver Intake-E2E-Nachweis. Source/Lockfile unverändert; nur generierte ZIP-/Manifestdateien erneuert. |
| E13 | L05 | Commit e6f6b68bf trennt öffentlichen Artefaktrelease von privatem Deploy-Dispatch. 6 Release-Vertrags-/Provenance-Tests, 36 Assertions, Exit 0; regulärer Commit-Hook einschließlich Typecheck PASS | Kein Workflow ausgeführt, keine Publikation. Lokaler Publikationsweg weiterhin offen. |
| E14 | L04 | `bun pm licenses --prod --json`: Exit 0, 1187 installierte Produktions-Paketeinträge. Ein Unknown-Metadateneintrag (khroma 2.1.0) anhand mitgelieferter license als MIT geklärt. LGPL-/CC-BY-Einträge identifiziert | Lokales Installationsinventar, keine vollständige Auslieferungs-/Container-Lizenzfreigabe. Rohinventar bleibt gitignored. |
| E15 | L02/L03/L05 | Drei Commits bis 01257eb8a mit normalen Hooks gepusht; alle acht Pre-Push-Schritte PASS (Lint, Typecheck, Determinismus, Invarianten, Drift, Commitnachrichten, Gitleaks neuer Commits, CLI-/Engine-Build). Danach sauber, HEAD=origin/main, 0/0 | Kein Release/Deployment; historischer Vollscan separat. Bestehende Lint- und Bundlegrößenwarnungen bleiben. |
| E16 | L07 | README-Shellblock in temporärem Verzeichnis ausgeführt: Neuanlage, Modus 0600, Überschreibschutz, unveränderte Secrets und zweimalige identische Compose-Konfiguration PASS; llms-Generator und diff --check Exit 0 | Keine Dienste gestartet; kein Verschlüsselungs-, Neustart- oder Restore-E2E. |
| E17 | L05 | 6 Release-/Provenance-Tests mit 39 Assertions PASS. Originaler Staging-Shellblock mit echter Compose-Datei/Clipper-ZIP und sechs Binärplatzhaltern: acht Prüfsummen korrekt, temporäre Ed25519-Signatur verifiziert, manipuliertes ZIP abgewiesen. Receipt lokal gitignored | Kein Imagebuild, keine echten Release-Binärdateien oder Release-Schlüssel verwendet; keine Publikation. |
| E18 | L05 | 60 Release-/Provenance-/Updater-Tests, 113 Assertions PASS. Exakten Workflow-Signaturbefehl isoliert ausgeführt: falscher Trust-Root abgewiesen, passender temporärer Schlüssel akzeptiert, manipuliertes Manifest abgewiesen | Reale Kryptografie mit Testschlüssel; Produktions-Signing-Key nicht verwendet oder geprüft. Damals zusätzlich festgestellt, inzwischen durch E20 korrigiert: scripts/install.sh erwartete nicht veröffentlichte subkit-Alias-Binärdateien und prüfte keine Signatur; dokumentierter Engine-Installer ist ein separater Pfad. |
| E19 | L04 | Gitleaks git --all mit Repo-Konfiguration und Redaction: Exit 1, 2291 Commits/1,39 GB/17m6s, 11 Treffer in 4 historischen Dateien. Drei kurze API-Key-Dokumentationsbeispiele mit Demo-Suffix als Beispielbefunde eingeordnet. Acht Firebase-Befunde betreffen denselben Clientkey; am geprüften HEAD nicht mehr vorhanden | Kein Nachweis eines missbrauchten Secrets. Laut [Firebase-Dokumentation](https://firebase.google.com/docs/projects/api-keys) sind passend eingeschränkte Firebase-Clientkeys nicht geheim; konkrete API-/App-Einschränkungen oder Stilllegung hier UNVERIFIED. Keine Key-Werte, privaten Projektangaben oder Rohreports im Repository; keine Historienumschreibung/Rotation vorgenommen. |
| E20 | L05 | GitHub-Installer lädt nur veröffentlichte sk-Datei, verifiziert Ed25519-Signatur und exakten eindeutigen Hash vor Ersetzung, erstellt lokalen subkit-Link. Rotation aktualisiert beide öffentlichen Schlüssel. 71 Installer-/Release-/Updater-Tests, 171 Assertions PASS; bash -n, Generator und diff --check PASS | Echte Shell/Kryptografie mit deterministischem Testschlüssel, isolierte Download-/OS-/Codesign-Fixtures. Keine öffentliche Installation und keine echte macOS-Codesign-/Linux-Plattformabnahme; kein Produktionsschlüssel erzeugt oder rotiert. Lokale Engine weiter 9.11.2, Checkout 9.15.2. |
| E21 | L05 | release:local prüft sauberes main, Tag-/Commit-/Gatebindung; baut Git-Snapshot und isolierten Docker-Smoke; signiert zehn Nutzartefakte samt Provenance. Publish braucht explizites Argument, öffentliches Repo, unverwendete Versionen und erneut gültige Nachweise. 18 Bundle-/Befehlsgrenzen-/Provenance-/Workflow-Tests, 78 Assertions PASS; Typecheck PASS | Echte Kryptografie und lokale Subprozesse mit isolierten Tool-Fixtures. Kein vollständiger Docker-Build/Smoke/Signierlauf, kein privater Release-Schlüssel verwendet, keine Registry-/GitHub-Publikation. Tatsächliche Route bleibt UNVERIFIED bis zum freigegebenen Kandidatenlauf. |

## Release, Website, Store und Automation

| Gegenstand | Zustand |
| --- | --- |
| Lokale vollständige Verifikation | Vorhandener GitHub-Gatestatus E02; neue Gesamtausführung NICHT DURCHGEFÜHRT |
| Release-Workflow | Jüngste Läufe fehlgeschlagen; Actions-Verfügbarkeit bekannter externer Blocker, keine neue Billing-Diagnose |
| Öffentliche Beta / GA | Nicht freigegeben; tatsächliche aktuelle öffentliche Installierbarkeit UNVERIFIED |
| Website | Kanal bekannt, SubKit-Produktauftritt/Downloads/Recht/Support UNVERIFIED |
| Store | Publisherkonto, Listing, Einreichung, Google-Freigabe und Veröffentlichung UNVERIFIED |
| Daily / Weekly | Laut Nutzer vorhanden: täglich 06:00 / montags ca. 08:00 Europe/Berlin; Konfiguration/Lesezugriff UNVERIFIED |
| Lokale globale Hooks | In geprüften Dateien nicht eingerichtet; keine Änderungen vorgenommen |

Nicht durchgeführt: Vollgate, Live-Modelle, Docker-E2E, frische Installation, Plattformabnahme,
Upgrade/Restore, produktive Smoke-Tests oder visuelle Abnahme. Für diese Dokumentänderung
werden keine teuren Produktgates wiederholt. Vorherige Mocktests ersetzen keine dieser Prüfungen.

## Nutzerentscheidungen und nächste Arbeit

Bestätigt am 17.10.2026: kostenloses Self-Hosting, bestehende Website, öffentliches Repository
nach Prüfung, täglich 1–2 Stunden Mitarbeit, Launch vor Features; Implementierungsfreigabe
dieser Planungsdateien. Anschließend: autonome Launch-Vorbereitung als Goal einschließlich
Commit und Push mit regulären Hooks freigegeben. Keine weitergehende Veröffentlichungsfreigabe daraus ableiten.

Offen: Betreiber-/Supportangaben, juristische Prüfung, Store-Konto/Freigabe, vorhandener Release-Signing-Key für lokale Abnahme, Testzugänge und
Zielsysteme, Nachweis zu Einschränkungen/Stilllegung des historischen Firebase-Keys, globale Hooks/Transkript-Datenfluss, Sichtabnahme sowie gesonderte Publikationsfreigaben. Commit/Push sind für den vereinbarten Scope freigegeben.

Aktiv: L04 (Befundklärung/Lizenzinventur) und L05 (signierte Distribution).
L07 wartet auf ausreichenden Docker-Buildspeicher und den Installations-/Restore-Test; L02/L03 sind auf main synchronisiert. Implementierung bleibt auf einen technischen Hauptstrom begrenzt.

Nächste drei priorisierte Aufgaben:

1. **L04:** Historischen Firebase-Key hinsichtlich Einschränkungen/Stilllegung klären; Auslieferungslizenzen prüfen.
2. **L05:** Lokalen Release-Weg praktisch abnehmen, sobald freigegebener Kandidat und vorhandener Signing-Key verfügbar sind.
3. **L07:** Persistenten Quickstart und isolierte Installationsprüfung vorbereiten.

Nächster Codex-Schritt: L04-Befundklärung und isolierten L07-Installations-/Restore-Nachweis vorbereiten; Docker-Speicherkapazität für L07 prüfen und isolierte Installation/Restore vorbereiten. L05-Code E21 ist vorhanden; reale Abnahme benötigt einen freigegebenen Kandidaten und vorhandenen Signing-Key außerhalb des Repos. Installer-/Signaturkorrekturen E20 nicht wiederholen. L03 nicht wiederholen. Fertige Pakete mit regulären Hooks committen und pushen.
Parallel kann der Nutzer Betreiber-/Supportangaben und Store-Kontostatus bereitstellen.
