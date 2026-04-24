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

- `docs/04-authoring.md` — AI-assisted authoring: conversations, skills, knowledge sources, discovery, multi-provider.
- `docs/06-execution.md` — Drift detection, self-healing, and bounded repair.
- `docs/02-concepts.md` — Entity glossary for Skill, Skill Candidate, Knowledge Source, Conversation.

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

Prompt context is assembled only for AI-assisted surfaces: conversations, discovery, diagnosis,
and bounded repair loops. Committed workflow execution does **not** re-enter this path.

Base prompt augmented with, in this order:

1. Runtime context block (engine URL, actor, tenant, surface).
2. Matching **Skills** (global → connector → workflow scope).
3. Explicitly loaded Skills (`load_skill`).
4. Matching **Knowledge Sources** (workflow-scoped first, then global).
5. Matching **Connector documentation** (from `docs-ingestion/`).
6. Prior execution failures relevant to this step.
7. User memory and authoring-context blocks.
8. User turns (Conversation history) as separate messages.

The per-tenant token budget caps the final size. When budget is tight, trim in this order:
failures → connector docs → knowledge → user memory → authoring context → loaded skills →
workflow skills → connector skills → global skills. User turns are not trimmed away.

## Human-in-the-loop rules

- **Skill Candidates are never auto-promoted.** The operator must explicitly promote
  via the approval flow. Do not add code paths that flip a Candidate to a Skill
  automatically.
- **Self-Healing writes Patch Candidates**, not live patches. The operator approves
  before the patch is applied.
- **Discovery writes proposals**, not committed Connectors / Skills.
- Every approval writes an `audit_log` entry with actor + structured diff.
- Knowledge Sources and Skills do not participate in deterministic workflow execution; they
  only guide authoring, diagnosis, and repair-oriented AI turns.

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
