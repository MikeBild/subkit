# Self-Healing in Operations

> **Audience:** SREs, platform engineers, operators running sk in production

**Outcome: workflows survive upstream API changes without silent failure.** When an external API renames a field, moves an endpoint, or adds a required parameter, the engine detects the break during real execution and hands the operator a validated, ready-to-apply repair — instead of a 3am pager and a from-scratch diagnosis.

## Why it matters

External APIs evolve constantly. Without detection, a workflow that worked yesterday fails today — silently or noisily — and the operator owns the cleanup. Self-healing turns that open-ended incident into a single review-and-apply decision.

| Without self-healing | With self-healing |
|---|---|
| Drift surfaces as a mystery failure | Drift surfaces as a structured diff |
| Operator reverse-engineers the change | Engine classifies the change as safe / unsafe |
| Fix is hand-written and untested | Fix is dry-run against recorded history |
| Separate health-check jobs needed | Detected during real work, when it matters |

## The bounded repair loop

Drift is caught during normal execution — no separate health check, no manual test run. The operator stays in control: nothing is applied without a decision.

```mermaid
flowchart LR
    A[Workflow execution] --> B{Step result<br/>as expected?}
    B -->|Yes| Z[Recorded run]
    B -->|No| C[Drift detected]
    C --> D[Patch Candidate<br/>structured diff]
    D --> E[Dry-run against<br/>recorded history]
    E --> F[Classify<br/>safe / unsafe]
    F --> G[Operator review]
    G -->|Approve| H[Apply repair]
    G -->|Reject| I[Discard / escalate]
    H --> A
```

## Stages

| Stage | What happens |
|---|---|
| **Execution** | A connector step runs as part of a real workflow. |
| **Drift detect** | The engine spots a discrepancy in the response shape, status, or contract. |
| **Patch Candidate** | A proposed repair is generated with a structured diff of exactly what changed. |
| **Dry-run** | The candidate is validated against recorded execution history before it is offered. |
| **Classify** | The repair is marked safe or unsafe based on the scope of the change. |
| **Operator review** | The operator approves or rejects — one action, not a manual rebuild. |
| **Apply** | On approval, the repair updates the connector and the loop closes. |

## Operator guarantees

- **No silent failure.** Drift becomes a visible, structured signal.
- **No auto-apply.** The operator always decides; sk only proposes.
- **Validated before offered.** Every Patch Candidate is dry-run against real history.
- **Caught early.** Leading-indicator risk signals flag a degrading connector boundary before it fails wholesale — see [Observability](./observability.md).

---

## Further reading

- [Observability & resource limits](./observability.md) — the metrics and risk signals that flag drift early.
- [Workflows](../concepts/workflows.md) — the execution model and the self-healing repair loop (Run → Drift → Patch Candidate → Skill Candidate) in full.
