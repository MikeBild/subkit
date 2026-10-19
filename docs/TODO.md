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

1. **C01 — TODO: Database connection robustness:** keepalive and bounded connect, query and statement
   timeouts on the pool and the listener, configurable pool maximum, `search_path` set
   per connection so the boot assertion does not depend on role settings.
2. **C02 — TODO: Tenant model and budgets:** tenant origin and status columns, one domain operation that provisions
   a tenant (insert only, random slug, owner role without engine-wide rights, idempotent
   through a global unique identity binding, only for verified emails), central status
   enforcement (login, principals, hooks, cron, dequeue, seeds, session and key
   revocation on suspend), operator-set budget that fails closed and is measured in
   money with a global monthly ceiling, atomic budget reservation with every direct LLM
   call covered, no runtime-config overlay for self-service tenants, tenants cannot set
   their own budget, model or limits.
3. **C03 — TODO: Login per identity:** ignore the tenant query parameter, resolve the tenant in the
   callback, per-provider signup policy instead of the global flag, join an existing
   tenant only through an existing link or an invite token, verified email required,
   adapt the identity assertion, `sk` login and token exchange.
4. **C04 — TODO: Fairness and abuse protection:** per-tenant job grouping and concurrency, per-tenant
   limit for inline chat turns, rate limits per principal and tenant stored in
   PostgreSQL, trusted proxy hop for forwarded addresses, throttled tenant creation and
   MCP client registration, SSRF gaps (database and object-store connectors, redirects,
   DNS rebinding, missing address ranges, internal platform networks), storage quota and
   smaller file limit per tenant, capped tenant-scoped resource limits, chat workspaces
   locked until ownership is proven.
5. **C05 — TODO: Tenant lifecycle:** erasure (data, objects, secrets, config entries, audit event),
   owner-initiated deletion in the Cockpit (design from Lovable), scheduler for trial
   expiry and grace period, lifecycle webhook route that verifies the signed event and
   maps (issuer, subject) to a tenant. Add an owner-authorized data export and a
   reviewable deletion request, including behaviour for in-flight work and backup retention;
   define these semantics before implementation.
6. **C06 — TODO: Authentication mail:** Upraft Auth delivery webhook to the SubKit workflow with the
   execution marked sensitive so action links are never stored in clear text; verify
   step outputs, logs and spans; end-to-end test with a dedicated account before
   switching off the built-in mail; uptime monitor on the hook.
7. **C07 — TODO: Hosted deployment runbook** (outside this repository, every mutation approved):
   Git build of the release commit, session-mode writer binding with owner access,
   compatibility repair of managed schemas, app revision with memory, stop-grace,
   drain and probe values, single replica until limits are in PostgreSQL, object-store
   binding with conformance run, fresh master key with offline escrow, domain and TLS,
   dedicated Auth realm with open signup, paired database and bucket backup, rollback
   rule, uptime monitors. Review all `tenant-filter:exempt` sites and add cross-tenant
   journeys for self-service before registration opens.
8. **C08 — TODO: Product position and legal:** update `LAUNCH.md`, `LAUNCH_STATUS.md`, `README.md` and
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
