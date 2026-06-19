# Changelog

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
