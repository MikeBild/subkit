# execution — runtime contracts

This subsystem runs workflow steps. Two contracts live here that consumers
depend on but aren't obvious from the code alone.

## Expression language: JSONata

Every author-written expression — `transform.expression`, `branch.when`,
`loop.over`, request-step `data_selector`, workflow-level
`output_transform` / `validation_expression`, request-string `${...}`
placeholders inside drivers — is JSONata. Subkit ships a single thin
wrapper at `jsonata-engine.ts` that compile-caches expressions, formats
parse errors with line/column/caret, and exposes static-analysis hooks
(`parseDeps`, `extractAst`).

**Rule:** never `import jsonata from "jsonata"` directly. Route every
new call site through `jsonata-engine.ts`. The CI grep gate enforces
this; the only legitimate exceptions are the wrapper itself and any
file that imports a JSONata *type* (e.g. `Expression`) without calling
the runtime.

**Bindings shape**, available in every author expression:

| Binding | Source | Notes |
|---|---|---|
| `$input` | workflow input | Top-level invocation payload. |
| `$caller` | authenticated execution caller | Immutable tenant, principal, kind, provider, and optional product identity; null for trusted system runs without a principal. Persisted at admission and reused by queue, resume, and child workflows. |
| `$scope.<id>` | step outputs | The full per-step envelope record. |
| `$steps.<id>` | alias of `$scope` | Retained for skill-doc symmetry. |
| `$cred.<slug>.<key>` | resolved credentials | RBAC-gated; pre-resolved. |
| `$connector.<slug>.<key>` | connector config | RBAC-gated; pre-resolved. |
| `$env.<KEY>` | allow-listed env | Subset chosen at boot. |
| `$loop_index` | inside `loop` body | 0-based index. |
| `$loop_item` | inside `loop` body | Current iteration value. |

Bare path expressions (without `$`) walk the second arg of
`expr.evaluate(data, bindings)` — e.g. `step1.data` works because
`step1` is a key on the scope object passed as data. Authors should
prefer `$scope.step1.data` for clarity; both forms are supported.

Request placeholders use `${caller.tenantId}`, `${caller.principalId}`, `${caller.principalKind}`, `${caller.provider}`, `${caller.productId}` and `${caller.subject}`. They resolve from the same persisted caller, never from `$input`. `subject` is present only for a product principal verified by an `oidc_bearer` provider: it is the issuer's `sub` of the token proven at admission, and caller erasure overwrites it with `null`. A request boundary may bind `caller.subject` or `caller.principalId` with `{caller_bound: true}`; that rule also admits a DELETE because the value is fixed by the authenticated caller. A workflow with `product_id` requires a matching product-bound principal before execution. Product S3 steps must declare a principal-bound scope rooted at `products/<product_id>/`; the next object-key segment is the authenticated principal ID.

## No-rollback / no-compensation contract

Subkit is **not transactional** at the workflow level. When a step
fails:

- Downstream steps are aborted.
- Previously committed external side effects (HTTP POSTs, SQL writes,
  S3 uploads) are **not unwound**. Subkit has no compensating-action
  framework.
- The execution row records the failure; `outcome-tracker.ts` keeps
  the per-step side-effect ledger for forensic use.

Operators relying on transactional semantics must encode compensating
actions as explicit subsequent steps (e.g. a "rollback" step that runs
on `on_error: continue`) or rely on the upstream API's idempotency
keys for replay-safe retry.

## Per-step retry policy

Idempotency rule (driver-enforced):

- `GET` / `HEAD` / `OPTIONS`: retry on 5xx, 429, connection errors.
- `POST` / `PUT` / `PATCH` / `DELETE`: retry only on 429 and connection
  errors. Servers are responsible for honoring `Idempotency-Key`.
- A POST explicitly classified with `side_effects: "read"` is retry-safe on
  5xx, which covers read-only search APIs. PUT, PATCH, DELETE and S3 mutations
  cannot be downgraded to reads.

Retry envelope: 5 attempts max, 200ms base, 30s cap, ±20% jitter.
429 with `Retry-After` overrides the schedule (cap 1h).

## `on_error` semantics

Each step declares `on_error: "fail" | "continue"` (default `"fail"`).
On `"fail"`, downstream steps are marked aborted. On `"continue"`, the
step's scope value is `undefined` and execution proceeds. There is no
third "retry indefinitely" option; the retry envelope above is the
ceiling.

## Caller guards

A sensitive product workflow with `required_caller_kind: "user"` may declare
`execution_guards` and `caller_erasure`. Both are part of the reviewed effect
manifest; changing them asks for a new approval.

- `execution_guards.input_bytes` maps `$input` dot paths to a maximum UTF-8
  size: a string counts its own bytes, any other value the bytes of its JSON
  text. Admission refuses a larger part with `invalid` before anything is
  reserved.
- `execution_guards.caller_daily_limit` reserves one unit per caller and local
  day in `caller_budget_units` inside the admission transaction, after the
  idempotency replay check, under a per-caller advisory lock. `unit` is an
  `$input` dot path. A reserved or committed unit is reused by later calls
  without a charge; a unit with a queued or running execution whose cancel was
  not requested refuses `turn_busy`; `max_metered` refuses `turn_limit`; a
  full day refuses `rate_limited` with `usage`.
- Every request a step listed in `billable_steps` sends marks the unit
  billable and adds 1 to `metered` in its own committed transaction, after the
  execution authority check and before the request leaves. A success of such a
  step adds what `meter` (JSONata over the step output, default 1) exceeds the
  sent requests; a step without requests therefore still counts `meter`.
- `finalizeExecution` settles in its own transaction: success commits when
  `commit_when` (JSONata over the run output) is true and otherwise extends the
  lease; failure refunds only a unit that is not billable and has no other
  queued or running execution. Expired leases settle lazily: billable units
  commit, the rest are refunded. On success `{usedToday, dailyLimit}` is merged
  into the sensitive result under `attach_usage_as`.
- `caller_erasure: "on_success"` erases the product caller in the same
  transaction: budget rows and identity bindings are deleted, sessions and keys
  revoked, the user disabled and anonymised, `caller_context.subject` nulled on
  its executions, and a tombstone with only the SHA-256 of the subject is kept
  so tokens issued before the erasure are refused.

## Own-connector credentials

- `dispatch.ts` passes `own_connector` to the placeholder resolver only when
  the step context carries `own_connector_credentials` and is not holding
  writes. The engine sets it for a saved, non-held run whose execution (or its
  authority root) has an `execution_authority_id`; `before_external_request`
  then checks that the authority is live and that every referenced credential
  is inside its boundary before anything is sent.
- Draft and step runs, held preparations and saved runs without an authority
  resolve `${cred.…}` only with `connector:read`.
- The boundary is the authority, the connector origin and the refused redirect.
  `redactOwnCredentials` is a best-effort aid for the raw, URL-, form- and
  JSON-escaped forms; never rely on it to keep a value out of a response.
