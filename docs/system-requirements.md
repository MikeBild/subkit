# System Requirements for Organisational Agentic Operationalisation

> *This is Document B of three. It derives the system requirements that follow from
> the thesis ([`thesis.md`](./thesis.md)). For a concrete realisation, see Document C
> ([`positioning.md`](./positioning.md)).*

---

## Purpose

This document is **vendor- and product-agnostic**. A reader can in principle use it to
evaluate any candidate system — including a custom build assembled from existing
components — against the same standard. Every requirement traces back to a specific
section of the thesis, and forward to the section of the positioning document that
describes how sk satisfies it.

The market term used throughout for this category is **operational AI execution layer**;
the theory term is *organisational agentic operationalisation*. Both are kept; neither
is mixed inside a single sentence.

---

## Recap

> **Idea 1 — The Problem.** Agentic productivity does not automatically scale
> organisationally.

> **Idea 2 — The Category.** The bottleneck is not intelligence; it is operationalisation.

> **Idea 3 — The Moat.** The moat emerges from organisational context accumulation —
> not from any single feature.

> ***Central axiom: the operating model improves because the organisation learns — and
> that is the part the organisation can actually control.***

For the full argument behind these ideas, see [`thesis.md`](./thesis.md).

![Diagram 2 — Three Integrated Layers vs. Five-Tool Build](./diagrams/02-three-layers.svg)

*Diagram 2. Three integrated layers — contextualised AI authoring, operational
governance, versioned reproducible execution — as a single product, contrasted with a
chain of five separate tools whose seams leak audit, identity, and context. The
requirements below describe what each band must provide and where the seams must
disappear.*

---

## R1 — A shared operational execution layer

Local per-team substrates do not aggregate. Operational learning, audit, and
context accumulation only emerge when operational experience becomes visible inside one
shared execution and review system.

A candidate system must therefore provide *one* governance, audit, and version space —
not a federation of per-team installations. Four properties enforce this: visibility
across teams, inheritability of skills, reuse of workflows, and audit at the
organisation level.

*Derives from* [`thesis.md`](./thesis.md) §7 (Why a Shared System?).
*Realised in sk:* see [`positioning.md`](./positioning.md) §1 (scope decision) and §2
(The Core).

---

## R2 — Context as a first-class input to authoring

When a model takes over the translation intent → spec, tenant-specific knowledge becomes
infrastructure rather than documentation. The system must therefore accept and
*accumulate* organisation-curated context as a first-class input to every authoring
action.

Five context sources are required:

- **Skills** — operator-approved best practices, integration patterns, and failure modes.
- **Knowledge sources** — runbooks, policies, architecture documents; chunked and
  searchable per tenant.
- **Integration recipes** — pre-authored, governed integrations against external systems.
- **Prior workflows** — existing, versioned workflows as reference cases the next
  authoring run can clone or extend.
- **Operational feedback** — drift and repair signals from real production runs flowing
  back into authoring (see also R5).

*Derives from* [`thesis.md`](./thesis.md) §5.2.
*Realised in sk:* [`positioning.md`](./positioning.md) §2 (the five context sources).

---

## R3 — Separation of authoring (probabilistic) from execution (controlled)

No runtime inference may decide control flow. The authoring phase may be probabilistic;
the execution phase must be policy-bound, version-bound, and reproducibly orchestrated.
Step outputs may legitimately vary (external systems return different data; humans pause
for decisions); the *path itself* is fixed once approved.

This is the structural answer to the "deterministic" claim that is often overstated:
the system as a whole is not deterministic, but the control flow is — and that is what
audit and reproducibility require.

*Derives from* [`thesis.md`](./thesis.md) §5.4 (the new middleware layer).
*Realised in sk:* [`positioning.md`](./positioning.md) §5 (principle: policy- and
version-bound execution).

---

## R4 — Workflow as a versioned organisational artefact

The authoring output must be a *formal, reviewable, diffable, rollbackable artefact* — an
artefact the organisation can own, inherit, audit, and roll back. Not a script in a
person's repository, not a wiki page, not a "the AI is handling it right now" answer.

This is the strongest structural change the system enables: operational logic enters the
balance sheet of organisational software assets, for the first time at first-class.

*Derives from* [`thesis.md`](./thesis.md) §5.3 (Git for operational organisational logic).
*Realised in sk:* [`positioning.md`](./positioning.md) §7 (Part 2b: structural changes).

---

## R5 — Closed learning loop with operator-reviewed remediation

Operational drift must produce *operator-reviewed* repair proposals, not autonomous
production changes. Repair candidates are bounded, classified, and validated against
recorded production fixtures before they are offered for review. The same loop produces
reusable skill proposals.

Formula (used identically across all three documents):

> **Run → Drift → Patch Candidate → Skill Candidate → Better Authoring → Better Run.**

![Diagram 3 — The Compounding Loop](./diagrams/03-compounding-loop.svg)

*Diagram 3. Every run makes the next one better — systematically, not dependent on
individual vigilance.*

No autonomous repair in production. The loop runs through a human gate. The
*compounding* effect — each run improving the next — is the actual moat.

*Derives from* [`thesis.md`](./thesis.md) §5.3 and §8 (compounding).
*Realised in sk:* [`positioning.md`](./positioning.md) §6 (Worked Example 1, drift
stage) and §7 (Part 2b: drift becomes context accumulation).

---

## R6 — Delegated AI action with scoped, time-bound, revocable, audited authority

External AI clients — coding assistants, chat connectors, third-party agents — must be
reachable without forming a second governance island. A delegated action is permitted
only if it is *scoped* (this user can only trigger these specific operational actions),
*time-bound* (the grant expires), *revocable* (it can be withdrawn immediately), and
*audited* (every use is recorded).

The market mechanic for this is OAuth 2.1 with dynamic client registration, PKCE,
refresh-token rotation, and revocation; the business meaning is **controlled operational
delegation**.

*Derives from* [`thesis.md`](./thesis.md) §4 (chat → action) and §7 (one governance
point).
*Realised in sk:* [`positioning.md`](./positioning.md) §6 (Worked Example 2, external
trigger) and §2.1 (principle: controlled operational delegation).

---

## R7 — Fine-grained, action-level identity and authorisation

Authorisation must be expressible per *operational resource* and per *action* (e.g.
"can run this workflow", "can rotate that credential"), not just per seat or feature
group. The same authorisation model must apply at every entry surface (HTTP, MCP,
webhook, CLI), and every denial must produce an audit record.

This is the structural answer to "RBAC light" in conversation-grade enterprise tarifs.

*Derives from* [`thesis.md`](./thesis.md) §4 (classical IAM no longer suffices) and §7.
*Realised in sk:* [`positioning.md`](./positioning.md) §5 (principle: fine-grained
action-level identity).

---

## R8 — Secrets isolation from the AI context

Credentials for external systems must be *authenticated-encrypted at rest* and
cryptographically bound to the tenant and the record they belong to, so that a
ciphertext lifted from one record cannot be replayed against another. Secrets must
never enter the model context, must be redacted before persistence in any log or
transcript, must be rotatable, and every access must be audited.

This is non-negotiable: the moment a credential enters a model context, governance is
already lost.

*Derives from* [`thesis.md`](./thesis.md) §4 (chat → action) — once AI acts against
production systems, secrets must be isolated from the model.
*Realised in sk:* [`positioning.md`](./positioning.md) §5 (principle: secrets outside the
AI context).

---

## R9 — Multi-tenant isolation as a structural property

Multi-tenancy must be a structural property, not a configuration mode. Every record
carries a tenant boundary; the boundary is enforced at storage, query, and response
layers and is covered by regression tests. This is not an absolute guarantee — no
isolation claim ever is — but it is structurally enforced, not conventional.

*Derives from* the entire thesis: organisational accumulation only makes sense if each
organisation's context stays its own.
*Realised in sk:* [`positioning.md`](./positioning.md) §5 (principle: layered tenant
isolation).

---

## R10 — Cost attribution and per-tenant budget

Cost for AI usage must be attributable per tenant and per operational flow, and the
system must enforce a hard per-tenant ceiling. Concretely: one provider identity per
tenant (not n personal keys), an append-only usage ledger recording each model call
(tenant, flow, model, tokens, latency, result), and an effective-cost weighting that
matches the actual provider invoice (prompt-cache reads cheaper, cache builds more
expensive).

The point is not "cheaper AI"; it is *cost as a tenant-level, vendor-decoupled property*.
Tools can change; pricing can change; the operating model stays, and the cost stays
attributable.

*Derives from* the centralisation argument in [`thesis.md`](./thesis.md) §7.
*Realised in sk:* [`positioning.md`](./positioning.md) §5 (cost principles).

---

## R11 — Audit-grade evidence (not compliance)

The system must produce an *append-only, immutable action log* with enough detail to
feed a SOC2 / ISO27001 / GDPR programme: actor, action, timestamp, reason, source
address, trace correlation, before/after diff for state changes. Action types must cover
operational actions, not only model conversations.

**Explicitly: this is not a compliance solution.** Compliance is achieved by processes,
documentation, operations, incident handling, and vendor management — never by
architecture alone. A candidate system can provide the *evidence and building blocks*
that make a compliance programme tractable; it cannot promise compliance.

*Derives from* [`thesis.md`](./thesis.md) §4 (governance shifts from conversation logs
to action artefacts).
*Realised in sk:* [`positioning.md`](./positioning.md) §5 (principle: traceability, not
compliance).

---

## R12 — Multiple entry surfaces, one governance point

Operators must reach the system from multiple entry surfaces (CLI, REST/MCP, chat) and
find the *same* governance gate and the *same* audit trail behind every one of them. A
second entry that bypasses the gate is a hole in the layer.

*Derives from* [`thesis.md`](./thesis.md) §7 (one governance point).
*Realised in sk:* [`positioning.md`](./positioning.md) §5 (principle: multiple surfaces,
one governance point).

---

## Anti-requirements (what the system is *not* required to do)

The category is sharper if its boundaries are explicit:

- **It is not required to replace IDE coding assistants.** Tools such as Claude Code,
  Codex, and Cursor address a different axis (code authoring in the editor); a useful
  system on this axis complements them but does not subsume them.
- **It is not required to govern all employee AI usage.** Generic chat, exploratory use,
  free-form research are intentionally outside scope. They are probabilistic by design.
- **It is not required to eliminate shadow AI.** It is required to provide a *governed
  lane* for the operational subset that touches production systems; the rest stays free
  and that is correct.
- **It is not required to be the only AI provider for an organisation.** Foundation
  models, IDE assistants, chat products, and this layer coexist; the layer adds the
  operational governance the others cannot provide (see [`thesis.md`](./thesis.md) §6,
  "Why not just OpenAI?").

A candidate system that *does* try to subsume any of these is making a different
strategic bet and should be evaluated as such — not as a realisation of this category.

---

## Cross-references and further reading

- Underlying theory: [`thesis.md`](./thesis.md).
- Concrete realisation in sk: [`positioning.md`](./positioning.md).
- Vocabulary used here: [`02-concepts.md`](./02-concepts.md).

## Sources

Same bibliography as [`thesis.md`](./thesis.md) §11 — research literature (ReAct, RAG,
agent surveys) and industry context (MindStudio, GitHub Enterprise AI Controls,
VentureBeat, Temporal/LangGraph, Grant Thornton, Lumenova).
