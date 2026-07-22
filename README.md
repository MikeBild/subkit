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

[![ci](https://github.com/mikebild/subkit/actions/workflows/ci.yml/badge.svg)](https://github.com/mikebild/subkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The authoritative glossary is [`docs/concepts/glossary.md`](docs/concepts/glossary.md); the canonical
contract for contributors is [`AGENTS.md`](AGENTS.md).

---

## Architecture at a Glance

![sk architecture at a glance — external AI clients cross the product-local MCP OAuth boundary into the engine; other surfaces enter directly. Tenant Context (Skills · Knowledge · Discovery · Skill/Patch Candidates) is the compounding learning loop.](docs/concepts/overview.png)

*External clients (IDE assistants, employee chat) reach governed workflows only through SubKit's product-local **MCP OAuth boundary**; other surfaces (Chat adapters, CLI, HTTP REST API, Inbound Webhooks, Scheduler) enter directly. The engine groups into six clusters; the green **Tenant Context** cluster is the compounding loop. Source: [`docs/concepts/overview.drawio`](docs/concepts/overview.drawio).*

Every interaction — regardless of entry point — flows through the same governed pipeline.
AI assists with authoring but never executes without human approval. Execution is
policy- and version-bound, auditable, and operator-reviewed for drift-assisted repair —
the control flow of an approved workflow is fixed; runtime does not re-decide it.

---

## Quick Start

| You want to | Start here |
|-------------|-----------|
| Brand new to sk — go from nothing to a running engine + first connector, workflow, and knowledge article | [Self-host quickstart](docs/developers/self-host.md) |
| Ground a **coding agent** (Claude Code, Codex, Cursor, …) in your team’s knowledge | [Use sk from a coding agent](docs/authors/coding-agents.md) |
| Run the engine for a team | [Operator quickstart](docs/operators/quickstart.md) |
| Use `sk`, chat, or MCP | [Author quickstart](docs/authors/quickstart.md) |
| Contribute to sk | [Developer quickstart](docs/developers/quickstart.md) |

---

## Documentation

Full conceptual, operational, and quickstart documentation lives in [`docs/`](docs/) — start
with the [docs index](docs/README.md) and the [glossary](docs/concepts/glossary.md).

Authoring is a guided pipeline: describe the outcome in plain language and sk builds a
grounded draft, tests it against a sample payload, applies precise patch edits, and commits
only on explicit approval — nothing reaches production without a human accepting the change.
The [authoring guide](docs/authors/authoring-workflows.md) walks the full loop, including
throwaway playground drafts that never persist and partial-accept of individual edits. For the
governed MCP surface those tools expose — session progress, confirmation gates, and
secrets-never-in-chat routing — see the [tool palette](docs/developers/tool-palette.md).

Cloudflare and Firebase/Firestore ship as built-in Connector Templates. Other APIs can be
bootstrapped from OpenAPI JSON/YAML or Google REST Discovery JSON; URL imports are streamed with
a 50 MiB limit and use document metadata to seed the connector base URL and authentication. The
[connector guide](docs/concepts/connectors.md#openapi-connector-import) includes setup commands,
credential guidance, and the separate live-discovery limits.

Remote MCP clients use SubKit's built-in OAuth 2.1 authorization server.
Its common `sk` browser card is configured only by the provider-neutral
`auth.providers` list, which can contain one API-key adapter and multiple named
direct `oidc` adapters. SubKit owns every OIDC client, secret, callback,
session, tenant mapping and deployment; no shared cross-product login component
exists. OIDC uses discovery and Authorization Code + PKCE. The same list drives discovery, browser login and
bearer verification. Consent is limited to the scopes the client actually
requested and the user's current RBAC, with mandatory `mcp:read`, revocable
eight-hour/24-hour browser sessions, logout and account switching. See
[Input surfaces](docs/developers/input-surfaces.md#mcp-oauth-21-chatgpt--claudeai--cursor).
The browser contract is the same independent `mcp-auth-v2` implementation used
by WikiKit and ContentKit: **Continue with SSO** is always first and
**Continue with API key** second, configured labels never rewrite those
actions, and authorize hands off only an opaque `login_state`. Provider
discovery and assertion exchange use the generic `/v1/identity/providers` and
`/v1/identity/sessions` endpoints; no provider-named or legacy route exists.

Operators can measure how the product is actually used without collecting content:
opt-in, tenant-scoped usage reports cover canonical HTTP routes, Chat turns, Conversation
streams, and MCP JSON-RPC/session/capacity behavior. Actor and session identities are
product-local HMACs; messages, prompts, arguments, results, raw URLs, IPs, and user agents
are never stored. See [Observability & usage reports](docs/operators/observability.md) and
`sk stats http|chat|mcp|conversations --json`.

---

## For Coding Agents

sk is designed for agentic coding environments. Start with [`AGENTS.md`](AGENTS.md) —
the canonical repo-wide contract, subsystem map, and quality gate. See [`SKILLS.md`](SKILLS.md)
for the skill index, the [tool palette](docs/developers/tool-palette.md) for the callable
workflow and conversation tools, and the [authoring guide](docs/authors/authoring-workflows.md)
for the build → test → patch → commit loop your agent drives.

---

## Contributing

Contributions are welcome — bug reports, docs fixes, connectors, features.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, test layers, and the PR checklist;
issues labeled [`good first issue`](https://github.com/mikebild/subkit/labels/good%20first%20issue)
are curated entry points. Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md); security reports go through
[`SECURITY.md`](SECURITY.md), never public issues.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Mike Bild
