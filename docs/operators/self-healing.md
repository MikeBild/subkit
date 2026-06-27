# Self-Healing in Operations

> **Audience:** SREs, platform engineers, operators running sk in production

From an operational perspective, self-healing is how sk stays healthy as the external world changes.

External APIs evolve. Fields are renamed. Endpoints move. Error codes change. New required parameters appear. Without a mechanism to detect and respond to these changes, workflows that were working yesterday fail silently or noisily today — and the operator has to diagnose and repair them manually.

When a Connector's external API changes in a way that causes Step failures, the engine detects the discrepancy during normal execution. It does not require a separate health check job or a manual test run. Drift is detected when it matters: when a workflow is trying to do real work and something unexpected comes back.

The operator receives a **Patch Candidate**: a proposed repair with a structured diff showing exactly what changed, a classification of the repair as safe or unsafe based on the scope of the change, and dry-run results validated against recorded execution history. Reviewing and applying the patch is a single operator action.

Self-healing does not apply repairs automatically. The operator decides. But the operator is presented with a ready-to-apply, validated proposal rather than a raw failure to diagnose from scratch. The operational burden of maintaining integrations in a changing API landscape is substantially reduced.

The leading-indicator risk signals that surface a degrading connector boundary before it fails wholesale are described in [Observability](./observability.md). The conceptual model of the repair loop — Run → Drift → Patch Candidate → Skill Candidate — lives in the [workflows concept doc](../concepts/workflows.md).

---

## Further reading

- [Observability & resource limits](./observability.md) — the metrics and risk signals that flag drift early.
- [Workflows](../concepts/workflows.md) — the execution model and the self-healing repair loop in full.
