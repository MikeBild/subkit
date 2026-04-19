# Guided Authoring Status

## Original plan status

The guided-authoring plan that shipped across `1.8.x` through `1.11.x`
is now closed at the implementation floor:

- real step + workflow preview across all 8 step kinds
- driver-parity probe for HTTP / GraphQL / Postgres / S3
- probe-before-save and preview-before-commit gates with audited `force`
- resume-review mode + `buildResumeSummary`
- masked authoring context block with mode-aware envelopes
- onboarding policy + `start_workflow_from_goal`
- all 8 structured authoring cards
- dedicated authoring panes in `sk`
- status line authoring fields + resume banner
- route-doc parity gate
- `propose_connector` removal and canonical `start_connector_from_*`
- canonical nested `draft.workflow`
- conversation-run cancellation that aborts active previews/probes cleanly

## Verification coverage

The authoring floor is now exercised across:

- unit/integration tests in `apps/engine/src/conversations/**` and
  `apps/sk/src/tests/**`
- `tests/e2e/guided-authoring.e2e.test.ts`
- `tests/e2e/authoring-regressions.e2e.test.ts`
- `tests/e2e/sk-interactive-smoke.e2e.test.ts`

These suites cover:

- onboarding with and without templates
- pending-approval resume state
- workflow version restore
- probe failures (`401`, timeout)
- preview failure and preview cancellation
- tenant isolation on conversation reads
- GraphQL / Postgres / S3 draft probe parity
- startup smoke for the compiled `sk` binary
- quick-start starter flows for resume / connector / workflow / import / help

## Remaining work

No known gaps remain against the original guided-authoring implementation
plan. Future work should be treated as additive scope, not deferred plan
closure. Examples:

- richer template metadata and ranking heuristics
- broader docs-ingestion journeys beyond the current guided import floor
- more production smoke probes or operator automation around deploys
