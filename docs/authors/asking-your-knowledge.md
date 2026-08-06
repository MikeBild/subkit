# Ask your company's knowledge

> **Audience:** Anyone who wants to ask questions in chat, a browser AI client, or a
> coding agent — and trust what comes back.

**Ask a question where you already work, and the company answers from its own documents —
naming what it read, or saying plainly that the answer isn't in there.** That second half
is the point: an assistant that cannot say "I don't know" is a liability with good
grammar.

## What a grounded answer looks like

You ask, in Slack or in an MCP client:

> *"What's the per-diem cap for international travel?"*

sk searches the knowledge sources your operators uploaded, answers from the matching
passages, and closes with a footer:

```
Sources: expense-policy-2026, travel-approval-runbook
```

Every name in that footer is a real, tenant-owned source — the same references land in
the audit log, so "where did that answer come from?" stays answerable later.

## The four guarantees

| Guarantee | What it means for you |
|---|---|
| **Provenance you can check** | Grounded answers carry a `Sources:` footer. A citation that doesn't resolve to a real source of yours is dropped before you ever see it — and the footer is identical on live answers and replayed transcripts. |
| **Quotes are faithful** | Before a grounded answer stands, a deterministic check confirms every quoted span actually appears in a cited source. An answer that fails is not allowed to stand as final — you get asked instead. |
| **Honest refusal** | If the knowledge base has no answer, sk says so instead of improvising one. The same discipline applies to its own abilities: it doesn't describe tools it cannot reach from your surface. |
| **A no is respected** | Decline a proposed action and the decline sticks for identical re-proposals in that conversation — including in auto mode. |

The mechanics behind these live in
[Governance & audit → Answer provenance and honest refusal](../concepts/governance-and-audit.md#answer-provenance-and-honest-refusal).

## Where you can ask

| Door | What it feels like | Setup |
|---|---|---|
| **Slack / Teams / Google Chat** | `@sk …` in a channel or DM. Ask questions, run saved workflows. Deliberately read-and-run only — chat never rewrites a process | [Chat channels](../operators/chat.md) |
| **A browser AI client or MCP client** | Claude, ChatGPT, Claude Desktop, Cursor, … connected to your engine — the client searches your knowledge as a tool | [Author quickstart, path D](./quickstart.md#path-d--mcp-client-claude-desktop-cursor-etc) |
| **A coding agent** | Claude Code / Codex sessions open already briefed on your approved domain rules, and look your runbooks up instead of inventing them | [Use sk from a coding agent](./coding-agents.md) |
| **The `sk` CLI** | Same conversations, plus authoring — the one door where processes get *changed* | [REPL tour](./repl-tour.md) |

## What the answers are built from

Two primitives, one distinction:

- **Skills prescribe.** Dense, operator-approved rules the AI follows — your conventions,
  not a generic tutorial's.
- **Knowledge Sources inform.** Your documents — runbooks, policies, specs — chunked and
  searchable; the AI cites them, it doesn't obey them.

What ships at boot is product knowledge: sk's own reference, plus per-vendor API mechanics
for the shipped connectors. **Your business domain is what you bring** — uploading it
takes minutes ([Knowledge sources](./knowledge-sources.md)), and teaching sk a whole field
of work is one page further ([Model a domain](./model-a-domain.md)).

## Keeping it honest over time

Curation is human: the engine may *propose* new knowledge and skills from what it observes,
but nothing becomes part of the answering corpus without a person approving it. And when
grounding goes stale — a connector's schema changed under a draft — sk flags it as a
re-check advisory rather than silently answering from yesterday's world.

## Further reading

- [Knowledge & skills](../concepts/knowledge-and-skills.md) — the model behind the context: assembly order, trimming, the compounding loop.
- [Use cases → Corporate LLM](../use-cases.md#corporate-llm) — this capability in the company-wide frame.
- [Governance & audit](../concepts/governance-and-audit.md) — audit trail, secret hygiene, and the provenance mechanics.
