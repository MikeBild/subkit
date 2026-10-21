---
slug: onboard-an-app
summary: Connect an app that signs users in at an identity provider to SubKit.
section: work
order: 7
audience: public
---
## Onboard an app

This checklist applies to any app that signs its users in at an identity provider and calls SubKit with that provider's access token. Hosts and ids below are placeholders (`example.test`, `<...>`). Work through it in order; the app only needs the product id and the workflow ids at the end.

### 1. Decide

- `product_id`: a lowercase name (`^[a-z][a-z0-9-]{0,62}$`), one per app. It ties provider, workflows, budget rows and the identity binding together.
- `issuer_url`: the provider's issuer, exactly as it appears in the token's `iss` claim. HTTPS outside localhost.
- `audience`: the value the token's `aud` claim carries. Read it from a real token of the app; the issuer defines it, SubKit has no default.
- `required_claims`: who may sign in. Every entry is a dot path into the verified payload with an exact value, for example `{ "path": "idp", "equals": "primary" }`. The key is required. An empty list `[]` admits every token of that issuer and audience and should be a deliberate choice.
- Sign-up by first token: the first verified token of a subject provisions a product user with the built-in member role (see above). If every holder of a valid token may become a user, nothing more is needed. If not, narrow `required_claims` so only the intended accounts qualify.

### 2. Runtime configuration

`auth.providers` is replaced as a whole array. Read the current value first and send it back with the new provider added; otherwise the other providers are removed.

```bash
sk settings get auth.providers --json
sk settings set auth.providers '[
  {"protocol":"api_key","id":"api-key","label":"SubKit API key"},
  {"protocol":"oidc_bearer","id":"<provider-id>","label":"<app> account",
   "issuer_url":"https://idp.example.test","audience":"<audience>","algorithms":["ES256"],
   "product_id":"<product-id>","tenant_slug":"default",
   "required_claims":[{"path":"idp","equals":"primary"}],
   "reject_anonymous":true,"clock_tolerance_s":30}
]'
sk settings get products --json
sk settings set products '{"<product-id>":{"execution_environment":"prod",
  "assistant_workflow_id":"<assistant-workflow-id>","budget_bucket":"<bucket>"}}'
```

`products` is also replaced as a whole object. `assistant_workflow_id` must be the id you choose for the guarded workflow in step 4.

`sk apps show <product-id>` shows what these values add up to once steps 3 to 5 are done; see "Inspect an app" below.

### 3. Connectors

Create one connector per upstream the workflows call: the model API, and the identity provider's admin API if the app deletes accounts. Write each definition as a JSON file without any secret, then:

```bash
sk connectors create --file connector-model.json --skip-checks
sk credentials set <model-connector-id> --mode bearer --token "$MODEL_API_KEY"
sk credentials set <idp-admin-connector-id> --mode header --header "Authorization=Bearer $IDP_ADMIN_KEY,apikey=$IDP_ADMIN_KEY"
```

`--skip-checks` is needed because a definition is probed before it is saved and the credential does not exist yet; `credentials set` probes afterwards. `bearer` sends `Authorization: Bearer <token>`; `header` sends the named headers (comma-separated `Name=Value`). Secrets come from your shell or secret store, never from a file, the app or this repository. A workflow reads its own connector's credential only as `${cred.<own-slug>.<field>}` under an approved authority.

SubKit probes every connector in the background and flags it as signed out when its configured probe answers 401 or 403; workflows that use a flagged connector are blocked until it is signed in again. Without a configured probe, SubKit sends `GET /` to the connector's base URL. Many admin APIs answer 401 or 403 there even with a valid credential, so that answer does not flag the connector: the probe reports `credential_unverified` with the warning `PROBE_AUTH_UNVERIFIED`, `sk connectors test <id>` prints the warning and exits non-zero, and the Cockpit shows "Verbunden · Anmeldung nicht geprüft" with a hint to set a probe path. To verify the credential, give the connector a cheap authenticated read as its probe, for example `"config": {"probe_endpoint": {"method": "GET", "path": "/admin/users?per_page=1", "expected_status": [200, 200]}}`, and check it with `sk connectors test <id>`.

To replace a stored credential, edit the connector in the Cockpit. A header credential with several headers, such as `Authorization` and `apikey` above, shows one field per header name: fill all of them to replace them together, or leave all empty to keep them. Filling only some is refused, so no header is dropped.

### 4. Workflows

Keep the definitions in the app's own repository and create them with operator-chosen ids so the app can hard-code them. A workflow definition accepts `id` (a UUID that must be unused; only an administrator may choose it).

```bash
sk workflows create --file workflows/assistant.json
sk workflows create --file workflows/delete-account.json
```

Each product workflow sets:

- `"id": "<fixed-uuid>"` and `"product_id": "<product-id>"`.
- `"required_caller_kind": "user"` and `"execution_privacy": "sensitive"`.
- On the metered workflow, `execution_guards.caller_daily_limit` (bucket equal to `budget_bucket`, limit, `tz`, unit path) and `execution_guards.input_bytes`.
- On the deletion workflow, `"caller_erasure": "on_success"`.

Division of responsibility. The identity provider owns the account: credentials, e-mail, sign-in methods and the account's existence. SubKit owns only its shadow records of the caller: the identity binding, budget rows, sessions and keys, the user row, the caller context stored on its executions, and the tombstone. The deletion workflow therefore runs in this order:

1. Delete the account at the identity provider with the admin connector, using `${caller.subject}` (bound with `{caller_bound: true}`). A 404 means the account is already gone and counts as success, so a retry is safe.
2. Best-effort revokes at other upstreams, for example a sign-in provider token. A failure here must not block step 3.
3. SubKit erases its own caller data last, through `caller_erasure: "on_success"` when the run succeeds. After it, tokens issued earlier are refused by the tombstone.

If step 1 fails, the run fails, nothing is erased and the app retries with the same `idempotency_key`.

### 5. Approve the execution authority

Without a live execution authority a product run answers 403. A person with write access approves each product workflow once per environment:

1. Open the workflow in Cockpit. A workflow that nothing starts but the app's HTTP calls (no schedule, no webhook) is checked in the environment its connectors live in, so for a production-only workflow the status line reads "Nicht freigegeben" (English: "Not approved") without a repair banner. If a step resolves to a connector in another environment, or a connector is missing, the repair state stays; fix that first.
2. Select "Freigeben…" in the status line, or on the "Freigaben" tab, which shows the same button while no approval is live. The dialog "Freigabe prüfen" opens with that environment already selected in the "Umgebung" field ("Produktion" or "Entwicklung"). Change it only if the product's `execution_environment` is a different one.
3. Review the effect boundary (connectors, addresses, read or write), choose open-ended or limit it by runs and time, and confirm.

The approval follows a newly activated version whose boundary does not grow and is asked for again when it grows. Revoke it on the "Freigaben" tab.

### 6. Verify

Check readiness first. Every check of `sk apps show <product-id>` should read `ok`; a failing check prints its next action.

```bash
sk apps show <product-id>
```

Use a real access token `$TOKEN` of a test account and the workflow ids from step 4. `$BAD_TOKEN` is `$TOKEN` with the last characters of its signature changed. `$BASE` is the engine URL.

```bash
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $BAD_TOKEN" $BASE/v1/budget
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/health
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/budget
curl -s -X POST $BASE/v1/executions -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"workflow_id":"<workflow-id>","idempotency_key":"check-1","async":true,"input":{}}'
```

Expected:

- `$BAD_TOKEN`, a wrong audience, a missing required claim or an expired token answers `401 invalid bearer token`.
- `GET /v1/health` with `ok: false` and a run answering `403` mean the authority from step 5 or a connector credential is missing.
- Using up the daily limit answers `429 rate_limited`; a second call while a unit runs answers `409 turn_busy`; the same `idempotency_key` replays instead.
- `sk executions` and the execution record show the caller summary and the authority used.

Secrets held in connectors can expire: provider client secrets often have a limited lifetime, and admin keys may be rotated. Record each secret's name, connector, owner and expiry date in the app's own repository (not the value), and renew it before expiry: attach the new value with `sk credentials set`, check it, then remove the old one with `sk credentials delete <credential-id>`. A probe with `sk connectors test <connector-id>` shows whether a credential still works. Cockpit and `GET /v1/health` show failing connectors.

Rollback: revoke the execution authority of the workflow (the app then receives 403 and nothing runs), restore the previous `auth.providers` and `products` values you read in step 2, and use `sk workflows history <id>` and `sk workflows restore <id>` for a workflow version. Removing the provider makes the app's tokens unclaimed; existing shadow records stay until the deletion workflow erases them.

### Inspect an app

An app is a read-only view assembled at read time from the `products` entry, the sign-in providers carrying its `product_id`, the workflows whose definition carries it, the users who signed in through it and today's caller budget. It has no storage of its own: changes go through `auth.providers`, `products` and the workflows, as in steps 2 to 5.

```bash
sk apps list                      # app, environment, users, budget today, readiness
sk apps show <product-id>         # settings, sign-in, workflows, users, budget today, readiness
sk apps show <product-id> --json
sk users list --app <product-id>  # users who signed in to that app
```

In Cockpit the same view is the "Apps" tab under "People & access" (German: "Personen & Rechte"); selecting an app opens its details. It is also available as `GET /v1/apps` and `GET /v1/apps/{id}`, and in admin-mode MCP as the read-only tools `list_apps` and `get_app`. All of them need `settings:read`; product principals are always refused with 403. A workspace sees an app when one of its sign-in providers (`tenant_slug`), workflows or signed-in users carries the `product_id`, or when the app's assistant workflow belongs to it; any other id answers 404. An id without a `products` entry is still listed, with `configured: false`.

Readiness consists of six checks, each with a message and, when it fails, a next action: `product_configured`, `sign_in_provider`, `assistant_workflow` (exists in the workspace, carries the `product_id`, is active and valid), `execution_authority` (live for the product's environment), `credentials` (usable on every connector the assistant uses) and `budget_guard` (a `caller_daily_limit` whose bucket equals `budget_bucket`). Budget today shows the units consumed and reserved in the guard's bucket for the current local day, the audited refusals of the app's workflows since local midnight (`rate_limited`, `turn_limit`, `turn_busy`) and when the day resets. Each entry in a user record's `identities` lists provider, `product_id` and last sign-in, without the subject; the placeholder `email` of a product principal still contains it.

### Erase an app user

Erasing removes SubKit's own data about one person for one app: their sign-in bindings, budget counters, sessions and API keys, and the subject in the caller context of past runs. The user record is anonymised and a tombstone makes tokens issued before the erasure be refused; a new sign-in at the provider creates a new, empty app user. A person who also has sign-in links to another app or to SubKit itself is not erased (409), because that would remove that access too. The account at the sign-in provider is not touched; deleting it stays with the app and its identity provider. Erasing is irreversible and needs an explicit confirmation by a person. It needs `identity:write` and an admin role; product principals are refused. The audit entry names the operator as actor with `source: operator_erasure`.

```bash
sk apps show <product-id>                          # lists the user ids of the app
sk apps erase-user <product-id> <user-id>          # asks for confirmation
sk apps erase-user <product-id> <user-id> --yes    # non-interactive; --json prints the result
```

In Cockpit the same action is on the user in the app's details, behind a confirmation dialog. Over HTTP it is `DELETE /v1/apps/{id}/users/{user_id}`, which answers `{ "user_id", "app_id", "erased": true }`, or 404 for an unknown, foreign or already erased user. Apps in MCP stay read-only. `DELETE /v1/identity/users/{id}` is unchanged and only deactivates a user.

Activating a settings revision that adds, removes, reorders or changes a sign-in provider, or adds, removes or changes a `products` entry, writes an audit entry (`auth_provider.*`, `product.*`) that names the provider or product and the changed fields; the changed values are not recorded.

### Generic or per app

| Concern | Where it lives |
| --- | --- |
| Token verification, binding, budgets, erasure, authority checks | Engine code, identical for every app |
| Provider entry, `products` entry, connectors and their credentials | Runtime configuration per deployment, set with `sk` |
| Workflow definitions and their fixed ids | The app's own repository, created with `sk workflows create` |
| Execution authority approvals | A person, per workflow and environment, in Cockpit |
| Secret expiry records | The app's own repository (metadata only) |

