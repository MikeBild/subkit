# Guided-authoring — landed vs. still open

## Landed (1.8.0 + 1.9.0 RC)

Foundational (1.8.0):
- Real step + workflow preview with budget + cancel + classification
- Driver-parity probe for HTTP / GraphQL / Postgres / S3
- Probe-before-save and preview-before-commit gates with audited `force`
  override (`CONNECTOR_SAVED_OVERRIDE` / `WORKFLOW_COMMITTED_OVERRIDE`)
- Resume-review mode + `buildResumeSummary` surfaced on
  `ConversationDetail.resume_summary`
- Authoring context block in the volatile cache segment of the prompt,
  with secrets masked by allowlist
- Deterministic onboarding policy + `start_workflow_from_goal` tool
- Structured sk cards for probe / preview / save / commit / resume
- Status-line authoring fields + resume banner
- sk slash commands `/templates`, `/probe`, `/preview`, `/versions`,
  `/restore`
- Brand-name hygiene gate (`tests/lint/brand-names.test.ts`)
- Pre-push hook mirroring the CI gate

Second pass (1.9.0 RC on `main`):

1. **Preview parity across all step kinds.** `previewStep` now handles
   `wait` (no-sleep duration report), `branch` (evaluates `when` against
   scope + input), and `parallel` / `loop` / `call` / `tool`
   (structural preview of what would run). `preview_unsupported` is a
   true forward-compat branch only.
2. **`/probe` and `/preview` trigger real actions.** Default invocation
   appends a directive message so the model runs
   `probe_connector_draft` / `dry_run_step` / `dry_run_workflow`.
   `/probe show` and `/preview show` render the latest persisted
   result in a tone-coloured structured pane.
3. **Structured authoring panes.** New `structured` PaneSpec kind —
   tone-coloured section headings + key/value rows. Used by
   `/connector`, `/workflow`, and `/probe show`. Text-pane fallback
   remains for readline mode.
4. **Richer context snapshot.** `GET /v1/conversations/:id/context-snapshot`
   now includes attachments (count + first 10), `latest_probe` and
   `latest_preview` summaries, and `workflow_version` (current version
   number when bound). sk `/context` renders each new section.
5. **Secure connector credential collection.** `submit_connector_credential`
   tool wraps `upsertCredential` with a bearer/basic/header/query
   discriminated union. Plaintext flows from `ask_user_form` (new
   `type: "password"` + `sensitive` field) directly into the
   encryption boundary; never lands on audit metadata, tool-result
   payload, or transcript.
6. **Draft-model dedup via normalize-on-read.** `normalizeWorkflowDraft`
   now merges top-level and nested `workflow` fields with last-write-wins
   semantics on `name`/`slug`. Bypass writers (direct DB snapshot
   edits) only need to touch one side.
7. **Failure-streak banner removed.** Redundant now that staged
   authoring and real previews land cleanly.

## Intentionally deferred

- **Full dedicated Ink React panes beyond the structured one.** The
  structured pane covers `/connector`, `/workflow`, and `/probe show`
  with tone colours. Dedicated React components for template-picker,
  step-detail, preview-results, version-browser, approval-history would
  each be another 150–300 lines + visual tests; the current
  implementation is the functional floor. Pick up when the UX is
  validated in the field.
- **Deeper connector intelligence.** Template-specific required fields,
  auth-shape validation, region/base-URL variants, and ranked template
  suggestion via the knowledge pipeline. Needs a template-schema
  design doc first.
- **Mode-specific hidden-context envelopes.** The authoring context
  block is single-shape today. Splitting per mode (onboarding /
  connector_authoring / workflow_authoring / resume_review) requires a
  context-assembler refactor that would be better as a dedicated change.
- **Expanded journey coverage.** Unit + integration + the existing
  e2e suite covers the hard rules; the 9 journey scenarios in the
  previous FOLLOWUP list (credential entry / OAuth / template decline /
  etc.) remain additive coverage for when they pay rent.

Every landed item has tests in the unit, integration, or e2e layer. The
pre-push hook now enforces the full CI gate locally before any push.
