# sk

**A self-hostable engine for governed, versioned, AI-assisted workflow execution.**

sk lets a team describe automation in natural language, review and approve what the AI
proposes, and then run it deterministically against the systems they already use — with
multi-tenancy, RBAC, encrypted credentials, and an immutable audit trail throughout. AI
assists with *authoring*; *execution* is fixed at approval time and never re-decided at
runtime.

It is open source and built to be run inside an organisation: every workflow is a
versioned, reviewable artefact, every state change is audited, and no workflow reaches
production without an explicit human approval step.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

For the architecture and concepts, start with [`docs/01-platform.md`](docs/01-platform.md)
and the [glossary](docs/02-concepts.md). The canonical contract for contributors is
[`AGENTS.md`](AGENTS.md).

---

## How It Works

![sk architecture at a glance — outside-the-bridge AI clients cross via the MCP OAuth bridge into the engine; other surfaces enter directly. Tenant Context (Skills · Knowledge · Discovery · Skill/Patch Candidates) is the compounding learning loop.](docs/overview.png)

*Outside-the-bridge clients (IDE assistants, employee chat) reach governed workflows only through the **MCP OAuth bridge**; other surfaces (Chat adapters, CLI, HTTP REST API, Inbound Webhooks, Scheduler) enter directly. The engine groups into six clusters; the green **Tenant Context** cluster is the compounding loop. Source: [`docs/overview.drawio`](docs/overview.drawio).*

Every interaction — regardless of entry point — flows through the same governed pipeline.
AI assists with authoring but never executes without human approval. Execution is
policy- and version-bound, auditable, and operator-reviewed for drift-assisted repair —
the control flow of an approved workflow is fixed; runtime does not re-decide it.

---

## Input Surfaces

sk meets users and systems where they already are.

| Surface | Who uses it | What it enables |
|---------|-------------|-----------------|
| **sk CLI** | End users, operators | Conversational REPL — describe what you need, review and approve what the AI builds |
| **REST API / OpenAPI** | Services, CI/CD, SDKs | Full programmatic control over every platform resource |
| **MCP Integration** | AI coding tools | Any MCP-compatible AI client gets governed access to every connected system |
| **Chat Systems** | Teams and individuals | Same conversation loop in Slack, Teams, and Google Chat — approval buttons included |
| **Webhooks & Schedules** | Systems and cron | Trigger workflows on external events or on a schedule without writing orchestration code |

All surfaces share the same identity model, RBAC, and audit trail — one governance
layer regardless of how a workflow was triggered.

---

## AI-Assisted Authoring

Conversations are the primary authoring interface. A user describes a goal in natural
language; the AI proposes a workflow, explains each step, and waits for approval before
anything is committed.

**Capabilities:**

- **Multi-AI provider** — Claude, OpenAI, and Gemini are all supported. The engine
  routes to the best model for the task; swap providers without changing workflows.

- **Connector Catalog** — 105 pre-built connector templates for Stripe, Salesforce,
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

- **Drift-assisted repair (operator-reviewed remediation)** — the engine detects
  connector drift (changed schemas, new error shapes, moved endpoints) and proposes the
  smallest safe repair as a Patch Candidate. Repairs are dry-run validated against
  recorded fixtures and require operator approval before they apply; nothing is changed
  autonomously in production. The codebase keeps the technical name *self-healing*
  ([`docs/02-concepts.md`](docs/02-concepts.md) explains the naming).

- **Scheduling and triggers** — workflows run on a cron schedule, in response to inbound
  webhooks, via the API, or through MCP tool calls. The trigger source is recorded in
  every audit entry.

---

## Quick Start

| You want to | Start here |
|-------------|-----------|
| Brand new to sk — go from nothing to a running engine + first connector, workflow, and knowledge article | [Zero-to-running quickstart](docs/quickstart/zero-to-running.md) |
| Run the engine for a team | [Operator quickstart](docs/quickstart/operator.md) |
| Use `sk`, chat, or MCP | [End-user quickstart](docs/quickstart/end-user.md) |
| Contribute to sk | [Developer quickstart](docs/quickstart/developer.md) |

---

## Architecture & Concepts

Full conceptual documentation in [`docs/`](docs/):

| Document | What it covers |
|----------|---------------|
| [The Platform](docs/01-platform.md) | Purpose, design principles, what sk is and is not |
| [Concepts](docs/02-concepts.md) | Authoritative glossary for every domain term |
| [Input Surfaces](docs/03-input-surfaces.md) | CLI, API, MCP, Chat, Webhooks — in depth |
| [AI-Assisted Authoring](docs/04-authoring.md) | Conversations, skills, knowledge, multi-provider |
| [Connectors & Integration](docs/05-connectors.md) | Drivers, templates, auth |
| [Workflow Execution](docs/06-execution.md) | Engine, step kinds, scheduling, drift-assisted repair |
| [Security & Governance](docs/07-security-governance.md) | Identity, RBAC, audit, compliance |
| [Deployment & Operations](docs/08-operations.md) | Installation, observability, resource limits |
| [Run with Docker](docs/operations/docker.md) | All-in-one image: quick start, onboarding, external-DB mode, persistence |

---

## For Coding Agents

sk is designed for agentic coding environments. Start with [`AGENTS.md`](AGENTS.md) —
the canonical repo-wide contract, subsystem map, and quality gate. See [`SKILLS.md`](SKILLS.md)
for the skill index.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Mike Bild
