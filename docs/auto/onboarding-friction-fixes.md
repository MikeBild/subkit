# Onboarding Friction — Fixes (status: all resolved & verified)

Originally found while running the [zero-to-running quickstart](../quickstart/zero-to-running.md)
against `mikebild/subkit:latest` (engine `7.0.1`). All items below were then
fixed in the engine/CLI/entrypoint and **re-verified end-to-end** by rebuilding
the all-in-one image (`docker build -t subkit:local .`) and replaying the whole
procedure on a fresh volume on 2026-06-19.

Legend: ✅ fixed & verified.

---

## Fixes

### ✅ F1 — LLM key written to the wrong config leaf (blocker)
- **Was:** `sk init --llm-api-key` wrote `llm.api_key`, but the resolver reads
  `llm.providers.<provider>.api_key` → first AI call died with
  `ProviderMisconfiguredError`.
- **Fix:** `apps/engine/src/config/loader.ts` now mirrors
  `(llm.provider, llm.api_key, llm.model)` into the active provider's leaves at
  load time **and** on every `setConfigKey` — only filling an empty
  provider-specific leaf, so an explicit per-provider value still wins.
- **Verify:** after `sk init --llm-provider anthropic --llm-api-key …`,
  `sk -p "pong"` returns `pong` with **no** manual workaround. Unit tests added
  in `config/__tests__/consumer-readback.test.ts` (mirror happens; explicit
  value never overwritten).

### ✅ F2 — AI failures showed as `sk: internal error`
- **Was:** a `ProviderMisconfiguredError` surfaced as a masked 500 → CLI printed
  only `sk: internal error`.
- **Fix:** `apps/engine/src/http/middleware/error.ts` maps
  `ProviderMisconfiguredError` → **400 `llm_provider_misconfigured`** with an
  actionable hint.
- **Verify:** misconfiguring the provider now returns a clear message
  (e.g. “Incorrect API key provided … find your API key at …”) instead of
  `internal error`.

### ✅ F3 — “files lost on reboot” warning + broken storage override (real bug)
- **Root cause (new):** the loader maps `SK_OVERRIDE_<PATH>` with a **single**
  underscore between path segments (`envKeyForLeaf` → `leaf.path.join("_")`), but
  `deploy/docker/entrypoint.sh` exported `SK_OVERRIDE_STORAGE__FILES__DIR`
  (**double** underscores). The override was silently dropped, so
  `storage.files.dir` stayed empty and on-disk uploads (>5 MB) really would land
  in an ephemeral tmpdir. The warning was *correct*.
- **Fix:** entrypoint now exports `SK_OVERRIDE_STORAGE_FILES_DIR` /
  `SK_OVERRIDE_STORAGE_FILES_BACKEND` (single underscore).
- **Verify:** `sk settings get storage.files.dir` → `/data/blobs (global/override)`;
  the boot warning no longer fires.

### ✅ F4 — `sk doctor` recommended a non-existent `sk setup`
- **Fix:** `apps/sk/src/commands/doctor.ts` hint now reads
  “run `sk doctor --json` (or hit GET /v1/diagnostics/setup)”. With F1 fixed, the
  LLM section also passes on a normal bootstrap.

### ✅ F5 — docs documented an ineffective LLM-config method
- **Fix:** F1's mirror makes the documented generic paths
  (`sk settings set llm.api_key`, `SK_OVERRIDE_LLM_API_KEY`) actually work, so
  `docs/operations/docker.md` / `operator.md` are now correct. The
  [zero-to-running guide](../quickstart/zero-to-running.md) dropped its
  workaround step.

### ✅ F6 — `--tags` didn't behave as documented
- **Fix:** `apps/engine/src/http/routes/knowledge-sources.ts` only auto-enriches
  when **neither** a description nor tags were supplied; explicit `--tags` are
  now authoritative. CLI help text updated to match.
- **Verify:** `--tags "weather,runbook,open-meteo"` → tags stay exactly those
  three (no AI augmentation).

### ✅ F7 — a workflow's result was not visible
- **Root cause (new):** `GET /v1/executions/:id` carries no output; the produced
  value lives on the final **step's** `output_preview`.
- **Fix:** new `sk executions result <id>` (`apps/sk/src/commands/executions.ts`)
  reads the last step's `output_preview` / `result_preview`.
- **Verify:** prints `{ "city": "Berlin", … "temperature_c": 30 }`.

### ✅ F8 — connector name blank in the list
- **Root cause (new):** the engine exposes the name as `display_name`, but
  `sk connectors list` mapped its `name` column from a non-existent `r.name`
  field. (The connector row itself was fine — `display_name` was set.)
- **Fix:** CLI list/picker now fall back to `display_name`
  (`apps/sk/src/commands/connectors.ts`); `service.ts` also defaults
  `display_name` to the slug as defense in depth.
- **Verify:** `sk connectors list` shows `name = open-meteo`.

### ✅ F9 — scary EACCES boot warnings
- **Root cause (new):** with no `CONFIGURATION_DIRECTORY` / `STATE_DIRECTORY`, the
  boot fs-write probe fell back to hard-coded `/etc/subkit` + `/var/lib/subkit`,
  which don't exist / aren't writable in the image → EACCES warnings.
- **Fix:** entrypoint sets those systemd-convention vars to `/data/config` and
  `/data` (real, writable). `SUBKIT_CONFIG` still pins the actual config path.
- **Verify:** no `/etc/subkit` / `/var/lib/subkit` warnings on boot.

### ✅ F10 — `sk doctor` exited non-zero on a healthy install
- **Fix:** `exitCodeFromStatus` now returns 0 for `ok`/`warn` and 2 only for a
  hard `blocked`. Meta updated.
- **Verify:** a freshly-bootstrapped engine reports `overall: warn (exit 0)`.

---

## Follow-up findings — resolved in 7.2.0

- ✅ **A1 — provider-switch key reuse.** `setConfigKey` now clears the generic
  `llm.api_key` on a real `llm.provider` change, so a stale key can't mirror into
  the newly-selected provider. The prior provider keeps its own provider-specific
  leaf; the new one stays unset until you supply its key (clear
  `ProviderMisconfigured` error, not a wrong-key auth failure). Regression test
  in `config/__tests__/consumer-readback.test.ts`.
- ✅ **A2 — JSON envelope.** Confirmed the CLI surface is already consistent:
  `emitList` always prints a **bare JSON array** for `--json` (lists → array,
  single-`get` → object). The `{items}` shape is the engine wire type, not the
  CLI output. Documented the convention; no breaking change made.
- ✅ **A3 — scriptable credential supply.** New `sk credentials set <connector-id>
  --mode bearer|header|query|basic|aws_sigv4|none …` POSTs to the existing
  `/v1/connectors/:id/credentials` and probes after. A key-based connector can
  now be provisioned fully headless (template create `--skip-checks` →
  `credentials set` → `connectors test`).

## Improvements — done in 7.2.0

- ✅ **Auto-consume the bootstrap token.** The engine writes the one-time token
  to `SUBKIT_BOOTSTRAP_TOKEN_FILE` (set to `/data/config/bootstrap.token` in the
  image) on mint and deletes it on consume; `sk init` reads it when `--token` is
  omitted. The all-in-one flow no longer needs `docker logs | grep`.
- ✅ **Zero-key tour.** Guide documents `--llm-provider mock` for a no-account run.
- ✅ **Downgrade localhost `public_base_url` warning.** Moved from a setup
  `warning` to a recommendation (the paths that truly need it already error
  clearly), so a clean local install shows no spurious ⚠.
- ✅ **Bootstrap token TTL.** Banner already states the absolute expiry + “(15
  minutes)”; with auto-consume the copy step is gone, so the TTL rarely bites.

## Still open (minor, found verifying 7.2.0)

- **A4 — `sk credentials list` shows no rows.** After `sk credentials set …`
  succeeds (engine returns 2xx), `sk credentials list <connector-id>` prints
  "(no rows)" — the command reads `connector.credentials`, which the connector
  view doesn't embed. The credential IS persisted (a probe with a valid key
  succeeds); only the listing is blind. Fix: embed a redacted credential summary
  (`{id, kind, has_credential, created_at}`) in the connector view, or have
  `credentials list` hit a dedicated endpoint. Low impact; deferred.

## Deliberately NOT done

- **One-step host login (`sk login --from-container`)** — rejected by design:
  `sk` is a multi-tenant end-user tool, not a Docker/DevOps wrapper, so it must
  not shell out to `docker exec`. The host path stays
  `engine --issue-admin-key` (operator action) → `sk login --api-key …`.
