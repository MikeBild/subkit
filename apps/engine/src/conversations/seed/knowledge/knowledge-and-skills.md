---
slug: sk-ref-knowledge-and-skills
name: sk Platform Reference — Knowledge Sources & Skills
description: How Skills and Knowledge Sources differ, when to use which, how the engine processes and searches knowledge, and how to model a whole business domain with a connector plus skills plus knowledge sources.
tags: [sk-platform-reference, skills, knowledge-sources, domain-modeling, concepts]
scope: global
version: 3
---

# Knowledge Sources & Skills

sk carries organization-specific context in two primitives. They look similar
from the outside — both feed the AI while it authors, discovers, and repairs
workflows — but they play opposite roles.

| Primitive | What it is | Role |
|---|---|---|
| **Skill** | Dense, operator-authored guidance | Prescriptive rules the AI **follows** |
| **Knowledge Source** | Broad organizational documents | Searchable grounding the AI **consults** |

The one-line mnemonic: **Skills prescribe; Knowledge Sources inform.** The AI
treats a Skill as instructions to obey and a Knowledge Source as reference
material to look things up in — never as a rule.

Both improve *authoring and repair* quality only. Once a workflow is committed,
its runtime path is deterministic and queries neither.

## When to use which

| Use a **Skill** when | Use a **Knowledge Source** when |
|---|---|
| The guidance is prescriptive — "always validate X", "never call Y" | The content is reference material to draw from |
| It fits in a tight, single-purpose page | It is document-scale (a runbook, a spec, a policy PDF) |
| You want it *followed*, not just consulted | You want it *available for lookup* |
| It encodes house conventions, security policy, integration patterns | It encodes facts, tables, glossaries, API specs |

A good test: if the sentence starts with "always" or "never", it is a Skill. If
it is a document you would hand a new hire to read, it is a Knowledge Source.

## How a Knowledge Source is processed

Knowledge Sources are ingested, chunked, indexed, and searched:

1. **Ingest** — a file upload, an attached document, an inline paste, or a
   scheduled crawl pulls the document in (Markdown, text, JSON/YAML/CSV, PDF,
   DOCX, XLSX, PPTX).
2. **Chunk** — the text is split into searchable passages.
3. **Embed + index** — passages become vectors; a short description and topical
   tags are attached (auto-generated when the operator omits them).
4. **Search** — hybrid retrieval ranks passages by semantic relevance, narrowed
   by tag, and injects the matches into the authoring context.

Because retrieval is chunk-level, granularity matters: several focused documents
beat one giant blob. A tenant that splits "chord voicings", "harmonic
functions", and "cadence rules" into separate sources gets sharper matches than
one 50 KB "everything about music" file — the AI receives only the passages that
bear on the current question, and the context budget is spent well.

## How Skills reach the AI

A Skill activates by **scope**:

- **Global** — considered on every Conversation.
- **Per-connector** — loads when that connector is referenced (touch the Stripe
  connector and the Stripe Skill loads).
- **Per-workflow** — loads while authoring or repairing that workflow.

Skills are never auto-generated or auto-promoted. The engine detects recurring,
successful patterns and surfaces them as **Skill Candidates**; a candidate
becomes an active Skill only through explicit operator promotion. The engine
learns what works; humans decide what becomes canonical.

## Modeling a business domain

The two primitives are strongest together. To teach sk a whole domain — an
expense policy, a contract-review process, a compliance framework — stand up
three things around it:

- **Connector** — the domain's system of record or API (the docs/OpenAPI source
  the AI grounds requests against).
- **Skill** — the house conventions the AI must obey when working the domain:
  required validations, error handling, tone, approval gates. *Prescribes.*
- **Knowledge Source** — the domain's reference documents: the policy PDF, the
  runbook, the glossary, the rate tables. *Informs.*

The combined effect: when someone authors a workflow in that domain, the AI
proposes against your conventions (from the Skill) and grounds specifics in your
documents (from the Knowledge Source) — instead of falling back on generic
knowledge. Compliance ships by construction, not by review after the fact.

The shape is domain-agnostic. The same three primitives model an expense policy,
tax law, a product catalog, or music theory — a `music-theory-authoring` Skill
for the conventions plus `harmonic-functions`, `chord-voicings`, and a glossary
as Knowledge Sources.

## Coding-agent sessions: briefing in, learnings back

Domains connect Skills and Knowledge Sources to external coding agents
(Claude Code, Codex). A domain is the tag `domain:<slug>` on both primitives;
a repo declares which domains it works in via `.sk/agent.json` (written by
`sk agent init`).

- **In:** every new session gets a budgeted briefing (`GET /v1/agent/briefing`)
  carrying the domain's active Skills verbatim and an INDEX of its Knowledge
  Sources — details stay behind `search_knowledge_v2` so sessions look up
  instead of preloading. `sk skills sync` additionally materializes the Skills
  as SKILL.md files for offline use.
- **Back:** session transcripts (`POST /v1/agent/sessions`, wired by the
  SessionEnd hook) and explicit `save_learning` calls produce
  `session_learning` Skill Candidates. They coexist in the review queue,
  dedup by normalized title + domains, and become active domain-tagged Skills
  only through `sk learnings review` — the same human gate every other
  candidate passes.

## Creating each

- **Knowledge Source** — self-serve. In a Conversation, upload or paste the
  document and ask to add it as a Knowledge Source (tag it while you are there).
  Scriptable: `sk knowledge-sources create --file ./runbook.md --tags "..."`, or
  `POST /v1/knowledge-sources`.
- **Knowledge bundle (whole directory)** — import a markdown directory
  (Obsidian vault, agent wiki, OKF bundle) as ONE source with one passage per
  file: `sk knowledge-sources import ./team-wiki` or `/knowledge import
  ./team-wiki` in the REPL (`POST /v1/knowledge-sources/bundle`). Upsert by
  slug — re-imports of unchanged content are no-ops. Frontmatter is read
  tolerantly: `type: Runbook` becomes a filterable `type:runbook` tag; files
  without frontmatter import fine; `index.md`/`log.md` are skipped.

- **Skill** — operator-owned. Author one in a Conversation, from the CLI
  (`sk skills create --file ./skill.json`, a SkillDef JSON), or promote a
  detected Skill Candidate (`sk skill-candidates approve <id>`). Skills are not
  created silently — a human always confirms what becomes canonical guidance.

## Reading knowledge back

`search_knowledge_v2` returns ranked snippets. When a snippet is not enough
("read me the deploy runbook"), `read_knowledge` pages through a source's FULL
content — pass `path` (e.g. `/runbooks/deploy.md`) for one file of a bundle, or
repeat with `next_offset` for everything. Raw HTTP:
`GET /v1/knowledge-sources/{id}/chunks`. Both are RBAC-gated by
`knowledge:read`.
