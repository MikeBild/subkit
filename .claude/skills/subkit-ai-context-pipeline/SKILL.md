---
name: subkit-ai-context-pipeline
description: Work on the AI context pipeline — Skills, Knowledge Sources, Skill Candidates, Conversations, Self-Healing, Discovery. Use when the task involves prompt assembly, LLM context, auto-proposed workflows, skill curation, knowledge ingestion, or repair loops.
---

# subkit AI Context Pipeline

> **Project context:** Before starting work, read `AGENTS.md` at the repository root.

subkit separates curated context (Skills, Knowledge Sources) from detected patterns
(Skill Candidates) from active AI loops (Conversations) from automatic repair
(Self-Healing). These are distinct subsystems — don't merge them.

## Canonical references

- `docs/16-ai-flows.md` — LLM-driven DAG authoring and tool-use loops.
- `docs/17-conversations.md` — Persistent, resumable authoring sessions (SSE + MCP).
- `docs/18-skills.md` — Curated Skills and Skill Candidates.
- `docs/19-self-healing.md` — Drift detection and bounded repair.
- `docs/35-knowledge-sources.md` — Uploaded-file KB with tsvector indexing.
- `docs/36-discovery.md` — File analysis → proposed connectors / skills / knowledge.
- `docs/02-domain-model.md` — Entity glossary for Skill, Skill Candidate, Knowledge
  Source, Conversation, Context Enhancement.

## Subsystem boundaries

| Concept | Subsystem | Authored by | Lifecycle |
|---|---|---|---|
| **Skill** (curated LLM-context record) | `apps/engine/src/skills/` | Operators, or promoted from a Skill Candidate | `draft → active → archived` |
| **Skill Candidate** (proposed from execution patterns) | `apps/engine/src/skill-candidates/` | The engine (pattern detection) | Proposed; **never auto-promoted** |
| **Knowledge Source** (tenant KB from uploaded files) | `apps/engine/src/knowledge/` | Operators upload files | `refresh: manual | scheduled | webhook` |
| **Conversation** (AI authoring loop) | `apps/engine/src/conversations/` | Users interact; engine runs the tool loop | Resumable; persisted |
| **Context Enhancement** (prompt assembly) | `apps/engine/src/llm/` | Engine at request time | Stateless; capped by per-tenant token budget |
| **Self-Healing Patch** (repair proposal) | `apps/engine/src/self-healing/` | Engine on failure | Proposed; operator approves |
| **Discovery Proposal** (file → connector/skill) | `apps/engine/src/discovery/` | Engine on upload | Proposed; operator approves |

## Prompt assembly order (from `llm/`)

Base prompt augmented with, in this order:

1. Matching **Skills** (global → connector → workflow scope).
2. Matching **Knowledge Sources** (workflow-scoped first, then global).
3. Matching **Connector documentation** (from `docs-ingestion/`).
4. Prior execution failures relevant to this step.
5. User turns (Conversation history).

The per-tenant token budget caps the final size. When budget is tight, drop lower-priority
items first (failures > knowledge > connector docs > skills).

## Human-in-the-loop rules

- **Skill Candidates are never auto-promoted.** The operator must explicitly promote
  via the approval flow. Do not add code paths that flip a Candidate to a Skill
  automatically.
- **Self-Healing writes Patch Candidates**, not live patches. The operator approves
  before the patch is applied.
- **Discovery writes proposals**, not committed Connectors / Skills.
- Every approval writes an `audit_log` entry with actor + structured diff.

## Conversation tool-use loop

Conversations expose a fixed set of structured-intent tools
(`list_skills`, `fetch_connector_docs`, `propose_step`, `validate_draft`, `commit_draft`,
etc.). When adding a tool:

1. Define Zod schema for input and output.
2. Register in the Conversation tool registry.
3. **Dry-run first.** Tools that would mutate state (`commit_draft`, `approve_patch`)
   must have an explicit approval step; don't short-circuit.
4. Audit the invocation.

## Things not to do

- Do not blur the line between Skill and Skill Candidate. Curated vs proposed is a
  core contract.
- Do not persist LLM raw responses as Skills. Skills are **curated** (hand-edited or
  operator-promoted).
- Do not write self-healing patches that apply without operator approval.
- Do not read from Knowledge Sources outside the `llm/` context assembly — raw KB
  access bypasses token budgets and tenant scoping.
- Do not call a real LLM in tests. Use the existing mock provider.
