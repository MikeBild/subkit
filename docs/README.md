# sk Documentation

These documents are the single source of truth for sk — what it is, how it works, how to
use it, and *why* the category it occupies exists at all. The core architectural narrative
that connects the concept docs:

> **Input Surfaces → AI-Assisted Authoring → Governed, Versioned Execution**

---

## Strategy & positioning (start here for *why*)

Three short documents that define the category sk occupies. Read in order:

| Document | What it covers |
|----------|---------------|
| [thesis.md](thesis.md) | *Why this category exists.* The theory of organisational agentic operationalisation — how individual agentic productivity does not automatically scale, and why a new operating layer is emerging. |
| [system-requirements.md](system-requirements.md) | *What such a system must do.* Twelve vendor- and product-agnostic requirements derived from the thesis. |
| [positioning.md](positioning.md) | *How sk realises it.* Principles, worked examples, structural changes, honest gaps. |

The concept docs below describe the architecture that follows from these decisions.

---

## Concept Docs

Nine architecture-level documents, read in order or by concern.

| Doc | What it covers |
|---|---|
| [01-platform.md](01-platform.md) | What sk is, what it is not, the three-layer story, and the six design principles that are enforced by architecture. |
| [02-concepts.md](02-concepts.md) | The authoritative glossary: every domain term defined exactly once — Tenant, Workflow, Skill, Connector, Execution, Audit Log, and more. |
| [03-input-surfaces.md](03-input-surfaces.md) | Every way users and systems reach sk: the CLI, REST API, MCP server, chat platforms, webhooks, and scheduled triggers. |
| [04-authoring.md](04-authoring.md) | How Conversations produce governed workflows: the AI authoring loop, the human approval gate, Skills, Knowledge Sources, and Discovery. |
| [05-connectors.md](05-connectors.md) | The integration fabric: Connectors, Drivers, Credentials, the vault, and the OAuth2 lifecycle. |
| [06-execution.md](06-execution.md) | The governed, version-bound execution engine: Workflow DAGs, Step types, Execution records, Schedules, and how drift-assisted repair keeps workflows healthy (codebase term: *self-healing*). |
| [07-security-governance.md](07-security-governance.md) | Multi-tenancy, authentication (OIDC, API keys, portal tokens), RBAC, Before-Request Hooks, the credential vault, and the immutable audit trail. |
| [08-operations.md](08-operations.md) | Deployment topology, configuration, metrics, structured logging, execution inspection, resource limits, drift-assisted repair, and backup. |
| [09-notifications.md](09-notifications.md) | Notification rules, channels (Slack / Teams / Google Chat / webhook), rate limits, circuit breaker, RBAC, and the synthetic-test endpoint. |

---

## Quickstarts

Three persona-specific paths to get running fast.

| Guide | For |
|---|---|
| [quickstart/operator.md](quickstart/operator.md) | You run sk for your team. Engine up, admin key minted, first connector registered. 10 minutes. |
| [quickstart/end-user.md](quickstart/end-user.md) | You use sk through the CLI, chat, or an MCP client. Authenticated, first conversation open. 5 minutes. |
| [quickstart/developer.md](quickstart/developer.md) | You contribute to sk. Repo cloned, tests green, engine in watch mode. 10 minutes. |

---

## Who Should Read What

**End users** — start at [03-input-surfaces.md](03-input-surfaces.md) to understand how to reach sk, then [04-authoring.md](04-authoring.md) to understand what Conversations can do. The [end-user quickstart](quickstart/end-user.md) gets you to a live session in 5 minutes.

**Operators** — start with the [operator quickstart](quickstart/operator.md) to get the engine running, then [07-security-governance.md](07-security-governance.md) for identity and RBAC setup, and [08-operations.md](08-operations.md) for monitoring and operational hygiene.

**Developers** — start with [AGENTS.md](../AGENTS.md) for the subsystem map and contribution rules, then read all eight concept docs for full architectural context. The [developer quickstart](quickstart/developer.md) gets the local environment running in 10 minutes.

**Architects** — start with [thesis.md](thesis.md) for the structural category sk occupies and the platform thesis, then [system-requirements.md](system-requirements.md) for the requirements that follow, then [positioning.md](positioning.md) for sk's realisation. After that, [01-platform.md](01-platform.md) for the design rationale, [02-concepts.md](02-concepts.md) for the domain model, and [07-security-governance.md](07-security-governance.md) for the security architecture.

---

