# Knowledge Sources

> **Audience:** Authors and operators grounding the AI in their own documents.

A Knowledge Source is a persistent, indexed document store the AI can search
while authoring, discovering, or repairing workflows. A workflow that correctly
follows your GDPR compliance runbook is possible because the runbook is a
Knowledge Source the AI can search. For the conceptual model — and how Knowledge
Sources differ from Skills — see
[Knowledge & Skills](../concepts/knowledge-and-skills.md).

---

## Adding a source

In the REPL you can just say *"add this file as a knowledge source tagged
weather, runbook"*. The scriptable form:

```bash
sk knowledge-sources create --file ./runbook.md \
  --title "Weather Runbook" --tags "weather,runbook,open-meteo"
sk knowledge-sources list
sk knowledge-sources search "open-meteo"   # semantic search; ranks by relevance
```

`--tags` you supply are authoritative (no AI auto-tagging); omit both `--tags`
and `--description` to let the engine generate them.

## Auto-analysis and self-description

When a document is uploaded interactively — from chat, an attached file, or `sk knowledge-sources create` — the AI auto-analyzes its content to generate a short description and a set of topical tags. This makes each source self-describing: the AI can list sources and decide which one covers a topic before searching, and a search can be narrowed to sources carrying a given tag.

The description is only generated when one was not supplied; tags are a deduped set that re-analysis replaces wholesale. Auto-analysis is best-effort — if it fails (for example, the tenant's model budget is exhausted) the upload still succeeds, just without enrichment. An operator can re-run analysis at any time (`sk knowledge-sources analyze <id>`, or the `analyze_knowledge_source` tool in chat). Bulk ingestion paths — crawled pages, scheduled refreshes — stay mechanical and are not auto-analyzed.

## Refresh strategies and scope

Knowledge Sources have configurable refresh strategies: manual, scheduled, or webhook-triggered. When a runbook is updated, the source can be refreshed automatically so the AI is always working from current documentation. Sources can be scoped to a tenant (available globally) or to specific workflows.

## Budgets

Per-source and per-tenant byte caps, per-message file counts, and ingestion concurrency are operator-tunable. Defaults are conservative; raise them on hardware that warrants larger corpora. The full tunable table lives in [Observability & Resource Limits → Documentation & Knowledge Tunables](../operators/observability.md#documentation--knowledge-tunables).

---

## Further reading

- [Knowledge & Skills](../concepts/knowledge-and-skills.md) — the conceptual model and context-assembly order.
- [Custom Skills](./custom-skills.md) — the dense, prescriptive counterpart to Knowledge Sources.
- [AI-assisted authoring](./authoring-workflows.md) — how Conversations draw on Knowledge Sources.
