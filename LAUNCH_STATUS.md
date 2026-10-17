# SubKit Launch-Status

Plan: [LAUNCH.md](LAUNCH.md) · Arbeitsvertrag: [LAUNCH_SYNC.md](LAUNCH_SYNC.md)

- Letzte Aktualisierung: **2026-10-17T17:53:40Z**; Planung in Europe/Berlin.
- Produkt-/Remote-Nachweis-Refresh: **2026-10-17T15:56:46Z**; Dokumentprüfung siehe E11.
- Geprüfter Produktcommit: **7c00b46e7832e97f9c08613ce04b1e5540841bfe**, `main`, Version **9.15.2**.
- Checkout und origin/main waren nach `git pull --ff-only origin main` identisch; vor Dateierstellung sauber.
- Synchronisation: **765a2fe269b9f930a44c301a7c43734b5e2f128c auf origin/main bestätigt**, Checkout sauber und 0/0 vor dieser Prüfung; git pull --ff-only erneut erfolgreich. Neue L08-Nachweise LOCAL_ONLY bis Push.
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
| L07 | DONE | Persistenter Quickstart und Backup-/Recovery-Anleitung; Linux-amd64-Build, frische Installation, Engine-Neustart und Restore in getrennte leere Volumes mit verschlüsselten Testdaten PASS, E22. Commit 765a2fe26 gepusht, alle acht Pre-Push-Gates bestanden. Öffentliche Installation bleibt L15, Versionsupgrade L18. |
| L08 | IN_PROGRESS | 139 gezielte Sicherheitsprüfungen PASS, E23. Abhängigkeitsscan meldet 88 Produktions-Advisories; MCP-OAuth-Issuerbindung als konkreter Launch-Befund identifiziert, S01/E24. Keine Security-Freigabe. |
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
| E22 | L07 | Docker-Build aus b98d91bb678088cd3e49bf87f5f471999260f847 für linux/amd64 PASS; Image sha256:7969fd79125bedad388161269578fe4ce11c3e2c38e81ad519ade8c83989b973. Frischer Compose-Start, Health 9.15.2, authentifizierter Workflow-/Dateizugriff, persistierte Testcredential-Entschlüsselung und falscher Schlüssel abgewiesen PASS; nach Engine-Ersetzung erneut PASS. Quiesziertes pg_dump (935364 Bytes) plus Objektarchiv (153600 Bytes), Restore in separate leere Volumes: dieselben Daten-/Schlüsselprüfungen PASS. Eigene Testprojekte/Volumes danach entfernt. 12 Start-/Compose-Vertragstests, 22 Assertions PASS; llms-Generator PASS. Receipt lokal: .artifacts/launch/installation-acceptance.json; Ablauf in README | Lokales Image plus Compose-Korrektur, keine öffentliche Installation. Erster Start scheiterte an SeaweedFS-Vorabreservierung; explizites master.volumePreallocate=false behebt diese. Vorübergehende Healthcheck-Timeouts beim Neustart unter amd64-Emulation; unveränderte Gates danach bestanden. Mock-LLM, kein realer Provider-/Chatlauf, kein Versionsupgrade, keine vollständige Rollen-/Provenienzabnahme. |

| E23 | L08 | Auf 765a2fe26 mit Bun 1.4.0: 14 isolierte Testsuiten, **139 pass, 0 fail, 1677 Assertions**, Exit 0. RBAC-Matrix/Grants/Ressourcenzugriff, MCP-Mandantentrennung/Audit und Ablehnung vor Approval, QuickJS fail-closed/Runtime sowie HTTP/MCP/Webhook-Mandantenjourney. Eigene PostgreSQL-Instanz auf isoliertem Port mit flüchtigem Datenvolume; keine Demo-Daten verwendet; Testcontainer danach entfernt. Receipt .artifacts/launch/security-boundaries.log | Reale Datenbank und lokale Transporttests, synthetische Connectoren/Mock-LLM. Keine vollständige Penetrationsprüfung, keine Prüfung veröffentlichter Artefakte; bestandene Tests schließen Dependency-Befunde nicht aus. |
| E24 | L08 | bun audit --json und --prod --json: jeweils Exit 1. Gesamt 149 Advisory-Einträge/28 Pakete (65 high, 2 critical); Produktion 88/24 (41 high, 2 critical, 34 moderate, 11 low). MCP SDK 1.30.0 vorhanden. Isolierte SDK-Reproduktion mit synthetischem Clientsecret und Fetch-Fixture: AUTHORIZED, Secret an vom MCP-Server ausgewählten Issuer übergeben; 0 externe Requests | Advisory-Anzahl ist keine Anzahl bewiesener Produktlücken. Reproduktion trifft SDK-Verhalten; SubKit ruft denselben Provider ohne expectedIssuer auf, vollständige Produkt-Gegenprüfung noch nötig. Kein echtes Secret verwendet, keine produktive Verbindung geprüft. |

## Security-Befundregister (L08)

| ID | Befund und Einordnung | Erforderlicher Abschlussnachweis |
| --- | --- | --- |
| S01 | **P0, offen:** MCP OAuth SDK 1.30.0 liegt im betroffenen Bereich von [GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h). session-auth.ts erzeugt ClientCredentialsProvider/PrivateKeyJwtProvider ohne expectedIssuer; oauth-provider.ts persistiert/liefert issuer nicht mit Token/Clientinformationen. Vorhandene Token-Response-Evidenz bewertet Antworten erst nach dem Request und verhindert diesen Versand nicht. SDK-Fixture bestätigt das Verhalten. | SDK mindestens 1.31.0, feste erwartete Issuer für M2M, verlustfreie Issuer-Persistenz für Client/Token und fail-closed Umgang mit nicht gebundenem Altbestand. Regression: geänderter Autorisierungsserver erhält keine Credentials; gültiger Issuer und Refresh bleiben funktionsfähig. Keine automatische Produktionsrotation ohne Befund/Freigabe. |
| S02 | **Offene Einordnung:** proxy-addr 2.0.7 (SDK → Express) und shell-quote 1.10.0 (react-devtools-core) mit kritischen Registry-Advisories. Produktionsabhängigkeitsbaum enthält sie; tatsächliche Erreichbarkeit im ausgelieferten Engine-/CLI-Pfad noch ungeprüft. | Callgraph und konkrete Angriffsvoraussetzungen prüfen; erreichbare Pfade korrigieren bzw. kompatible Fixversionen mit zielgerichteten Regressionen übernehmen. Keine pauschale Entwarnung aus der Paketposition. |
| S03 | **Offene Einordnung:** übrige Produktions-Advisories u. a. Hono, ZIP-/Textparser, Undici, gRPC und Grafikabhängigkeiten. | Gegen ausgelieferte Aufrufpfade und Hersteller-Advisories prüfen; hohe ausnutzbare Launch-Befunde schließen. Rohscan lokal gitignored, keine automatische Massenaktualisierung. |


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

Nicht durchgeführt: Vollgate, Live-Modelle, vollständiges Docker-E2E, öffentliche Installation, vollständige Plattformabnahme,
Versionsupgrade, vollständige Rollen-/Provenienz-Wiederherstellung, produktive Smoke-Tests oder visuelle Abnahme. Same-image-Restore ist durch E22 geprüft. Für diese Dokumentänderung
werden keine teuren Produktgates wiederholt. Vorherige Mocktests ersetzen keine dieser Prüfungen.

## Nutzerentscheidungen und nächste Arbeit

Bestätigt am 17.10.2026: kostenloses Self-Hosting, bestehende Website, öffentliches Repository
nach Prüfung, täglich 1–2 Stunden Mitarbeit, Launch vor Features; Implementierungsfreigabe
dieser Planungsdateien. Anschließend: autonome Launch-Vorbereitung als Goal einschließlich
Commit und Push mit regulären Hooks freigegeben. Keine weitergehende Veröffentlichungsfreigabe daraus ableiten.

Offen: Betreiber-/Supportangaben, juristische Prüfung, Store-Konto/Freigabe, vorhandener Release-Signing-Key für lokale Abnahme, Testzugänge und
Zielsysteme, Nachweis zu Einschränkungen/Stilllegung des historischen Firebase-Keys, globale Hooks/Transkript-Datenfluss, Sichtabnahme sowie gesonderte Publikationsfreigaben. Commit/Push sind für den vereinbarten Scope freigegeben.

L07 ist auf main abgeschlossen und synchronisiert. L04 benötigt noch Lizenzprüfung und menschliche Key-Befundklärung; L05 wartet für die reale Release-Abnahme auf Kandidat/Signing-Key. Aktiver technischer Hauptstrom: L08, zuerst S01 (MCP-OAuth-Issuerbindung).

Nächste drei priorisierte Aufgaben:

1. **L08/S01:** MCP-SDK und Issuerbindung einschließlich gespeichertem Altbestand korrigieren; manipulierte Discovery ohne Credential-Versand verifizieren.
2. **L04:** Auslieferungslizenzen prüfen; menschlichen Nachweis zu Einschränkungen/Stilllegung des historischen Firebase-Keys ergänzen.
3. **L12:** Aktuelle reale Kern-/Intake-Journeys ausführen; vorhandene funktionale Verifier und isolierte Testdaten verwenden.

Nächster Codex-Schritt: S01 beheben. Dazu zuerst einen SubKit-Regressionstest für abweichende OAuth-Discovery ergänzen, SDK-Fixversion und vollständige Client-/Token-Issuerbindung umsetzen, Altbestand ohne belegte Bindung zur erneuten Autorisierung führen, gültigen Issuer/Refresh sowie Credential-Generation- und Approval-Grenzen prüfen. Danach S02/S03 triagieren. E23 ist Baseline vor diesen Änderungen und danach gezielt zu erneuern. L03/L07 nicht wiederholen.
Parallel kann der Nutzer Betreiber-/Supportangaben und Store-Kontostatus bereitstellen.
