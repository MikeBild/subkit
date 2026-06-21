# Changelog

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
