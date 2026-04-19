# Guided-authoring follow-up — deferred parity work

This release (1.7.1) ships the guided-authoring foundations end-to-end:
real step + workflow preview, driver-parity probes, probe-before-save and
preview-before-commit gates with audited `force` overrides, resume-review
summaries, the authoring context block, an onboarding policy with a staged
`start_workflow_from_goal`, structured sk cards + a resume banner, new sk
slash commands (`/templates`, `/probe`, `/preview`, `/versions`,
`/restore`), doc parity fixes, and a brand-name hygiene gate.

The items below are the remaining parity gaps called out in the latest
review. They are intentionally deferred to keep this release focused; every
one has an explicit pointer and a next-step suggestion.

## Still to land

1. **Secure connector credential collection.** Draft authoring currently
   persists only connector *metadata* (`update-connector-draft.ts`,
   `save-connector-draft.ts`). A real authenticated connector still needs
   a masked secret request, confirmation step, OAuth handoff, credential
   row write, and credential-state display. Next: add
   `request_connector_credential` + `submit_connector_credential` tools
   behind a dedicated `ask_user_form` elicitation kind.
2. **Dedicated Ink panes.** Current pane kinds are `status`,
   `conversations`, and `text`. `renderAuthoringCard` dispatches
   structured transcript cards, and `/draft` / `/connector` / `/workflow`
   / `/context` / `/probe` / `/preview` / `/versions` render text panes.
   Next: add `connector-draft`, `workflow-draft`, `step-detail`,
   `probe-results`, `preview-results`, `version-browser`,
   `approval-history`, and `template-picker` pane kinds as first-class
   Ink components under `apps/sk/src/panes/`.
3. **Preview parity across step kinds.** `previewStep` supports `request`
   and `transform`; everything else returns `preview_unsupported`. Next:
   implement cheap previews for `wait` (return immediately),
   `branch`/`parallel` (evaluate condition/fan-out without running child
   steps), `call` (preview the callee's first step only), `loop` (1
   iteration with a small sample), `tool` (shape-only).
4. **Deeper connector intelligence.** `start-connector-from-template.ts`
   is a prefill; `start-connector-from-description.ts` does naive driver
   inference. Next: add template-specific required fields, auth-shape
   validation, region / base-URL variants, and connector-specific probe
   defaults. Rank template suggestions with the knowledge pipeline.
5. **Hidden-context envelopes per mode.** The authoring context block
   already renders draft state + guided next step. Next: split
   conversation-level context per mode (onboarding /
   connector_authoring / workflow_authoring / resume_review) and emit
   starter-action / selected-template / attached-docs hidden envelopes
   the way the prompt block does today.
6. **Version/history UX depth in sk.** `/versions` and `/restore` now
   call the real engine routes, but the list is a text pane. Next:
   promote to a `version-browser` pane with diff summaries and an
   "attach to this version" action.
7. **Richer context snapshot.** `GET /v1/conversations/:id/context`
   returns skills + message counts + tool-call counts + pending
   elicitations. Next: add docs in scope, knowledge hits, attachment
   inventory, latest probe artifact, and version context.
8. **Draft-model deduplication.** `authoring-state.ts` still seeds
   top-level workflow fields alongside `workflow`. Next: collapse to
   one shape and delete the mixed compatibility reads in `resume.ts`
   and `service.ts`.
9. **Expanded test coverage.** Unit + integration coverage is in place
   for preview, gates, resume, context block, onboarding policy, and
   brand hygiene. Next: add journey tests for credential entry / OAuth /
   template decline / per-driver probing / unsupported-step previews /
   auth-failure recovery / connector-to-workflow continuation / version
   restore / interrupted-session resume.

Every item above is additive — nothing in this release is blocking its
follow-up.
