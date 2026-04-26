---
slug: connector-creation-guidance
scope: global
title: Connector Creation Guidance
description: Authoring contract for creating a NEW connector in a conversation. Covers the discover-before-probe loop, the masked-form credential path, the harness's auto-persist on confirmation, and the structured `next_best_actions` error envelope. Loaded on creation-intent keywords only — not on every mention of `api` or `http`. Driver-level detail still lives in the per-protocol skills (`http-connectors`, `graphql-connectors`, `postgres-connectors`, `s3-connectors`).
gates_tools: []
version: 3
auto_load: true
trigger_keywords: [create connector, new connector, add connector, add integration, new integration, set up integration, configure connector, start connector, start_connector_from_description, start_connector_from_template, wire up, hook up]
---

# Connector Creation Guidance

You are authoring a connector with the operator. Follow the loop below. Do not
guess endpoints, do not type secrets into tool arguments, and do not abandon a
turn just because a tool reports it is unavailable in the current state — every
error tells you what to do next.

## The four facts to confirm before any tool call

1. **Vendor + base URL** — full URL including any environment-specific
   subdomain or path prefix. Ask whether staging and production differ.
2. **Authentication shape** — none, API key (header or query), Bearer token,
   Basic, or OAuth2. For header/query keys, capture the exact parameter name.
3. **API versioning** — version path (`/v1`, `/v2`) belongs on the base URL,
   not on each step.
4. **Rate limits** — if documented, plan `max_retries: 2` or lower and respect
   `Retry-After`.

If the user has named a vendor, run `suggest_connector_templates` and offer
the top match as an accelerator. Templates are an offer, never a requirement.

## Happy path

```
1. discover_connector_endpoints({ template_id })       # curated index from the spec
2. start_connector_from_template({ slug })             # opens a draft
3. ask_user_form({ fields:[{ type:"password", sensitive:true }] })
                                                       # collects the credential
                                                       # harness auto-persists draft + credential atomically
4. probe_connector_draft                               # confirms connectivity
5. (operator already sees a saved connector — no extra commit call needed)
6. call_connector({ connector_id, method, path })      # iterate / paginate / sample
```

The harness applies the connector + credential write the moment the operator
submits the form. Do not call `save_connector_draft` on the happy path; it is
now a diagnostic re-issue tool (see below).

## discover_connector_endpoints — read this before probing

`discover_connector_endpoints({ template_id, base_url? })` returns a curated
endpoint index built from the connector's OpenAPI spec. Use it instead of
guessing routes from training-data memory. The result is the single authoritative
list of paths you may probe or call.

Read it as:

- `endpoints[]` — `{ method, path, summary, auth_required, scopes?, sample_query? }`
- `auth_required: true` means you MUST attach a credential before any probe of
  that path; skipping straight to `probe_connector_draft` will return
  `credential_required` and you have to back up to `ask_user_form` anyway.
- `recommended_probe` — when present, this is the cheapest path to verify the
  credential works. Prefer it over a full list endpoint.

If the template lacks a discovered index (older templates, `discover_connector_endpoints`
returns `discovery_unavailable`), ask the operator for one canonical endpoint
and use that as the probe target. Never invent `/account`, `/me`, `/projects`,
or any other path the spec did not advertise.

## Credential capture — masked form, atomic save, never named

When the connector requires auth (the discovered index says so, or the probe
came back 401/403):

1. Run **exactly one** `ask_user_form` with one entry of
   `type: "password", sensitive: true`. Do NOT prose-ask "What's your token?"
   in chat — the masked form IS the prompt.
2. The harness pipes the form value straight into the persistence layer as
   `credential: { mode: "<bearer|basic|header|query|oauth2>", … }`. The connector
   draft and its credential land together in one transactional write. Your
   next `inspect_connector_draft` already shows the persisted state.
3. **Never** ask the operator to name the credential. The credential is keyed
   on `(tenant_id, connector_id, environment)`; it has no user-supplied name.

`save_connector_draft({ credential })` is still defined as a tool but it is
**diagnostic re-issue only** — for example after a credential rotation, after
`authenticate_oauth` returns `oauth_not_configured`, or when the operator
explicitly asks to re-attach a secret without re-creating the draft. Do not
call it as the normal commit step. Behaviour notes:

- **Idempotent**: re-issuing against a draft whose `saved_connector_id` already
  exists AND whose stored credential matches the supplied one returns
  `{ ok: true, data: { already_persisted: true, connector_id, … } }` with
  `next_best_actions: ["inspect_connector", "list_connectors"]` and never
  writes. Treat that envelope as success.
- **Probe failure override**: if the most recent probe failed, the tool returns
  a structured `probe_failed` envelope. Pass `force_save: true` only after the
  operator explicitly confirms in chat — the audit row is tagged
  `kind: probe_override` and the response includes a `warnings[]` line.
- **Audit signal**: every write through this tool emits a
  `reason: "manual_re_issue"` audit row, distinct from the harness
  auto-persist's `reason: "auto_persist_on_confirmation"`.

## Authentication quick guide

- **API key in header** — credential `mode: "header"`, store under the header name.
- **API key in query** — credential `mode: "query"`.
- **Bearer token** — credential `mode: "bearer"`, raw token only (the driver adds the `Bearer ` prefix).
- **Basic** — credential `mode: "basic"`, fields `username` + `password`.
- **OAuth2** — `load_skill("oauth-flow")`. Briefly: collect `client_id` +
  `client_secret` via masked form, save with `mode: "oauth2"`, then call
  `authenticate_oauth`. Access + refresh tokens never reach the agent.

## Connector config defaults

For HTTP connectors:
- `timeout_ms`: 30000 for general APIs; 10000 for real-time endpoints.
- `max_retries`: 3 for idempotent reads; 1 for non-idempotent writes.
- `follow_redirects`: true unless redirects are themselves a signal.

## Anti-patterns — these are rejected by the engine, not stylistic

The harness enforces these. Each one returns a structured error envelope you
must read instead of retrying.

- **DO NOT** put `token`, `api_key`, `apikey`, `password`, `credential`,
  `secret`, any `*_token`, or `authorization` keys inside
  `update_connector_draft.config`. The tool rejects with
  `error_code: "credential_must_use_form"` and
  `next_best_actions: ["ask_user_form", "save_connector_draft"]`.
  Credentials never live in `connector.config` — they live in the credential
  row, attached atomically through the masked-form path above.
- **DO NOT** type a credential value verbatim into any tool argument, anywhere.
  If the operator pastes a secret in chat before you offered the form, do not
  echo it, do not store it via `save_connector_draft.credential` (the value
  reached the model — calling it "masked" is a lie). Fire `ask_user_form`
  immediately and treat the leaked value as discarded.
- **DO NOT** call `probe_connector_draft` before a credential is attached for
  auth-required connectors. It will return
  `error_code: "credential_required"` and the loop has to back up to
  `ask_user_form` anyway. Just do that step first.
- **DO NOT** abandon the conversation when a tool returns
  `error_code: "tool_unavailable_in_state"`. Read the `next_best_actions`
  array and follow it. The tool is gated by skill or by draft state, not gone.

## The error envelope you must read

Every tool error returns:

```
{
  ok: false,
  error_code: "<stable_snake_case>",
  message: "<short human-readable>",
  details?: { … },
  next_best_actions: string[]   // ordered, prefer the first action you can take
}
```

`next_best_actions` is the engine telling you the recovery path. Items are
either tool names ("ask_user_form", "save_connector_draft", "load_skill"),
skill slugs ("oauth-flow", "http-connectors"), or short verbs the operator
should perform ("provide credential", "open authorization url"). Pick the
first one you can act on. If none map to a tool you currently have, fall
back to `ask_user` for clarification — never silently retry with the same
inputs.

Common codes you will see while authoring a connector:

- `credential_must_use_form` — you put a secret in `update_connector_draft.config`. Move it to `ask_user_form`.
- `credential_required` — probe ran without a credential. Run `ask_user_form` first.
- `tool_unavailable_in_state` — the tool is skill-gated; `next_best_actions[0]` is the `load_skill` slug.
- `discovery_unavailable` — template has no curated endpoint index; ask for one canonical path.
- `oauth_not_configured` — connector saved without OAuth metadata; re-issue `save_connector_draft` with `credential.mode: "oauth2"` and the missing fields.
- `placeholder_connector_missing` — slug typo or wrong environment.

## After save: iterate with call_connector

Once the connector is persisted, use `call_connector({ connector_id, method, path, query?, body? })`
for ad-hoc HTTP against it. This is how you paginate, sample a response shape
before drafting a workflow step, or verify a write endpoint without committing
a step. `call_connector` reuses the saved credential automatically — never pass
auth headers manually.

## See also

- `subkit-concepts.md` — placeholder grammar, envelope shape.
- `http-connectors.md` — driver specifics, pagination modes, retry semantics.
- `oauth-flow.md` — the two-phase OAuth2 dance.
- `error-recovery.md` — typed error codes beyond connector creation.
