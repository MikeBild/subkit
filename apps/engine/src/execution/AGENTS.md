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

Retry envelope: 5 attempts max, 200ms base, 30s cap, ±20% jitter.
429 with `Retry-After` overrides the schedule (cap 1h).

## `on_error` semantics

Each step declares `on_error: "fail" | "continue"` (default `"fail"`).
On `"fail"`, downstream steps are marked aborted. On `"continue"`, the
step's scope value is `undefined` and execution proceeds. There is no
third "retry indefinitely" option; the retry envelope above is the
ceiling.
