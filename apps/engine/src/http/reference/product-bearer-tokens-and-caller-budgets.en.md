---
slug: product-bearer-tokens-and-caller-budgets
summary: Let your app call SubKit with its own sign-in, limited per user.
section: operate
order: 6
audience: operator
---
## Product bearer tokens and caller budgets

Your app can call SubKit with its own users' sign-in instead of shipping a SubKit key. You need this when a native app or portal starts workflows for signed-in customers. Afterwards SubKit verifies every token itself and creates a tightly limited account per user; per workflow you can also set a daily quota per user.

A bearer token is a credential the app sends in the `Authorization: Bearer …` header. Here it is a JWT (JSON Web Token): a signed data package whose issuer and content SubKit can verify. OIDC (OpenID Connect) is the standard through which SubKit finds the issuer's keys and details.

### Configure provider and product

Add a provider with `oidc_bearer` and an entry under `products` through runtime configuration. Hosts in the example are placeholders. `audience` and `required_claims` have no defaults; you state both for your issuer. The complete checklist is in the chapter "Onboard an app".

```json
{
  "auth": {
    "providers": [
      { "protocol": "api_key", "id": "api-key", "label": "SubKit API key" },
      {
        "protocol": "oidc_bearer",
        "id": "app-accounts",
        "label": "App account",
        "issuer_url": "https://idp.example.test",
        "audience": "app-audience",
        "algorithms": ["ES256"],
        "product_id": "app",
        "tenant_slug": "default",
        "required_claims": [
          { "path": "idp", "equals": "primary" },
          { "path": "claims.tier", "equals": "member" }
        ],
        "reject_anonymous": true,
        "clock_tolerance_s": 30
      }
    ]
  },
  "products": {
    "app": {
      "execution_environment": "prod",
      "assistant_workflow_id": "00000000-0000-4000-8000-000000000001",
      "budget_bucket": "assistant"
    }
  }
}
```

`label` is only the provider's display name, in the example the app account ("App account"). A claim is a field in the token. `reject_anonymous` refuses tokens whose `is_anonymous` claim is true.

### How SubKit verifies the token

The app sends `Authorization: Bearer <access token>`. SubKit reads only that header, never a `token` query parameter. SubKit claims a token only when it is a compact JWS, meaning a signed JWT in the usual dot-separated form, and its `iss` equals a configured `issuer_url`. This provider never claims SubKit keys, portal tokens (short-lived SubKit tokens for embedded end-user runs), MCP tokens or exchanged tokens.

SubKit then verifies:

- the signature against the issuer's JWKS, meaning its published keys; it comes from `jwks_uri` or the OIDC discovery, is cached per provider and refetched once for an unknown key,
- the audience and the list of allowed algorithms,
- `exp`, `iat` and a `sub` in UUID format,
- every `required_claims` entry, where `path` is a dot path into the verified payload,
- anonymous subjects, when `reject_anonymous` is true.

If any check fails, SubKit answers `401 {"code":"unauthorized","error":"unauthorized","message":"invalid bearer token"}`. For that request SubKit then tries no other provider, cookie or key.

### What a product caller may do

On a subject's first verified token, SubKit creates a product user. It gets the built-in member role, a placeholder address and an identity binding to the provider, issuer and product; email addresses are never linked. The product ceiling leaves this principal, meaning the authenticated identity, only `workflow:run`, `execution:read` and `execution:abort`. These apply to saved workflows with the same `product_id` and to its own executions.

These limits also apply:

- No MCP surface: `/mcp` answers `403 product_caller_forbidden`, and the tool dispatcher refuses every tool outside those three permissions with `policy_denied`.
- `oidc_bearer` providers never issue API keys or browser sessions and are not listed for browser login.
- Runs always use the product's `execution_environment`; SubKit ignores an `x-subkit-environment` header for them.
- Runs of a product principal verified through `oidc_bearer` are always live. Without a live execution authority, an active version or a usable prepared credential, SubKit answers 403 with the refusal code.
- The run then does not start as a held preparation, meaning a preview with writes held back. `hold_writes: true` answers `403 product_preparation_forbidden`.

### Daily quota per caller

A sensitive product workflow with `required_caller_kind: "user"` may declare two guards:

- `execution_guards.caller_daily_limit` limits use per caller and day. Fields: `bucket`, `limit`, IANA `tz`, `unit` as a `$input` path, `lease_ms`, `billable_steps`, optional `meter` (JSONata), `max_metered`, `commit_when` (JSONata over the run output) and `attach_usage_as`.
- `execution_guards.input_bytes` limits the UTF-8 bytes per `$input` path. A string counts itself, other values count their JSON text.

Counting happens in units; `unit` decides which input value defines a unit. On admission SubKit first checks the sizes. It then reserves one unit per caller and local day, in the same transaction that creates the execution, and only after the idempotency replay check. A replay therefore never charges.

Later calls of a reserved or committed unit are free until `max_metered` calls were used. A unit runs only one call at a time. A call whose cancel was requested no longer counts as running. Refusals create no execution:

- `429 {"error":"rate-limited","code":"rate_limited","message":"…","usage":{"usedToday":50,"dailyLimit":50}}` when the day is used up,
- `409 {"error":"turn-busy","code":"turn_busy"}` while another run of the unit is queued or running; that run continues, and the same request with the same `idempotency_key` replays it (`idempotent_replay: true`, 202 while it runs) instead of reserving again,
- `429 {"error":"turn-limit","code":"turn_limit"}` once `max_metered` calls were used (every request a billable step sends counts when it is sent),
- `400 {"error":"invalid","code":"invalid"}` for an input part above its byte limit.

### Charge and refund

When a run ends:

- On success SubKit commits the unit if `commit_when` is true. Otherwise it stays reserved for the next call.
- As soon as a billable step sends its request, the unit counts as billable. This happens after the execution authority check. A failure, abort or timeout after that point stays charged.
- A failed, aborted or timed-out run gets the unit refunded only under three conditions: no billable request was sent, no billable step succeeded, and no other run of the unit is active.
- SubKit settles reservations whose lease expires on the next read: billable units are committed, the others refunded.

A successful run's sensitive result contains `usage: {usedToday, dailyLimit}`.

### Endpoints for product clients

- `GET /v1/budget` returns `{usedToday, dailyLimit, day, resetsAt}` for the product's assistant workflow.
- `GET /v1/health` returns `{ok, version, model, key}`. `ok` needs the active workflow, a live execution authority for the product environment and a usable credential on every connector it uses; no secret is read.
- Both answer 404 to principals without a product.
- `POST /v1/executions` with a `workflow_id` and no `source` runs that saved workflow. A product client therefore sends only `{workflow_id, idempotency_key, async, input}`.
- `GET /v1/executions/{id}` also returns `execution_id` and `error: {code}` for failed or timed-out runs.

An admin may create a workflow under a fixed `id` so an app can address it without configuration. The id must be unused.

### Erase the caller after success

`caller_erasure: "on_success"` on such a workflow erases the caller as soon as the run succeeds:

- Budget rows and identity bindings are deleted.
- Sessions and keys are revoked.
- The user is disabled and anonymised.
- The subject is removed from its executions' caller context.
- A tombstone holding only the subject's SHA-256 refuses tokens issued before the erasure.

Request steps can address the caller's own record with `${caller.subject}` and the boundary rule `{caller_bound: true}`. The rule is also accepted on a DELETE.

### Credentials of the step's own connector

A request step of a saved workflow may read its own connector's credential as `${cred.<own-slug>.<field>}` without `connector:read`. This applies only under a live execution authority and not in a held preparation. The reference must stay inside the approved reach. Draft and step runs, held preparations and saved runs without an authority still need `connector:read` on that connector.

The actual boundary: the credential is sent only to that connector's origin and never with a redirect. SubKit also redacts the raw, URL-encoded, form-encoded and JSON-escaped forms of the value from step outputs, errors, audit and logs. This is only a best-effort aid. If an upstream reflects the value in another encoding, or stores it and returns it later, it is not covered.
