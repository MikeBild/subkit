---
slug: onboard-an-app
summary: Connect an app that signs users in at an identity provider to SubKit.
section: work
order: 7
audience: public
---
## Onboard an app

Use this checklist for an app that signs users in at its own identity provider and calls SubKit with that token.
Work through the steps in order.
At the end, the app needs only the product ID and the workflow IDs.
Hosts and IDs in the examples are placeholders (`example.test`, `<...>`).

### What you need

- The `sk` CLI, signed in to your engine. In SubKit Cloud the engine address is `https://subkit-cloud.mikebild.info`, without `/cockpit`.
- A real access token of a test account of the app.
- Access to the upstreams the workflows call, such as the model API.

### 1. Choose the product ID and sign-in rules

Pick these values before you change any setting. Read `iss` and `aud` from a real token of the app.

| Setting | What to enter | Example |
| --- | --- | --- |
| `product_id` | A lowercase name (`^[a-z][a-z0-9-]{0,62}$`), one per app. It ties provider, workflows, budget and identity binding together. | `<product-id>` |
| `issuer_url` | The provider's issuer, exactly as in the token's `iss` claim. HTTPS outside localhost. | `https://idp.example.test` |
| `audience` | The value of the token's `aud` claim. The issuer defines it; SubKit has no default. | `<audience>` |
| `required_claims` | Who may sign in: a dot path into the verified token with an exact value. The key is required. | `[{"path":"idp","equals":"primary"}]` |

The first verified token of a person creates a product user with the built-in member role.
An empty `required_claims` list `[]` admits every token of that issuer and audience.
If not every token holder may become a user, narrow `required_claims` to the intended accounts.

### 2. Set the runtime configuration

`auth.providers` and `products` are each replaced as a whole. Read each value first and write it back with your addition.

1. Read the current sign-in providers.

```bash
sk settings get auth.providers --json
```

2. Add your provider entry and write the whole list back. Keep every existing entry, or it is lost.

```bash
sk settings set auth.providers '[
  {"protocol":"api_key","id":"api-key","label":"SubKit API key"},
  {"protocol":"oidc_bearer","id":"<provider-id>","label":"<app> account",
   "issuer_url":"https://idp.example.test","audience":"<audience>","algorithms":["ES256"],
   "product_id":"<product-id>","tenant_slug":"default",
   "required_claims":[{"path":"idp","equals":"primary"}],
   "reject_anonymous":true,"clock_tolerance_s":30}
]'
```

3. Read the current products.

```bash
sk settings get products --json
```

4. Add your product entry and write the whole value back.

```bash
sk settings set products '{"<product-id>":{"execution_environment":"prod",
  "assistant_workflow_id":"<assistant-workflow-id>","budget_bucket":"<bucket>"}}'
```

`assistant_workflow_id` is the ID you choose for the guarded workflow in step 4. Once steps 3 to 5 are done, `sk apps show <product-id>` shows what the values add up to.

### 3. Create the connectors

Create one connector per upstream the workflows call: the model API, and the identity provider's admin API if the app deletes accounts.

1. Write each definition as a JSON file without any credentials.
2. Create the connector.
3. Store the credential.

```bash
sk connectors create --file connector-model.json --skip-checks
sk credentials set <model-connector-id> --mode bearer --token "$MODEL_API_KEY"
sk credentials set <idp-admin-connector-id> --mode header --header "Authorization=Bearer $IDP_ADMIN_KEY,apikey=$IDP_ADMIN_KEY"
```

- `--skip-checks` is needed because the credential does not exist yet when the connector is created. `credentials set` checks it afterwards.
- `bearer` sends `Authorization: Bearer <token>`. `header` sends the named headers (comma-separated `Name=Value`).
- Credentials come from your shell or secret store, never from a file, the app or this repository.
- To replace a credential with several headers in the Cockpit, fill all header fields, or leave all empty to keep them.

To verify a credential, give the connector a cheap authenticated read as its probe:

```json
"config": {"probe_endpoint": {"method": "GET", "path": "/admin/users?per_page=1", "expected_status": [200, 200]}}
```

Then run `sk connectors test <id>`. A connector whose probe answers 401 or 403 counts as signed out, and its workflows are blocked.

### 4. Create the workflows

Keep the definitions in the app's own repository. Create them with fixed IDs so the app can hard-code them. Only an administrator may choose a workflow `id` (an unused UUID).

```bash
sk workflows create --file workflows/assistant.json
sk workflows create --file workflows/delete-account.json
```

Each product workflow sets:

- `"id": "<fixed-uuid>"` and `"product_id": "<product-id>"`.
- `"required_caller_kind": "user"` and `"execution_privacy": "sensitive"`.
- On the metered workflow, `execution_guards.caller_daily_limit` (bucket equal to `budget_bucket`, limit, `tz`, unit path) and `execution_guards.input_bytes`.
- On the deletion workflow, `"caller_erasure": "on_success"`.

The identity provider owns the account. SubKit owns only its own records of the caller. The deletion workflow therefore runs in this order:

1. Delete the account at the identity provider with the admin connector, using `${caller.subject}` (bound with `{caller_bound: true}`). A 404 means "already gone" and counts as success.
2. Revoke tokens at other upstreams on a best-effort basis. A failure here must not block step 3.
3. SubKit erases its own caller data last, through `caller_erasure: "on_success"`. Tokens issued earlier are then refused.

If step 1 fails, the run fails and nothing is erased. The app retries with the same `idempotency_key`.

### 5. Approve the workflows

Without a valid approval, a product run answers 403. A person with write access approves each product workflow once per environment.

1. In the Cockpit, open **Workflows** and click the workflow.
2. Select **Approve** in the status line or on the **Approvals** tab. The dialog **Approve <workflow> v<n>** opens.
3. Check that **Environment** (**Production** or **Test**) matches the product's `execution_environment`.
4. Review the connectors, addresses and read or write access.
5. Under **Validity**, choose **7 days**, **30 days** or **Until revoked**. **Until revoked** is preset and sets no run limit and no end date.
6. Select **Approve**. Approving starts no run.

A workflow that only the app's HTTP calls start is checked in the environment of its connectors. Its status line may read "Not approved" without a fix banner. If a connector is missing or lives in another environment, fix that first.

The approval follows a new version whose boundary does not grow. If the boundary grows, you approve again.

### 6. Test the app's access

Check readiness first. Every check should read `ok`. A failing check prints its next action.

```bash
sk apps show <product-id>
```

Then call the engine with a real token. `$TOKEN` is the access token of a test account. `$BAD_TOKEN` is `$TOKEN` with the last characters of its signature changed. `$BASE` is the engine URL.

```bash
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $BAD_TOKEN" $BASE/v1/budget
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/health
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/budget
curl -s -X POST $BASE/v1/executions -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"workflow_id":"<workflow-id>","idempotency_key":"check-1","async":true,"input":{}}'
```

Expected:

- `$BAD_TOKEN`, a wrong audience, a missing required claim or an expired token answers `401 invalid bearer token`.
- `sk executions` and the run record show the caller summary and the approval used.

### Renew a connector's credentials

Credentials in connectors can expire, and admin keys get rotated. Record the name, connector, owner and expiry date of all credentials in the app's repository, never the value. Renew them before they expire.

1. Store the new value with `sk credentials set`.
2. Check it with `sk connectors test <connector-id>`.
3. Remove the old one with `sk credentials delete <credential-id>`.

The Cockpit and `GET /v1/health` show failing connectors.

### Roll back an app

1. Revoke the workflow approval on the **Approvals** tab. The app then gets 403 and nothing runs.
2. Restore the `auth.providers` and `products` values you read in step 2.
3. Restore a workflow version with `sk workflows history <id>` and `sk workflows restore <id>`.

Without the provider entry, the app's tokens are no longer accepted. Existing caller records stay until the deletion workflow erases them.

### Erase an app user

Erasing cannot be undone.
It removes SubKit's own data about one person for one app:

- sign-in bindings
- budget counters
- sessions
- API keys
- the person's ID in past runs

A new sign-in at the provider creates a new, empty app user.

1. Find the user ID with `sk apps show <product-id>`.
2. Run `sk apps erase-user <product-id> <user-id>` and confirm.

```bash
sk apps show <product-id>                          # lists the user ids of the app
sk apps erase-user <product-id> <user-id>          # asks for confirmation
sk apps erase-user <product-id> <user-id> --yes    # non-interactive; --json prints the result
```

Good to know:

- Erasing needs `identity:write` and an admin role. Product users are refused.
- The account at the sign-in provider stays. Deleting it is up to the app and its identity provider.
- A person with sign-in links to another app or to SubKit itself is not erased (409).
- In the Cockpit, the same action is on the user in the app's details, behind a confirmation dialog.

| Interface | Call | Result |
| --- | --- | --- |
| HTTP | `DELETE /v1/apps/{id}/users/{user_id}` | `{ "user_id", "app_id", "erased": true }`, or 404 for an unknown, foreign or already erased user. |
| HTTP | `DELETE /v1/identity/users/{id}` | Only deactivates a user. |
| MCP (admin mode) | `list_apps`, `get_app` | Read-only. Erasing is not available. |

### Inspect an app

An app is a read-only view.
SubKit assembles it from five sources:

- the `products` entry
- the sign-in providers with the same `product_id`
- the workflows with the same `product_id`
- the signed-in users
- today's budget

The app itself stores nothing.
You change it through `auth.providers`, `products` and the workflows (steps 2 to 5).

```bash
sk apps list                      # app, environment, users, budget today, readiness
sk apps show <product-id>         # settings, sign-in, workflows, users, budget today, readiness
sk apps show <product-id> --json
sk users list --app <product-id>  # users who signed in to that app
```

In the Cockpit, open **People & access** > **Apps** and select an app. Over HTTP, use `GET /v1/apps` and `GET /v1/apps/{id}`. Both need `settings:read`.

Readiness consists of six checks:

| Check | Meaning |
| --- | --- |
| `product_configured` | A `products` entry exists. |
| `sign_in_provider` | A sign-in provider carries the `product_id`. |
| `assistant_workflow` | Exists in the workspace, carries the `product_id`, is active and valid. |
| `execution_authority` | A valid approval exists for the product's environment. |
| `credentials` | Usable on every connector the assistant uses. |
| `budget_guard` | A `caller_daily_limit` whose bucket equals `budget_bucket`. |

Budget today shows the units used and reserved today, the refusals since local midnight (`rate_limited`, `turn_limit`, `turn_busy`) and when the day resets.

### Where each setting lives

| Setting | Where it lives |
| --- | --- |
| Provider entry, `products` entry, connectors and their credentials | Runtime configuration per deployment, set with `sk` |
| Workflow definitions and their fixed IDs | The app's own repository, created with `sk workflows create` |
| Workflow approvals | A person, per workflow and environment, in the Cockpit |
| Credential expiry records | The app's own repository (metadata only) |

Every change to a sign-in provider or a `products` entry writes an audit entry. It names the changed fields, not their values.

### If something does not work

| What you see | What to do |
| --- | --- |
| `401 invalid bearer token` | The token was refused. Check `issuer_url`, `audience` and `required_claims` against a real token, and whether it has expired. |
| `403` on a product run, or `ok: false` at `GET /v1/health` | The approval from step 5 or a credential is missing. Check `sk apps show <product-id>`. |
| `429 rate_limited` | The daily limit is used up. `sk apps show` tells when the day resets. |
| `409 turn_busy` | A call is still running. Wait, or repeat with the same `idempotency_key`, which replays. |
| `credential_unverified` and `PROBE_AUTH_UNVERIFIED`, or "Connected · sign-in not verified" in the Cockpit | The connector has no probe, and `GET /` gave no clear answer. Set a probe path with an authenticated read (step 3) and check with `sk connectors test <id>`. |
| A connector counts as signed out | Its probe answered 401 or 403. Store the credential again (step 3) and check with `sk connectors test <id>`. |
| `409` when erasing an app user | The person has sign-in links to another app or to SubKit itself and is not erased. |
