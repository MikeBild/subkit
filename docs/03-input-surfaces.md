# Input Surfaces

Automation that only works from one place does not fit how enterprise teams actually operate. A developer may prefer a terminal. An analyst may live in Slack. A CI pipeline needs a machine-readable API. An AI coding assistant should be able to call a workflow directly.

sk is designed around this reality. It has multiple entry points — the sk CLI, the REST API, the MCP server, chat platform integrations, webhooks, and scheduled triggers — and all of them lead to the same governed authoring and execution pipeline. The security model, the RBAC checks, and the Audit Log apply identically regardless of where a request originates.

Many doors. One platform.

---

## The sk CLI (Conversational REPL)

The sk CLI is the primary human-facing authoring tool. It is a terminal interface built on Ink that opens a Conversation when launched — a live session where the user describes what they want and the AI proposes, iterates, and assembles a workflow.

**Who uses it.** End users describe automation goals in natural language and work through the AI-assisted authoring loop. Operators use the same CLI to manage Connectors, review Skill Candidates and Patch Candidates, query the Audit Log, and administer the platform — the surface adapts based on the authenticated user's role.

**Authentication.** The sk CLI supports four modes: API Key (for developers and CI), OIDC (for SSO-enabled organizations), Portal Token (for scoped external-user flows), and headless mode where input is piped from stdin for scripted or automated usage. All modes resolve to the same identity and RBAC model.

**In-conversation actions.** Users interact with the ongoing Conversation through slash commands: `/approve` to commit a Draft, `/reject` to discard a proposal, `/list` to enumerate available Connectors or Skills, `/run` to trigger an execution, and others. These commands give users explicit control over the AI authoring loop without leaving the terminal.

**Resource references.** Within a Conversation, users can mention platform resources directly using `@connector` and `@skill` syntax. This lets the AI ground its proposals in the specific Connectors and Skills the tenant has configured, rather than making generic assumptions.

**Headless mode.** When stdin is not a TTY, the sk CLI operates without interactive prompts. This enables scripted workflows, CI pipeline integration, and automated testing scenarios where a human is not present at the terminal.

---

## The REST API (OpenAPI)

The REST API is the full programmatic interface to sk. Every capability available through any other surface is available through the API. It is the canonical interface that all other surfaces — including the CLI and MCP server — ultimately use.

**Coverage.** The API exposes CRUD endpoints for all platform resources: Workflows, Connectors, Executions, Credentials, Skills, Skill Candidates, Knowledge Sources, Conversations, Schedules, Webhooks, Audit Log entries, and more. Every operation that changes state goes through the API layer, which means RBAC and the Audit Log apply uniformly.

**Schema-first design.** All request and response shapes are defined as Zod schemas. The OpenAPI 3.1 specification is generated from those schemas — it is never hand-written. This means the spec is always accurate, and client code generated from it is always consistent with the actual implementation.

**Consistency.** Pagination, filtering, and sorting follow the same conventions across all list endpoints. Operators and developers can learn the pattern once and apply it everywhere.

**Discoverability.** The OpenAPI spec is served at `/openapi.json`. An interactive Scalar UI for exploring and testing the API is available at `/docs`. Both are available to any authenticated client.

---

## MCP Integration

The Model Context Protocol (MCP) server is embedded in the sk engine and exposes the platform's capabilities to AI coding tools. Where the REST API is designed for direct programmatic use, the MCP server is designed for AI agents and AI-assisted development tools that need to reason about and invoke platform capabilities as part of their own workflows.

**Supported clients.** Any MCP-compatible client can connect: Claude Code, GitHub Copilot, Codex CLI, Gemini, and custom MCP clients built for specific workflows. The connection is a single configuration line pointing at the engine's MCP endpoint.

**Three capability types.** The MCP server exposes sk's capabilities in three forms that match the MCP standard:

- **Tools** are Workflows exposed as callable functions. A workflow named `payment-sync` becomes a tool named `run_payment_sync` that any connected AI tool can invoke directly. The AI sees the workflow's input schema, can call it, and receives the result.
- **Resources** are Connectors exposed as structured data access. A Stripe Connector might surface as a `stripe://customers` resource that an AI tool can read to understand available data shapes.
- **Prompts** are Skills exposed as curated context. When an AI tool requests a prompt, sk injects the relevant Skill content — best practices, integration patterns, known failure modes — directly into the AI's context.

**Transport.** The MCP server supports Streamable HTTP transport, which is the current MCP standard. Stdio transport is also supported for legacy compatibility with tools that expect a subprocess interface.

**Governance.** All MCP tool calls are subject to the same RBAC checks and Audit Log entries as direct API calls. There is no privileged back channel through MCP; identity and permissions are enforced identically regardless of which surface initiated the request.

---

## Chat Systems (Slack, Teams, Google Chat)

Enterprise teams spend much of their day in chat. The sk chat integrations bring the Conversation authoring loop into the tools teams already use, so automation work does not require context switching.

**How it works.** Each chat platform has a dedicated adapter that normalizes incoming messages — mentions, slash commands, interaction callbacks — into sk's Conversation model. The same AI authoring loop that runs in the sk CLI runs inside a Chat Session. Responses are rendered as native platform messages. A conversation started in Slack and continued the next day picks up exactly where it left off.

**Approval flow.** When a Draft or Patch Candidate requires approval, the platform surfaces an interactive card in the relevant chat thread. Operators see an approve button and a reject button as native chat UI elements — no separate tool required. The approval decision is recorded in the Audit Log with the chat platform as the request source.

**Identity linking.** A chat user's platform identity (their Slack user ID, Teams user principal, or Google Chat identity) is linked to their sk Tenant account through a user-initiated flow. Once linked, messages from that user carry their full sk identity, including role and permissions.

**Notification routing.** Execution results, alerts, and approval requests can be routed to specific channels or users through Notification Rules. Operators configure which events go where, at what severity level, and with what quiet-hour constraints. Chat systems are the primary notification channel in sk — email notifications are not supported.

---

## Webhooks and Scheduled Triggers

Not all automation starts with a human. Scheduled triggers and inbound webhooks let sk respond to time and to external system events without requiring a person to initiate anything.

**Inbound webhooks.** Each inbound webhook endpoint has a unique URL and is bound to a specific Workflow. When an external system — a payment processor, a CI system, a monitoring tool — sends a request to that endpoint, sk verifies the signature using the Standard Webhooks specification, deduplicates replays, and triggers the bound Workflow. The trigger is recorded in the Audit Log with source `webhook`.

**Outbound webhooks.** sk can also push events outward. Operators configure Subscriptions that match internal platform events and fan them out to external systems as signed webhook deliveries. Delivery retries follow a well-defined cadence, failed deliveries go to a dead-letter queue, and repeated failures trip a per-subscriber circuit breaker to prevent cascading problems.

**Scheduled triggers.** Cron expressions can be attached to any Workflow. The sk scheduler fires the Workflow at the configured time with catch-up semantics — if the engine was offline when a scheduled run was due, it fires the missed run when it comes back online (subject to a configurable window). Scheduled fires are recorded in the Audit Log with source `scheduler`.

**Triggering without a human.** Whether triggered by a webhook or a schedule, the resulting Execution is governed by exactly the same rules as a manually triggered one: RBAC applies to the trigger, the Workflow runs deterministically as committed, and the full Execution record is written to the immutable log.

---

## What to Read Next

- [docs/04-authoring.md](04-authoring.md) — How Conversations work, how the AI assembles Workflows, and how the approval gate turns a Draft into a committed, executable Workflow.
