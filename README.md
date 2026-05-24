# sk

**sk — reference implementation of the operational AI execution layer.** A shared system that turns individual agentic productivity into organisational agentic operationalisation.

> ***Your operating model used to live in PowerPoint. Now it runs.***

> *Agentic productivity does not automatically scale organisationally. The bottleneck is
> not model quality or workflow execution; it is the organisation's ability to make
> operational AI work repeatable, reviewable, and learnable. This reference implementation
> integrates three otherwise separately assembled layers — contextualised AI authoring,
> operational governance, versioned reproducible execution — into one running system whose
> effect compounds per tenant over time.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Strategy & positioning

Three short documents plus the glossary. In reading order:

| Document | What it covers | Reading time |
|----------|----------------|--------------|
| [The Thesis](docs/thesis.md) | *Why this category exists.* Theory of organisational agentic operationalisation. | ~15 min |
| [System Requirements](docs/system-requirements.md) | *What such a system must do.* Twelve vendor-agnostic requirements. | ~18 min |
| [Positioning](docs/positioning.md) | *How this reference implementation realises it.* Worked examples, principles, honest gaps. | ~20 min |
| [Glossary](docs/02-concepts.md) | Every term used across the stack, defined once. | reference |

```mermaid
flowchart LR
    Thesis["thesis.md<br/>Why this category exists"]
    Reqs["system-requirements.md<br/>What such a system must do"]
    Pos["positioning.md<br/>How this reference implementation realises it"]
    Concepts["02-concepts.md<br/>Glossary"]

    Thesis --> Reqs --> Pos
    Concepts -. cited by .- Thesis
    Concepts -. cited by .- Reqs
    Concepts -. cited by .- Pos
```

For developers, the platform/architecture entry point is
[`docs/01-platform.md`](docs/01-platform.md); the canonical contract for coding agents
is [`AGENTS.md`](AGENTS.md).

---

## How It Works

![sk architecture at a glance — outside-the-bridge AI clients cross via the MCP OAuth bridge into the engine; other surfaces enter directly. Tenant Context (Skills · Knowledge · Discovery · Skill/Patch Candidates) is the compounding moat.](docs/overview.png)

*Outside-the-bridge clients (IDE assistants, employee chat) reach governed workflows only through the **MCP OAuth bridge**; other surfaces (Chat adapters, CLI, HTTP REST API, Inbound Webhooks, Scheduler) enter directly. The engine groups into six clusters; the green **Tenant Context** cluster is the compounding loop. Source: [`docs/overview.drawio`](docs/overview.drawio).*

Every interaction — regardless of entry point — flows through the same governed pipeline.
AI assists with authoring but never executes without human approval. Execution is
policy- and version-bound, auditable, and operator-reviewed for drift-assisted repair —
the control flow of an approved workflow is fixed; runtime does not re-decide it.

---

## Input Surfaces

The reference implementation meets users and systems where they already are.

| Surface | Who uses it | What it enables |
|---------|-------------|-----------------|
| **sk CLI** | End users, operators | Conversational REPL — describe what you need, review and approve what the AI builds |
| **REST API / OpenAPI** | Services, CI/CD, SDKs | Full programmatic control over every platform resource |
| **MCP Integration** | AI coding tools | Claude Code, Codex, Copilot, Gemini get governed access to every connected system |
| **Chat Systems** | Teams and individuals | Same conversation loop in Slack, Teams, and Google Chat — approval buttons included |
| **Webhooks & Schedules** | Systems and cron | Trigger workflows on external events or on a schedule without writing orchestration code |

All surfaces share the same identity model, RBAC, and audit trail — one governance
layer regardless of how a workflow was triggered.

---

## AI-Assisted Authoring

Conversations are the primary authoring interface. A user describes a goal in natural
language; the AI proposes a workflow, explains each step, and waits for approval before
anything is committed.

**What makes this enterprise-ready:**

- **Multi-AI provider** — Claude, OpenAI, and Gemini are all supported. The platform
  routes to the best model for the task; swap providers without changing workflows.

- **Connector Catalog** — 90 pre-built connector templates for Stripe, Salesforce,
  GitHub, Slack, Jira, and more. Each template includes setup guidance, documentation
  ingestion, and auth configuration. The AI uses these templates to propose accurate
  integrations, not generic HTTP requests.

- **Central Credential Vault** — integration secrets are stored encrypted
  (AES-256-GCM) and never exposed to the AI or the user. Connectors authenticate
  using vault-managed credentials. End-user credential overrides allow agents to act
  as the requesting user rather than as an admin.

- **Skills and Knowledge Sources** — reusable, curated context that the AI loads
  during conversations. Skills encode best practices, compliance checklists, and
  domain knowledge. Knowledge Sources are enterprise documents (PDFs, runbooks)
  with semantic search. Both evolve over time as the platform learns from execution
  patterns — always with human approval.

- **Human-in-the-loop approval** — no workflow reaches production without an explicit
  approval step. The AI presents a structured diff; the operator reviews and approves or
  rejects. This is not optional; it is the governance model.

---

## Governed, Versioned Execution

Once approved, workflows execute in a policy- and version-bound way. The execution
engine is not an AI agent — it is a strict DAG runner that follows the workflow
definition exactly. Step outputs can vary (external systems return different data;
humans pause for decisions); the **control flow** does not — the path was fixed at
approval and the runtime does not re-decide it. Every run is an immutable record;
rollback is a version change.

**What governs execution:**

- **Audit trail** — every state change produces an immutable record: what ran, who
  triggered it, which connector was called, what changed, and from which surface.

- **Versioning** — every workflow change creates a new version with a full DAG snapshot.
  Roll back to any prior version in seconds.

- **Drift-assisted repair (operator-reviewed remediation)** — the platform detects
  connector drift (changed schemas, new error shapes, moved endpoints) and proposes the
  smallest safe repair as a Patch Candidate. Repairs are dry-run validated against
  recorded fixtures and require operator approval before they apply; nothing is changed
  autonomously in production. The codebase keeps the technical name *self-healing*
  ([`docs/02-concepts.md`](docs/02-concepts.md) explains the dual vocabulary).

- **Scheduling and triggers** — workflows run on a cron schedule, in response to inbound
  webhooks, via the API, or through MCP tool calls. The trigger source is recorded in
  every audit entry.

---

## Quick Start

| You want to | Start here |
|-------------|-----------|
| Run the engine for a team | [Operator quickstart](docs/quickstart/operator.md) |
| Use `sk`, chat, or MCP | [End-user quickstart](docs/quickstart/end-user.md) |
| Contribute to sk | [Developer quickstart](docs/quickstart/developer.md) |

---

## Architecture & Concepts

Full conceptual documentation in [`docs/`](docs/):

| Document | What it covers |
|----------|---------------|
| [The Platform](docs/01-platform.md) | Purpose, design principles, what this reference implementation is and is not |
| [Concepts](docs/02-concepts.md) | Authoritative glossary for every domain term |
| [Input Surfaces](docs/03-input-surfaces.md) | CLI, API, MCP, Chat, Webhooks — in depth |
| [AI-Assisted Authoring](docs/04-authoring.md) | Conversations, skills, knowledge, multi-provider |
| [Connectors & Integration](docs/05-connectors.md) | Drivers, templates, auth |
| [Workflow Execution](docs/06-execution.md) | Engine, step kinds, scheduling, drift-assisted repair |
| [Security & Governance](docs/07-security-governance.md) | Identity, RBAC, audit, compliance |
| [Deployment & Operations](docs/08-operations.md) | Installation, observability, resource limits |
| [Deploy a sk engine](docs/operations/deploy.md) | Step-by-step systemd-native host bootstrap + release flow |

---

## For Coding Agents

This reference implementation is designed for agentic coding environments. Start with [`AGENTS.md`](AGENTS.md) —
the canonical repo-wide contract, subsystem map, and quality gate. See [`SKILLS.md`](SKILLS.md)
for the skill index.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Mike Bild
