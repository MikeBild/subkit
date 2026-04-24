# Concepts & Domain Model

Every enterprise automation platform lives or dies by the clarity of its vocabulary. Ambiguous terms produce misaligned expectations, inconsistent implementations, and governance gaps.

This file is the authoritative glossary for sk. Every term used across all other documentation is defined exactly once here. When a doc uses a term from this list, the meaning is the meaning given here — not an approximation.

Terms are grouped by concern. Read the groups in order for a complete mental model, or jump to a specific group when you need a definition.

---

## Group 1: Platform Core

**Tenant** — the top-level isolation unit in sk. All resources — workflows, connectors, credentials, users, skills, conversations, and knowledge sources — belong to exactly one Tenant. Multi-tenancy is structural, not configurable; no shared state crosses tenant boundaries, and every platform operation is scoped to the tenant of the authenticated principal.

**User** — a human principal within a Tenant. A User has a role (admin, member, or end-user) that governs which resources they can see and which actions they are permitted to take. Users authenticate through an Auth Provider (OIDC or API Key) and their identity is linked to their chat-platform accounts when chat integrations are enabled.

**API Key** — a bearer token scoped to a Tenant and a set of permissions. Used for programmatic access, service-to-service integration, and CLI authentication. API Keys carry explicit scopes and can be constrained to specific workflows or connectors. They support overlap-window rotation so access is never interrupted during a key change.

**Portal Token** — a short-lived, scoped credential issued to an end user for single-purpose access. Portal Tokens allow external users to interact with specific workflows without becoming full Tenant members. They are a tighter variant of an API Key, with a shorter default lifetime and a narrower permission surface.

---

## Group 2: Authoring

**Conversation** — the primary authoring session in sk. A User and the AI exchange messages; the AI uses structured authoring actions internally to propose, validate, and assemble a workflow. Conversations are persistent and resumable — a session can be paused and continued without losing context. The Conversation is where Drafts are created, refined, and committed.

**Draft** — a workflow under construction within a Conversation. A Draft exists only in the context of the Conversation until a User explicitly commits it. Committing a Draft creates a versioned, immutable Workflow. Drafts are never executed directly; only committed Workflows run in the execution engine.

**Skill** — a reusable, curated piece of context loaded into the AI during Conversations and executions. Skills encode best practices, integration patterns, domain-specific knowledge, and known failure modes. They are authored or promoted by operators with explicit human approval. Skills are never auto-generated or auto-promoted from execution history.

**Skill Candidate** — a pattern detected from execution history that might improve AI context quality. The platform proposes Skill Candidates automatically when it detects recurring patterns in successful or failed executions. A Skill Candidate becomes a Skill only through explicit operator approval — the platform never promotes one automatically.

**Knowledge Source** — a persistent document store attached to a Tenant or Workflow. Operators upload documents (PDFs, runbooks, compliance policies, architecture diagrams) which are chunked and indexed for semantic search. The AI searches Knowledge Sources during Conversations to ground its proposals in tenant-specific context. Knowledge Sources can also be queried at execution time when a Step requires document-level reasoning.

**Discovery** — a one-shot analysis where the AI examines uploaded files (API specifications, runbooks, architecture diagrams, OpenAPI docs) and proposes Connectors, Skills, and Knowledge Sources inferred from their content. The result is a set of proposals — called Discovery Artifacts — that operators can approve or reject individually. Discovery does not configure anything automatically.

---

## Group 3: Integration

**Connector** — a configured connection to an external integration boundary. A Connector is built from a template, a driver, and credentials. It represents a specific integration instance — for example, a Stripe production account or a GitHub organization. Connectors are tenant-scoped, versioned, and can be bound to a Tunnel when the target boundary lives in a private network.

**Connector Template** — a pre-built blueprint for a well-known service. Templates include the driver type, authentication configuration, documentation ingestion setup, and guided setup instructions. sk ships 89 Connector Templates covering services across payments, CRM, DevOps, data, communication, and cloud infrastructure. Templates are the starting point for creating a Connector; they are not Connectors themselves.

**Driver** — the protocol layer that executes Connector requests. sk has four built-in drivers: HTTP, GraphQL, PostgreSQL, and S3. Each driver handles request construction, response parsing, pagination, and error normalization for its protocol. Drivers are not pluggable at runtime — the four built-in drivers cover the intended integration surface.

**Credential** — an encrypted secret stored in the platform's credential vault. Credentials include API keys, OAuth2 tokens, connection strings, and similar sensitive values. Connectors reference Credentials by identifier; the raw secret value is never exposed outside the vault. All Credentials are encrypted at rest. OAuth2 Credentials refresh automatically.

**Tunnel** — a secure outbound WebSocket connection that allows the sk engine to reach services in private networks without requiring inbound firewall rules. The Tunnel Agent is a small binary that runs inside the private network and opens the persistent outbound connection to the engine. The engine routes specific Connector requests through the open Tunnel. Keepalive, reconnect logic, and per-target concurrency limits are built in.

---

## Group 4: Execution

**Workflow** — a versioned, directed acyclic graph (DAG) of Steps that produces a deterministic outcome. Workflows are authored through Conversations, approved by a human, and then committed as immutable versions. Each version is a complete snapshot of the workflow at the time of approval. Workflows are tenant-scoped and support a lifecycle of draft, active, and archived.

**Step** — a single unit of work within a Workflow DAG. Step types are: request (call a Connector), transform (reshape data), branch (conditional routing), loop (iterate over a collection), parallel (run Steps concurrently), wait (introduce a delay), and call (invoke another Workflow or Skill). Each Step declares retry policy, timeout, error handling behavior, and optional field masking for sensitive data.

**Execution** — a single run of a Workflow. An Execution carries its own state, step-by-step results, logs, and final status. Executions are immutable records — they are never modified after completion. Each Execution records its request source (API, CLI, scheduler, webhook, MCP, or chat) and its environment (dev or prod). Executions are queryable and searchable after the fact.

**Execution Fixture** — a recorded snapshot of a past Workflow execution, capturing the request and response at each Step. Fixtures serve as the dry-run corpus for Self-Healing proposals: before a Patch Candidate is presented to an operator for approval, it is validated against relevant Fixtures to confirm the repair does not break known-good behavior.

**Schedule** — a cron expression or event trigger attached to a Workflow. The scheduler fires the Workflow at the configured time or in response to an inbound event. Schedules are reconciled at engine boot and on configuration changes. Scheduled fires are recorded in the Audit Log with source `scheduler`.

---

## Group 5: Governance

**Audit Log** — the immutable, append-only record of every state change in the platform. Every entry carries: what changed, who initiated it, from which surface (API, CLI, MCP, chat, scheduler, webhook), and when. The Audit Log cannot be modified or deleted. It is the authoritative record for compliance, debugging, and incident review.

**RBAC** — role-based access control enforced at every platform boundary. Every API route, MCP call, webhook trigger, and execution path checks the caller's role and permissions before proceeding. sk ships four built-in roles. Custom roles and resource-level grants are supported for more granular control. RBAC decisions are recorded in the Audit Log.

**Before-Request Hook** — a sandboxed script that runs before a Connector request executes. Hooks can inspect or modify the outbound request, enforce policy (such as blocking writes during maintenance windows), or abort execution entirely. Hooks run in an isolated sandbox with a strict CPU budget and no access to the host environment. Hook execution is audited. Any error or timeout fails closed and denies the request.

**Self-Healing** — the platform's drift detection and bounded repair system. When a Connector's schema or behavior changes in a way that causes Step failures, the engine detects the drift, compares the new response against the last known Schema Version, proposes a repair using the AI within a narrow repair loop, and dry-runs the proposed repair against recorded Execution Fixtures. The result is a Patch Candidate presented to an operator for approval. Self-Healing never applies a repair automatically without operator approval.

**Patch Candidate** — a proposed repair generated by the Self-Healing process. Each Patch Candidate carries the proposed change, a classification of safe or unsafe based on the scope and risk of the repair, the Execution Fixtures it was validated against, and a full audit trail. Patch Candidates require explicit operator approval before they are applied to a live Workflow.

---

## Group 6: Surfaces

**sk CLI** — the conversational command-line interface and primary human-facing surface for sk. Built on Ink, it provides a terminal UI that opens a Conversation for end users describing workflow goals, and a full admin surface for operators managing the platform. The sk CLI supports four authentication modes: API Key, OIDC, Portal Token, and headless (stdin pipe for scripted usage). Persona-aware: the surface adapts based on the authenticated user's role.

**subkit CLI** — the operator-focused command-line tool for administrative tasks. Used for managing Connectors, running diagnostics, querying the Audit Log, managing Schedules, and performing platform maintenance. The subkit CLI is separate from the sk conversational REPL and is oriented toward operators and developers rather than end users.

**MCP Server** — the Model Context Protocol server embedded in the sk engine. It exposes Workflows as callable `wf.<slug>` entries inside the MCP callable surface, Connectors as structured resources, and Skills as curated prompts that can be injected into an AI's context. Any MCP-compatible client — including Claude Code, GitHub Copilot, Codex CLI, and Gemini — can connect to the MCP Server and interact with the platform. All MCP calls are governed by the same RBAC and Audit Log as direct API calls.

**Chat Adapter** — the integration layer for enterprise chat platforms (Slack, Microsoft Teams, Google Chat). Each adapter normalizes platform-specific events — mentions, slash commands, interaction callbacks — into sk's Conversation model, and renders responses back as native platform messages. Approval flows surface as interactive cards with approve and reject buttons. Identity linking connects a chat user's platform identity to their sk Tenant account.

---

## What to Read Next

- [docs/03-input-surfaces.md](03-input-surfaces.md) — How users and systems reach sk: the CLI, REST API, MCP server, chat platforms, webhooks, and scheduled triggers.
