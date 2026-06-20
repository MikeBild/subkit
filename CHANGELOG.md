# Changelog

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
