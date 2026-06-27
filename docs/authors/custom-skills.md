# Custom Skills

> **Audience:** Authors and operators encoding organization-specific guidance for
> the AI.

A Skill is a curated, reusable piece of context loaded into the AI's context
window during a Conversation and other AI-assisted authoring flows (discovery,
diagnosis, bounded repair). Skills encode best practices, integration patterns,
security policies, and the domain knowledge that makes the AI propose *your*
conventions, not generic ones. For how Skills sit alongside Knowledge Sources and
how the engine assembles them into each turn, see
[Knowledge & Skills](../concepts/knowledge-and-skills.md).

---

## Authoring and scoping a Skill

Operators create and manage Skills. They can be scoped:

- **globally** — available in all Conversations,
- **per-Connector** — loaded automatically when that Connector is referenced (the Stripe Skill loads when the AI touches your Stripe connector),
- **per-Workflow** — loaded when authoring or repairing that workflow.

In chat you can author a Skill conversationally (`create_skill` / `update_skill`),
or manage them from the CLI:

```bash
sk skills list
sk skills create --title "Stripe conventions" --scope connector:stripe --file ./stripe-skill.md
```

A Skill is dense, prescriptive guidance the AI should follow — keep each one tight and single-purpose. Broader, document-scale context belongs in a [Knowledge Source](./knowledge-sources.md) instead.

## Skill Candidates: learning from what works

Skills are not auto-generated and not auto-promoted. The platform detects recurring patterns from execution history — Connectors or step sequences that are used together frequently and tend to succeed — and surfaces them as **Skill Candidates** for operator review. Each candidate carries a confidence score and links to the executions that support it.

A candidate becomes an active Skill only through explicit operator promotion:

```bash
sk skill-candidates list
sk skill-candidates promote <id>
```

The system learns from what works, but humans decide what becomes canonical guidance.

## The sk-Stdlib the AI proposes

JavaScript that authors write — transform steps with `language: "javascript"`, before-request hooks — runs inside a QuickJS-WASM sandbox with zero host globals. Every sandbox context ships a frozen, versioned, deterministic `sk` standard library (HTTP-method classification, null-safe access, allow/deny builders, array reshapers, type guards). The conversational authoring layer is aware of the stdlib and proposes `sk.*` forms by default — `sk.http.isMutating(method)`, `sk.deny("reason")`, `sk.get(input, "request.method", "")` — which shortens code review and keeps policy uniform across tenants. Nothing in the stdlib touches the host, so dry-runs and self-healing stay reproducible.

---

## Further reading

- [Knowledge & Skills](../concepts/knowledge-and-skills.md) — the conceptual model, context-assembly order, and the compounding loop.
- [Knowledge Sources](./knowledge-sources.md) — the broad-context counterpart.
- [AI-assisted authoring](./authoring-workflows.md) — how Conversations load and use Skills.
