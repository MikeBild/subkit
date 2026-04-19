# Guided-authoring — landed vs. still open

## Landed through 1.10.0

Foundational (1.8.0):
- Real step + workflow preview with budget + cancel + classification
- Driver-parity probe for HTTP / GraphQL / Postgres / S3
- Probe-before-save and preview-before-commit gates with audited `force`
  override (`CONNECTOR_SAVED_OVERRIDE` / `WORKFLOW_COMMITTED_OVERRIDE`)
- Resume-review mode + `buildResumeSummary`
- Authoring context block (secrets masked)
- Onboarding policy + `start_workflow_from_goal`
- 5 structured sk cards (probe/preview/save/commit/resume)
- Status-line authoring fields + resume banner
- sk slash commands `/templates`, `/probe`, `/preview`, `/versions`,
  `/restore`
- Brand-name hygiene gate, pre-push hook

1.9.0:
- Preview parity across **all 8 step kinds**
- `/probe` / `/preview` trigger real actions
- `structured` PaneSpec kind (tone-coloured sections)
- Richer context snapshot (attachments, latest probe, latest preview,
  workflow version)
- Secure `submit_connector_credential` tool + `password` + `sensitive`
  field types
- Draft-model dedup via normalize-on-read
- Failure-streak banner removed

1.10.0:
- **Masked keystroke echo** for `password` / `sensitive` form fields —
  plaintext never appears on terminal.
- **3 more authoring cards**: `ConnectorDraftCard` (start/update/
  validate/inspect connector), `WorkflowDraftCard` (propose_step / build
  / connect / validate / inspect with inline errors), `ApprovalCard`
  (ask_user_confirm / choice with pending + resolved states). All 8
  cards from the original plan now shipped.
- **Route-doc parity contract gate** — fails on any drift between
  engine `createRoute` declarations and `docs/17-conversations.md` +
  `docs/09-connectors.md`, or between sk slash registry and
  `docs/27-sk-cli.md`.

## Intentionally deferred (structural, needs own change)

- **Dedicated React pane components beyond `structured`** —
  `template-picker`, `step-detail`, `preview-results`, `version-browser`,
  `approval-history` would each be 150–300 lines + visual tests. The
  structured pane covers the content floor; dedicated components are
  interactive polish.
- **Deeper connector template intelligence** — template-specific
  required fields, auth-shape validation, region/base-URL variants,
  knowledge-pipeline-ranked template suggestion. Needs a template
  schema design doc.
- **Mode-specific hidden-context envelopes** — single-shape block
  today. Splitting per mode (onboarding / connector / workflow /
  resume) requires a context-assembler refactor.
- **`propose_connector` → `start_connector_from_*` migration** —
  entrenched in canned plans, 4+ e2e tests, skill docs, discovery
  service. Redundancy, not bug. Collapse in its own branch.
- **Additional dedicated E2E journey tests** — credential entry /
  OAuth / template decline / driver-specific probing / journey
  scenarios. Existing suite covers the hard behaviours; these are
  additive coverage.

Every landed item has tests in unit, integration, or e2e. The pre-push
hook enforces the full CI gate locally.
