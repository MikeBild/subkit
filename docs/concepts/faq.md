# FAQ

> **Audience:** Anyone new to sk asking the first questions — what the pieces
> are, how they differ, and where to create them.

**Outcome:** a fast path from "what even is this?" to the one page that answers
it in full. Each answer here is a pointer, not a re-explanation.

---

## What is a workflow?

A workflow is an ordered list of **steps** the engine runs deterministically —
every run is permission-checked, recorded, and replayable. You author one by
describing the outcome in plain language; the AI proposes the steps and you
approve them. Once committed, a workflow runs the same way every time. See
[Workflow Execution](./workflows.md).

## What is a Skill?

A Skill is dense, operator-authored guidance the AI **follows** while authoring,
discovering, and repairing workflows — your house conventions, integration
patterns, and security policies. Skills load by scope (global, per-connector,
per-workflow) so the right conventions are in context at the right moment. See
[Custom Skills](../authors/custom-skills.md).

## What is a Knowledge Source?

A Knowledge Source is a persistent, indexed document store the AI **searches**
for reference material — runbooks, API specs, compliance frameworks, glossaries.
The engine ingests, chunks, embeds, and searches it, injecting the passages that
match the current question. See [Knowledge Sources](../authors/knowledge-sources.md).

## How do Skills and Knowledge Sources differ?

**Skills prescribe; Knowledge Sources inform.** The AI *obeys* a Skill as a rule
and *consults* a Knowledge Source as reference — never treating the document as a
rule. A quick test: if the sentence starts with "always" or "never", it is a
Skill; if it is a document you would hand a new hire, it is a Knowledge Source.
The full comparison, scoping, and context-assembly order are in
[Knowledge & Skills](./knowledge-and-skills.md).

## How are Knowledge Sources processed?

Four stages: **ingest** (upload, attach, paste, or crawl), **chunk** (split into
searchable passages), **embed + index** (vectors plus tags and a description),
and **search** (hybrid semantic + tag retrieval into the authoring context).
Because retrieval is chunk-level, several focused documents beat one large blob.
See [How grounding works](../authors/knowledge-sources.md#how-grounding-works).

## How do I model a whole domain?

Stand up three primitives around the domain: a **Connector** (its API / system of
record), one or more **Skills** (the conventions the AI must follow), and one or
more **Knowledge Sources** (its reference documents). Together the AI authors
inside your domain — proposing against your conventions and grounding specifics
in your documents. The worked walkthrough is [Model a Domain](../authors/model-a-domain.md).

## Where do I create each?

- **Knowledge Source** — self-serve: in a Conversation, upload or paste a
  document and ask to add it; `sk knowledge-sources create --file …` for one
  file, or `sk knowledge-sources import ./team-wiki` for a whole markdown
  directory (an Obsidian vault, an agent wiki, an OKF bundle).
- **Skill** — operator-owned: author one in a Conversation, `sk skills create
  --file …`, or promote a detected **Skill Candidate**
  (`sk skill-candidates approve <id>`).
- **Workflow / Connector** — start a Conversation and describe the outcome; the
  approve-to-commit loop is covered in the [authoring quickstart](../authors/quickstart.md).

---

## Further reading

- [Knowledge & Skills](./knowledge-and-skills.md) — the conceptual model in full.
- [Model a Domain](../authors/model-a-domain.md) — the connector + skills + knowledge trio, worked end to end.
- [Concepts & Domain Model](./glossary.md) — one-place definitions of every term.
