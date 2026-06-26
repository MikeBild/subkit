---
name: subkit-observability
description: Add or change metrics, traces, structured logs, drift detection, or token-budget accounting in subkit. Use whenever the task touches apps/engine/src/observability/ or apps/engine/src/logging/, or whenever you need to emit a signal the operator will read at runtime.
---

# subkit Observability

> **Project context:** Before starting work, read `AGENTS.md` at the repository root.

subkit exposes three observability surfaces: Prometheus metrics, structured JSON
logs, and per-request traces. Drift detection and token-budget accounting are
first-class signals layered on top of these.

## Canonical references

- `docs/operations.md` — Metrics catalog, tracing model, log field conventions, resource limits.
- `docs/execution.md` — Drift signals fed by observability.
- `docs/security-governance.md` — Redaction rules (never log secrets or raw credentials).

## Subsystem boundaries

| What | Where | Notes |
|---|---|---|
| Prometheus metrics | `apps/engine/src/observability/` | Counters, gauges, histograms. Exposed at `/metrics`. |
| Structured logger | `apps/engine/src/logging/` | JSON lines. Context-aware (tenant, request, actor, run). |
| Per-request tracing | `apps/engine/src/observability/` + `logging/` context | trace_id, span_id propagated through `async_hooks`-like context. |
| Drift signals | `apps/engine/src/self-healing/`, `schema-versions/` | Computed from execution failures vs. last known schema. |
| Token-budget accounting | `apps/engine/src/llm/` | Per-tenant budget; metric + structured log on overrun. |
| Audit log | `apps/engine/src/audit/` | **Immutable** — distinct from observability. See RBAC skill. |

## Rules

- **Use the structured logger. No `console.*` in engine/CLI/agent/sk code.** The
  logger in `logging/` enriches every entry with `tenant_id`, `actor_id`, `request_id`,
  and module tag.
- **Log levels:** `trace | debug | info | warn | error`. `warn` is operator-attention;
  `error` is a failure mode. Don't cry wolf.
- **Log fields are nouns, not sentences.** `{ action: "workflow.commit", workflow_id }`
  is useful; `"committed workflow abc-123"` is grep-only.
- **Redact secrets.** The logger calls `crypto/redaction.ts` on known-sensitive fields.
  If you add a new sensitive field, extend redaction — don't rely on reviewers
  remembering.
- **Metrics are per-tenant-labeled when tenant-scoped.** Cardinality matters; don't
  label by `user_id` or free-form strings.
- **Traces span the full request,** from auth → route → execution → connector call →
  sandbox → response. If your change adds a new processing boundary, add a span.

## Adding a metric

1. Name it following the naming convention (`subkit_<subsystem>_<metric>_<unit>`). See `docs/operations.md`.
2. Pick the right kind: counter (monotonic), gauge (current value), histogram (distribution).
3. Labels: use low-cardinality labels (subsystem, tenant_id, outcome). Avoid user_id,
   workflow_id, request_id.
4. Register in `apps/engine/src/observability/`.
5. Unit test the emission in the owning subsystem (assert counter incremented, etc.).

## Adding a structured log field

1. If the field is broadly useful (tenant_id, run_id, request_source), add to the
   logger context type in `logging/context.ts`.
2. If it's subsystem-local, pass it via the structured call: `logger.info({ ...,
   my_field })`.
3. If it could ever contain a secret, add it to redaction.

## Drift detection

- Drift = runtime response diverges from the last known Schema Version for a
  Connector endpoint.
- Live in `self-healing/` + `schema-versions/`.
- Emits: metric (drift counter per connector+endpoint), structured log (detailed
  diff), trigger for bounded repair loop.
- When adding a new drift signal, wire all three emissions — don't add metric-only
  or log-only.

## Token-budget accounting

- Per-tenant budget, enforced at `llm/` context assembly.
- Overrun → lower-priority context items dropped in order (failures > knowledge >
  connector docs > skills) until the budget fits.
- Emit: metric (overrun counter + histogram of drop count), structured log, and a
  warning-level operator signal.
- Never silently over-spend the budget.

## Things not to do

- **No `console.log`/`.warn`/`.error` in engine/CLI/agent/sk code.**
- **No high-cardinality metric labels** (user_id, workflow_id, request_id, URL).
- **No logging of plaintext secrets.** Use redaction.
- **No ad-hoc metric naming.** Follow the catalog.
- **No metrics without corresponding operator docs.** If you add a new counter, tell
  the operator what threshold matters.
