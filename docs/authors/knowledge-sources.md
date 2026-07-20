# Knowledge Sources

> **Audience:** Authors and operators grounding the AI in their own documents.

**Outcome:** workflows follow *your* runbooks and compliance docs, not generic
knowledge. A workflow that correctly honors your GDPR retention rule exists
because the runbook is a Knowledge Source the AI searched while authoring — so
compliance ships by construction, not by review after the fact.

A Knowledge Source is a persistent, indexed document store the AI can search
while authoring, discovering, or repairing workflows. For the conceptual model —
and how Knowledge Sources differ from Skills — see
[Knowledge & Skills](../concepts/knowledge-and-skills.md).

## How grounding works

```mermaid
flowchart TB
    src[Your docs<br/>runbooks, policies, specs] --> ingest[Ingest<br/>upload, crawl, scheduled refresh]
    ingest --> chunk[Chunk<br/>split into searchable passages]
    chunk --> embed[Embed and index<br/>vectors + tags]
    embed --> search[Hybrid search<br/>semantic + tag filter]
    search --> ground[Grounds authoring<br/>follows your rules, not generic knowledge]
    ground --> wf[Authored / repaired workflow]
```

| Stage | What happens |
|---|---|
| Ingest | Upload, crawl, or scheduled refresh pulls the document in. |
| Chunk | The text is split into searchable passages. |
| Embed + index | Passages become vectors; tags and descriptions are attached. |
| Hybrid search | Queries rank by semantic relevance, narrowed by tag. |
| Ground | Matched passages enter the authoring context so the workflow follows your rules. |

---

## Adding a source

In the REPL, say *"add this file as a knowledge source tagged weather, runbook"*.
The scriptable form:

```bash
sk knowledge-sources create --file ./runbook.md \
  --title "Weather Runbook" --tags "weather,runbook,open-meteo"
sk knowledge-sources list
sk knowledge-sources search "open-meteo"   # semantic search; ranks by relevance
```

| Flag | Behavior |
|---|---|
| `--tags` | Authoritative — no AI auto-tagging when you supply them. |
| `--description` | Authoritative when supplied. |
| (omit both) | The engine generates tags and a description. |

## Auto-analysis and self-description

When a document is uploaded interactively — from chat, an attached file, or
`sk knowledge-sources create` — the AI auto-analyzes its content to generate a
short description and a set of topical tags. This makes each source
self-describing: the AI can list sources and decide which one covers a topic
before searching, and a search can be narrowed to sources carrying a given tag.

| Rule | Detail |
|---|---|
| Description | Generated only when none was supplied. |
| Tags | Topical tags are a deduped set that re-analysis replaces wholesale; **namespaced tags** (a name-shaped prefix — letters/digits, Unicode included — a colon, and content directly after it: `domain:blog-de`, `café:paris`) are structural routing keys that always survive re-analysis, and re-analysis never adds new ones. Prose or punctuation colons (`note: x`, `q&a:faq`) stay topical. The `<ns>:` shape is reserved for routing, so don't use it for plain topical tags. To re-home a source (drop or change a `domain:*` tag), edit the tags explicitly (`sk knowledge-sources update` / PATCH) — explicit edits replace the tag set wholesale. |
| Embeddings | Freshly ingested or updated chunks are embedded right away (source-scoped, off the request path); semantic ranking works within seconds of an update, no manual step needed. |
| Failure mode | Best-effort — if it fails (e.g. model budget exhausted) the upload still succeeds, just without enrichment. |
| Re-run | `sk knowledge-sources analyze <id>`, or the `analyze_knowledge_source` tool in chat. |
| Bulk paths | Crawled pages and scheduled refreshes stay mechanical — not auto-analyzed. |

## Importing a whole directory (knowledge bundles)

A team wiki rarely lives in one file. `import` turns a directory of markdown
files — an Obsidian vault, an agent-maintained wiki, a Notion export, or an
[OKF](https://okf.md/) bundle — into **one** knowledge source with one
searchable passage per file:

```bash
sk knowledge-sources import ./team-wiki --tags "runbooks"
```

In the REPL the same import is `/knowledge import ./team-wiki` — ask a question
right after and the answer grounds on your wiki.

> **Importing for a coding agent?** Tag the source with the domain, or a Claude
> Code / Codex session will never see it: `sk knowledge-sources import ./team-wiki
> --tags "domain:<slug>"`. The session briefing indexes exactly the sources
> carrying its `domain:` tag — see [Use sk from a coding agent](./coding-agents.md).

| Behavior | Detail |
|---|---|
| Upsert by slug | Re-running the import is idempotent: unchanged content reports `unchanged`, changed content re-ingests in place. Perfect for a CI job that keeps sk in sync with a git wiki. |
| Frontmatter | Read tolerantly, never rejected. `type: Runbook` becomes a structural `type:runbook` tag (filterable in search); a `tags:` list merges into the source's topical tags. Files without frontmatter import fine. |
| Reserved files | `index.md` and `log.md` (navigation/history in OKF bundles) are skipped at any depth. |
| Reading it back | `read_knowledge` (chat/MCP tool) pages through the full content — e.g. *"read me the deploy runbook"* after a search hit; `GET /v1/knowledge-sources/{id}/chunks` is the raw HTTP form. Nothing is locked in. |

Pairing with a knowledge-engineering system that exports OKF bundles: schedule
a workflow that pulls the exported bundle and posts it to
`POST /v1/knowledge-sources/bundle` — curated knowledge lands in sk as governed
grounding: every read is RBAC-gated (`knowledge:read`), and every import that
writes anything is audited (an unchanged re-import is a deliberate no-op).

## Refresh strategies and scope

Knowledge Sources have configurable refresh strategies, so the AI always works
from current documentation. When a runbook is updated, the source refreshes and
the next workflow follows the new rule.

| Axis | Options |
|---|---|
| Refresh | Manual or scheduled. |
| Scope | Tenant-wide (available globally) or pinned to specific workflows. |

## Budgets

Per-source and per-tenant byte caps, per-message file counts, and ingestion
concurrency are operator-tunable. Defaults are conservative; raise them on
hardware that warrants larger corpora. The full tunable table lives in
[Observability & Resource Limits → Documentation & Knowledge Tunables](../operators/observability.md#documentation--knowledge-tunables).

---

## Further reading

- [Use sk from a coding agent](./coding-agents.md) — grounding a coding agent in these sources: the `domain:` tag, the briefing, and the review loop.
- [Knowledge & Skills](../concepts/knowledge-and-skills.md) — the conceptual model and context-assembly order.
- [Model a Domain](./model-a-domain.md) — a Knowledge Source and a Skill configured side by side for one domain, worked end to end.
- [Custom Skills](./custom-skills.md) — the dense, prescriptive counterpart to Knowledge Sources.
- [AI-assisted authoring](./authoring-workflows.md) — how Conversations draw on Knowledge Sources.
