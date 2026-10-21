---
slug: product-bearer-tokens-and-caller-budgets
summary: Let an app call SubKit with its own sign-in and limit each caller's usage.
section: operate
order: 6
audience: operator
---
## Product bearer tokens and caller budgets

A native app can call SubKit with its own sign-in instead of a SubKit key. Add an `oidc_bearer` provider and a `products` entry through runtime configuration. Hosts below are placeholders. `audience` and `required_claims` have no defaults; the operator states both for the issuer in use (see "Onboard an app" for the complete checklist). `reject_anonymous` refuses tokens whose `is_anonymous` claim is true.

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

The app sends `Authorization: Bearer <access token>`. SubKit reads only that header, never a `token` query parameter. A token is claimed only when it is a compact JWS whose `iss` equals a configured `issuer_url`; SubKit keys, portal tokens, MCP tokens and exchanged tokens are never claimed. SubKit verifies the signature against the issuer's JWKS (from `jwks_uri` or the issuer's OIDC discovery, cached per provider and refetched once for an unknown key), the audience, the algorithm list, `exp`, `iat`, a UUID `sub` and every `required_claims` entry (`path` is a dot path into the verified payload). Anonymous subjects are refused when `reject_anonymous` is true. A claimed token that fails any check answers `401 {"code":"unauthorized","error":"unauthorized","message":"invalid bearer token"}`; no other provider, cookie or key is tried for that request.

The first verified token of a subject provisions a product user with the built-in member role, a placeholder address and an identity binding to the provider, issuer and product; addresses are never linked. The product ceiling then limits the principal to `workflow:run`, `execution:read` and `execution:abort` on saved workflows with the same `product_id` and on its own executions. Product principals have no MCP surface: `/mcp` answers `403 product_caller_forbidden`, and the tool dispatcher refuses every tool outside those three permissions with `policy_denied`. `oidc_bearer` providers never issue API keys or browser sessions and are not listed for browser login. Runs of a product principal always use the product's `execution_environment`; an `x-subkit-environment` header is ignored for them. A run of a product principal verified by an `oidc_bearer` provider is always live: without a live execution authority, an active version or a usable prepared credential it answers 403 with the refusal code instead of running as a held preparation, and `hold_writes: true` answers `403 product_preparation_forbidden`.

A sensitive product workflow with `required_caller_kind: "user"` may declare `execution_guards.caller_daily_limit` (`bucket`, `limit`, IANA `tz`, `$input` path `unit`, `lease_ms`, `billable_steps`, optional JSONata `meter`, `max_metered`, JSONata `commit_when` over the run output, `attach_usage_as`) and `execution_guards.input_bytes` (maximum UTF-8 bytes per `$input` path; a string counts itself, other values their JSON text). Admission checks the sizes and then reserves one unit per caller and local day in the same transaction that creates the execution, after the idempotency replay check; a replay never charges. Later calls of a reserved or committed unit are free until `max_metered` calls were used. A unit runs one call at a time; a call whose cancel was requested no longer counts as running. Refusals carry no execution:

- `429 {"error":"rate-limited","code":"rate_limited","message":"…","usage":{"usedToday":50,"dailyLimit":50}}` when the day is used up,
- `409 {"error":"turn-busy","code":"turn_busy"}` while another run of the unit is queued or running; that run continues, and the same request with the same `idempotency_key` replays it (`idempotent_replay: true`, 202 while it runs) instead of reserving again,
- `429 {"error":"turn-limit","code":"turn_limit"}` once `max_metered` calls were used (every request a billable step sends counts when it is sent),
- `400 {"error":"invalid","code":"invalid"}` for an input part above its byte limit.

When a run ends, a success commits the unit if `commit_when` is true and otherwise keeps it reserved for the next call; a billable step's request marks the unit billable as soon as it is sent, after the execution authority check, so a failure, abort or timeout after that point stays charged; a failed, aborted or timed-out run refunds the unit only when no billable request was sent, no billable step succeeded and no other run of the unit is active. Reservations whose lease expires settle on the next read: billable units commit, others are refunded. A successful run's sensitive result carries `usage: {usedToday, dailyLimit}`. `GET /v1/budget` answers `{usedToday, dailyLimit, day, resetsAt}` for the product's assistant workflow, and `GET /v1/health` answers `{ok, version, model, key}`, where `ok` needs the active workflow, a live execution authority for the product environment and a usable credential on every connector it uses; no secret is read. Both answer 404 to principals without a product. `POST /v1/executions` with a `workflow_id` and no `source` runs that saved workflow, so a product client sends only `{workflow_id, idempotency_key, async, input}`. `GET /v1/executions/{id}` also returns `execution_id` and `error: {code}` for failed or timed-out runs.

`caller_erasure: "on_success"` on such a workflow erases the caller when the run succeeds: budget rows and identity bindings are deleted, sessions and keys revoked, the user disabled and anonymised, the subject removed from its executions' caller context, and a tombstone with only the subject's SHA-256 refuses tokens issued before the erasure. Request steps can address the caller's own record with `${caller.subject}` and the boundary rule `{caller_bound: true}`, which is also accepted on a DELETE. An admin may create a workflow under a fixed `id` so an app can address it without configuration; the id must be unused.

A request step of a saved workflow that runs under a live execution authority, and is not a held preparation, can read its own connector's credential as `${cred.<own-slug>.<field>}` without `connector:read`; the reference must stay inside the approved authority. Draft and step runs, held preparations and saved runs without an authority still need `connector:read` on that connector. The credential is sent only to that connector's origin and never with a redirect. That is the boundary. SubKit also redacts the raw, URL-encoded, form-encoded and JSON-escaped forms of the value from step outputs, errors, audit and logs, but this redaction is a best-effort aid: an upstream that reflects the value in another encoding, or stores it and returns it later, is not covered.

