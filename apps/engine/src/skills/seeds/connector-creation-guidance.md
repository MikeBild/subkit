---
slug: connector-creation-guidance
scope: global
title: Connector Creation Guidance
description: Authoring contract for creating a NEW connector in a conversation. Covers the discover-before-probe loop, the masked-form credential path, the inline auto-save on a green `probe_connector_draft`, the OAuth2 form-submit auto-persist, and the structured `next_best_actions` error envelope. Loaded on creation-intent keywords only — not on every mention of `api` or `http`. Driver-level detail still lives in the per-protocol skills (`http-connectors`, `graphql-connectors`, `postgres-connectors`, `s3-connectors`); the `mcp` driver — an external MCP server, which is a connector and not a separate entity — is covered here.
activates_when: [{"kind":"intent_keyword","word":"create connector"},{"kind":"intent_keyword","word":"new connector"},{"kind":"intent_keyword","word":"add connector"},{"kind":"intent_keyword","word":"add integration"},{"kind":"intent_keyword","word":"new integration"},{"kind":"intent_keyword","word":"set up integration"},{"kind":"intent_keyword","word":"configure connector"},{"kind":"intent_keyword","word":"start connector"},{"kind":"intent_keyword","word":"start_connector_from_description"},{"kind":"intent_keyword","word":"start_connector_from_template"},{"kind":"intent_keyword","word":"wire up"},{"kind":"intent_keyword","word":"hook up"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, connector, onboarding]
audience: [runtime]
version: 14
---

# Connector Creation Guidance

You are authoring a connector with the operator. Subkit's domain has exactly
two first-class entities: **connector** and **workflow**. Connectors are
external systems we talk to; workflows are the multi-step recipes that call
them. Don't conflate them.

The authoring lifecycle has six discrete phases. Each phase has a single
responsibility and a checkpoint that flips fresh when it succeeds. Skipping a
phase produces an `*_invalid` rejection from the next gate; rerunning a phase
is cheap.

```
find_connector  ──►  create_connector_draft  ──►  authenticate_connector
                                                              │
                                                              ▼
save_workflow  ◄──  author_workflow  ◄──  test_connector  ◄───┘
```

| Phase | LLM tool | Checkpoint that flips fresh |
|---|---|---|
| 1. find_connector | `find_connector` (also implicit in `start_connector_from_description` when `base_url` is given) | none — short-circuits with `reused_existing` when a saved connector matches |
| 2. create_connector_draft | `start_connector_from_description` / `start_connector_from_template` / `import_connector_from_spec` | `connector_inspected`, then `connector_validated` |
| 3. authenticate_connector | • `auth_type=bearer/header/query/basic/aws_sigv4`: `ask_user_form(type=password,sensitive=true)` — credential lands on the draft only, persistence happens at probe time<br>• `auth_type=oauth2`: `ask_user_form` carries `commit_intent: save_connector` so the harness saves the draft on submit, then `authenticate_oauth` runs against the persisted row | `connector_authenticated` |
| 4. test_connector | `probe_connector_draft` | `connector_probed` AND (on green probe) `connector_persisted` — the probe tool calls `saveConnectorAtomic` inline; no separate save call |
| 5. author_workflow | `author_workflow` (one call generates + evaluates the complete draft — the grounded pipeline builder). `edit_workflow_patch` is THE editor for targeted findings (path fix, repaired expression, limit change) afterwards | `workflow_inspected` → `workflow_validated` → `workflow_previewed` |
| 6. save_workflow | `dry_run_workflow` (holds writes; auto-commits on a clean preview with a passing judge verdict) | `workflow_previewed` AND (on green, judged preview) `workflow_persisted` |

**Separate connector on a URL that already has one.** When `start_connector_*`
short-circuits with `reused_existing`, that is the default credential-preserving
behaviour — a differing name is NOT enough to override it. If the operator
explicitly wants an INDEPENDENT connector on the same `base_url` (e.g.
scope-isolated credentials — a read/write key alongside an admin key), call the
same start tool again with `force_new: true`. That skips reuse and mints a fresh
draft with its own credential; the existing connector is untouched. Only set it
on an explicit "separate/second connector" request — never to work around a
reuse you merely didn't expect.

`config.oauth` is **never** written by hand on the draft — it is owned by the
template snapshot and the OAuth2 client at mint time. `update_connector_draft`
will reject any payload that includes `oauth` with
`error_code: auth_mutation_not_allowed`.

Follow the loop below. Do not guess endpoints, do not type secrets into tool
arguments, and do not abandon a turn just because a tool reports it is
unavailable in the current state — every error tells you what to do next.

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

## URL-first authoring — call `match_connector_template_by_url` before creating

When the user pastes a concrete URL (Atlassian wiki link, Stripe charge URL,
GitHub repo link…), run `match_connector_template_by_url({ url })` FIRST. The
tool now returns three signals you must read before proposing a draft:

- `matches[]` — the top-N template candidates ranked by URL pattern. Same
  shape as `suggest_connector_templates`.
- `resolved_resource` — when present, the resource embedded in the URL is
  already decoded for you. Atlassian Cloud examples:
  - `{ kind: "confluence_tinyui", short: "y4ozBQ", page_id: 87263947 }` →
    use `page_id` (not the short) when building the page-fetch request.
  - `{ kind: "confluence_page", page_id: 83907824 }` → direct page URL.
  - `{ kind: "jira_issue", key: "ACME-22926" }` → drop the key into the
    Jira request path.
  Decoding the resource id at match time saves 3+ probe round-trips —
  do NOT call the API to discover an id the matcher already gave you.
- `matches[].existing_connector_candidates[]` — saved connectors on the
  tenant that already serve this URL host. Each candidate carries:
  - `score` (1-3) and `matched_dimensions` (any subset of `driver`,
    `base_url_host`, `auth_type`).
  - `reuse_recommendation`:
    - `"exact_match_reuse"` (score 3) — propose using this connector
      unchanged. Do NOT create a new draft.
    - `"reuse_with_host_override"` (score 2, auth matches) — propose
      adjusting the existing connector's base URL OR forking it. Confirm
      with the user before either.
    - `"reuse_after_auth_check"` (score 2, auth differs) — auth shape
      differs; surface the conflict to the user before drafting.

Order of operations after a URL paste:

1. `match_connector_template_by_url({ url })` — read all three signals above.
2. If `existing_connector_candidates[0].reuse_recommendation === "exact_match_reuse"`,
   skip directly to `author_workflow` against the existing connector.
3. Otherwise, follow the happy path below — but pass `resolved_resource` (when
   present) into the first request step so the dry-run hits the real resource.

## Happy path

For bearer / header / query / basic / aws_sigv4 (the common case):

```
1. discover_connector_endpoints({ template_id })       # curated index from the spec
2. start_connector_from_template({ slug })             # opens a draft
3. ask_user_form({ fields:[{ type:"password", sensitive:true }] })
                                                       # operator types the secret
                                                       # value lands on the DRAFT only
4. probe_connector_draft                               # green probe → inline auto-save
                                                       # envelope returns auto_saved: true
5. call_connector({ connector_id, method, path })      # iterate / paginate / sample
```

For OAuth2 (one extra phase before the probe):

```
3. ask_user_form({ commit_intent: "save_connector",
                   fields:[{ name: "client_id" }, { name: "client_secret", type: "password" }] })
                                                       # harness auto-persists draft on submit
                                                       # — required because authenticate_oauth needs
                                                       # a persisted connector_id
4. authenticate_oauth({ connector_id })                # opens authorization URL → tokens land
5. probe_connector_draft                               # confirms the access_token works
6. call_connector(…)
```

**There is no separate `save_connector_draft` call on either happy path.** A
green probe completes the persistence transaction inline (audit reason
`auto_persist_on_green_probe`); for OAuth2 the form-submit completes it
(audit reason `auto_persist_on_confirmation`). `save_connector_draft` is
diagnostic re-issue only — covered in its own section below.

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

### Read `data.suggested_endpoints` first

When the operator's most recent message is in scope, the result includes
`data.suggested_endpoints` — the top-3 endpoints ranked by relevance to that
message via a deterministic BM25-lite scorer over `summary + description +
path + operation_id + parameter names`. Each suggestion is shaped
`{ endpoint, score, reasons }`:

- `score` — the raw BM25 score; higher = stronger match. The list only
  contains entries with `score > 0`, so its mere presence means the operator's
  message intersected the index in a non-trivial way.
- `reasons` — short strings like `"matched 'droplets' in path"` enumerating
  which query token hit which field. Use these to explain to the operator
  *why* you are recommending an endpoint.

Read `suggested_endpoints` BEFORE re-reading the full `endpoints[]` list — it
is built so you can act in one turn instead of scanning a 200-endpoint index.
Treat it as a hint, not a constraint: if the operator's intent is broader, you
still have the complete list available.

### Fallback: discover_systems_from_files

If the template lacks a discovered index (older templates, no public OpenAPI
spec) the result returns `endpoints: []` and surfaces
`next_best_actions: ["discover_systems_from_files"]`. When the operator has
uploaded a knowledge source describing the system — README, architecture
document, code dump, vendor PDF — call:

```
discover_systems_from_files({ knowledge_source_id: "<uuid>" })
```

The tool asks the LLM to enumerate every third-party system the document
mentions and synthesises provisional connector candidates of shape
`{ name, kind, base_url_guess, endpoints, auth_kind, data_flow }`. The result
is cached for 24h keyed off the source upload's id, and persisted as a
`knowledge_sources` row of `kind: "connector_endpoint_candidates"` so the
operator can re-read it without paying for another LLM call. Treat the
candidates as a starting point the operator must refine — never auto-create
connectors from them without confirmation.

If neither the OpenAPI chain nor a knowledge-source upload yields anything,
ask the operator for one canonical endpoint and use that as the probe target.
Never invent `/account`, `/me`, `/projects`, or any other path no spec or
document advertised.

## Credential capture — masked form, atomic save, never named

When the connector requires auth (the discovered index says so, or the probe
came back 401/403):

1. Run **exactly one** `ask_user_form` with one entry of
   `type: "password", sensitive: true`. Do NOT prose-ask "What's your token?"
   in chat — the masked form IS the prompt.
   - **Over MCP (a client that renders no inline form or confirm dialog):**
     fire that same single `ask_user_form({ password, sensitive: true })`
     anyway. Against a fresh, unsaved static-auth draft the harness converts
     it into a secure **setup link** — a one-time `setup_url` surfaced to you
     as text. Relay that URL and its expiry to the operator; they submit the
     secret on the portal page and the draft binds it. Never fall back to
     prose-asking the token or asking the operator to paste it in chat: over
     MCP a prose question just parks and nothing persists.
2. **Bearer / header / query / basic / aws_sigv4:** the form value lands on
   the connector draft via the credential cache. No `commit_intent` — the
   subsequent `probe_connector_draft` will read the cached credential, run
   the probe, and on success persist the connector + credential together
   under audit reason `auto_persist_on_green_probe`. Your next
   `inspect_connector_draft` already shows the saved state.
3. **OAuth2:** the form must carry `commit_intent: "save_connector"` so the
   harness saves the draft + `client_id` / `client_secret` immediately on
   submit (audit reason `auto_persist_on_confirmation`).
   `authenticate_oauth` then opens the authorization URL against the
   persisted row and lands access + refresh tokens via the OAuth callback.
4. **Never** ask the operator to name the credential. The credential is keyed
   on `(tenant_id, connector_id, environment)`; it has no user-supplied name.

After the connector is saved, the right tool to verify it from the loop is
`test_connector({ connector_id })` — it runs the driver's canned health
probe (HTTP HEAD/GET against `base_url`, Postgres `SELECT 1`, S3
`list-bucket`, etc.) and returns `{ ok, latency_ms, status?, detail? }`. Use
it after a credential rotation, after self-healing approves a patch, or
before re-running a workflow that previously failed. Never suggest a
`curl` or shell command instead — `test_connector` is the chat-first
contract for that question, and it lands the same audit row
(`connector.invoked`, `method: "PROBE"`) that the HTTP / CLI surfaces emit.

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
  `reason: "manual_re_issue"` audit row. The two automatic paths are
  distinguished by their own reasons so operators can triage exactly which
  surface persisted a given connector:
  - `auto_persist_on_green_probe` — the inline save fired by
    `probe_connector_draft` after a successful probe.
  - `auto_persist_on_confirmation` — the harness auto-persist fired when an
    `ask_user_form` (typically OAuth2's client_id/client_secret form) was
    submitted with `commit_intent: "save_connector"`.

## Authentication quick guide

- **API key in header** — credential `mode: "header"`, store under the header name.
- **API key in query** — credential `mode: "query"`.
- **Bearer token** — credential `mode: "bearer"`, raw token only (the driver adds
  the `Bearer ` prefix). Only use `bearer` when the vendor sends
  `Authorization: Bearer <token>`.
- **Basic** — credential `mode: "basic"`, fields `username` + `password`. The driver
  composes `Authorization: Basic base64(username:password)` — never ask the operator
  to pre-encode `email:token`. Collect TWO fields: `username` (often the account email)
  and `password` (the API token). Atlassian API tokens (Jira, Confluence) are always
  Basic — even though Atlassian calls them "API tokens" they are NOT bearer tokens.
- **API token ≠ bearer** — many vendors advertise "API tokens" that travel as HTTP
  Basic, not Bearer. Default to `basic` when the vendor docs show
  `Authorization: Basic base64(email:token)`. Only choose `bearer` when the docs
  explicitly show `Authorization: Bearer <token>`.
- **OAuth2** — `load_skill("oauth-flow")`. Briefly: collect `client_id` +
  `client_secret` via masked form, save with `mode: "oauth2"`, then call
  `authenticate_oauth`. Access + refresh tokens never reach the agent.
- **Cognito User-Password / JWT-Bearer / Device / SigV4** —
  `load_skill("auth-flows")`. **Trust the matched_template** returned by
  `start_connector_from_description` — when the URL pattern matches an
  AWS / Cognito / GCP template, the engine pre-selects the correct
  `auth_type` + `oauth.grant_type` and the credential_hints array tells
  you exactly which fields to ask for (e.g. `username` + `password` for
  Cognito, `jwt_private_key_pem` for GCP, `access_key_id` +
  `secret_access_key` for SigV4). Don't override `auth_type` to
  `"header"` because you recognise an `appsync-api.*.amazonaws.com`
  hostname — that path forces the operator to re-enter creds twice.

### Offering auth options — use verbatim auth_type values

When the template exposes `auth_options`, present them via `ask_user_choice`. Each
choice `value` MUST be the option's `auth_type` string exactly as it appears in the
template — e.g. `"basic"` or `"oauth2"`. Never invent values like `"bearer_token"`,
`"api_token"`, or `"pat"`. The engine matches the choice value against `auth_type` and
rejects anything that does not match.

### Canonical credential field names per mode

The engine enforces these names. Sending any other name returns
`error_code: "credential_form_mismatch"`.

| Mode | Required fields | Notes |
|---|---|---|
| `bearer` | `token` | Driver prepends `Bearer ` |
| `basic` | `username`, `password` | Driver encodes as `Basic base64(u:p)` |
| `header` | `header_name`, `header_value` | Emitted verbatim |
| `query` | `param`, `value` | Appended to request URL |
| `aws_sigv4` | `access_key_id`, `secret_access_key` (+ optional `session_token`) | |
| `cognito_user_password` | `username`, `password` | |
| `oauth2` | `client_id` (+ optional `client_secret`) | |

Labels are free-form; only the `name` field is canonical and must match the table above.

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
- `oauth_not_configured` — connector saved without OAuth metadata; re-issue `save_connector_draft({ credential: { mode: "oauth2", client_id, client_secret? } })` so the operator's client_id/secret land in `config.oauth`, then call `authenticate_oauth`. The credential row is created by the OAuth callback.
- `placeholder_connector_missing` — slug typo or wrong environment.
- `auth_mutation_not_allowed` — you tried to write `config.oauth` via `update_connector_draft`. Only `config.oauth.client_id` is writable (public id). For client_secret + endpoints, use `save_connector_draft({ credential: { mode: "oauth2", ... } })`. To change the auth shape entirely, call `start_connector_from_description` with a different `auth_type`.
- `force_save_cooldown` — a force_save was requested while the failed probe is still fresh (within 60s). Collect a new credential via `ask_user_form`, re-probe, and retry. The cooldown protects you from persisting the credential a probe just rejected.
- `reserved_auth_header_present` — remove any header that shadows a saved connector or credential header, regardless of casing. Dynamic `Authorization` is allowed only after tenant-scoped validation checks current HTTP/GraphQL connector configuration and credentials: compatible `none`, `header` or `query` authentication must not own `Authorization`. Missing credentials do not establish this permission. `Cookie`, `Proxy-Authorization` and duplicate case variants are always forbidden; `x-subkit-token` and every other saved header remain protected. See `auth-flows.md`.

## MCP connectors (driver `mcp`) — a different shape, not a different entity

An external MCP server is a connector. There is no separate MCP-server
registry, no `subkit mcp-servers` command and no `/v1/mcp-servers` route; if the
operator asks to "add an MCP server", they are asking for a connector with
`driver: "mcp"`. Its config is narrow and strictly validated — an unknown key
under `config.mcp` is rejected at write time, not at first call:

- `base_url` — the MCP endpoint for `http` and `sse`. It is `null` for `stdio`.
- `config.mcp.transport` — `http` (the default), `sse` (a path ending in
  `/sse`), or `stdio` (a local command, see below).
- `config.mcp.auth.kind` — `none`, `bearer`, `basic`, `header`, `oauth2`,
  `oauth2_client_credentials`, or `oauth2_private_key_jwt`, with optional
  `issuer` / `client_id` / `scope` / `algorithm`. Secrets never go here: the
  storage layer refuses a secret-looking key under `config.mcp.auth`, and the
  credential belongs in the credential row like every other driver.
- A server that wants its key in a named header (e.g. `X-API-KEY`) is
  `auth_type: "header"` with `config.mcp.auth.kind: "header"` and nothing else
  in the auth block. The header name travels with the credential, as for an
  http connector: collect it with `ask_user_form` as a `header_name` field
  (pre-filled, not sensitive) next to a sensitive `header_value` field.
- `config.mcp.remote_tool_call_timeout_ms` — optional per-connector override,
  bounded 1000–300000. Raise it only for a genuinely slow remote; the bound is
  what stops a hung server holding the whole turn.
- **Keep the slug short.** The remote's tools are addressed as
  `mcp_<slug>__<tool>`, that composed name is capped at 64 characters, and a
  slug may never contain a double underscore (a database CHECK enforces it).
  A long slug silently costs the operator the tools with the longest names.

**Creating one in the chat.** `start_connector_from_description` picks
`driver: "mcp"` when the address path ends in `/mcp` or `/sse`, when the user
says MCP, or when the user gives a command to start. `probe_connector_draft`
then runs an MCP `initialize` + `tools/list` handshake, and a green handshake
saves the connector like any other draft. `POST /v1/connectors` and
`subkit connectors create --file` remain the definition-based paths.

**Interactive OAuth (`auth_type: "oauth2"`, `config.mcp.auth.kind: "oauth2"`).**
The server signs the person in through its own authorization server, so there
is no credential before the browser sign-in. Do not ask for one and do not
treat the 401 of a probe as a blocker: save the draft, and it is persisted in
the state `needs_sign_in` (the save result carries `sign_in`). Then call
`request_connector_reauth` for the one-time sign-in link.

- Dynamic client registration needs nothing from the person: the sign-in
  registers the client once (as a public PKCE client when the server allows
  `none`) and every later sign-in reuses it.
- A pre-registered public client (PKCE, no secret) is plain configuration:
  `update_connector_draft({ config: { mcp: { auth: { kind: "oauth2",
  client_id, token_endpoint_auth_method: "none" } } } })`. Never collect a
  public client id with a password field. Only a client secret goes through
  `ask_user_form(sensitive: true)`.
- The issuer of a pre-registered client is discovered at save time when it is
  missing. `mcp_oauth_issuer_unresolved` means discovery failed: ask the person
  for the authorization server URL, set it as `config.mcp.auth.issuer` with
  `update_connector_draft`, and save again.

### Local servers (all drivers)

A connector may point at a server on the engine's own machine: `localhost`,
`127.0.0.1` (any `127.x`), `[::1]`, and from a Docker engine
`host.docker.internal`. This holds for every driver (`http`, `graphql`, `s3`,
`sftp`, `postgres`, `mcp`), over `http://` and `https://`. These are real
addresses, never placeholders: do not replace them and do not ask the user to
"use a real host".

- **No sign-in by default.** A local target starts with `auth_type: "none"`.
  Switch to `bearer`, `header` (own header name) or `oauth2` only when the user
  asks for it, when discovery finds a REQUIRED scheme or OAuth metadata, or
  when the probe returns 401. A scheme that a spec only declares (no root
  `security`, `security: []`, or an anonymous `{}` alternative) is returned as
  `optional_auth_schemes`: mention it, do not demand a key for it.
- **Local https.** A self-signed or mkcert certificate needs either the CA as
  PEM (`tls: { ca_pem }`) or, as a last resort, `tls: { skip_verify: true }`.
  Set it through `update_connector_draft({ tls })`: it lands in `config.tls`
  for `http`/`graphql` and in `config.mcp.tls` for `mcp`. Both work only for
  local targets; tell the user that skip_verify accepts any certificate.
- **Docker engine.** Inside the container `localhost` is the engine itself.
  Use `http://host.docker.internal:8931`; on Linux the host service must
  listen on the Docker bridge or `0.0.0.0`, not only on `127.0.0.1`.
- **Limits.** SubKit Cloud and a Desktop connected to SubKit Cloud cannot reach
  local servers; the engine runs elsewhere. An admin can switch local servers
  off with the setting `connectors.local_servers: deny`. Other private
  addresses stay blocked.

### Local commands (`transport: "stdio"`, MCP only)

When the user names a command ("start `docker mcp gateway run`", "run
`npx @playwright/mcp@latest`"), the draft gets `transport: "stdio"`,
`command`, `args`, optional `env` (non-secret values only), `env_secret_names`
(names of secret variables; values go through the credential form) and `cwd`.
The command is split into words without a shell: pipes, redirects, `&&`, `;`
and `$…` expansion are refused. A stdio draft has no `base_url` and starts
with `auth_type: "none"`. When it needs secret environment variables, list
their names in `env_secret_names`: the draft then switches to
`auth_type: "header"` (`config.mcp.auth.kind: "header"`), and each value is
collected with `ask_user_form` as a header credential whose header name is the
variable name. Secret values never go into `env`.

- **A person must allow the command.** `probe_connector_draft` does not start
  it. It shows the person the literal command (program, arguments, the NAMES of
  the environment variables, the working folder) as an `ask_user_confirm`
  question of kind `mcp_local_command`. Only the person's answer counts: your
  own message, a model-relayed answer or a guess never confirms. After a yes
  the engine saves the connector, records the confirmation and runs the probe.
  Never claim the command is allowed before that answer arrives.
- **Every change asks again.** Changing the command, arguments, environment
  names or working folder resets the confirmation; the next probe asks again.
  `confirmed_command_hash`, `confirmed_by` and `confirmed_at` are engine-owned
  and cannot be written by `update_connector_draft`.
- **Who may confirm.** An owner or admin with `connectors:confirm_local_command`
  who did not enter the command. On a single-person Desktop workspace the owner
  confirms their own command. When the engine refuses, relay its reason and
  tell the user that an owner or admin must allow the command in the Cockpit.
- **Where it runs.** stdio runs on SubKit Desktop (macOS) and on an engine
  started on the host. A Docker engine answers `mcp_stdio_unavailable_in_container`:
  run the server on the host and connect over
  `http://host.docker.internal:8931/mcp` instead. `mcp_stdio_disabled` means
  an admin switched local commands off (`connectors.mcp.stdio`).

What you CAN do from here, once the connector exists:

- `test_connector({ connector_id })` — forces a real handshake and reports the
  tool count. This is the answer to "is this MCP server working?".
- `list_connectors({ category: "mcp" })` — every MCP connector on the tenant;
  `category` is the driver and is filterable.
- `get_connector` — the saved row, including `driver`, `enabled` and
  `last_error` (never the secret).
- `update_connector` — patch the saved row.

Two operator actions live outside the conversation palette, because a browser
or a terminal has to be involved: `POST /v1/connectors/{id}/mcp/inspect`
(handshake plus the tools, capabilities and instructions the remote serves,
also `subkit connectors mcp-inspect`) and `POST /v1/connectors/{id}/mcp/authorize`
(the interactive OAuth 2.1 URL the operator opens, also
`subkit connectors mcp-authorize`). The MCP flow is separate from the ordinary
connector `authenticate_oauth` path because an MCP server publishes its own
authorization server rather than declaring one in config.

Once it handshakes, the remote's tools appear in the chat palette as
`mcp_<slug>__<tool>` (plus read-only `list_resources` /
`list_resource_templates` / `read_resource` / `list_prompts` / `get_prompt` adapters where the server declared those
capabilities), and a workflow reaches them with a `request` step carrying
`protocol: "mcp"` and an `mcp` block. `call_connector` does NOT support this driver — it answers
`driver_not_supported_for_call_connector` and tells you to use a workflow
step. Every remote tool call is confirmed as a write regardless of what the
server annotates about itself.

## After save: iterate with call_connector

Once the connector is persisted, use `call_connector({ connector_id, method, path, query?, body? })`
for ad-hoc HTTP against it. This is how you paginate, sample a response shape
before drafting a workflow step, or verify a write endpoint without committing
a step. `call_connector` reuses the saved credential automatically — never pass
auth headers manually.

## After a failed probe (401/403)

A 401 or 403 from `probe_connector_draft` is almost never just a wrong credential —
read the response before re-asking.

1. **Read `latest_probe.response_preview` and `response_headers`.** The response body
   usually names the real problem (expired token, wrong scope, missing plan, CORS
   pre-flight). Only after reading it should you decide whether to collect a new
   credential.

2. **Verify the endpoint before re-asking for a credential.** A valid credential still
   returns 401/403 against a wrong host or path. Run
   `fetch_connector_docs` / `search_docs` / `discover_connector_endpoints` to confirm
   the base URL and probe path are correct before presenting the masked form again.
   Example: Atlassian Cloud's GraphQL gateway lives at
   `https://{domain}.atlassian.net/gateway/api/graphql` — probing `/graphql` or the
   REST base URL will return 404/403 regardless of the credential.

3. **Never re-probe an unchanged draft.** If nothing changed — same `base_url`, same
   credential, same probe path — the engine returns `error_code: "probe_unchanged"`.
   You must change at least one of: `base_url`, the credential (via `ask_user_form`),
   or the probe path before calling `probe_connector_draft` again.

## See also

- `subkit-concepts.md` — placeholder grammar, envelope shape.
- `http-connectors.md` — driver specifics, pagination modes, retry semantics.
- `oauth-flow.md` — the two-phase OAuth2 dance.
- `error-recovery.md` — typed error codes beyond connector creation.
