# Changelog

## [7.7.0]

The conversation prompt stops paying the full cost of every skill it has ever
loaded. Loaded skills now render their full body only while they are *relevant
to the current turn*, and fall back to a one-line index entry once they age out
— so a long session keeps its skill palette without the prompt growing without
bound.

- **Recency-gated skill loading (K=3).** `conversations.loaded_skills` moves
  from a one-way `string[]` ratchet to `{slug, last_turn}` recency entries with
  a new monotonic `turn_count` clock. A skill renders its full body while it
  was touched within the last K=3 turns; beyond that it is demoted to the
  "Loaded" index (one line) but stays referenceable and `load_skill`-reaffirmable
  until a wider retention horizon (K·8 = 24 turns). Nothing disappears, nothing
  is truncated — the dominant controllable LLM cost (full skill bodies) is now
  bounded by recency.
- **Tenant-isolation hardening.** The `load_skill` and tool-call autoload writes
  to `loaded_skills` are now scoped on `(tenant_id, id)`, not `id` alone, and
  every read validates the persisted shape at the boundary (malformed/legacy
  rows are dropped with a structured warning instead of poisoning the prompt).
- **Atomic per-turn clock.** `turn_count` is incremented via a single
  `UPDATE … RETURNING`, so concurrent turns on one conversation can no longer
  collapse a recency index.

Also includes the Gmail-send redaction fix (#239) and the `sk` startup
health-digest in-context chrome (#240).

## [7.6.0]

Runtime incidents become diagnosable in one pass, and the engine now warns
operators *before* a failure — the bounce that took manual `journalctl` grepping
to root-cause is now a structured, classified, correlated log line plus a
leading-indicator risk surfaced at the `sk` REPL, in `/v1/operator/health-digest`,
and to a connecting MCP client.

- **Errors are discoverable.** Every `errorFields(err)` log now carries an
  `error_class` facet (`transient` / `upstream_4xx` / `timeout` / `validation` /
  `logic` / …, mapped from the existing DB/HTTP/provider classifiers) plus the
  error's `cause` and `stack` — so "all transient DB errors" or "the real reason
  behind a DrizzleQueryError" is a single grep, not a forensic reconstruction.
- **A request's trace survives the queue boundary.** Worker handlers re-establish
  the enqueuing request's `trace_id` / `tenant_id` and a `request_source:"queue"`
  via a context bridge, so one trace_id now stitches HTTP → queued job → execution.
  A configurable per-field log truncation cap bounds a tool that interpolates a
  large payload into a message.
- **Predictive-maintenance telemetry.** New gauges/counters for DB-pool
  saturation, a *windowed* transient-retry rate, dead-letter-queue depth,
  connector health mix, LLM latency + fallback fraction, and RSS high-water —
  all on `/metrics`. They feed six leading-indicator risk signals (pool, DLQ,
  retry-rate, connector-unhealthy, LLM-fallback, memory) computed once in the
  operator health digest.
- **The digest speaks first.** `GET /v1/operator/health-digest` gains a
  deterministic `risk[]` block (gated on `stats:read`); the `sk` REPL renders it
  at startup and `sk login` shows a one-line risk summary; a connecting MCP
  client receives the same summary as `initialize` instructions and can pull the
  live `subkit://operator/health-digest` resource — all RBAC-gated, with
  `operator.risk_signal_raised` / `_cleared` audited on the transition edge under
  the system tenant.

## [7.4.0]

Runtime-log hardening, authoring-quality lints, and a count-consistency critic check — all grounded in production runtime-log analysis.

- **Scheduler survives a transient PostgreSQL bounce.** A short PG restart (e.g. an unattended-upgrade point release) used to drop per-cadence scheduler jobs — docs/knowledge refresh, schedule fan-out, drift/reauth/endpoint/skill-candidate scans — for a full cadence (1–6h). Each reconcile pass now retries on a transient DB error with jittered backoff, absorbing a ~10s bounce within the tick.
- **Silent-data-loss warnings now fire.** `transform_empty_extraction` (blocking at dry-run) and `transform_dropped_fields` (informational) were defined and consumed by the repair loop but never emitted; the transform step now produces them, so a projection that quietly drops fields or extracts nothing surfaces during authoring instead of shipping green.
- **New `supabase-graphql` connector template** (graphql driver at `/graphql/v1`, apikey + Bearer) with matching skills, plus a GraphQL `404 → remote_resource_not_found` probe classification so the authoring agent gets a "wrong endpoint" signal instead of a generic upstream error.
- **Authoring guidance:** independent reads should use `for_each` (auto-parallel) over `loop` (sequential); a bounded recursive/tree-traversal pattern (`has_children`, no nested loops); the authoring critic now flags avoidable sequential reads, silent data loss, and incomplete traversal.
- **Chat-critic count consistency:** a deterministic check rejects a self-contradictory assistant tally (total ≠ sum of parts) or a stated count that over-claims the items actually listed — caught from a bulk-delete summary that claimed more workflows than existed.
- **`tool.failed` carries the reason:** a structured `ok:false` rejection (e.g. `credential_form_mismatch`) now logs its `error_code`/`message` instead of a bare `ok:false` with only `data_keys`.

## [7.3.1]

Make Biome honor `.gitignore` so local lint/pre-push stays green after the docker tests.

- `biome.json` had `vcs.enabled: false`, which silently disabled the already-set `useIgnoreFile: true` — so Biome ignored `.gitignore` entirely. Running `bun run test:docker` leaves git-ignored scratch homes (`.docker-repl-home/`, `.docker-sk-home/`) in the working tree, and the next `bun run lint` / pre-push hook then failed on those JSON artifacts. Setting `vcs.enabled: true` brings lint and git back in sync (also covers `coverage/`, `subkit.config.json`, `.claude/settings.local.json`, …). No effect in CI (fresh checkout) and no tracked source is git-ignored.

## [7.3.0]

Upgrade the bundled database to PostgreSQL 18.

- The all-in-one image (`mikebild/subkit`) now embeds **PostgreSQL 18** (`postgres:18-bookworm` runtime stage); the dev `docker-compose.yml` and CI/nightly/weekly service containers move to `postgres:18-alpine`. Docs and the operations topology diagram are updated to match.
- **Breaking (embedded DB only):** the embedded cluster's on-disk format changes across the major version. An existing `/data` volume initialized by PostgreSQL 16 will not start under PG18 — back up and recreate the volume, or point the engine at an external `DATABASE_URL`. External-database deployments are unaffected.

## [7.2.2]

Fix connector reauth for Cognito `USER_PASSWORD_AUTH` connectors.

- `request_connector_reauth` no longer mints a dead browser sign-in link for `cognito_user_password` connectors (e.g. AppSync/Cognito). Cognito is a password grant — the engine never stores the password — so reauth now routes to the in-chat email+password re-issue and re-mints via `InitiateAuth`, rotating the credential in place. Previously the browser dance hit the Cognito endpoint and failed with "unexpected HTTP response status code", showing a misleading "this link has been used up" page.
- `beginConnectorOAuthDance` now fails fast with a clear error for non-browser grants instead of the opaque transport error.

## [7.2.1]

Closes the last onboarding rough edges.

- `sk credentials list <connector-id>` now shows attached credentials (redacted: id, mode, environment, oauth-refresh flag, created_at). The single-connector GET embeds the same summary; secret material never leaves the vault.
- `engine --issue-admin-key` prints a complete, copy-paste `sk login --engine-url … --api-key …` line so logging the host CLI in is one paste.
- Quickstart now covers the conversational `sk` REPL (approve-to-commit loop, slash commands) and connecting from an MCP client — Codex `config.toml` (streamable-HTTP + `bearer_token_env_var`) and the `sk mcp` stdio proxy.
- New docker-backed smoke (`bun run smoke:surfaces`) verifies the Codex MCP handshake (`/mcp` initialize + tools/list) and the headless REPL loop against a released image.

## [7.2.0]

Onboarding polish: scriptable setup and a friction-free first run.

- New `sk credentials set <connector-id> --mode bearer|header|query|basic|aws_sigv4|none …` attaches a credential without a conversation, so key-based connectors can be provisioned fully headless (create `--skip-checks` → `credentials set` → `connectors test`).
- All-in-one image: `sk init` auto-detects the one-time bootstrap token from the volume — no more `docker logs | grep`. The engine writes it to `SUBKIT_BOOTSTRAP_TOKEN_FILE` on mint and deletes it on consume.
- Switching `llm.provider` no longer lets the previous provider's generic key leak into the new provider (clear "not configured" error instead of a wrong-key failure).
- A clean local install is fully green: the missing `server.public_base_url` is now an advisory recommendation, not a setup warning.
- Guide: documents `--llm-provider mock` for a zero-API-key tour.

## [7.1.0]

Onboarding hardening and a zero-to-running quickstart.

- LLM key set via `sk init --llm-api-key` (or the generic `llm.api_key` / `SK_OVERRIDE_LLM_API_KEY`) now propagates to the provider-specific config leaf, so the first AI call works without a manual fix.
- Provider-misconfiguration now returns a clear `400 llm_provider_misconfigured` with a hint instead of a masked `internal error`.
- All-in-one image: file-storage persistence override is honored (uploads land on the `/data` volume, not an ephemeral tmpdir), and benign EACCES boot warnings are gone.
- New `sk executions result <id>` prints the value a workflow produced.
- `sk connectors list` shows the connector name; `sk doctor` no longer points at a non-existent command and exits 0 on a healthy (warn-only) install.
- Explicit `--tags` on `sk knowledge-sources create` are authoritative (no surprise AI-generated tags).
- New docs: `docs/quickstart/zero-to-running.md` and `docs/quickstart/using-the-repl.md`.

## [7.0.1]

Release pipeline now emits an event-driven deploy notification on publish, replacing a scheduled poll.

## [7.0.0]

Initial baseline release. History reset to a single `init` commit; prior changelog removed.
