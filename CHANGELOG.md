# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.22.0] – 2026-07-20

### Added
- Opt-in, product-internal usage telemetry for canonical HTTP routes, Google Chat and other
  Chat turns, Conversation calls/streams, and MCP JSON-RPC/session/task/capacity behavior.
  Tenant-scoped actor/session identities use a dedicated product-local HMAC; the bounded
  ledger cannot store messages, prompts, tool arguments/results, raw paths/query strings,
  IPs, user agents, OAuth material, or plaintext dynamic identifiers.
- `GET /v1/stats/http|chat|mcp|conversations` and matching
  `sk stats http|chat|mcp|conversations` commands return exact full-window identities,
  numerator/denominator ratios, stream outcomes, latency/byte coverage, retention quality,
  traffic-class separation, and semantic measured/zero/missing states for Cockpit reports.
- `observability.usage.enabled`, `hmac_secret`, and `retention_days` settings; telemetry is
  disabled by default and raw rows expire after 90 days unless configured otherwise.

## [1.21.1] – 2026-07-20

### Fixed
- Workflow validation now rejects bare JSONata calls such as `not(...)` in
  branch predicates and suggests the runtime-compatible `$not(...)` form.
- Successful connector responses now build a cumulative shape contract per
  workflow step, preserving optional fields across executions instead of
  misclassifying their absence as response-schema drift.
- Proactive drift detection is scoped to the exact workflow and step that
  produced the response evidence. Legacy unscoped observations and additive
  response changes no longer create unsafe patch candidates; incompatible
  type changes remain detectable.
- Schema history retains the raw observed response shape alongside its
  cumulative runtime contract, so migration previews remain evidence-based
  without weakening drift detection.
- Test-only audit draining can be scoped to its originating database, avoiding
  ordering-dependent notification-suite timeouts from unrelated disposable
  database writes.
- E2E apps now bind their own PgBoss instance, so parallel disposable
  databases cannot enqueue through or tear down a process-global queue runtime.
- Fast MCP workflow calls can no longer start a progress poller after the run
  has already settled, preventing leaked background queries; disposable test
  databases terminate in-flight backends before awaiting pool drain.
- OAuth credential polling is single-flight per database, uses idle pool
  capacity only, and destroys a client whose bounded read stalls, so slow or
  timed-out waits cannot exhaust the connection pool or block credential writes.
- The E2E release gate runs every file in its own sequential worker process,
  isolating process-global mock/config state and server teardown while each
  app retains its own PgBoss instance.
- Unit and integration gates run every file in a fresh sequential process,
  preventing sessions, disposable pools, queue workers, catalog migrations,
  and module globals from accumulating in a long-lived Bun runtime.
- Elicitation outcome handling loads the conversation tool registry only when
  replaying a confirmed tool call, removing a startup import cycle that could
  expose an uninitialized `ask_user_choice` tool.
- Headless CLI create, resume, and attachment turns consume their POST SSE
  response directly and stop on `completed`, eliminating the replay-subscribe
  race and indefinite waits on keep-alive transports.

## [1.21.0] – 2026-07-20

### Added
- Admin-only, tenant-scoped connector promotion moves or copies a complete
  DEV binding to PROD without secret re-entry. The transactional REST,
  conversation, and CLI surfaces require idempotency, preserve explicit
  source-retention semantics, and emit connector plus per-credential audit
  events.
- Static credentials are re-encrypted under fresh credential ids for copy;
  move preserves OAuth refresh metadata, ciphertext/AAD bindings, health
  state, and end-user credential ownership.

### Fixed
- Schedule catalog responses now include the persisted JSON input payload,
  and create/update/list paths round-trip objects, arrays, scalars, and null.
- Repeated `POST /v1/schedules` upserts return 200 with
  `upsert_status: "updated"` and audit `schedule.updated`; only inserts return
  201 and audit `schedule.created`.
- Built-in Notion health probes send the required `Notion-Version` header,
  including compatibility for connectors pinned to historical template
  snapshots. Probe headers are bounded and cannot inject authentication,
  cookie, or transport headers or shadow saved credential headers.

## [1.20.4] – 2026-07-19

First shipped tag carrying the 1.20.3 changes: the v1.20.3 release build
failed its CI gate (systemd-inherited `JOURNAL_STREAM` on the runners flipped
the new sd-daemon prefix on during tests) and was never published.

### Fixed
- `edit_workflow_patch` reports `workflow_unsupported_placeholder` (with its
  did-you-mean rewrite) again for unknown placeholder namespaces on
  addressing surfaces — the commit-time resolvability gate had shadowed it
  behind a generic `patch_invalid`.
- The google-search-console connector template ingests from the Search
  Console v1 discovery document; Google retired the legacy `webmasters/v3`
  discovery URL.
- Test runs strip an ambient `JOURNAL_STREAM` via a bun test preload, so the
  sd-daemon prefix default stays deterministic on systemd-run CI runners.
- Vendor recipes (claude-desktop, codex) re-verified; the codex config path
  hint now points at `~/.codex/config.toml`.
- commitlint skips dependabot PRs by PR author instead of push actor, so a
  maintainer commit on a dependabot branch no longer lints dependabot's
  changelog-table bodies.

## [1.20.3] – 2026-07-19

### Added
- Log lines now carry sd-daemon priority prefixes (`<3>` error, `<4>` warn)
  when running under systemd, so `journalctl -p err` surfaces application
  errors instead of filing everything at info.
- The connector re-auth scan detects runtime 401 streaks on schedule-bound
  workflows (3 consecutive auth-failed runs) and logs an error naming the
  workflow and connector, instead of reporting `auth_failed: 0` while a
  workflow keeps failing.
- Workflow commit gates reject unresolvable `${...}` placeholders, storage
  bindings that don't resolve, and cadence phrasing without a bound schedule
  trigger — failures that previously only surfaced at runtime.

### Fixed
- Fan-outs against a connector with an open circuit breaker now fail once at
  the parent step instead of scheduling every branch into a doomed
  `circuit_open` failure (observed: 464 step failures in 3.5 minutes).
- Write steps fail hard when the requested connector environment falls back
  (dev → prod) instead of silently mutating production; reads keep warning.
- MCP session admission is bounded by a hard cap above the soft cap, and
  stuck leases time out and become evictable, so sessions can no longer grow
  past the cap indefinitely.
- Provider quota exhaustion (HTTP 429 / usage-limit messages) parks
  conversation turns until the reported reset time instead of failing them
  permanently on no-retry queues.

## [1.20.2] – 2026-07-18

### Added
- Workflow schedules now persist an explicit `execution_mode` and expose it
  consistently through workflow triggers, REST/OpenAPI, CLI, conversation
  tools, audits and documentation. Durable automation defaults to `prod`;
  short authoring loops can opt into `dev`.

### Fixed
- Scheduler-created executions now carry their schedule's execution mode into
  the queue worker. Production schedules therefore resolve production
  connectors directly instead of recording `execution_mode=dev` and emitting
  a misleading environment-fallback warning while still reaching PROD.

## [1.20.1] – 2026-07-18

### Fixed
- Connector statistics now read both canonical audit metadata and the aliases
  emitted by the shared egress wrapper. Successful HTTP and GraphQL calls are
  classified by their real status instead of appearing as `network_error`;
  connector, method, endpoint and latency grouping also works for existing
  audit rows. Successful non-HTTP calls such as S3 use the explicit `no_status`
  class. New rows carry the canonical fields and the legacy aliases during the
  compatibility window.

## [1.20.0] – 2026-07-18

### Added
- Canonical W3C Trace Context continuation at the HTTP edge and OpenTelemetry
  service/deployment resource fields on structured logs.

### Changed
- HTTP tracing now follows W3C Trace Context semantics: all-zero IDs are
  rejected, every request creates a fresh server span, sampled flags propagate,
  and new HTTP traces use full 128-bit trace IDs. Structured records include
  `trace_id`, `span_id`, `service.name`, `service.version`, and
  `deployment.environment.name`.
- `observability.deployment_environment` configures the general
  `deployment.environment.name` telemetry resource field. Existing
  tenant-scoped `/v1/stats/*`, HTTP connectors, workflows and S3 connectors
  remain the reusable building blocks for external reporting pipelines.

## [1.19.1] – 2026-07-17

### Changed
- GitHub release pages now carry the release's own `CHANGELOG.md` section as
  their body, so "what shipped in this tag?" is answered on the release page
  itself — an empty body made a released commit look unreleased. A tag without
  a matching changelog section falls back to a link to `CHANGELOG.md`; the
  notes step never fails a release. The v1.18.0 and v1.19.0 release pages were
  backfilled the same way.

## [1.19.0] – 2026-07-17

### Added
- [Use sk from a coding agent](docs/authors/coding-agents.md) — one page from
  install to a grounded session, for Claude Code, Codex, Cursor, Claude Desktop,
  claude.ai, and ChatGPT: connect the client, import your wiki with the
  `domain:` tag, verify the briefing, and close the review loop. It states per
  client which channels actually work (Claude Code and Codex get the briefing
  hook; the rest are MCP-only, and get the grounding rule as a rules-file
  snippet instead). The docs index and the root README now route coding-agent
  users straight to it instead of through the contributor lane.

### Fixed
- `sk --help` hid most of the CLI. `persona_hint` was only ever set for
  portal-token logins, so every profile from a normal `sk login` fell back to
  the lowest tier and the whole authoring surface — `sk agent`,
  `sk knowledge-sources`, `sk skills`, `sk learnings`, and the operator
  commands — was undiscoverable, even for admins. `sk login` now records the
  persona from the key's actual role, and an unknown or unset persona shows
  every command rather than hiding them (help is UX-only; the engine
  permission-checks every call regardless).
- `read_knowledge` never reached the chat surface: it was documented as a chat
  tool but missing from the fail-closed read-only allow-list, so Slack / Teams /
  Google Chat could search knowledge but not read a source back. The chat
  palette test now asserts the knowledge-read tools are present, not just that
  nothing leaks.
- Aligned the MCP setup instructions that disagreed across pages (server name,
  `SK_API_KEY` vs `SUBKIT_API_KEY`, transport string), documented where the API
  key actually comes from, and corrected the self-host guide's claim that the
  `sk mcp` stdio proxy exposes the full tool catalog — it carries only the
  `sk_conversation_*` tools.
- The MCP OAuth cleanup sweep no longer fails intermittently
  (`mcp_oauth_cleanup.refresh_tokens_failed`): deleting an expired refresh
  token that a still-live access token references hit an `ON DELETE NO ACTION`
  foreign key. The link is now `ON DELETE SET NULL` (migration covers both the
  historical and the fresh-install constraint name), so the sweep proceeds and
  the surviving access token simply loses its refresh link.

## [1.18.0] – 2026-07-17

### Added
- Import a whole markdown directory as one knowledge source: `sk
  knowledge-sources import ./team-wiki` for CI, `/knowledge import ./team-wiki`
  in the REPL. An Obsidian vault, an agent-maintained wiki, an
  [OKF](https://okf.md/) bundle, or a Notion export becomes one searchable
  source with a passage per file, so chat, MCP clients, and workflows ground on
  your own runbooks. Import is an upsert by slug — unchanged content is a no-op,
  changed content re-ingests in place — so a nightly job keeps sk in sync with a
  git wiki without churn.
- Frontmatter is read tolerantly and never rejected: `type: Runbook` becomes a
  filterable `type:runbook` tag, a `tags:` list joins the topical set, files
  without frontmatter import fine, and the reserved `index.md`/`log.md` are
  skipped at any depth so an agent appending to its log never rotates the
  source version.
- Knowledge reads back in full, not just as snippets: the `read_knowledge` tool
  (chat + MCP, gated on `knowledge:read`) pages through a source's whole
  content and takes a `path` to read one file of a bundle;
  `GET /v1/knowledge-sources/{id}/chunks` is the raw HTTP form. Nothing is
  locked in — an agent or script can pull every byte back out.

### Changed
- The `knowledge://` MCP resource now serves the actual markdown content
  (byte-capped, with a truncation notice) instead of a metadata stub, so an MCP
  client can read a source it can already see.
- The tenant knowledge byte budget now gates re-ingests as it has always gated
  creates: a source that grows past the cap on refresh is refused rather than
  silently admitted.

### Fixed
- Frontmatter from an untrusted vault can no longer mint `domain:*` routing
  keys — only the bounded `type:` mapping and operator-supplied `--tags` may —
  so importing a third-party wiki cannot steer another domain's grounding.
- The boot seed sweep no longer overwrites a source a tenant deliberately put on
  a seed slug; the tenant's own knowledge wins and the sweep leaves it alone.

## [1.17.0] – 2026-07-16

### Added
- Answers grounded in a knowledge source or connector documentation now show a
  dim `Sources: <name>` footer in `sk`, naming the sources the answer was built
  on so a reader can verify the claim rather than trust the prose. A source-less
  answer shows nothing; the same references are mirrored to the audit log. The
  footer appears on the live REPL and on replayed transcripts (headless
  `sk -p`, the plain REPL) alike.
- `/context` shows a grounding-staleness advisory: when a workflow draft was
  built on a connector schema that has since changed, it flags "re-check before
  saving". Advisory only — it never blocks, and any ambiguity (a missing or
  expired discovery index, a recompute error) resolves to silence rather than a
  false warning.

### Changed
- A declined confirmation now sticks within the conversation: after you decline
  a concrete action, an identical re-proposal is answered with the prior decline
  instead of re-prompting — even in auto mode. The guard is one-shot, so a
  deliberate retry can still reach a prompt; an edited draft prompts normally;
  and a plain question (no concrete action) is never suppressed.

### Fixed
- Source citations now actually fire. The harvester read the wrong tool-result
  shape, so the `Sources:` footer and the `conversation.answer_cited` audit
  mirror never appeared in production. As a result the source-faithful
  anti-drift check — which verifies that quoted spans appear in a cited source
  — now runs on grounded chat answers as designed; `ts_headline` highlight
  markup is stripped from excerpts so a verbatim quote is not misread as
  ungrounded.

## [1.16.0] – 2026-07-15

### Changed
- Chat/MCP `create_skill` now files a PROPOSED skill candidate for human
  review instead of silently activating a skill — it lands in the same
  queue as session learnings (`sk learnings review`, the REPL
  welcome-row starter, or an in-session `approve_skill_candidate`).
  Identical re-proposals dedup; revised content files a fresh candidate.
  The admin/REST create stays direct. This closes the one remaining
  bypass of the never-auto-promote invariant.

### Fixed
- `SK.md` memory merge is byte-accurate and keeps the closest project
  file: under over-cap it previously discarded exactly the
  highest-priority (cwd-closest) section first and measured UTF-16 code
  units against a byte cap. Far sections now collapse to a one-line
  marker; section headers carry the source path plus a content hash.
- Long conversations no longer lose authoring evidence without a trace:
  when the context trimmer sheds the connector-operations index or
  recorded endpoint samples, a one-line reference naming the reload tool
  stays in the prompt (so the model re-fetches instead of guessing), and
  `/context` shows what the last turn trimmed (`tokens used/cap` + the
  dropped sections).

### Added
- `policy.denied` audit rows from the tool dispatcher carry `args_hash`
  — the same fingerprint the approval lifecycle uses — so a denied
  intent joins forensically with any approval for the identical call
  (hash only, never raw values).

## [1.15.0] – 2026-07-15

### Added
- The skill-candidates list endpoint returns `total` — the true
  matching-row count for the applied filters, independent of the page
  cap. The sk REPL's "Review N proposed learnings" starter now shows the
  honest backlog (previously it plateaued at 100 and downloaded up to
  100 full candidate payloads on every boot just to render a number).

### Fixed
- The post-ingest embedding kick is truly source-scoped: it no longer
  sweeps the tenant's entire un-embedded connector-doc and
  conversation-topic backlog (unbounded, with an N+1 query per
  conversation) on every knowledge create/ingest, and it short-circuits
  when the local embedding model is unavailable. The capped 5-minute
  scheduler sweep keeps owning the tenant-wide backlog.
- Knowledge tag curation: only namespace-PREFIXED tags (`domain:x`) are
  structural; a topical tag containing a colon mid-string can be cleaned
  by re-analysis again, and an explicit tags edit remains the one way to
  re-home a source out of a domain (now documented).

### Changed
- Internal hardening from the post-release review: the read-only MCP
  exemption is a declared per-tool property instead of a hand-curated
  name set, `/learnings` and the starter action share one prompt source,
  the REPL start-screen signals ride one boot-snapshot channel (the
  tenant-switch re-seed is structurally shared), and the first-paint
  contract plus the immediate-embedding behavior are pinned by tests.

## [1.14.1] – 2026-07-15

### Fixed
- The "Review N proposed learnings" starter reliably appears on the sk
  REPL's first paint — the count is now resolved with the other boot
  snapshots instead of racing Ink's once-flushed welcome banner.

## [1.14.0] – 2026-07-15

### Added
- Approve a captured learning without leaving the coding session:
  `approve_skill_candidate` is directly callable over MCP — the client's
  native destructive-write dialog is the explicit operator approval, and
  RBAC `skill:write` remains the hard gate.
- The sk REPL start screen surfaces the curation queue (a numbered
  "Review N proposed learnings" starter when proposals exist) and
  `/learnings` opens the same chat-first review.

### Fixed
- Knowledge analysis preserves namespaced tags (`domain:*` etc.) —
  re-analysis no longer drops a source out of its domain briefing and
  tag-filtered search.
- Freshly created or updated knowledge sources are embedded immediately
  (source-scoped, off the request path) instead of waiting for the
  5-minute sweep; measured A/B: semantically findable after ~6s versus
  not at all within 3 minutes on the previous release.

## [1.13.3] – 2026-07-14

### Fixed
- CI stability: audit-log test assertions poll for their own rows instead
  of draining the process-global pending-writes set (a hung neighboring
  suite could stall the drain for the whole test timeout). Supersedes the
  unreleased 1.13.1/1.13.2 tags and ships their content.

## [1.13.2] – 2026-07-14 (tag never released — gate failure, superseded by 1.13.3)

### Fixed
- Test-only audit drain awaits a snapshot of in-flight writes instead of
  looping until the process-global set is empty — a background writer could
  livelock the drain and time the calling test out on CI. (v1.13.1's release
  gate tripped over exactly this; 1.13.2 ships its content.)

## [1.13.1] – 2026-07-14 (tag never released — gate failure, superseded by 1.13.2)

### Added
- Coding-agent integration guide (`docs/developers/coding-agent-integration.md`)
  — the full briefing → lookup → capture → review → sync loop for Claude Code
  and Codex, beginner-first; served via `/llms.txt` and `/llms-full.txt`.

### Changed
- The embedded platform-reference knowledge seeds (`sk-ref-cli`,
  `sk-ref-rest-api`, `sk-ref-mcp-tools`, knowledge-and-skills) and the
  default skills (`sk-cli-reference`, `domain-setup-onboarding`) now cover
  the coding-agent surface, so in-product grounding answers match the
  shipped commands and routes.

### Fixed
- The dead-letter reconciliation now stamps `mcp_tasks.failure_reason` and
  writes the `conversation.turn_failed` audit entry in one transaction —
  no more observation window where the state change is visible without its
  audit evidence.

## [1.13.0] – 2026-07-14

### Added
- `sk skills sync` materializes active, domain-tagged skills as
  Agent-Skills-standard `SKILL.md` directories into `.claude/skills/`
  and `.agents/skills/` of the repo declaring the domains. Only
  sk-managed directories (marker comment) are created, updated, or
  pruned — hand-authored skills are never touched.

### Fixed
- Deleting a promoted skill no longer fails on the candidate's foreign
  key: `skill_candidates.promoted_skill_id` is set null on skill delete
  and the candidate keeps its approved status as history.

## [1.12.1] – 2026-07-14

### Fixed
- `GET /v1/skill-candidates` accepts every `pattern_kind` filter value —
  a hand-copied subset enum silently rejected `session_learning` and
  `authoring_capability`, breaking `sk learnings list`.

## [1.12.0] – 2026-07-14

### Added
- Coding-agent session capture: `POST /v1/agent/sessions` accepts a
  session transcript and distills durable, human-taught learnings into
  `session_learning` skill candidates (new `skill:propose` permission;
  analysis runs on the `agent-session.analyze` queue). Nothing goes live
  without human review.
- `save_learning` tool (conversation + MCP): explicitly capture a rule
  the user taught mid-session as a proposed candidate. Additive and
  confirmation-free; proposing never implies the authority to approve.
- `sk learnings review` / `sk learnings list`: interactive curation of
  proposed learnings — approve (optionally after editing) promotes to an
  ACTIVE, domain-tagged skill that the next session briefing carries;
  reject retires the learning for good.
- `sk agent capture` and SessionEnd hook wiring in `sk agent init`:
  finished Claude Code sessions in domain-declared repos are captured
  automatically (Codex uses the printed Stop-hook snippet).

### Changed
- Skill candidates carry `tags`; approval copies them onto the promoted
  skill. Session learnings are fingerprint-identified (normalized title +
  domains): re-taught rules accrue evidence instead of duplicating, and
  distinct learnings coexist in the review queue.

## [1.11.0] – 2026-07-14

### Added
- `GET /v1/agent/briefing` — budgeted, domain-scoped grounding block for
  external coding agents (Claude Code, Codex): active skills tagged
  `domain:<slug>` as conventions, a knowledge index (full documents stay
  behind `search_knowledge_v2`), a search-first grounding rule, and the
  open-candidate counter. Deterministic budget trim: index entries drop
  first, then skill bodies collapse to pointer lines, last skill first.
- Domain convention: the tag `domain:<slug>` on skills and knowledge
  sources scopes them to a business domain; a repo declares its domains
  in `.sk/agent.json`.
- `sk agent briefing` (SessionStart-hook mode reads the hook payload from
  stdin and never fails the session) and `sk agent init` (writes
  `.sk/agent.json`, wires the Claude Code SessionStart hook idempotently,
  prints the Codex hook snippet and MCP registration commands).

### Changed
- MCP connect instructions now carry the search-first grounding rule;
  `search_knowledge_v2` and `find_skill` are exempted from client-side
  deferred tool loading (`anthropic/alwaysLoad`).

## [1.10.0] – 2026-07-13

### Added
- The full HTTP API is now documented: all previously spec-invisible
  routes (the `/v1/rbac/*` family, discovery runs, knowledge-source and
  conversation uploads, the credential-setup form) carry OpenAPI
  registrations, and the undocumented-route ratchet tests are pinned
  empty so new drift fails CI.
- Typed `request_credential_form` conversation event: when the sk
  composer intercepts a pasted secret, the engine now opens the masked
  credential form deterministically (no model call); the prose fallback
  still works for older CLIs.
- Cross-tenant executor isolation is proven end-to-end over MCP: a
  principal that passes RBAC still cannot reach another tenant's
  connector (tenant-scoped SELECT defense).

### Changed
- Discovery archives and knowledge uploads persist their bytes into the
  canonical `files` table (deduplicated, scanned, linked and audited)
  instead of writing past it; `knowledge_sources.file_id` is populated
  for file-backed sources.
- The `http/routes` coverage floor is enforced (was deferred at 0), and
  the coverage runner no longer dies on large test output.

## [1.9.6] – 2026-07-13

### Fixed
- Honest run results: `on_error: continue` failures surface as warnings instead of a
  false-positive success or a false error.
- MCP conversation approvals are reconciled after engine restarts — no more zombie
  pending approvals.

## [1.9.5] – 2026-07-09

### Fixed
- Wildcard-scope principals resolve to the authoring catalog on the MCP surface.

## [1.9.4] – 2026-07-09

### Changed
- MCP advertises the full authoring catalog; removed `find_tool` and the
  token-budget catalog trim.

## [1.9.3] – 2026-07-09

### Changed
- Writes over MCP are gated via the client's native `destructiveHint` dialog
  instead of the approval portal (re-cut of 1.9.0/1.9.2).

### Fixed
- Reground the `mcp-tool-contract` skill to the client-dialog write gate;
  English-only skill content.

## [1.8.2] – 2026-07-09

### Fixed
- Portal-only write approval on MCP plus `find_tool` catalog discovery.

## [1.8.1] – 2026-07-09

### Added
- Human-in-the-loop write governance for MCP via the approval portal (1.8.0,
  re-cut as 1.8.1).

### Fixed
- RBAC runs before tool-name canonicalization on the MCP surface.

## [1.7.1] – 2026-07-07

### Added
- Cross-layer regression test for the install-answer output guard.

## [1.7.0] – 2026-07-07

### Added
- Credential-setup portal for connector re-authentication.
- Graceful drain on deploy — in-flight executions finish before shutdown.
- Row-first workflow descriptions.

## [1.6.0] – 2026-07-07

### Changed
- `tenant_read` inventory tools are RBAC-gated on the chat and MCP surfaces;
  self-status answers are grounded.

## [1.5.0] – 2026-07-07

### Added
- `sk chat install-space` with pending-space discovery for Google Chat.
- Google Search Console connector template.

## [1.4.3] – 2026-07-07

### Fixed
- Chat-surface guard exempts the sk installer instructions (1.4.1–1.4.3:
  authoring-leak fix, engine-URL grounding, output-guard follow-ups).

## [1.4.0] – 2026-07-06

### Added
- Grounded skills-vs-knowledge answers and guided domain setup in chat.

## [1.3.6] – 2026-07-06

### Fixed
- Chat channel end-to-end polish (1.3.0–1.3.6): run workflows from prose, native
  chat formatting, surface-gated install grounding, table rendering, honest
  self-update failures with private-repo token support, sk served from the
  engine `/install` endpoint.

## [1.2.0] – 2026-07-05

### Security
- Secret input mode: elicitation answers and secret tool arguments never
  transit the transcript or LLM context.

## [1.1.1] – 2026-07-05

### Fixed
- Data-fidelity root causes in held writes and vendor payload shaping;
  `conversation_commit` derives its reply from the persisted rows; bounded
  per-turn memory in model-message assembly.

### Changed
- Generic stdlib surface names — vendor wire formats hidden behind shape
  detection; dependency refresh (TypeScript 6, Biome 2.5, js-yaml 5).

## [1.0.0] – 2026-07-04

First public release.

- **Engine** — self-hostable workflow engine: versioned workflow definitions,
  deterministic execution with step-level auditing, multi-tenant RBAC,
  encrypted credential storage, OAuth2 flows, inbound webhooks, scheduler,
  and self-healing patch candidates behind human approval.
- **AI-assisted authoring** — describe an outcome in natural language; the
  engine drafts a grounded workflow, dry-runs it against recorded previews,
  and commits only on explicit approval. Execution never re-decides control
  flow at runtime.
- **Connectors** — a template catalog across HTTP, GraphQL, PostgreSQL, and
  S3 drivers, with endpoint discovery, docs ingestion, and vendor-drift
  sweeps.
- **Surfaces** — `sk` CLI (REPL + admin), REST API with generated OpenAPI,
  MCP server for AI clients, chat adapters, and inbound webhooks.
- **Operations** — structured logs, metrics, traces, token-budget
  accounting, immutable audit trail, signed release binaries, and Docker
  images.
