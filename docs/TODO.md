# SubKit: operative Produktaufgaben

## Zuständigkeit und Status

Diese Liste ist die kanonische Aufgabenquelle für Cloud-Self-Service und die hierher
übernommenen offenen Root-TODO-Befunde. [Roadmap](PRODUCT-ROADMAP.md) führt Ziele,
Entscheidungen und Abhängigkeiten. [LAUNCH_STATUS](../LAUNCH_STATUS.md) führt weiterhin
ausschließlich den aktuellen Status der L-Aufgaben; [WEBSITE-TODO](../WEBSITE-TODO.md)
führt Website-Arbeit. Keine zweite Kopie dieser Statuslisten anlegen.

Status: TODO, IN_PROGRESS, BLOCKED, UNVERIFIED, DONE gemäß
[Launch-Arbeitsvertrag](../LAUNCH_SYNC.md). DONE braucht passenden Nachweis.
C01–C08 übernehmen den bisherigen technischen Detailumfang ohne neue Produktabnahme.
Die vorhandene Operatortrennung ist Bestand, kein Beweis fertiger Cloud-Isolation.
Die Dokumentkonsolidierung ersetzt weder Produktarbeit noch menschliche Abnahmen.

## Aktueller Implementierungsstand und Nachweise

Historischer Integrationscheckpoint E244: Engine-/Cockpit-Typecheck und 22
Invarianten PASS, globales Lint ohne Fehler. Gezielte Hosted-Regression über
41 isolierte Testdateien: 317 PASS, zwei Invite-Fehler; korrigierte Fixture
anschließend fokussiert 3 PASS. Kein neuer Gesamtlauf daraus abgeleitet.

Seitdem geschlossene Lücken: Quotenabschluss tatsächlicher Worker bei voller
Inhalts-/Auditquote (E245), spezifische Chat-Quotenfehler und sichere SSE-/DB-
Fehlerantworten (E246), öffentlicher Betreiberpfad für unbekannte Objekt-PUTs
mit sieben lokalen HTTP/PG-Tests und 55 Assertions (E247), tenantgebundene
Gruppen/Rollen und Portal-E-Mailauflösung (E248; 73 beziehungsweise elf Tests).
Intervall-Schedules mit fremder Tenantzuordnung werden ebenfalls verweigert;
vier PostgreSQL-Tests PASS (E249). Diese Änderungen sind LOCAL_ONLY und noch
nicht gemeinsam abgenommen.

OAuth-Refresh und Secret-Eigentümerschaft sind jetzt fokussiert abgeschlossen:
45 Tests für Refresh/Lifecycle (E250), 27 für Zählung, Erasure und frische sowie
historische Migrationen (E251). Vier Quoten-/Privacy-/Recovery-Dateien nach der
neuen Migration gemeinsam erneut 23 PASS/118 Assertions (E252).

Ein Teil der Scheduler-/Dateibereinigung ist fokussiert geprüft: öffentliche
Queue-Schnittstellen, begrenzter Produkt-/SDK-Scan, atomarer Soft-Delete-Audit und
Gegenprobe zum Löschrennen; 42 Tests PASS (E254), unabhängig geprüft.

Settings-only-Keywartung ist einschließlich CLI und separater DB-Fähigkeit
fokussiert geprüft: 92 Crypto-/CLI-/Wartungstests sowie 19 DB-Wartungstests PASS.
Startup-/Coordinator-Tests decken Gate, Key-Pin, Drain und die äußere
Registrierungs-Commit-Barriere ab. Engine-/Cockpit-Typecheck, Lint ohne Fehler
und 22 Invarianten bestanden (E259). Eine Rotation aller Produktdaten wird nicht
behauptet: andere Cipher-/HMAC-Bestände verhindern diese Operation ausdrücklich.
Externe Stillstandsattestierung bleibt erforderlich; produktive Rollenfähigkeit
und vollständige private Login-Zuordnung sind nicht nachgewiesen.

Tatsächlicher Source-Prozessstart/-stop besteht zwei Tests mit 25 Assertions
(E261), einschließlich Key-Verweigerung vor HTTP sowie SIGTERM/SIGKILL.
Dies ist kein kompiliertes Artefakt und kein Modell-/Cloudnachweis.

Der gesicherte Arbeitsstand ist mit origin/main integriert. Die veröffentlichte Migration und ihre Snapshot-Historie sind unverändert
integriert; 14 lokale Schritte wurden sicher verschoben, 49 fokussierte Tests PASS
(E262). Anschließend
Generatoren, integrierte Hosted-Regression und neues Gesamtgate auf dem gemeinsamen
Stand. Der unabhängige Ausnahme-Delta-Review fand keinen neuen belegten Bypass;
Die historischen 34 Annotationen betreffen reguläre Schedulerjobs; der aktuelle
Abgleich fand 25 noch unbegrenzte SQL-Arbeitseinheiten. Titelpfad und
Notification-Mutationsbatch sind inzwischen fokussiert begrenzt (E265);
Nach zusätzlich begrenzten beiden Approval-Mutationen (E280) bleiben
nach acht begrenzten OAuth-Einheiten (E283) und vier Kadenz-Producern (E282)
noch neun Einheiten aus diesem historischen Inventar offen. Der zusätzliche
Chat-Dedup-Lauf ist ebenfalls fokussiert begrenzt; ebenso
bleibt die Gesamtzahl residenter Timer offen. Kein Cloud-, Release-
oder aktueller Gesamtgate-PASS wird daraus abgeleitet.

Signed-JWT-Merge gezielt geprüft: Token-Echo vor GraphQL-Fehlerlogging redigiert,
und vorgelagerte Egress-Prüfungen verwenden den vorgegebenen DB-/TX-Kontext.
21 Tests PASS/39 Assertions einschließlich tatsächlicher PostgreSQL-Transport-
Gegenproben (E263); kein gesamter SSRF- oder Cloud-Nachweis.

Integrierte Regression über alle 151 ursprünglich ausgewählten vorhandenen
geänderten Testdateien besucht. Fail-fast-Befunde und Korrekturen stehen getrennt
in E266–E271; wegen zwischenzeitlicher Quellenänderungen kein einzelner grüner
Gesamtlauf. HTTP-Fixture, Scrape-/Robots-Policy, Body-Caps, historische Erasure-
Fixtures und Importzyklus sind gezielt korrigiert und geprüft.

Architektur für acht Producer-Fanouts unabhängig geprüft: operative Cursor-Tabelle,
endliche Epochen mit Created-at-Cutoff, kurze CAS-/Lease-Transaktionen und
Admission-Fencing. Cursor-Schema mit fünf PostgreSQL-Tests geprüft (E279); Lease-/Walker-Helper
und Producer-Integration in Umsetzung. Docs-/Knowledge-
Post-Send-Verhalten und Timer-Grenzen bleiben ausdrücklich getrennte Arbeit.
Der lokale Reconciler-Dispatch einschließlich wiederkehrender Startup-Ticks
besteht Kontrollfluss-/Drain-Proben (E278); reale
Producer-/PostgreSQL-Abnahme folgt. Es wird keine Schließung der acht Abfragen
allein aus diesem Kontrollflusscheck abgeleitet.

Weitere negative Abrufpfade geschlossen: Antwortgrößen/Body-Fristen und native
Abbruchgegenprobe sowie CPU-sichere begrenzte Sitemap-Erkennung (E268).
Browser-Lifecycle prüft tatsächlichen Sitzungswiderruf und unabhängige
Tenant-Statussperre getrennt; Seed-Gegenprobe unverändert bestanden.
Legacy-Erasure und Lifecycle bestehen 24 fokussierte Tests/129 Assertions;
das Sweep-Szenario besitzt eigene Datenbank und hält Legacy-Upgrade-Abdeckung.
Ein Importzyklus im gemeinsamen Body-Reader wurde danach an einer importfreien
Primitive-Grenze behoben; 94 Tests in sechs isolierten Prozessen PASS.
Die letzten 19 Dateien bestehen mit 106 PASS/0 FAIL; damit sind alle 151 Dateien
besucht (E271). Wegen zwischenzeitlicher Korrekturen kein einzelner grüner Gesamtlauf.

Native Engine und CLI 10.1.3 regulär gebaut; zwei tatsächliche native Prozesstests
bestehen mit 27 Assertions (E272), einschließlich Start, Key-Pin, SIGTERM/SIGKILL.
Eigene Fixtures bereinigt, Nutzerdemo unverändert. Typecheck und 22 Invarianten
aktuell PASS (E273). Nach Indexaufnahme bestehen alle 30 Vertragstests (E274). Der integrierte Stand
175901a0f ist normal mit allen acht Pre-Push-Gates gepusht (E276); native Prüfsumme
bleibt identisch. Aktiv: Cursor-/Producer-Plan sowie begrenzte Approval-/Chat-
Dedup-Bereinigung integrieren und weitere OAuth-/Datei-Mutationen begrenzen.
Die Approval-/Dedup-Komponente besteht sieben PostgreSQL-Tests (E280).
Lease-/Walker-Helper und vier Kadenz-Caller sind fokussiert geprüft (E281/E282),
OAuth-Retention mit 38 Tests (E283). Catalog ist lokal implementiert, aktueller
Abschlusslauf wegen Fixture-Infrastruktur vor Assertions abgebrochen. Die bisher
vermutete Singleton-Wirkung besteht unter tatsächlicher Standard-Queue-Policy
nicht; als eigene Fairness-/Queue-Vertragslücke offen. Docs-/Knowledge-Refresh
und frühe Boot-/Shutdown-Eigentümerschaft nach unabhängigem Review in Umsetzung.
Neue PostgreSQL-Läufe pausieren bis die bestehende Testumgebung wieder reagiert;
keine Fristenlockerung und kein Neustart fremder Dienste (E284).

### Aktives Hosted-Goal

Nutzerauftrag: vollständiger Self-Service-Cloud-Plan einschließlich DevOps und
Architektur. Eigener Tenant plus eingeladene Mitgliedschaften, Pflichtbudgets,
eine Startreplik, kein Trial, sieben Tage widerrufbare Löschung. Offenes Signup
bleibt bis zur vollständigen Abnahme deaktiviert. Alle neuen Ergebnisse sind
LOCAL_ONLY; kein neuer Release-, Deployment- oder öffentlicher Freigabenachweis.

Freigegebene Free-Betriebswerte: 5 USD Modellkosten pro Tenant/Monat,
50 USD Modellkosten insgesamt/Monat, 50 MB (50.000.000 Bytes) gemeinsamer logischer
Speicher für Dateien und gespeicherte Nutzerinhalte pro Tenant
sowie 1.000 aufbewahrte Datensätze je Ressourcentyp einschließlich logisch gelöschter
Einträge bis zur physischen Bereinigung und 10.000 metrierte Requests pro
Tenant/UTC-Kalendermonat. Auth-Aktionen werden
per Webhook zugestellt; Ziel-URL folgt. Diese Werte sind im privaten
Deploymentvertrag festgehalten, noch nicht produktiv konfiguriert. Schutzlimits
pro Minute und Queue-/Dateigrenzen bleiben davon getrennt. Die Nutzerpräzisierung
schließt Knowledge und Gespräche ein; bestehende Dateiquoten allein erfüllen diese
Gesamtgrenze noch nicht. Gemeinsames Byte-Ledger einschließlich Content-Historien
und nicht dateigebundenem Objekt-Offload ist implementiert und fokussiert geprüft;
die nachträglich gefundene OAuth-Secretversionen-Lücke ist fokussiert geschlossen
(E251). Settings-only-Wartung ist fokussiert geprüft (E259); kein vollständiger
Produkt-Keywechsel bei weiteren Cipher-/HMAC-Beständen wird behauptet.
Eine vollständige integrierte und echte Cloud-Abnahme steht aus.

| ID | Status | Nachweis und nächstes Ergebnis |
| --- | --- | --- |
| H01 Bestand/Herkunft | IN_PROGRESS | Historisches Deployment durch private Deployment-Git-Historie belegt; Ersatz oder Reset nicht bewiesen. Der Nutzer hat die Einrichtung der aktuellen Zielumgebung ausdrücklich beauftragt. GitHub-Provider verbunden, Git-Quelle, separate leere Produktdatenbank, privater Objekt-Bucket und Image-Verwaltung angelegt. Noch keine laufende App. Historische Recovery-Metadaten bleiben mit diesem Token nicht lesbar. |
| H02 DB/Runtime | IN_PROGRESS | Gepinnter Bun isoliert verfügbar; früher Versionscheck in Verify/Pre-Push implementiert und positiv/negativ geprüft. Gemeinsame Pool-/Listener-Initialisierung mit Keepalive, Deadlines, Poolgrenze und Session-Search-Path implementiert. 41 fokussierte DB-/Konfigurationstests bestanden; Listener-Lifecycle und Reconnect zusätzlich gezielt geprüft. Fünf Tenant-Statusfälle und Queue-/Scheduler-/Webhook-Regressionen zusammen 24 PASS. Integrierte Kandidatenprüfung ausstehend. Nach main-Fast-forward Checkout 10.1.3, bestehende lokale Demo aktuell separat 9.11.2; Demo unverändert. |
| H03 Identität/Mitgliedschaften | IN_PROGRESS | Globale Identität, ein eigener Tenant, eingeladene Mitgliedschaften, Browser-Sitzungsrotation und Tenant-Kontextprüfung implementiert. Registrierung getrennt vom laufenden Hosted-Betrieb; acht zusätzliche HTTP/OIDC/PG-Fälle zu geschlossener Registrierung und sicherem Invite-Login bestanden. Frische browsergebundene OIDC-Recovery und zehn zusätzliche HTTP/OIDC/PG-Transportfälle bestanden. CLI-/OAuth-Membership-Handoff implementiert und fokussiert mit HTTP/PG sowie CLI-Tests geprüft; Gruppen-/Rollenisolation mit eigener Vorwärtsmigration nachgeschärft, 73 Tests PASS; Portal-E-Mail tenantgebunden, elf Tests PASS (E248). Native verbundene Browser-/CLI- und echte Cloud-Journey offen. |
| H04 Geldbudgets/Fairness | IN_PROGRESS | Atomare monatliche Tenant-/Gesamtgeldreservierung mit sieben DB-Tests bestanden. Gemeinsame Modell-Middleware reserviert vor Provideraufrufen, hält unbekannten Verbrauch und verhindert Doppelaufrufe; 42 gezielte Middleware-/Modell-/Labeltests bestanden. Persistente Peer-/Principal-/Tenant-/Global-Requestlimits sowie monatliches Tenant-Kontingent implementiert; acht atomare DB- und sieben echte HTTP-Tests sowie 18 Policy-/Labeltests für den Monatsdeckel bestanden. Unabhängiges Review schloss Pfadfreistellung und Denial-Rollback. Speicherquoten und atomare Queue-/Direct-Chat-Fairness implementiert; 14 Queue-/Ledger-/Reviewtests PASS. Betreiber-Reconciliation zusätzlich drei echte HTTP/PG-Tests PASS, E236. Persistente Signup-/DCR-Admisson und gemeinsames Byte-/Ressourcenledger implementiert und fokussiert geprüft, E242. Neue Queue-Integration 14 PASS; Dokumentimport mit Stream-/Fehlergrenzen E241. Vollquoten-Workerabschluss E245, Chat-Fehlergrenze E246 und Tokenhistorien-Eigentümerschaft E251 fokussiert bestanden. Vollständiges Transportinventar und integrierte Abnahme offen; einzelne Transportchecks ergeben keine gesamte SSRF-Freigabe. |
| H05 Lifecycle/Auth-Mail | IN_PROGRESS | Tenant-Status sperrt HTTP/MCP, Ausführung und tenantgebundene Jobs. Löschauftrag mit sieben Tagen Frist, atomarem Credential-Widerruf und frischer einmaliger Browser-Recovery implementiert; sieben DB-Tests bestanden. Erasure-Domain isoliert mit Objekt-/Retry-/Nachbartenant-/Drainfällen geprüft; Sweep in bestehende Cleanup-Kadenz integriert und verweigert unaufgelöste Arbeit, fremde Prozessbesitzer oder fehlenden Drainnachweis. Objektledger und Erasure erneut fokussiert geprüft, einschließlich physischem Tombstone bei Budget null, E243. Öffentliche Objekt-Reconciliation E247 und Refresh-Lifecycle E250 fokussiert bestanden. Settings-only-Keywartung einschließlich inaktiver Registry-Owner ist fokussiert geprüft (E259); produktive Rollenfähigkeit und externe Stillstandsattestierung unbewiesen. Vollständiger Produkt-/Objektspeicher-/Cloudnachweis fehlt. Auth-Aktionszustellung per Webhook vorbereitet; Ziel-URL und echter Zustellnachweis offen. |
| H06 Cockpit/Client-Verträge | IN_PROGRESS | Lovable-Entwurf inspiziert und Workspace-Menü, Löschdialog sowie Recovery-Seite integriert. 33 Cockpit-Session-/Kontexttests bestanden. Browser prüfte Wechsel, Stale-Tab-Sperre sowie HTTP-200-Löschung/Wiederherstellung gegen isolierte PostgreSQL-Fixture; Browser-Identitätsnachweis dabei simuliert. Bootstrap-Refetchloop korrigiert; Zwei-Tab-Gegenprobe blieb bei drei Bootstrap-Aufrufen. Engine- und Cockpit-Typecheck bestanden. Clientparität, finale generierte Assets und Sichtabnahme offen; E232. Zusätzlicher Lovable-Entwurf für Betreiber-Reconciliation meldet Buildfehler, Korrektur wegen fehlender Workspace-Credits abgelehnt; diese neue Oberfläche ist noch nicht integriert, E236. |
| H07 Vollständige Abnahme | IN_PROGRESS | Boot-/Shutdown-Abhängigkeiten 30 fokussierte Tests PASS/98 Assertions (E287). Neuer nativer Lifecycle-Zwischenstand zwei PASS/31 Assertions (E288); Container-URI-Korrektur acht PASS/24 Assertions (E289). Vier aktuelle Catalog-/Admission-/Datei-Cleanup-/Referenzdateien 30 PASS/140 Assertions (E290); Engine-/Cockpit-Typecheck Exit 0. Vollständiges integriertes Gate und echte Cloud-Abnahme bleiben offen; E224 bleibt historisch. |
| H08 Privater Deployment-Vertrag | IN_PROGRESS | SubKit-only Vertrag und rein lesender Kandidatenguard im privaten Deployment-Repo vorbereitet; 29 Tests bestanden, einschließlich bestätigter 1.000 Datensätze je Ressourcentyp samt Soft-Delete, E242. Gemeinsame 50-MB-Quote, Ressourcenanzahl und nachgewiesen unversionierter, nicht gesperrter Objekt-Bucket sind explizite Kandidatengrenzen. Herkunft, finaler Releasepin und Deploymentautorität bleiben gesperrte Pflichteingaben. Historischen Sechsproduktvertrag erhalten. |
| H09 Release/Cloud/Signup | IN_PROGRESS | Deployment durch den Nutzer ausdrücklich beauftragt; aktuelle Zielressourcen werden eingerichtet. Docker-Image aus dem geprüften Git-Stand, laufende App, echte Upraft-Journeys und Backup/Restore fehlen weiterhin. Signierte öffentliche Distribution, Rechts-/Sichtabnahmen und separate Signup-Freigabe bleiben eigenständige Gates. |

`query-fragment.test.ts` aktuell allein 4/4 und gemeinsam mit Server-Registry 8/8
bestanden; alter Batchfehler nicht reproduziert, daher kein spekulativer Fix.
Nächste Schritte: verbleibende ausgehende Transportpfade und Lifecycle-Lücken
schließen, gemeinsames Ledger sowie Producer-/Transportabdeckung integriert
prüfen und den erweiterten Lovable-Betreiberablauf fertigstellen.
Recovery und Lifecycle sind lokal implementiert; externe Nachweise bleiben getrennt.
Neue fokussierte Ergebnisse stehen in lokalen Prüfprotokollen; dauerhafte
Nachweisübernahme und neues Gesamtgate folgen nach dem gemeinsamen Review.


## Technische Inkremente C01–C08

Direction: one shared engine, one isolated tenant per registered account, platform LLM
key with a fixed budget per tenant, open registration with throttling. The hosted
deployment is a separate deployment path next to the existing one; the existing release
and deploy path stays unchanged. Product position documents must change from
self-hosting-only to include the hosted offering before registration opens.

Done: separation of engine-operator authority from tenant authority.

Remaining increments, in order. Each one is shippable on its own; open registration
requires C01–C09 and the opening criteria in PRODUCT-ROADMAP.md, including isolation,
real onboarding, lifecycle, operating readiness and legal approval.

1. **C01 — IN_PROGRESS: Database connection robustness:** keepalive and bounded connect, query and statement
   timeouts on the pool and the listener, configurable pool maximum, `search_path` set
   per connection so the boot assertion does not depend on role settings.
2. **C02 — IN_PROGRESS: Tenant model and budgets:** tenant origin and status columns, one domain operation that provisions
   a tenant (insert only, random slug, owner role without engine-wide rights, idempotent
   through a global unique identity binding, only for verified emails), central status
   enforcement (login, principals, hooks, cron, dequeue, seeds, session and key
   revocation on suspend), operator-set budget that fails closed and is measured in
   money with a global monthly ceiling, atomic budget reservation with every direct LLM
   call covered, no runtime-config overlay for self-service tenants, tenants cannot set
   their own budget, model or limits.
3. **C03 — IN_PROGRESS: Login per identity:** ignore the tenant query parameter, resolve the tenant in the
   callback, per-provider signup policy instead of the global flag, join an existing
   tenant only through an existing link or an invite token, verified email required,
   adapt the identity assertion, `sk` login and token exchange.
4. **C04 — IN_PROGRESS: Fairness and abuse protection:** per-tenant job grouping and concurrency, per-tenant
   limit for inline chat turns, rate limits per principal and tenant stored in
   PostgreSQL, trusted proxy hop for forwarded addresses, throttled tenant creation and
   MCP client registration, SSRF gaps (database and object-store connectors, redirects,
   DNS rebinding, missing address ranges, internal platform networks), storage quota and
   smaller file limit per tenant, capped tenant-scoped resource limits, chat workspaces
   locked until ownership is proven.
5. **C05 — IN_PROGRESS: Tenant lifecycle:** erasure (data, objects, secrets, config entries, audit event),
   owner-initiated deletion in the Cockpit (design from Lovable), scheduler for the seven-day reversible deletion
   grace period; no trial expiry, lifecycle webhook route that verifies the signed event and
   maps (issuer, subject) to a tenant. Add an owner-authorized data export and a
   reviewable deletion request, including behaviour for in-flight work and backup retention;
   define these semantics before implementation.
6. **C06 — IN_PROGRESS: Authentication mail:** Upraft Auth delivery webhook to the SubKit workflow with the
   execution marked sensitive so action links are never stored in clear text; verify
   step outputs, logs and spans; end-to-end test with a dedicated account before
   switching off the built-in mail; uptime monitor on the hook.
7. **C07 — IN_PROGRESS: Hosted deployment runbook** (outside this repository, every mutation approved):
   Git build of the release commit, session-mode writer binding with owner access,
   compatibility repair of managed schemas, app revision with memory, stop-grace,
   drain and probe values, single replica until limits are in PostgreSQL, object-store
   binding with conformance run, fresh master key with offline escrow, domain and TLS,
   dedicated Auth realm with open signup, paired database and bucket backup, rollback
   rule, uptime monitors. Review all `tenant-filter:exempt` sites and add cross-tenant
   journeys for self-service before registration opens.
8. **C08 — IN_PROGRESS: Product position and legal:** update `LAUNCH.md`, `LAUNCH_STATUS.md`, `README.md` and
   generated `llms*.txt`; imprint, privacy policy, data-processing agreement and terms.
   Document consolidation is prepared locally; product availability, final legal texts
   and human legal acceptance remain open. Include actual providers, region, retention,
   support and updated Clipper privacy for hosted as well as independent installations.

Known smaller findings to fold into the increments above: a failed tenant activation
blocks other tenants' settings writes until the operator activates; the operator
backfill in a multi-tenant installation picks silently and should log its choice.

## Open verification after the operator separation

- Before the next release tag, retain `bun run verify` with its contract/end-to-end
  gates and the applicable `demo:local:verify` API checks. Cockpit browser acceptance
  uses browser-use with Codex or Claude Code; visual acceptance remains manual.
  The operator separation has since passed focused checks and the complete local
  gate on the product source recorded in LAUNCH_STATUS.md (E206/E215). Local-demo,
  live-channel and publication evidence remain separate.
- `query-fragment.test.ts` fails in batch runs and passes alone; find the shared state.
- The sandbox helper drift check fails with a Bun version other than the pinned one;
  make the pre-push hook or `verify` fail early with a clear message about the pinned version.
- Not reviewed in depth: inbound hooks, read tools of the chat, the apps listing.
- Optional hardening left out: composite foreign keys and tenant filters in API-key row
  and role lookups, a deterministic test for a token refresh racing a client revoke,
  a drift test that every example scope is a known permission.

## Entscheidungen

Die vollständigen noch offenen Entscheidungen und Planungsannahmen stehen einmalig
in der [Produktroadmap](PRODUCT-ROADMAP.md#offene-entscheidungen-vor-umsetzung-oder-öffnung).
Keine Limits, Fristen, Mitgliedschaftsregeln oder Tarife aus dieser Liste erraten.

## Row-Level Security as a second line of tenant isolation

Deferred for the hosted self-service offering. Tenant isolation currently relies on
application-level tenant filters enforced by the tenant-filter invariant and the
cross-tenant isolation journeys.

- Enable PostgreSQL row-level security on tenant-scoped tables with a per-connection
  tenant setting, so a missing application filter fails closed.
- Cover tables without a tenant column first (runtime config revisions, runtime secret
  versions) or document why they stay operator-only.
- Re-review every `tenant-filter:exempt` site against the policy model.
- Measure the query-plan and connection-pooling impact (session pool mode) before enabling.

## C09 — TODO: vollständige Cloud-Journey und Öffnungsnachweise

Voraussetzungen: C01–C08. Prüfabläufe und Nachweisformat stehen in der
[Teststrategie](browserstack-teststrategie.md). Dieses Paket integriert die
Einzelnachweise; keine erneute Vollprüfung unveränderter Quellen ohne Anlass.

- [ ] Registrierung → bestätigte E-Mail → genau ein eigener Mandant → echte
  KI-Antwort → Konnektor → menschlich freigegebener Workflow → Laufprotokoll.
- [ ] Zwei isolierte Testmandanten: Daten, Objects, Secrets, Suche, Rollen,
  HTTP/MCP/CLI, Inline-Chat, Hooks, Scheduler und Queue negativ prüfen.
- [ ] Parallele Budgetreservierung, globales Limit, Fehlerabrechnung, Quoten,
  faire Ausführung, gesperrte Mandanten und widerrufene Sitzungen/Schlüssel prüfen.
- [ ] Export, Löschung, gegebenenfalls Ablauf und Wiederaufnahme, Backup/Restore
  sowie Incident-/Rollback-Verfahren gegen die tatsächliche Testinstallation prüfen.
- [ ] Clipper, CLI, MCP, HTTP, Cockpit und Google Chat auf Intake-Parität prüfen:
  Sammeln, Kategorien, Discovery, Review, Verwerfen/Wiederherstellen, Proposal,
  authentifizierter Bestätigungshandoff, Provenienz und spätere Suche. Nicht native
  Aktionen brauchen eine funktionierende Fortsetzung; fehlende Live-Kanäle ausweisen.
- [ ] Vor Bestätigung null gewöhnliche Wissenssuchtreffer; identische Bestätigung
  erzeugt genau eine Übernahme; veraltete Vorschläge und unzureichende Rechte ablehnen.
  Codex-/Claude-Briefings finden bestätigte Quellen in ihrer Domäne, ohne rohe
  Cliptexte als Anweisung oder Wissen auszugeben; echten Clientdispatch getrennt belegen.
- [ ] Website-/Cloud-Oberflächen mit konkreter Lovable-Vorlage prüfen; visuelle und
  rechtliche Abnahme sowie Cloud-Go durch Menschen. Vorhandene Self-Hosting-Gates erhalten.
- [ ] BrowserStack-Verbindung und geeigneten Live-Testpfad vor Nutzung verifizieren;
  keine automatischen Tarifbuchungen, Tunnel oder Sitzungen aus der Planung starten.
- [ ] Quell-/Runtimeversion, echte und simulierte Evidenz, Fixture-IDs, Cleanup und
  offene Lücken dokumentieren; Credentials und konkrete Infrastruktur extern halten.

## Dokumentationsübergabe

- [x] Struktur, Produktziel und bisherige technische Aufgaben konsolidiert.
- [x] Offiziellen Lovable-MCP und SubKit-Wissen lesend gegen die Planung geprüft;
  BrowserStack-Verbindung als ungeprüfte Voraussetzung ausgewiesen.
- [ ] Produkt-/Rechts-/Betriebsentscheidungen aus der Roadmap schließen.
- [ ] Erst nach vollständigen Öffnungskriterien Registrierung freigeben.

Die beiden erledigten Punkte bezeichnen lokale Dokumentationsarbeit, keine technische
Cloud-Abnahme und keinen veröffentlichten Stand. Aktuelle Dokumentprüfungen stehen
im [Launch-Status](../LAUNCH_STATUS.md#cloud-dokumentation-und-quellenabgleich).
