# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.22.32] – 2026-08-28

### Fixed

- Cockpit actions now use the family-wide neutral primary hierarchy; blue is
  reserved for links and informational emphasis across sign-in, failure, and
  application surfaces.

## [6.22.31] – 2026-08-28

### Fixed

- Authenticated Cockpit and API reads no longer consume the shared anonymous
  per-IP rate-limit budget, so browser smoke tests and screenshot captures can
  complete without weakening protection for public requests.

## [6.22.30] – 2026-08-28

### Fixed

- Cockpit sign-in now opens the product-local SSO/API-key chooser directly with browser-localized German and English copy and consistent product identity.
- Unknown Cockpit routes and bootstrap failures now use the concise family 404/500 states, while API errors outside the Cockpit remain machine-readable.

## [6.22.29] – 2026-08-27

### Fixed

- Catalogue tables now use the shared compact cell density so skill records stay within the family row-height contract.

## [6.22.28] – 2026-08-27

### Fixed

- Dense catalogue tables now keep one compact relation chip per row, summarize additional links without exposing raw engine names to assistive technology, and use the shared row height across primary collections.

## [6.22.27] – 2026-08-27

### Changed

- Primary Cockpit collections now share the family 1280-pixel workbench with searchable, sortable, configurable, paginated, URL-addressable, responsive rows and explicit data states; embedded collections keep the same anatomy at compact density.

## [6.22.26] – 2026-08-27

### Fixed

- Legacy workflow step previews now humanize UUIDs and ISO timestamps before rendering, so the cockpit keeps machine identifiers in the evidence depth instead of exposing them as primary content.

## [6.22.25] – 2026-08-27

### Changed

- The decisions page now follows the shared family workboard: fixed blocked, overdue and remaining groups; no more than 25 initially visible compact positions; human-readable impact and source; folded technical evidence; and explicit data states.

## [6.22.24] – 2026-08-26

### Fixed

- The canonical Cockpit overview is served directly at `/cockpit`; session returns and sign-out preserve that exact product-family start address without a redirect.

## [6.22.23] – 2026-08-26

### Fixed

- The overview now canonicalizes the product-family entry address to `/cockpit` without keeping a legacy trailing-slash route.

## [6.22.22] – 2026-08-26

### Changed

- The default Cockpit route is now a compact operational overview with the shared five-KPI decision model, product KPIs, accessible drilldowns, and no queue or raw backend text on the start page.
- REST, the read-only `get_operational_overview` MCP tool, and Prometheus now project the same role-scoped operational snapshot.
- Authenticated read and screenshot traffic has a dedicated high-rate budget while public and write limits stay protected.

## [6.22.21] – 2026-08-26

### Fixed

- The overview now exposes its tile group as one measurable surface, allowing the shared parity harness to prove that the incident banner precedes every overview card without changing the visible layout.

## [6.22.20] – 2026-08-26

### Changed

- Shared collection and decision surfaces now expose measurable loading, empty, and error states, including immediate retry feedback while reads are retried.
- The mandatory cockpit browser gate now exercises those three controlled states and verifies that a future decision kind cannot unmount the queue or leak its raw enum.

### Fixed

- Workflow step configuration hides UUID-shaped references embedded in paths instead of exposing opaque database identifiers.

## [6.22.18] – 2026-08-25

### Changed

- Catalog details now expose the shared family detail header, navigation, context, actions, and main-content anatomy.

## [6.22.17] – 2026-08-25

### Changed

- Relation-heavy cockpit list rows now stay within the shared family density while preserving every hidden relation through an accessible compact remainder.

## [6.22.16] – 2026-08-25

### Changed

- Shared cockpit data tables now expose a measurable family list surface, toolbar, and addressable desktop and mobile rows.

## [6.22.15] – 2026-08-25

### Changed

- The cockpit settings view now declares its shared family configuration mode for measurable cross-product parity.

## [6.22.14] – 2026-08-25

### Changed

- Overview content and headers now share the family reading axis, and decision cards use the common family radius.

## [6.22.13] – 2026-08-25

### Changed

- Cockpit page content now exposes the shared family measurement slot, and the mobile navigation trigger uses the common 32 px control size.

## [6.22.12] – 2026-08-25

### Fixed

- The audit table now names current credential, settings, inbound-webhook and MCP OAuth resources and operations, and uses truthful neutral labels for future resource or operation kinds instead of exposing raw enums or “Unbekannt”.

## [6.22.11] – 2026-08-25

### Fixed

- Audit entries for issued browser sessions now use the human resource name “Sitzung” and the action “Sitzung ausgestellt” instead of an unresolved resource label.

## [6.22.10] – 2026-08-25

### Fixed

- Audit entries for notification deliveries now use a human resource name instead of the unresolved state “Unbekannt”.
- Workflow detail cards translate engine step kinds into human-facing German and English labels instead of rendering raw enums.

## [6.22.9] – 2026-08-25

### Fixed

- Reviewer-facing conversation titles now also hide UUID-shaped references that historical title generation had already shortened with an ellipsis.

## [6.22.8] – 2026-08-25

### Fixed

- Reviewer-facing conversation titles now hide legacy UUID-shaped references even when historical data does not use RFC-conformant version or variant nibbles.
- Catalogue details no longer expose opaque resource identifiers in the rendered cockpit.

## [6.22.7] – 2026-08-25

### Fixed

- The cockpit hides opaque conversation references and uses canonical SubKit casing in reviewer-facing titles and excerpts.
- S3 credential integration setup no longer hides MinIO bucket creation failures behind misleading `NoSuchBucket` errors.

## [6.22.6] – 2026-08-24

### Changed

- The decisions queue now uses the family status signal, spacing and authoritative open-count banner throughout the cockpit.

## [6.22.5] – 2026-08-24

### Changed

- The overview header and all three content zones now share the family working measure and vertical rhythm across desktop and mobile layouts.

## [6.22.4] – 2026-08-24

### Changed

- The overview now follows the family A/B/C anatomy. Recent-run history moved off the start screen; the failure-and-risk hero now ends in one audit-trail exit.

## [6.22.3] – 2026-08-24

### Changed

- The decisions cockpit now uses the family's single-queue anatomy. Redundant
  KPI tiles were removed, and the visual sweep follows the same stable queue.

## [6.22.2] – 2026-08-23

### Fixed

- **Long-lived HTTP transports can no longer consume the hard-kill budget.**
  Production proved that pg-boss now drains in milliseconds, but Node's HTTP
  close callback can remain pending even after all ordinary connections are
  force-closed. Shutdown now bounds that final callback wait to one second,
  records the timeout explicitly, and continues closing database and tracing
  resources instead of waiting for the 140-second process kill.
- **A completed shutdown is now observable.** The engine emits
  `shutdown.complete` immediately before its clean exit, so a deployment can
  distinguish a fully converged stop from a process that only reached
  `boss.stopped`.

## [6.22.1] – 2026-08-23

### Fixed

- **Graceful shutdown can now converge before the hard-kill deadline.** The
  engine stops HTTP admission without waiting for long-lived SSE or MCP
  sockets, stops every queue producer and listener, then drains pg-boss before
  closing the remaining transports. Deploy shutdowns therefore no longer race
  newly enqueued `event.fanout` work or spend the drain budget waiting on a
  persistent client connection.
- **Queue shutdown now explains where its drain budget went.** Structured
  `boss.stop_begin` and `boss.stopped` records include the timeout, elapsed
  time, and a sanitized worker snapshot, so an occupied queue can be
  distinguished from an HTTP transport that has not closed.

## [6.22.0] – 2026-08-22

### Fixed

- **The audit trail dispatched over MCP with no permission check.**
  `list_audit` and `get_audit_entry` serve the same rows as
  `GET /v1/audit-log`, which demands `audit:read`. On MCP they carried no
  `rbac` descriptor, and the dispatcher's step is `if (descriptor.rbac)` — so
  `can()` was skipped entirely and any MCP principal could page the tenant's
  whole audit history. The `member` role names this exact denial in its own
  description ("NOT permitted: … audit reads") and does not hold
  `audit:read`; neither does `enduser`. Both tools now require it,
  tenant-scoped, matching the HTTP middleware.
- **Forgotten was the default, so one entry was not the answer.**
  `descriptorFor` now falls back to a tool's own `permission` declaration,
  which `wrapOne` had been enforcing on the chat path only — one declaration
  now covers both surfaces, and it can only ever add a `can()`. Ungated tools
  drop from 82 to 61 in the admin catalog and from 46 to 41 in product mode.
  `rbac-descriptor-coverage.test.ts` names every remaining ungated tool with a
  reason and fails on any new one, so the number is visible rather than implied.
- **The audit scrubber ate the skill version history.** `audit_log.before`/
  `.after` is not only a log: `updateSkill` writes whole Skill rows there and
  `restoreSkill` reads them back. Running the prompt-prose net over those
  columns collapsed `Skill.body` to a redaction marker, and because
  `restoreSkill` delegates to `updateSkill`, a restore wrote that marker back
  as the live body of an append-only record. The prose net is now off for the
  two snapshot columns and on everywhere else; both credential nets still run
  on all four fields. No released build ever carried the defect.
- **The body redaction net deleted structured payloads.** A `request_body`
  object was matched by key name and replaced whole, so the operator lost
  exactly the record the log is opened for. The prose half still collapses
  strings and objects; the `body` half now collapses strings only and recurses
  into objects, so nested prose one level deeper is still caught.
- **A malformed `before` cursor was a 500, not a 400.** Widening the parameter
  to admit the keyset cursor left no shape check, so any 1..128-character value
  reached Postgres as a `::timestamptz` / `::uuid` cast and surfaced a client
  error as a server fault.

### Changed

- **The invariant run is now part of CI, on the push path.**
  `audit-invariants.yml` triggered on `pull_request` and `schedule` and hung
  outside the `build` aggregate branch protection requires, so a direct push to
  main ran no invariant at all. The blocking run is now the `invariants` job in
  `ci.yml`; the nightly stays for drift on main that no push triggered.
- **The wildcard-bind invariant knew one of two `serve()`.** It matched
  `Bun.serve(` only, while the suites that actually broke the gate call the
  bare `serve()` from `@hono/node-server` — including the harness behind every
  HTTP and MCP suite. Both forms are matched now, and the allow-list marker is
  read from the lead-in comment rather than a trailing one a formatter moves.
- **Fifteen S3 cases that checked nothing reported pass.** Each gated on Docker
  with a bare `return` in its body, so under `SKIP_DOCKER=1` they entered,
  returned, and were counted as passed. The probe runs once at module scope and
  the suites are gated with `describe.skipIf`, so they report as skipped. The
  `expect()` count is unchanged — the same five cases were doing all the
  verifying the whole time.

## [6.21.0] – 2026-08-20

### Added

- **The engine answers `/health` and `/ready` as well as `/v1/health` and
  `/v1/readyz`.** The unversioned pair runs the same handlers — same bodies,
  same status codes, the same 503 while the database is unreachable or the
  unit is draining — so a probe that knows only the conventional names no
  longer reads a 404 as a dead service. The versioned pair stays the
  documented contract and the only probe in `openapi.json`.

### Changed

- **The version line continues at 6.21.0.** Release identities are immutable
  once their workflow has run, and 6.8.0 through 6.20.12 were claimed by an
  earlier numbering era of this repository. The next free minor above that
  block is 6.21.0; nothing else about the release changes.

## [6.7.1] – 2026-08-19

### Fixed

- **Release versions remain immutable after their first workflow attempt.** The
  tag command now checks GitHub Actions history as well as live Git tags, so a
  deleted tag or Release cannot make an already-used version available again.

- **The local isolated-test gate now uses the same default mock LLM provider as CI.** The
  runner previously set `NODE_ENV=test` without supplying the provider default already used by
  CI and the isolated E2E runner, so provider-facing unit tests could fail locally before their
  stubs were reached. An explicit caller setting still wins.

- **Dry-run previews cannot dispatch mutating transports through a false read
  override.** Workflow validation rejects `side_effects: "read"` on PUT,
  PATCH, DELETE, and S3 mutations, while runtime classification keeps legacy
  definitions held. Read-only POST searches remain supported.

## [6.6.6] – 2026-08-19

### Added

- **HTTP pagination can place offset, page, limit, or cursor parameters in a
  JSON request body.** `parameter_location`, `items_path`, `page_size`, and
  `max_pages` are stored in each workflow version, so vendor-specific GSC,
  GA4, and other report settings can change without an engine deployment.
- **Read-only POST searches use the read retry contract.** A request explicitly
  classified as `side_effects: "read"` retries transient 5xx responses without
  adding write idempotency metadata.
- **Paginated reads can preserve raw response pages.** Set
  `output_mode: "pages"` in the workflow version to return the ordered,
  unmodified page bodies for append-only archival before normalization.

### Fixed

- **Pagination retries always return a complete collection.** Progress
  checkpoints remain diagnostic evidence, but a retry restarts at page one
  until accumulated page data has durable storage; it no longer skips earlier
  pages and returns only a suffix.
- **Documented bare pagination paths now work.** Values such as `rows` and
  `paging.next.after` are normalized to selectors while explicit `$` selectors
  remain supported.
- **Page limits fail closed.** Reaching `max_pages` before the endpoint signals
  completion fails the step instead of reporting a bounded prefix as complete.
- **The pagination memory ceiling fails closed.** If another page is required
  after the accumulator reaches the engine safety limit, the step fails rather
  than succeeding with a warning and a truncated result.

## [6.6.4] – 2026-08-19

### Fixed

- **Migration diagnostics distinguish accepted history from real drift.**
  Tagless journal rows retained from the pre-squash lineage are reported as
  accepted history instead of blocking `sk doctor`; unknown tagged identities
  and missing embedded identities remain blocking failures.
- **Schema-drift status now follows the migration runner's stable identity
  contract.** The diagnostics API, audit metadata, engine health state and CLI
  agree on the same tag-and-hash classification.

## [6.6.3] – 2026-08-19

### Fixed

- **Durable abort requests recover immediately after a worker disappears.** A
  periodic or boot-time recovery pass now moves the orphaned execution to
  `aborted` without waiting for its workflow timeout.
- **Execution, step, event, and audit state recover atomically.** Running step
  rows are terminalized in the same transaction as their parent execution,
  and a late worker cannot overwrite the recovered state.
- **Recovery repairs inconsistent rows left by earlier engine versions.** A
  bounded, indexed reconciliation pass finds running steps beneath an already
  terminal execution, applies the parent's terminal status, emits the missing
  step event, and records the repair in the audit trail.

## [6.6.2] – 2026-08-18

### Fixed

- **Executions orphaned by a worker or engine restart are reconciled
  periodically.** Recovery is no longer limited to engine startup, so rows
  that were still inside their timeout window during boot cannot remain in
  `running` forever.
- **Crash recovery uses the workflow version recorded on the execution.**
  Later workflow edits can no longer change the timeout contract used to
  recover an older run.

### Added

- **The recovery sweep interval is a global hot-reloadable setting.** Operators
  can tune `queue.crash_recovery_sweep_interval_ms` without rebuilding or
  restarting the engine.

## [6.4.7] – 2026-08-18

### Fixed

- **HTTP request deadlines no longer depend on the runtime transport settling.**
  The engine now rejects its observed request promise when the execution or
  step signal aborts, even if a stalled Bun `fetch` ignores the signal and
  remains pending. Step timeouts and execution cancellation therefore reach a
  terminal persisted state instead of leaving runs stuck in `running`.

## [6.4.6] – 2026-08-18

### Fixed

- **Turn-level LLM fallback now switches provider and model together.** A
  cross-provider route such as Anthropic to OpenAI no longer sends the
  fallback model identifier through the primary provider. Provider-specific
  caching, thinking, web-search, step routing, telemetry, and model resolution
  all follow the active attempt.

## [6.4.5] – 2026-08-18

### Added

- **Loops can stop after the first non-tolerated body failure.** Set
  `fail_fast: true` on a `loop` to skip the remaining body steps and later
  iterations after a body step governed by `on_error: "fail"` fails. Existing
  workflows keep the collect-all default until they opt in.

## [6.2.14] – 2026-08-16

### Fixed

- **Execution cancellation now reaches the worker across engine replicas.**
  The cancel endpoint persists an idempotent, tenant-scoped abort request and
  audits it atomically before using the process-local fast path. Each worker
  monitors only its registered executions and aborts an in-flight provider or
  connector request when the durable flag appears.
- **A cancel racing with queue pickup can no longer resurrect an execution.**
  The queued-to-running transition is compare-and-set and refuses a row with a
  pending abort request. The monitor interval is available as the globally
  scoped, hot-reloadable `queue.abort_poll_interval_ms` setting.

## [6.2.13] – 2026-08-16

### Added

- **Saved workflows can publish a precise, versioned agent-tool effect.** A
  reviewed workflow may declare itself read-only or a reversible write, and
  its MCP tool exposes matching standard read-only, destructive, and
  idempotency hints. Workflows without the declaration remain conservative
  irreversible writes, preserving the existing approval posture.

## [6.2.12] – 2026-08-15

### Fixed

- **New MCP connectors are verified before either connector or credential is
  persisted.** Draft probing now opens a throwaway MCP session, performs the
  real `initialize` and paginated `tools/list` handshake through the existing
  egress and manifest-validation path, and closes it again. A green result
  atomically saves the connector and encrypted credential; failures leave no
  connector, credential, pool, backoff, or handshake state behind.
- **MCP connector definitions keep authentication consistent across every
  authoring surface.** The connector service, conversational drafts, and REST
  validation reject mismatches between `auth_type` and `config.mcp.auth.kind`,
  seed absent MCP transport/auth defaults, and require an endpoint. URL-based
  template selection is now driver-scoped, so an HTTP template cannot be
  attached accidentally to an MCP connector on the same host.

## [6.2.11] – 2026-08-15

### Fixed

- **Single-use credential forms work from an authenticated Cockpit browser.**
  The browser CSRF middleware now recognizes only the exact saved-connector
  and connector-draft credential setup targets as grant-authenticated form
  routes. Their short-lived, single-use grant remains mandatory, while
  neighboring connector writes still require a browser-session CSRF proof.

## [6.2.10] – 2026-08-14

### Fixed

- **Explicit authoring targets now control conversation resumption.** A
  `conversation_start` carrying a workflow or connector ID resumes only a
  recent conversation bound to that exact resource. Slug matches and repeated
  prose can no longer redirect an edit into an unrelated unbound draft.
- **Existing workflow edits start from the persisted definition.** When no
  exactly bound conversation exists, the engine creates a new bound session;
  its draft hydration loads the current workflow version before patches are
  applied.

## [6.2.9] – 2026-08-14

### Fixed

- **Negated creation requests preserve an explicitly selected workflow.**
  English and German phrases such as “do not create a new workflow” and
  “keinen neuen Workflow erzeugen” no longer become positive creation intent.
  All creation-intent paths share the same clause-local polarity rule.
- **Workflow creation intent cannot span sentence boundaries.** A workflow
  noun in one sentence is no longer combined with a creation verb in the next,
  preventing version-edit instructions from detaching and replacing a hydrated
  saved workflow.

## [6.2.8] – 2026-08-14

### Fixed

- **Editing a new version or configuration keeps the selected workflow
  identity.** Phrases such as “new persisted workflow version” no longer
  detach an authoring conversation from its explicit `workflow_id` or replace
  the hydrated workflow with an empty `new-workflow` draft. New artifacts are
  still created for explicit “create a new workflow” requests.
- **Release builds no longer mutate the installed dependency tree.** Optional
  native `cpu-features` support is externalized consistently instead of being
  deleted from `node_modules`, so consecutive builds preserve identical
  dependency and Cockpit artifacts.

### Changed

- **The isolated test suite is deterministically sharded in CI.** All test
  files still run in fresh processes and exactly once, while eight parallel
  shards replace the previous hour-long serial startup path. A final required
  `build` job aggregates every quality, test, Docker and security gate.

## [6.2.7] – 2026-08-13

### Fixed

- **Conversation authoring now preserves every canonical workflow-level field.**
  Hydrating, patching, inspecting, validating, and committing an existing
  workflow no longer drops execution governance such as
  `max_llm_tokens_per_run`, timeouts, validation functions, response filters,
  or runtime metadata. The projection is derived from the canonical
  `WorkflowDef` schema so future persisted fields do not require another
  parallel allowlist.
- **Workflow execution-guard configuration is visible to the authoring agent.**
  `inspect_workflow` exposes the active token budget, timeout, validation and
  runtime fields, and the bundled authoring guidance requires real top-level
  configuration instead of unenforced prose in a description.

## [6.2.6] – 2026-08-13

### Fixed

- **Explicit no-run instructions now override saved-workflow execution.** German
  separable-verb negations such as “führe ihn nicht aus” and English forms such
  as “do not run” remove both `run_workflow` and the matching `wf_*` tool from
  an authoring turn, even when a persisted workflow is already bound. Genuine
  run commands and build-new authoring requests keep their existing routing.

## [6.2.5] – 2026-08-13

### Fixed

- **Direct MCP write confirmations now always establish a durable human
  approval channel.** Model-authored `ask_user_confirm` calls with a commit
  intent mint the same one-time browser approval URL as policy-generated
  confirmations; the internal approval handle remains server-side and an
  unauthenticated request fails closed without opening an approval.
- **MCP conversation and Tasks clients now exercise the actual browser-owned
  approval contract.** Human decisions can no longer be simulated through the
  model-facing elicitation response tool; portal approval creates the governed
  resume task that completes the pending authoring operation.

## [6.2.4] – 2026-08-12

### Fixed

- **Workflow authoring now preserves the human save gate in every non-auto
  permission mode.** A clean dry-run in `ask`, `plan`, or the default mode
  returns the governed `save_workflow_draft` confirmation instead of silently
  committing a workflow; only an explicitly selected `auto` mode may save
  without that confirmation.
- **Capability-gap recording remains best effort before database bootstrap.**
  A missing default database can no longer turn a `cannot_help` response into
  an unrelated internal error.
- **The local release gate is hermetic across isolated test processes.** Test
  encryption and model-provider defaults no longer depend on developer-machine
  credentials, while explicitly configured real-provider lanes remain intact.

## [6.2.2] – 2026-08-12

### Fixed

- **Browser approval pages now resolve the signed-in approver's email from the
  database.** Sessions whose cookie intentionally carries no email render the
  pending write instead of failing with an internal error, while inactive,
  deleted, cross-tenant, or anonymous users remain unable to decide.
- **The full contract suite now runs in the regular verification and CI paths.**
  The OpenAPI 3.1 nullability contract is asserted explicitly so generated
  client types cannot drift silently.

## [6.2.0] – 2026-08-12

### Added

- **The Cockpit now provides persistent, searchable conversation navigation.** Existing
  chats have stable URLs, can be reopened or renamed, and retain their workflow or connector
  context while responses stream into the active transcript.
- **Workflows, connectors, Knowledge Sources, Skills, and files now have dedicated catalog
  and detail workspaces.** Tenant-scoped APIs support server-side search, sorting, filtering,
  pagination, and stable totals for responsive data tables.
- **Knowledge and Skill content can be edited as Markdown with write, preview, and split
  modes.** Version checks prevent stale saves, and every successful mutation remains audited.

### Changed

- **Cockpit navigation is organized around operator work.** Work, Build, Knowledge, Govern,
  and Admin groups keep related resources together and provide direct routes from catalogs to
  governed chat actions.
- **Tables use an explicit responsive interaction model.** Desktop views support sorting and
  column visibility, mobile views become readable record cards, and wide content stays within
  a contained horizontal scroll region.

## [6.1.6] – 2026-08-10

### Fixed

- **Long conversations now remain a usable work surface.** Conversation history,
  transcript and composer have independent scroll boundaries; assistant messages
  keep a readable line length, and working context opens in an on-demand drawer.
- **Tables and structured tool output no longer force horizontal page scrolling.**
  Responsive tables retain essential columns and move complete details into the
  record drawer, while long values wrap inside their own components.
- **Cockpit language and testing contracts cover real data states.** User-facing
  fallbacks stay localized, internal identifiers remain hidden, and the visual
  sweep verifies stable test IDs across 110 German and English desktop, wide and
  mobile screenshots.

## [6.1.5] – 2026-08-10

### Fixed

- **The Cockpit now follows one interaction system throughout.** Primary,
  secondary, selected and destructive actions use consistent shadcn variants;
  icon-only actions have localized tooltips and stable test IDs, while compact
  layouts own their scrolling without clipped or overlapping content.
- **Conversation tool calls render as governed action cards again.** Dynamic
  tool parts are accepted by the renderer, assistant content uses the available
  width, and redundant icons and internal identifiers stay out of the operator
  surface.
- **German and English Cockpit coverage is complete and visually verified.**
  Navigation, user settings, tooltips, chat controls and all workspace routes
  are exercised at desktop and mobile sizes by the screenshot sweep.

## [6.1.4] – 2026-08-10

### Fixed

- **Changing a user's built-in role now updates the effective RBAC assignment.**
  The legacy role value and named `role_id` are synchronized in the same
  transaction, so an administrator selected through the identity API receives
  administrator permissions in browser, API-key and conversation sessions.

## [6.1.3] – 2026-08-10

### Fixed

- **Chat now remains a bounded workspace at every supported viewport.** Long
  conversations scroll inside the transcript, the composer stays reachable,
  and technical tool payloads and opaque identifiers no longer displace the
  operator-facing conversation.
- **Usage now sends the required time-bucket query and renders useful runtime
  summaries.** Execution totals, latency percentiles and success rate are
  presented through the same responsive card, table and detail patterns as the
  rest of the Cockpit.
- **Cockpit permissions and presentations now match their engine contracts.**
  Usage, operations and settings use the permissions required by their routes,
  while settings provenance and operational digests are flattened into
  readable fields in English and German.

### Changed

- **Every Cockpit route is now covered by a visual release sweep.** Desktop and
  mobile verification checks layout overflow, visible UUIDs, resource errors
  and the Chat composer contract, and the production deployment retains the
  authenticated screenshots as an artifact.

## [6.1.2] – 2026-08-10

### Changed

- **The Cockpit is now a complete, responsive workspace built from the shared
  shadcn design language.** Chat, navigation, resource lists, detail panels and
  mobile layouts use one compact visual hierarchy while retaining Subkit's own
  product model. The signed-in user's menu now owns profile information,
  language, colour scheme and sign-out instead of scattering personal settings
  across operator pages.
- **Cockpit chrome is available in English and German.** Browser-language
  detection is the default, with persistent manual selection for English or
  German. Theme selection likewise supports system, light and dark modes.

### Fixed

- **Opaque database identifiers no longer leak into the working UI.** Resource
  tables, details, workflow steps and tool results present readable names and
  labels instead of UUIDs or identifier-shaped fallback values.
- **Every interactive Cockpit control now has a stable test identifier.** The
  contract is enforced by an AST test, alongside catalog parity, locale,
  theme and readable-presentation tests, so future controls cannot silently
  become inaccessible to browser verification.

## [6.1.1] – 2026-08-10

### Added

- **The authenticated Subkit Cockpit is now part of the engine release.** It
  provides tenant-scoped Chat, workflow and execution workspaces plus the
  operator surfaces permitted by the signed-in user's effective role. The Vite
  bundle is embedded into the single engine binary and checked for generated
  drift in CI.

### Fixed

- **Supabase SSO sessions now enter the Cockpit instead of returning to the
  sign-in card.** The browser boundary validates the signed session's user,
  tenant and session identifiers instead of depending on which compatible auth
  resolver recognized the cookie first.
- **The Cockpit Chat route no longer crashes while rendering tooltips.** A
  single application-level tooltip provider now covers the sidebar, composer
  and message actions.

## [6.1.0] – 2026-08-06

### Changed

- **The sign-in and consent pages follow the reader's colour scheme.** The shared
  auth funnel was `color-scheme: light` and nothing else, so anyone working in
  dark met a white page. It now declares both schemes and switches on
  `prefers-color-scheme`. SubKit ships no web console, so there is no explicit
  preference to honour — the media query is the whole answer here, and the
  optional `.scheme-light` / `.scheme-dark` classes the shared block carries are
  never set. No server change was needed, which is what that optionality is for.

  The block also moves to the family's cockpit token vocabulary, which fixes two
  defects the old one carried: `.deny:hover` was about to become invisible, and
  the page had no focus styling at all — it relied on the browser's default
  outline, which is invisible on a dark card.

- **The auth UI contract loses its version number.** `mcp-auth-v2` is now
  `mcp-auth`. The number existed so a product that had NOT taken a change would
  fail loudly rather than render unstyled — but a change to this block lands in
  every product in one wave, so that product does not exist. What the number
  bought was a second thing to keep in step, hand-typed, which is exactly the
  failure it was meant to prevent: four repositories all asserted `content="2"`
  while nothing compared the bytes.

  `<meta name="mcp-auth-ui-contract">` now carries a digest computed from the
  stylesheet at module load. Two products serving different bytes announce
  different strings, in the DOM. Verified identical across watchkit, contentkit,
  wikikit and subkit: 3866 bytes, sha256 `ebdaece1`.

## [6.0.7] – 2026-08-05

### Changed

- **The documentation leads with what sk delivers instead of how it is built.**
  The first line a reader met described the architecture — an answer to a
  question nobody asked, and no way in for someone seeing sk for the first time.
  Every entry surface now opens with a result: the README states the promise,
  then three deliverables that each carry an acceptance criterion and a
  timeframe, then an honest account of what sk does not do. The architecture
  diagram moves below a section explaining why the promise survives production,
  because it is the reassurance rather than the pitch. Around twenty reference
  pages had their opening rewritten the same way; their reference bodies are
  untouched.

### Added

- **A starting page that assumes no prior knowledge.** `docs/start-here.md`
  explains the problem, what sk does about it, and the three questions you would
  ask before handing a new colleague the keys — what may it touch, does it check
  first, can I see afterwards what it did. It carries no code and no jargon that
  is not glossed in the sentence it appears in, and it now opens the served
  documentation index.

### Fixed

- **The documentation index no longer skips pages that sit outside an audience
  folder.** The generator derived a page's audience from its subfolder, so a
  file directly in `docs/` was assigned an empty audience and dropped — which
  would have made the new starting page invisible to every model grounding
  itself on `llms.txt`, on the one surface most likely to need it. Top-level
  pages now receive a synthetic `start` audience that renders as the first
  section; the documentation index itself stays excluded, so the index does not
  list itself. Pinned by a test.

## [6.0.6] – 2026-08-05

### Fixed

- **A workflow triggered by an inbound webhook now runs against production
  connectors.** Execution creation defaults to `dev` and the inbound webhook
  path passed nothing, so every webhook-triggered workflow resolved development
  connectors — and a development connector is the one nobody re-authenticates.
  The consequence was live and silent: a tenant's development mail connector
  went to `needs_reauth`, and every notification since had failed with a 401
  visible only inside an execution nobody was reading. The delivery is accepted,
  the workflow runs, the audit trail shows it succeeding right up to the last
  step, and no mail is sent. The schedule reconciler already defaults unattended
  automation to production for exactly this reason; an inbound webhook is
  equally unattended, and the inconsistency was the bug. A caller who says
  nothing means production, because production is what sent the webhook.

### Added

- **`GET /.well-known/service-descriptor.json` reports the version and a
  checksum per self-description artifact in one small response.** A monitor
  asking whether anything changed otherwise downloads every artifact on every
  poll — roughly 600 KB a round for the full-text documentation alone, almost
  always to discover that nothing changed. That cost is what forces a drift
  check to run hourly when it wants to run every thirty seconds. Hashes are
  computed per request rather than cached: the documents are embedded at build
  time and cannot change while the process lives, and a cached hash that went
  stale would make this endpoint lie in precisely the situation it exists to
  report. The OpenAPI entry carries a null hash for now, because that document
  is assembled at request time and there is no single served byte string to
  fingerprint — saying so is better than fingerprinting something else and
  calling it the spec.

## [6.0.5] – 2026-08-05

### Fixed

- **A build retry that could not tell a repair from a no-op no longer pretends
  to be one.** The cross-compile step retries once when the target runtime's
  cached download is corrupt, after removing that cache entry — but the removal
  used a force flag that reports success on a path which never existed, and the
  cache location was a single guess derived from `HOME`, which is not where the
  container build keeps it. So the entry was never found, the removal
  "succeeded", and the retry repeated the identical failure a second later. The
  cache is now searched across the locations the tool actually uses, a purge is
  reported only when something was really removed, and a build that cannot find
  the corrupt entry fails immediately naming the paths it searched instead of
  doing the same thing twice.

## [6.0.4] – 2026-08-04

### Fixed

- **`GET /v1/mcp/tools` now answers with the catalog it is named after.** It
  served a seven-name constant — no principal, no database, `input_shape: null`,
  the same answer for every caller in every tenant. Measured against production,
  that constant and `tools/list` for the *same* principal shared not one name: 7
  against 107. The seven were the authoring loop's draft-only intents, which the
  MCP surface omits deliberately, so the route was not a stale approximation of
  the catalog — it was answering a different question under the catalog's name,
  beside two sibling endpoints that both read live data. It now assembles the
  catalog through the same call `tools/list` makes, honouring the caller's
  resolved tier and the operator's read-only switch, and `input_shape` carries
  the declared schema instead of `null`.
- **A truncated toolchain download no longer fails the container image.** The
  embedding assets are fetched during the image build; a dropped socket on one
  of five files failed `docker-publish` for v6.0.2 outright, leaving a published
  release with binaries but no image. The fetch now retries the failures that
  are about the network — dropped sockets, resets, 5xx, 429, truncated bodies —
  and still fails immediately on a 404 or 403, which are answers rather than
  accidents.

## [6.0.2] – 2026-08-04

### Fixed

- **The two flows that exist to be elevated were being demoted instead.**
  `judge` (the verdict that gates auto-commit) and `generate` (whole-workflow
  authoring) are routed in code onto the model route's *fallback*, on the stated
  convention that the fallback is the stronger model — cheap primary for volume,
  strong fallback for capability. The shipped default violated that convention:
  primary `claude-sonnet-4-6`, fallback `claude-sonnet-4-5`. Every installation
  that did not override the models ran its two quality-critical flows a
  generation behind. The default fallback is now `claude-opus-4-7`, above the
  default primary, and a test pins the direction rather than the model names, so
  the same inversion cannot return under new ids.
- **The cheap tier escalated into a superseded model.** The Anthropic step-router
  ladder sent `claude-haiku-4-5` one-up to `claude-sonnet-4-5` instead of
  `claude-sonnet-4-6` — and Haiku is what production runs as its primary, so that
  was the escalation most likely to fire. A hard-turn upgrade landed a generation
  short every time.
- **A truncated toolchain download no longer wedges the build forever.** A
  cross-compile needs the target platform's bun runtime, which `bun build`
  fetches and caches; a truncated fetch leaves the broken archive in place, so
  every later attempt fails identically. One bad download became four
  consecutive red nightlies. The staging step now removes exactly the artifact
  the compiler named and retries once — and only then, so a genuine compile error
  still fails immediately instead of slowly.

### Changed

- Dependencies: 29 minor and patch bumps.

## [6.0.1] – 2026-07-31

### Fixed

- **An upgrade no longer stops on retired MCP config sections that hold
  nothing.** The 6.0.0 boot check refused whenever `mcp.servers` or `mcp.client`
  was present at all — including an empty array and a block that merely repeated
  the budgets `connectors.mcp` already defaults to. That protected nothing: the
  reason for refusing is that a later settings write would erase an operator's
  declarations, and there were none to erase. It cost a production deploy, where
  the engine refused five times over a message that itself printed
  "(0 declaration(s))". The check now stops only when a declaration exists, a
  budget differs from its default, or a key appears that this engine cannot
  interpret — and it names the offending keys rather than only the section. What
  is dropped is still logged, so an operator learns the keys are going away.

## [6.0.0] – 2026-07-30

### Added

- **Any Model Context Protocol server is now a Connector.** Point sk at an MCP
  server and everything it publishes — tools, resources, prompts — becomes
  reachable from workflows and from chat, with no driver to write and no engine
  change. `mcp` joins `http`, `graphql`, `postgres`, and `s3` as the fifth
  built-in driver, and it is the one that turns a closed driver set into an open
  integration surface: where the other four each cover a single wire protocol,
  this one covers an ecosystem. A vendor shipping an MCP server is a connector
  you create in a minute rather than an integration you wait for.
- **MCP servers are created, listed, patched, enabled, disabled and deleted
  through the ordinary connector surface** — `/v1/connectors` and
  `sk connectors`. They carry their secret in the same credential vault, appear
  in the same catalog grouped under the `mcp` driver, and answer the same
  "which workflows depend on this?" question as every other connector.
- **Remote tools reach workflows as a `request` step carrying an `mcp` block** —
  `call_tool` (with `tool`), `read_resource` (with `uri`), or `get_prompt` (with
  `prompt`). No new step kind: retry, backoff, `error_policy`,
  `response_filters`, and the versioned output envelope behave identically to
  every other driver. A tool that declares an output schema returns
  `{ content, structured_content }`, keeping the half the remote guaranteed
  separate from the half it did not.
- **Remote tools reach chat as `mcp_<connector-slug>__<tool>`**, so a message
  naming one dispatches in a single call. Where a server declares resource or
  prompt capabilities, four engine-minted read adapters are added per server
  (`list_resources`, `read_resource`, `list_prompts`, `get_prompt`) — and only
  where declared, so the model is never offered an entry whose every call would
  be a protocol error.
- **A driver-agnostic operator off switch.** `POST /v1/connectors/{id}/enable`
  and `/disable` (`sk connectors enable|disable`) work on every driver, and the
  disable is honest: an MCP connector's pooled session is evicted and a Postgres
  connector's pool is closed on the way out, so nothing keeps serving past the
  switch.
- **`POST /v1/connectors/{id}/mcp/inspect`** (`sk connectors mcp-inspect`) forces
  one handshake and reports what a remote actually serves — its negotiated
  capabilities, its instructions, and its tool manifest — so a server can be
  verified before anyone authors against it.
- **Connectors can now be authored from a file, like every other resource.**
  `sk connectors create --file` and `sk connectors patch --file` take a full
  definition, `sk connectors validate` checks one without saving it, and
  `sk connectors probe --file` reaches the upstream without creating anything.
  Until now `create` accepted only a template slug, so a connector matching no
  built-in template could not be authored from the CLI at all — the one gap that
  made "author through the sk CLI" a promise the tool could not keep. Workflows,
  knowledge sources and skills already had this shape; connectors now match it.
- **`sk connectors import --spec` builds a connector from a specification** —
  OpenAPI, HAR, Postman or a `curl` line. The import produces a draft you read
  and edit before it exists as anything; it never writes on its own.
- **The documentation now names one authoring surface and describes it in full.**
  `docs/llms.txt`, `llms-full.txt` and the OpenAPI description route authoring to
  the sk CLI, and the generated CLI reference lists every command with every
  argument — type, default, alias and whether it is required — rather than a
  one-line summary per subcommand. A coding agent reading only the generated
  reference can now author without guessing at a flag.
- **The API now answers "why is this connector not being used?"** Every
  connector representation carries `health_state` — the engine's reconciled
  verdict (`ok`, `degraded`, `needs_update`, `needs_reauth`) — beside
  `health_reason` and the branchable `health_error_code`. Until now the API
  reported only whether a human had switched the connector off, and the other
  half of the answer was reserved for whoever had database access.

### Changed

- **BREAKING: a wildcard credential no longer authors over MCP.** The `*` scope
  asserts "no narrowing of role-derived access"; it does not assert consent to
  author. It now resolves to the **product** tier — 67 tools: every tenant read
  plus the run tools — instead of the authoring tier. Authoring is opt-in per
  credential: a credential authors when someone wrote `mcp:authoring` on it, and
  not otherwise. This is enforced on the call and not merely in the catalogue —
  a `conversation_*` call from a credential without the scope is refused, with a
  message naming the scope that would enable it.

  Why: `*` is the default minted scope, the admin-key scope, and the OIDC
  session scope, so the old mapping meant authoring-on-by-default for every
  credential ever issued — including the ones pasted into browser clients that
  cannot carry a human through an authoring turn. Breadth of role is not
  consent to author.

  **Upgrade:** re-issue any key that is supposed to author.

  ```bash
  sk apikeys create --name coding-agent  --scopes "*,mcp:authoring"
  sk apikeys create --name browser-client --scopes "*"
  ```

- **BREAKING: `/v1/mcp-servers` is removed** — all eight endpoints, along with
  the OAuth callback that belonged to them. An external MCP server is a
  connector, so it is managed through `/v1/connectors`. The interactive OAuth
  round-trip was not dropped: it moved to
  `POST /v1/connectors/{id}/mcp/authorize` with its callback at
  `GET /v1/connectors/mcp/oauth/callback`. It stays a separate flow from the
  generic connector OAuth start because an MCP server publishes its
  authorization server through protected-resource metadata rather than declaring
  an issuer in config — two discovery models cannot share one handler without
  one of them misreporting what it did.

  **Upgrade:** replace `/v1/mcp-servers` calls with the `/v1/connectors`
  equivalents; a removed route answers 404.

- **BREAKING: `sk mcp-servers` is removed** — all nine subcommands, along with
  the `/mcp-servers` REPL slash command, which now redirects to `/connectors`.
  Use `sk connectors`, which gained `enable`, `disable`, `mcp-inspect`, and
  `mcp-authorize`.

- **BREAKING: `mcp.servers` and `mcp.client.*` are removed from the engine
  configuration, and an engine that still finds them *populated* refuses to
  boot.** The refusal is deliberate: `ConfigSchema` strips an unknown key
  silently and the next settings write reserializes the whole file, so
  warn-and-continue would have *deleted* an operator's server declarations on
  the first `sk settings set` after the upgrade. That is data, and only stopping
  is honest. The error names every offending path (including per-tenant
  overlays), which keys are at stake, the config file, and the migration. An
  empty `servers` array, or an `mcp.client` that only repeats the new defaults,
  holds no decision to lose — those are dropped with a warning and the boot
  continues.

  **Upgrade, before swapping the binary.** Recreate each declared server as a
  connector and move the three client budgets:

  ```bash
  # Each entry in mcp.servers becomes a connector:
  #   driver: "mcp", environment: "prod", base_url: <the server url>,
  #   config: { mcp: { transport: "http", auth: { kind: … } } }
  sk connectors create --file server.json
  sk credentials set <CONNECTOR_ID> --mode bearer --token '<TOKEN>'
  ```

  | Removed | Replacement |
  |---|---|
  | `mcp.client.per_server_manifest_byte_cap` | `connectors.mcp.per_server_manifest_byte_cap` |
  | `mcp.client.remote_tool_call_timeout_ms` | `connectors.mcp.remote_tool_call_timeout_ms` |
  | `mcp.client.tools_list_max_pages` | `connectors.mcp.tools_list_max_pages` |

  A config secret is not carried over by design: `config.mcp.auth` is refused at
  the storage layer if it holds a secret-shaped key — a database `CHECK`, not a
  convention. Attach the secret with `sk credentials`.

- **BREAKING: `mcp_server:manage` is removed from the permission catalog.**
  Managing an external MCP server is managing a connector, so the connector
  permissions govern it. Custom roles granting the old permission need updating.

- **BREAKING: a connector slug may no longer contain a double underscore**, and
  existing slugs that do are renamed automatically on migration
  (`legacy__conn` → `legacy-conn`), each with an audit row naming the old and
  new value. Remote tools are addressed as `mcp_<slug>__<tool>`, and the
  separator is only an unambiguous split point with that ban. Workflows bind
  connectors by id, so definitions are unaffected — but a hand-written
  slug-addressed command or a bookmark may need updating. The audit row is the
  reconciliation trail.

### Fixed

- **A connector's failure record is written by the engine, not by the remote.**
  `connectors.last_error` and `health_reason` used to carry the upstream's own
  error text, redacted on a best-effort basis — and an authentication failure
  is exactly the response in which a server may echo the credential it just
  rejected. Both now carry an engine-authored sentence plus a machine-readable
  code (`[auth_rejected] …`), naming the endpoint, the status, and — when the
  engine itself refused — which credential or setting is missing. The upstream
  body stays in the structured log, which has retention and access control that
  a database column does not.
- **A remote MCP server can no longer talk its own calls past the confirm
  gate.** `readOnlyHint` and `destructiveHint` are optional, unverified, and
  asserted by the same party whose side effects they describe. They now reach
  the model's tool description and the audit trail, and they reach no gate: a
  `tools/call` is a write whatever the server claims, and only a tenant-side
  author can reclassify one with `side_effects: "read"`. `read_resource` and
  `get_prompt` are reads by the specification's own definition of them.
- **A healthy MCP session is no longer torn down by a validation complaint.**
  A tool result that failed its own declared output schema raised an error the
  pool read as a dead socket: it evicted a live session, armed backoff, and —
  because the check was a bare match on "401" anywhere in the message — a
  validator complaint that happened to mention 401 could delete the server's
  OAuth token. Transport failures and peer answers are now told apart by the
  protocol's own error codes.
- **A paginating MCP server no longer exposes only its first page of tools.**
  The `nextCursor` was dropped; pages are now followed, bounded by
  `connectors.mcp.tools_list_max_pages`.
- **A handshake backoff now survives an engine restart.** Failure counts and the
  backoff window are held in the database rather than only in process memory, so
  a server that has been refusing for an hour is no longer handed a full-rate
  retry because the process bounced.
- **A call step's input can no longer smuggle a credential into stored data.**
  Call steps interpolate their input like every other step, and `executions.input`
  is persisted verbatim and readable from the read tier — so a `${cred.…}`
  reference there would have written a decrypted secret into a row a reader can
  fetch. Such an input is now refused with `call_input_credential_forbidden`
  before anything is resolved, rather than resolved and then stored.
- **An MCP server can no longer be reached by rebinding its name.** The connect
  path checked the egress allowlist against the literal hostname while the
  registry checked it against the resolved address, so a name that passed the
  first check could point somewhere else by the time the socket opened. Every
  handshake now resolves before it connects.
- **`sk.fmt` no longer depends on the machine's locale.** Formatting used the
  host locale, so the same workflow rendered different numbers and dates on a
  developer's laptop than on the engine — and the sandbox has no ECMA-402 at
  all, making the difference silent rather than loud. The locale-taking
  overloads now throw instead of quietly falling back, and both arguments are
  checked: passing only options was still a locale-dependent call.
- **The circuit breaker now blocks every driver.** Enforcement sat below an
  HTTP-only guard while the fan-out preflight applied the same rule to all
  drivers — one predicate with two scopes. A new failure-class predicate decides
  what counts: 5xx, 429, transport errors, and connection-class SQLSTATEs open
  the breaker; a 4xx, a SQL syntax error, an integrity violation, and a missing
  S3 key do not. A connector is no longer taken offline for the whole reset
  window because an author typed a query wrong.

## [5.16.1] – 2026-07-29

### Fixed

- **`sk workflows list` no longer renders a permanently blank column.** The list
  asked for `status`; the engine has always called that field `lifecycle`, so
  the column showed nothing on every row from the day it was added — nothing
  failed, it was just silently empty. Grouping the catalog put it beside real
  data, which is what made it visible. A column name is a contract with the
  engine's schema, and nothing was checking it: the rendered columns are now
  resolved against the committed OpenAPI list-item schemas, and a column that is
  not a real property fails the suite.

## [5.16.0] – 2026-07-28

### Added

- **Workflows and connectors are grouped into blocks instead of one flat list.**
  A tenant with 60+ workflows got a single undifferentiated list on every
  surface. Grouping needed no new column and nothing to maintain: a workflow's
  category is derived from the slug corpus — a leading segment shared by at
  least three workflows forms a block, and the rest collect under `other` — so
  blocks emerge as the catalog grows. Connectors need no derivation at all;
  their category is the driver they already store. Block order is computed once
  in the engine and sent on the response, so every client renders the same order
  rather than re-deriving the rule.
- **Two catalog filters, identical on HTTP, MCP, `sk`, and chat:** by category,
  and by connector — the latter answering "what breaks if I rotate this
  credential?" directly.
- Authoring context now carries the families that already exist, so a new
  workflow is named into one at creation time, when nothing has to be renamed.

### Fixed

- **"Which workflows use this connector?" had two different answers.** The
  delete-time dependency guard matched `steps[].connector_id` only, so a
  workflow bound through a `${connector.<slug>.base_url}` URL was invisible to
  it and the delete was cleared as having no dependants. The guard and the new
  filter now resolve through one complete extractor covering both binding forms.

## [5.15.0] – 2026-07-28

### Fixed

- **Corrected the documented MCP authoring boundary against a live `tools/list`
  rather than against a reading of the code.** An earlier correction had widened
  the claim in the wrong direction. Verified on a running engine: an
  `mcp:authoring` credential carries neither `restore_workflow_version` nor
  `update_workflow`, and calling either is refused. The mistake was testing the
  wrong layer — querying the tool provider directly bypasses where the
  authoring/admin split actually happens, which makes the two tiers look
  identical when they are not. The test now runs through the real path and
  asserts what production returns, including that admin does carry the writes
  authoring withholds.

## [5.14.0] – 2026-07-28

### Fixed

- **Self-healing now actually repairs.** One patch semantic backs preview,
  dry-run, and apply, so the diff an operator approves is the diff that goes
  live. An applied patch rewrites the step; one the engine cannot perform is
  refused with a typed reason instead of being recorded as a repair. A new
  `patch.applied` event reports it — until now only proposals were announced.
- **Committing no longer starts an unattended trigger behind nobody's back.** A
  commit with no human decision behind it is blocked before it can bind an
  unpaused production cron or a public webhook. `create_schedule` correspondingly
  stops collapsing its confirmation on MCP: a schedule fires before anyone can
  see and delete it, so "additive" never made it reversible.
- **A judge outage no longer auto-commits an unjudged preview while a human is
  present.** The deferral now keys on any skip, not only one specific reason.
- A commit that skipped the prior-approval gate under `permission_mode=auto` now
  says so, carrying an honest reason instead of claiming a manual re-issue.
- `POST /v1/skill-candidates/{id}/approve|reject` were reachable with
  `skill:read` alone, and setting `status: "active"` routed around
  `skill:activate`. Both closed.
- The approval, determinism, audit-immutability, and one-gate claims in the docs
  now state what the code holds rather than an absolute it does not.
  `max_llm_tokens_per_run` is documented — sk ships a template that calls a model
  at runtime while the docs said that could not happen.

## [5.13.0] – 2026-07-28

### Fixed

- **Replacing an existing workflow now requires a person; restoring one is now
  possible at all.** A verified 14-step workflow was overwritten twice with
  nobody looking, and the session that found the damage had no way to undo it.
  Creating and replacing shared one gate, and recovery had no tool. Saving a
  draft is now declared dangerous when the payload means "overrule something
  that already holds" — adopting a workflow this conversation did not create, or
  forcing past a non-green preview — so it confirms with a human. A fresh slug
  still commits with no added friction: the split is create-versus-replace, not
  "everything is gated". `restore_workflow_version` makes the undo real.
- **A conflict error stopped dictating its own bypass.** It used to name the
  exact field that would overrule the conflict "after the user confirms"; the
  model supplied the field four seconds later and skipped the confirming. It now
  says what to *ask*.

## [5.12.0] – 2026-07-27

### Fixed

- **A refused abstention no longer throws the turn away.** `cannot_help` ended
  the turn on the call and never looked at the result — so once the tool learned
  to refuse an abstention naming a capability the model demonstrably holds, the
  engine could prove the claim false, tell the model exactly which tool it has,
  and then discard the turn anyway. The correction was issued and thrown out in
  the same breath. An accepted abstention ends the turn; a refused one does not.

## [5.11.0] – 2026-07-27

### Fixed

- **An "I can't do that" is now checked before it is believed.** A model
  abstained claiming a tool was "not available in this MCP surface" minutes
  after calling that same tool successfully in the same turn. Two things went
  wrong and only one of them was the model's: the user was told something false,
  and a durable, demand-ranked capability gap was filed for a capability that
  exists — a backlog read as evidence of what the product lacks, where a
  fabricated row does not add noise but misdirects. An abstention naming a tool
  the caller's own palette contains is now rejected, and no gap is filed for it.
  An unverifiable claim still goes through: "cannot verify" is not "false".

## [5.10.0] – 2026-07-27

### Fixed

- **A retry budget that could not pay for the retry.** The authoring pipeline
  allowed each model call up to 90 seconds and promised two passes, inside a
  120-second aggregate budget — so a first pass running legitimately near its own
  ceiling left the second structurally unable to finish. Production duly started
  a second pass and cut it off 33 seconds in: a full prompt spent, guaranteed to
  return nothing. The deadline is now derived from what the pipeline advertises,
  so raising the pass count cannot silently re-open the gap, and a pass the
  remaining budget cannot cover is not started.
- **A failed generation now names the real reason.** The total-failure path
  blamed the model unconditionally — "produced no schema-parseable workflow
  definition within the pass cap" — even when the actual cause was the blown
  budget it had already recorded. An agent believed it exactly as written,
  invented tool names, started an unrelated connector draft, and abstained
  claiming a tool it had just used successfully was unavailable. 858k tokens. A
  wrong reason costs more than no reason.

## [5.9.0] – 2026-07-27

### Fixed

- **The configured model decides again.** A hard-coded premium model was seeded
  onto any conversation turn whose message matched an authoring word pattern,
  silently overriding `llm.model` and only ever upward. Measured over one month
  before removal: roughly four fifths of spend from a fifth of the calls, and it
  exhausted the deployment's monthly provider quota. The rule that made the seed
  necessary was fixed structurally long ago; the seed stayed and kept charging
  for a failure that had become impossible. Which model a turn runs on is now
  `llm.model`, `llm.fallback_model`, or the per-conversation override, and
  escalating one stays the step router's job — on earned signals, not on a regex
  over the user's wording.
- **The bill now names what actually ran.** Usage accounting logged the
  attempt's base model, so a per-step router swap was never reflected. This is
  why the above stayed invisible: the deployment went two months without a single
  usage row for a model the router had selected 58 times in a fortnight.

## [5.8.0] – 2026-07-27

### Added

- **A parked turn now says so instead of waiting in silence.** For 21 hours,
  three conversation turns reported an ordinary in-flight state while the LLM
  provider's monthly quota was exhausted and the engine was correctly waiting for
  the reset. Nothing was wrong with the worker or the queue, but the reason
  existed only in the engine log, where a waiting client cannot look — so a
  careful reader concluded a worker was hung and proposed restarting it and
  killing a conversation. Neither would have helped. `conversation_get` now
  answers with a `parked` phase, the reset instant, how long until it resumes,
  and a note stating plainly that nothing is stuck, that restarting or opening a
  new conversation does not help, and that raising the provider quota does. The
  stamp is deliberately not terminal — the turn really will run — and it is
  cleared when the turn starts, so a stale "parked until" can never mislead the
  way the original silence did.

## [5.7.0] – 2026-07-26

### Fixed

- **Every gated confirmation now has a human channel, not just one of them.** A
  held `save_workflow_draft` paused on a browser client with no approval link and
  no approval handle — a dead end on any client that cannot render an in-band
  form, leaving an operator to hand-run `curl` with their API key, which is
  precisely the workaround the approval portal exists to replace. Only the
  universal confirmation carrier ever minted an approval; every shape-specific
  one — draft saves, deletes, key creation, the run commit — skipped it. All of
  them mint one now. What the approval *means* still differs by carrier, and
  deliberately so: the universal carrier grants a claimable capability the
  harness replays byte-exactly, while a shape-specific one supplies the portal
  channel plus the decision record. Ordinary clarifying questions are untouched.

## [5.6.0] – 2026-07-25

### Fixed

- **The human who releases a write is now recorded.** The approver was `NULL` on
  100% of grants. The approval portal is reachable without a token — the approver
  has a browser — and the only resolver for the session cookie lived inside the
  OIDC provider, so on the default configuration a human who had just signed in
  was, to every route, an anonymous browser. Possession of the grant link decided
  the write, unattributably, in a system whose whole promise is an audited one.
  The portal now separates the two facts it needs: the grant scopes *which*
  approval is on the table, and a signed-in account supplies *who* is deciding.
  An unidentified browser goes through the login funnel and returns to the same
  link; an unidentified POST is refused rather than recorded as "somebody". The
  decision form carries a CSRF token bound to both the approver's session and the
  grant, so a cross-site post cannot release a write on a signed-in approver's
  behalf and a token minted for one approval cannot be replayed against another.
  The write preview is no longer shown to anonymous visitors.
- **A deactivated account no longer keeps a live session.** Deactivation revoked
  API keys and pending invites but never sessions, and login re-checks are no
  help to an already-issued cookie. Sessions are now revoked in the same
  operation — which is how a no-longer-entitled account had been reaching the
  consent screen.

## [5.5.1] – 2026-07-25

### Fixed

- **A portal-approved action now executes the arguments the approver reviewed.**
  Verified in production: a human approved, the conversation resumed, the action
  happened — and the approval was never claimed. What actually ran was the model
  re-issuing the tool once the pause cleared, so the arguments the operator saw
  in the write preview were not necessarily the arguments that executed. The
  resume was running as the browser approver, who on an unauthenticated portal is
  usually nobody, so the claim failed before it could bind. The turn now runs as
  the principal that *owns* the approval — the one whose permissions the original
  call already passed. Attribution of the decision stays separate: the approver
  decides, they do not execute.

## [5.5.0] – 2026-07-25

### Fixed

- **An approval decision now carries its own effect.** An operator approved a
  held write in the browser portal, the grant was recorded, and the conversation
  still died nine minutes later reporting that the operator had not answered.
  Across the entire history of the feature, 0 of 5 approval-backed confirmations
  had ever resolved in production. Granting was the end of the story: advancing
  the paused conversation was delegated to a client poll that the clients which
  *need* the portal never make, and the only durable reactor keyed on an approval
  expiring, never on one being granted. The portal decision now stages the
  answer and enqueues the resume inside the approver's own request.
- **A grant now opens its own claim window.** The expiry was set from mint time,
  so a human who deliberated for 14 of their 15 minutes left the system one
  second to act on their decision.
- **An abandoned grant is now loud.** The expiry sweep gained the missing edges —
  granted-but-unclaimed completes, declined resolves as a decline, and a grant
  that can no longer be acted on expires with its own audit action. Every
  previous trace of that outcome was indistinguishable from "nobody answered".
- A dry run now gates on whether writes will actually execute, rather than on the
  environment, since it holds its writes and dispatches nothing.

## [5.4.2] – 2026-07-24

### Fixed

- **You can now create a second, scope-isolated connector on a base URL that
  already has one.** Creating a separate connector (e.g. a read/write key
  alongside an admin key) on an upstream that already had a saved connector
  was impossible over MCP: connector authoring deduplicated on the base URL
  and returned the existing connector, so a fresh draft was never started and
  the secure credential setup-link flow — which requires a fresh, unsaved
  draft — was never reached. The request dead-ended on a prose question and
  nothing was persisted. A distinct connector *name* is not the signal to
  fork (that is the normal re-describe case, which reuse deliberately
  protects so cached credentials are not lost). Connector authoring now takes
  an explicit `force_new` flag: the default stays credential-preserving, and
  `force_new: true` mints an independent draft on the same URL. The connector
  creation guidance documents it, and the setup-link elicitation now carries
  a relay instruction so a form-less MCP client surfaces the link verbatim.

## [5.4.1] – 2026-07-24

### Fixed

- **MCP clients (claude.ai, ChatGPT) no longer have to re-authenticate every
  hour.** A refreshed OAuth access token was minted without its audience
  (`resource`) because the refresh-token table had no column to carry it
  forward. The resource server rejects an audience-less token as
  `audience_missing` whenever a public base URL is configured, so the very
  next `/mcp` call after a refresh returned 401 and the client fell back to a
  full re-authorization — roughly hourly, matching the access-token TTL. The
  audience now rides on the refresh token and is copied onto every rotated
  access token, so a client stays connected for the full 30-day refresh
  lifetime. Adds a `resource` column to `mcp_oauth_refresh_tokens` (migration
  0029) and propagates the audience through the code-exchange and both
  rotation inserts in the OAuth server provider.

## [5.4.0] – 2026-07-24

### Added

- **Policy confirmations are answerable from an MCP client that cannot render
  an in-band form.** When the confirm gate mints an approval, it now surfaces
  the single-use approval-portal link (`approval_url`) on the paused
  elicitation and in the model-facing tool result, so an agent can hand the
  operator a bare browser URL. Opening the link is already authorized — the
  one-shot grant *is* the authorization, no sign-in — exactly as the
  credential-setup portal already works. A url-capable client receives the
  confirmation as a native URL-mode elicitation; a form-capable client keeps
  the rich confirm form unchanged.
- **The approval portal now reactivates the conversation it gates.** Deciding
  a policy confirmation through `/v1/tool-approvals/decide` marks the paired
  conversation elicitation settled and nudges the polling MCP client, so its
  next Tasks poll replays the decision and resumes the turn — the harness then
  claims the granted approval and performs the tool. Previously a granted
  approval left its conversation stranded in `awaiting_input` until the
  15-minute expiry sweep abandoned it.

### Changed

- **A full authoring conversation now degrades by auto-compaction instead of a
  hard `LlmContextTooLarge`.** On crossing the model's usable context window,
  the loop pre-flight compacts the conversation once and retries; only if it
  still cannot fit (or there was nothing left to collapse) does it raise the
  typed error. The draft workflow lives in draft snapshots, not the chat
  turns, so collapsing history never loses the in-progress build.

## [5.3.1] – 2026-07-24

### Fixed

- **`conversation_start` no longer funnels new intents into an unrelated
  stuck conversation.** The start-idempotency check matched kebab tokens
  extracted from the incoming message against tokens extracted from a
  candidate conversation's opening-message *prose*. German (and hyphenated
  English) compounds — `http-connector`, `api-key`, `authorization-header` —
  count as kebab tokens, so once one authoring conversation existed, every
  later start sharing a single such compound "resumed" it, observed live as
  all starts funnelling into one conversation with no escape. Resume now
  matches only the candidate's **authored identity** (draft workflow
  slug/name, draft summary active target), with a whitespace-insensitive
  identical-message fallback for the pre-draft retry window.
- **A resumed `conversation_start` runs the message instead of swallowing
  it.** The resume path returned `resumed: true, status: "working"` without
  persisting the incoming message or enqueueing a turn — the client polled a
  conversation that was never going to move and the user's intent silently
  vanished. A resume is now an append: the message lands in the resumed
  conversation and a background turn runs it.
- **Agents must not claim actions they never performed.** New `ACTION
  HONESTY` prompt rule on every real surface (REPL included): an action may
  only be reported as done when a tool call in the conversation returned
  success for it, and a request no palette tool can perform is answered
  honestly instead of with a fabricated "done"/"deleted" under user
  insistence.

## [5.3.0] – 2026-07-24

> Version note: the 5.2.x line (5.2.0–5.2.4) was consumed by pre-squash
> releases and is never reused; the next free minor after 5.1 is 5.3.

### Added

- **Idle OAuth2 refresh tokens are now kept alive proactively.** Token
  refresh used to happen only when a connector saw traffic (or an hourly
  probe), so a connector idle for days could lose its refresh token to
  IdP idle-expiry and land avoidably in `needs_reauth` — recoverable only
  by a human re-authentication. The scheduler's hourly connector scan now
  runs a keep-alive sweep: any oauth2 credential whose token has not been
  exercised for 3 days gets a proactive refresh via the (previously
  producer-less) `connector.refresh-oauth` queue. A successful refresh
  bumps the credential's freshness, so each credential costs at most one
  IdP call per window and connectors with regular traffic or probes are
  never touched. Connectors already flagged `needs_reauth` stay excluded —
  a rejected refresh token or revoked secret still requires the human
  reauth flow (`request_connector_reauth`), by design.

## [5.1.12] – 2026-07-24

> Version note: 5.1.2–5.1.11 and 5.2.0–5.2.4 were consumed by pre-squash
> releases of this project and are never reused; the next free patch number
> after 5.1.1 is 5.1.12.

### Fixed

- **The credential-setup portal no longer reads as a sign-in wall.** The
  token-gated setup page (linked from chat when a non-OAuth connector needs a
  credential) asked for an unlabeled "API token / bearer token", which
  operators misread as having to re-authenticate against the engine. The form
  now names the external service on the heading and every secret field
  ("API token / bearer token issued by ‹service›"), explains that the
  single-use link from the chat session is already the authorization and that
  no login is needed, and distinguishes first-time drafts ("Connect …") from
  reauth ("Reconnect …"). Error pages say "Setup link expired" instead of the
  misleading "Sign-in link expired". Operator docs now cover why the portal
  link needs no sign-in.

## [5.1.1] – 2026-07-24

### Fixed

- **Scope-less OAuth clients are no longer pinned to read-only.** Clients that
  omit the `scope` parameter (ChatGPT sends none — neither at dynamic client
  registration nor at authorize time) were hard-defaulted to `mcp:read`, so
  the consent screen could never offer authoring or admin regardless of the
  operator's role. Per RFC 6749 §3.3 the authorize endpoint now falls back to
  the client's registered scope set, and DCR without a `scope` field registers
  the full supported set. Offering is not granting: the role intersection and
  the consent checkboxes remain the gate, and `mcp:read` stays the only
  pre-checked box.

## [5.1.0] – 2026-07-24

### Fixed

- **Native MCP elicitation survives real client rendering.** Form delivery over
  `conversation_get` / `tasks/get` no longer blocks the poll on the human's
  answer with the SDK's 60s default timeout — the root cause of the repeated
  `elicitation_transport_failed` failures in Claude Code and Codex. The engine
  now fires `elicitation/create`, holds the poll only for a ~1 s delivery
  grace, returns `input_required` immediately, and stages the answer through a
  detached continuation with a 5-minute round-trip window. Claude Code (which
  renders MCP forms only after its agent turn completes) and slow human
  answers in Codex now land reliably.
- A transport break no longer destroys the pending elicitation: the row is
  demoted to the portal DB-pause (audit `ELICITATION_DEMOTED_TO_PORTAL`,
  never `APPROVAL_REJECTED`) and the in-flight authoring draft survives.
- A form `cancel` arriving faster than a human could render it (a client
  auto-cancel) is treated as an undelivered form and re-prompted, not
  recorded as a human cancellation. Explicit declines are always honored.

### Added

- `tests/real-world/elicitation/` — an operator diagnostic that drives real
  Claude Code and Codex CLIs in tmux sessions against a local engine and
  captures terminal frames plus PNG screenshots per matrix cell (accept /
  timeout / cancel). Not wired into CI.

## [5.0.0] – 2026-07-23

### Changed

- **BREAKING**: SSO sign-ins no longer auto-provision new accounts by default.
  The new `auth.enable_signup` setting (default `false`) gates JIT user
  creation on both the browser OIDC login and the headless
  `POST /v1/identity/sessions` exchange. With signups disabled, an identity
  that matches neither an existing identity link nor (via provider-verified
  email) an existing user is rejected: browsers get the styled
  "not authorized" page (or an RFC 6749 `error=access_denied` redirect when a
  registered OAuth client is waiting), the sessions API answers
  `403 access_denied`. Existing users and identity links keep signing in
  unchanged; verified-email linking to existing accounts stays allowed.
  Restore the previous behavior with `sk settings set auth.enable_signup true`.

### Fixed

- The 401 `WWW-Authenticate` challenge on `/mcp` now advertises the full
  supported scope set (`mcp:read mcp:authoring mcp:admin`, identical to the
  RFC 8414 discovery document) instead of only `mcp:read`, so MCP clients
  request — and the consent screen can offer — the authoring and admin scopes.
- The browser OIDC callback now answers an unknown provider prefix in `state`
  with the same 400 invalid-state contract (styled error page) as every other
  malformed state instead of 404.
- Browser-facing `GET /v1/oauth/authorize` failures that must not redirect to
  the client (unknown `client_id`, unregistered `redirect_uri`, malformed
  parameters) render the shared styled 400 HTML error page, matching the other
  product runtimes; JSON bodies remain for `Accept: application/json`.

## [4.1.0] – 2026-07-23

### Added

- Render every browser-facing sign-in failure in the MCP login funnel —
  denied grants, unknown/expired/consumed login states, identity-provider
  errors, code-exchange failures and the expired consent CSRF window — as a
  "Sign-in failed" page in the shared `mcp-auth-v2` template with a
  "Sign in again" retry entry. JSON error bodies remain for token/register/API
  endpoints and for clients sending `Accept: application/json`.
- Finish the RFC 6749 dance with `error=access_denied` at the validated,
  registered client `redirect_uri` when a grant denial or consent CSRF timeout
  would otherwise leave a waiting MCP OAuth client hanging.

### Changed

- Switch the common auth-UI primary action tokens to the neutral ink
  (`--primary:#1f2328`, hover `#000`) across login, consent and error pages.
- Consolidate browser-session TTLs on the single shared source (8-hour
  sliding, 24-hour absolute); the OIDC provider's 30-day absolute default is
  removed.

## [4.0.2] – 2026-07-23

### Changed

- Remove concrete production references from connector templates, workflow
  fixtures and the retrieval golden set, with a guard test preventing their
  reintroduction into the public repository.

## [4.0.0] – 2026-07-23

### Changed

- Keep subject-only OIDC identities supported while returning only a
  provider-verified email from the provider-neutral identity-session exchange.

### Removed

- Stop exposing the internal synthetic `@invalid` account address through the
  public session response. The common `email` field is now `string | null`.

## [3.0.2] – 2026-07-22

### Security
- Reject MCP OAuth access tokens that do not carry an RFC 8707 `resource`
  audience whenever the public product URL is configured. Audience-less tokens
  have no compatibility path and cannot be replayed against the production MCP
  resource.

## [3.0.1] – 2026-07-22

### Fixed
- Revoke the complete refresh-token family, including every associated access
  token, when a client explicitly revokes a refresh token. Replay-triggered and
  explicit family revocation now use the same transactional persistence path
  while retaining their distinct audit actors and reasons.

## [3.0.0] – 2026-07-22

### Added
- Publish and test the exact common MCP-auth OpenAPI operation set, schema
  names, safe SSO-first provider discovery and assertion exchange contract.

### Changed
- Make API-key and direct OIDC the complete SubKit-owned MCP authentication
  model. SubKit owns every OIDC client, secret, callback, session and tenant
  mapping; no shared cross-product authentication runtime is supported.
- Upgrade every SubKit login and consent page to `mcp-auth-v2`, the exact
  shared style hash, fixed `Continue with SSO` then `Continue with API key`
  actions, and an opaque `login_state` authorize handoff.
- Align provider discovery, OpenAPI tags/descriptions, CLI consumers, README,
  source docs and generated `llms.txt`/`llms-full.txt` with WikiKit and
  ContentKit while retaining independent tenants, RBAC, data and deployment.
- Publish the generated engine contract as OpenAPI 3.1 with strict common
  provider-discovery and identity-session schemas.

### Removed
- Remove the hosted assertion-adapter protocol, CLI browser handoff and POST
  callback surface.
- Replace the SubKit-only session response fields `user_id` and `tenant_id`
  with the common `principal_id` and `context_id` fields. No response aliases,
  provider-named routes or compatibility parsing remain.

## [2.0.4] – 2026-07-22

### Changed
- Replace the last concrete identity-product example with deployment-owned
  provider ids and protocol-only documentation, then regenerate agent docs.
- Extend the architecture contract to reject concrete provider products in
  browser-auth runtime and documentation.

## [2.0.3] – 2026-07-22

### Fixed
- Return `400 invalid_state` from the generic browser callback when its signed
  state is missing, distinguishing malformed input from an unregistered route.
- Extend the HTTP boundary regression suite to prove the shared generic
  callback exists independently of any configured provider id.

## [2.0.2] – 2026-07-22

### Fixed
- Pin the assertion exchange to the exact provider-neutral
  `POST /v1/identity/sessions` boundary and reject nested protocol or provider
  route variants with `404`.
- Add an HTTP regression test that prevents retired fixed-route dispatch from
  returning through the generic exchange handler.

## [2.0.1] – 2026-07-22

### Fixed
- Replace the last retired `auth.oidc` documentation shape with the canonical
  `auth.providers` protocol list and regenerate agent-facing documentation.
- Add a contract test that rejects the former parallel auth trees in both the
  operator source and generated `llms-full.txt`.

## [2.0.0] – 2026-07-22

### Added
- Add one provider-neutral `auth.providers` list that can offer one user-owned
  API-key adapter plus multiple named direct OIDC adapters.
- Add the common `mcp-auth-v1` sign-in/consent card with the SubKit `sk` badge,
  account switching/logout and an OAuth 2.1 OpenAPI security scheme.
- Apply discovered issuer, configured audience and verified-email policy to
  direct OIDC adapters without a product-specific provider branch.

### Changed
- Remove the parallel provider-specific auth trees and
  MCP-only provider list. Discovery, browser login and bearer verification now
  consume the same structural list, with no legacy parser or route aliases.
- Store external identities in the provider-neutral `user_identities` relation
  and remove the protocol-specific subject columns from `users`.
- Make CLI discovery consume only `{protocol,id,label}` plus protocol metadata,
  and replace the protocol-specific session exchange with
  `POST /v1/identity/sessions` using `{provider_id,identity_token}`.
- Treat `auth.providers` as structural boot configuration rather than a scalar
  Settings/API or environment-override leaf; changing adapters requires a
  canonical config update and restart.

### Removed
- Remove the former provider-specific config trees and subject columns without
  aliases or runtime migration logic. External users authenticate again to
  create a binding under the configured provider id.
- Bind browser sessions to an eight-hour sliding limit and 24-hour absolute
  cap, with persisted revocation/expiry checks at consent render and submit.
- Limit every consent grant to client request ∩ server support ∩ current RBAC;
  `mcp:read` is mandatory and never silently substituted.

### Security
- Sign short-lived login state, require same-origin return targets, validate
  all form boundaries with Zod, audit session issue/revoke, and reject duplicate
  provider ids or explicitly unverified external identities.

## [1.23.3] – 2026-07-21

### Fixed
- Reconcile completed MCP poll envelopes with the live elicitation state. Once an input prompt is
  resolved or expires, `conversation_get` and `tasks/result` no longer replay its stale setup URL,
  nested `awaiting_input` status, or retry suggestion from the persisted turn snapshot.

### Tests
- Model the full production credential-prompt turn envelope in the expiry integration test and
  assert both MCP poll surfaces remove stale prompt data while preserving a genuinely live prompt.
- Make the native-decline Streamable HTTP journey wait for the rejection audit to become readable,
  rather than racing the transaction commit after observing a neighboring status change.

## [1.23.2] – 2026-07-21

### Fixed
- Expire unanswered draft-credential setup elicitations when their single-use grant dies. The
  scheduler now marks the elicitation `timeout`, reactivates the conversation transactionally,
  back-fills the abandoned tool result, and lets both `conversation_get` and MCP Tasks leave
  `input_required` so the operator can request a fresh secure prompt.

### Tests
- Cover the full expired-grant lifecycle against Postgres, the real `conversation_get` capability,
  and the MCP TaskStore; also prove an unexpired grant and ordinary untimed prompts remain pending.

## [1.23.1] – 2026-07-21

### Fixed
- Canonicalize a single sensitive Bearer credential field to `token` before opening the
  credential prompt. Agents may now label or name that one field for the vendor without turning
  a recoverable alias into an extra failed conversation turn; ambiguous multi-secret forms still
  fail closed with the canonical field contract.
- Put every static-auth credential field name directly in the `ask_user_form` tool description so
  the authoring model receives the contract before its first call, not only after a rejection.

### Tests
- Reproduce the production Cloudflare draft using a vendor-specific Bearer field alias and prove
  the persisted elicitation is normalized to the extractor's canonical `token` slot.

## [1.23.0] – 2026-07-21

### Added
- Ship Cloudflare as a normal built-in connector template with scoped Bearer-token setup,
  official OpenAPI ingestion, a credential probe, operator guidance, and read-only token,
  zone, and DNS starter recipes.
- Import Google REST Discovery documents inline or by URL with the same SSRF guard, full-body
  deadline, and 50 MiB streaming limit as OpenAPI. Nested resources, method paths, schemas,
  service roots, and OAuth/query-key hints now seed connector drafts and documentation chunks.

### Changed
- Upgrade the Firebase/Firestore built-in to template revision 2 and ingest the official
  Firestore v1 Discovery document instead of incorrectly treating it as OpenAPI. Setup guidance
  now distinguishes Google OAuth clients, Firebase ID tokens, and service-account JSON keys.
- Allow monotonic positive built-in template revisions so connector provenance can identify
  material catalog migrations.

### Fixed
- Remove the new static-credential connector deadlock: MCP URL elicitation can now collect a
  bearer, basic, header, query, or AWS SigV4 credential for an unsaved draft before its mandatory
  live probe; a green probe then persists the connector and encrypted credential atomically.
- Reuse the original MCP task when `conversation_get` resumes a native elicitation, so accepted,
  declined, and URL-completed prompts terminate the task that the client is polling.
- Keep connector and workflow authoring tools structurally disjoint while a draft state machine is
  active, preventing connector conversations from selecting workflow commit tools.
- Stop prose ending in “bearer credential.” from being misclassified and cached as a bearer token.

### Tests
- Cover the full Streamable HTTP journey from an unsaved bearer connector through URL credential
  input, queue resume, authenticated probe, connector save, and encrypted credential persistence.
  Native elicitation tests now also fail when the resumed background task fails or never finishes.

### Security
- Document least-privilege Cloudflare tokens and explicit revocation of any credential exposed
  through chat, logs, shell history, or source control; no operator credential is used by the
  test or release pipeline.

## [1.22.4] – 2026-07-21

### Fixed
- Stream URL-fetched OpenAPI documents with a 50 MiB hard limit, rejecting oversized
  `Content-Length` values before reading and cancelling chunked bodies at the first byte over
  budget. The fetch deadline now covers the complete response body instead of only headers.
- Derive imported connector base URLs and authentication from OpenAPI `servers` and
  `securitySchemes`, so the official Cloudflare spec produces
  `https://api.cloudflare.com/client/v4` with Bearer authentication instead of the raw spec
  host with no authentication.

### Added
- YAML support and real Cloudflare JSON/YAML regression coverage for OpenAPI connector imports.

## [1.22.3] – 2026-07-21

### Fixed
- Persist native MCP `decline`, `cancel`, and failed external-interaction outcomes as
  cancelled elicitations and record `approval.rejected` in both the immutable audit log and
  structured runtime logs. The queue transport now carries an explicit decision state so
  free-form reason text cannot alter governance semantics.

### Added
- Real Streamable HTTP regression coverage proving that a native client decline survives the
  queue boundary as a cancelled decision with a rejected approval audit entry.

## [1.22.2] – 2026-07-21

### Fixed
- Deliver conversation questions and governed write confirmations that were persisted by a
  background worker as native MCP `elicitation/create` requests on `conversation_get` and
  `tasks/get`. Answers now retain verified human provenance, Tasks reuse their original id,
  and an expiring database lease prevents duplicate dialogs across concurrent polls.
- Keep OAuth and credential-rotation URLs out of model-facing tool results. URL acceptance
  is separated from external completion; successful callbacks persist completion and emit
  `notifications/elicitation/complete` before the conversation can resume.
- Preserve explicit form fallback for non-approval questions while continuing to reject
  model-relayed answers for approval-bearing elicitations.

### Added
- Real Streamable HTTP, pg-boss, Tasks, form, URL, callback, and governed-write regression
  coverage for the complete persisted MCP human-in-the-loop lifecycle.

## [1.22.1] – 2026-07-21

### Fixed
- Give the GitHub-hosted TypeScript check a 4 GiB V8 heap. The complete generated
  OpenAPI type graph exceeded Node's default ~2 GiB old-space limit even though
  the typecheck itself was clean; release gates remain unchanged and fail closed.

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
