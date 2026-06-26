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

The authoritative glossary is [`docs/concepts.md`](docs/concepts.md); the canonical
contract for contributors is [`AGENTS.md`](AGENTS.md).

---

## Architecture at a Glance

![sk architecture at a glance — outside-the-bridge AI clients cross via the MCP OAuth bridge into the engine; other surfaces enter directly. Tenant Context (Skills · Knowledge · Discovery · Skill/Patch Candidates) is the compounding learning loop.](docs/overview.png)

*Outside-the-bridge clients (IDE assistants, employee chat) reach governed workflows only through the **MCP OAuth bridge**; other surfaces (Chat adapters, CLI, HTTP REST API, Inbound Webhooks, Scheduler) enter directly. The engine groups into six clusters; the green **Tenant Context** cluster is the compounding loop. Source: [`docs/overview.drawio`](docs/overview.drawio).*

Every interaction — regardless of entry point — flows through the same governed pipeline.
AI assists with authoring but never executes without human approval. Execution is
policy- and version-bound, auditable, and operator-reviewed for drift-assisted repair —
the control flow of an approved workflow is fixed; runtime does not re-decide it.

---

## Quick Start

| You want to | Start here |
|-------------|-----------|
| Brand new to sk — go from nothing to a running engine + first connector, workflow, and knowledge article | [Zero-to-running quickstart](docs/quickstart/zero-to-running.md) |
| Run the engine for a team | [Operator quickstart](docs/quickstart/operator.md) |
| Use `sk`, chat, or MCP | [End-user quickstart](docs/quickstart/end-user.md) |
| Contribute to sk | [Developer quickstart](docs/quickstart/developer.md) |

---

## Documentation

Full conceptual, operational, and quickstart documentation lives in [`docs/`](docs/) — start
with the [docs index](docs/README.md) and the [glossary](docs/concepts.md).

---

## For Coding Agents

sk is designed for agentic coding environments. Start with [`AGENTS.md`](AGENTS.md) —
the canonical repo-wide contract, subsystem map, and quality gate. See [`SKILLS.md`](SKILLS.md)
for the skill index.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Mike Bild
