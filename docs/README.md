# sk Documentation

These documents are the single source of truth for sk — what it is, how it works, and how to
use it. The core architectural narrative that connects the concept docs:

> **Input Surfaces → AI-Assisted Authoring → Governed, Versioned Execution**

---

## Concept Docs

Eight architecture-level documents, read in order or by concern.

| Doc | What it covers |
|---|---|
| [concepts.md](concepts.md) | The authoritative glossary: every domain term defined exactly once — Tenant, Workflow, Skill, Connector, Execution, Audit Log, and more. |
| [input-surfaces.md](input-surfaces.md) | Every way users and systems reach sk: the CLI, REST API, MCP server, chat platforms, webhooks, and scheduled triggers. |
| [authoring.md](authoring.md) | How Conversations produce governed workflows: the AI authoring loop, the human approval gate, Skills, Knowledge Sources, and Discovery. |
| [connectors.md](connectors.md) | The integration fabric: Connectors, Drivers, Credentials, the vault, and the OAuth2 lifecycle. |
| [execution.md](execution.md) | The governed, version-bound execution engine: Workflow DAGs, Step types, Execution records, Schedules, and how drift-assisted repair keeps workflows healthy (codebase term: *self-healing*). |
| [security-governance.md](security-governance.md) | Multi-tenancy, authentication (OIDC, API keys, portal tokens), RBAC, Before-Request Hooks, the credential vault, and the immutable audit trail. |
| [operations.md](operations.md) | Deployment topology, configuration, metrics, structured logging, execution inspection, resource limits, drift-assisted repair, and backup. |
| [notifications.md](notifications.md) | Notification rules, channels (Slack / Teams / Google Chat / webhook), rate limits, circuit breaker, RBAC, and the synthetic-test endpoint. |

### Deep-dive companions

Focused references that expand a single concept doc.

| Doc | Expands | What it covers |
|---|---|---|
| [conversational-flow-replay.md](conversational-flow-replay.md) | authoring | Canonical happy-path authoring transcripts that pin the auto-persist contract. |
| [recipe-authoring.md](recipe-authoring.md) | connectors | Recipe authoring deep-dive: schema, intent matching, and worked walkthroughs. |
| [tool-palette.md](tool-palette.md) | input-surfaces | The unified tool palette and dispatcher: registry, naming, and policy gates. |

---

## Quickstarts

Three persona-specific paths to get running fast.

| Guide | For |
|---|---|
| [quickstart/zero-to-running.md](quickstart/zero-to-running.md) | Brand new to sk, no prior knowledge. From the Docker image to a running engine, authenticated `sk`, and a first connector, workflow, and knowledge article. 15 minutes. |
| [quickstart/using-the-repl.md](quickstart/using-the-repl.md) | Author connectors and workflows by conversation in the `sk` REPL — the approve-to-commit loop, slash commands, and headless `-p` scripting. |
| [quickstart/operator.md](quickstart/operator.md) | You run sk for your team. Engine up, admin key minted, first connector registered. 10 minutes. |
| [quickstart/end-user.md](quickstart/end-user.md) | You use sk through the CLI, chat, or an MCP client. Authenticated, first conversation open. 5 minutes. |
| [quickstart/developer.md](quickstart/developer.md) | You contribute to sk. Repo cloned, tests green, engine in watch mode. 10 minutes. |

---

## Who Should Read What

**End users** — start at [input-surfaces.md](input-surfaces.md) to understand how to reach sk, then [authoring.md](authoring.md) to understand what Conversations can do. The [end-user quickstart](quickstart/end-user.md) gets you to a live session in 5 minutes.

**Operators** — start with the [operator quickstart](quickstart/operator.md) to get the engine running, then [security-governance.md](security-governance.md) for identity and RBAC setup, and [operations.md](operations.md) for monitoring and operational hygiene.

**Developers** — start with [AGENTS.md](../AGENTS.md) for the subsystem map and contribution rules, then read all eight concept docs for full architectural context. The [developer quickstart](quickstart/developer.md) gets the local environment running in 10 minutes.

**Architects** — start with [concepts.md](concepts.md) for the domain model, then [security-governance.md](security-governance.md) for the security architecture.

---

