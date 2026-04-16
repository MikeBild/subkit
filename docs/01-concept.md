# 01 — Concept

## Problem statement

Operators who automate real work across SaaS and internal systems keep running into the same wall. Visual workflow builders are fast to demo but slow to iterate on, brittle under version control, and impossible for an AI agent to drive directly. Traditional integration platforms hide behind a GUI and treat API-driven workflow authoring as an afterthought. Code-first job runners, on the other hand, push everything — credentials, retries, scheduling, tenancy, observability — back onto the operator. None of them make it easy to hand an LLM the keys and let it propose, test, and commit a workflow with a human checking its work.

subkit is a headless backend workflow engine built for that gap. It runs as a single compiled binary next to a PostgreSQL database, speaks an explicit domain language, and exposes every operation through a typed REST contract, an MCP server, a CLI, inbound and outbound webhooks, and chat adapters for Slack, Microsoft Teams, and Google Chat. Workflows are declarative DAGs of Steps that call typed Connectors with encrypted Credentials; AI-assisted authoring happens inside a bounded tool loop with Skills loaded into the prompt and approvals gated by Policy; and the engine records enough state to replay, repair, and audit everything it did.

The engine does not try to be everything. It is narrow by design. The surface is the domain language plus the handful of primitives needed to operate it — no visual editor, no template marketplace, no autonomous learning layer. When the engine needs to do something unusual, it does it through the same primitives an external user would use: a Connector, a Step, a Skill, a Tool call.

## Product shape

The product presents five end-user interfaces, all built on the same domain services:

- **REST** — the canonical surface. Every operation goes through `/v1/...` routes generated from a single Zod schema and published as `openapi.json`.
- **MCP** — a full Model Context Protocol server over Streamable HTTP and stdio. Workflows are tools, Connectors are resources, Skills are prompts, Conversations are a tool cluster. Long calls stream progress notifications.
- **CLI** — a typed `subkit` command-line client that consumes the in-repo typed REST client and offers an Ink-based conversational authoring mode for humans at a terminal.
- **Chat Adapters** — Slack, Microsoft Teams, and Google Chat as parallel end-user interfaces. A human mentions the bot in a thread, runs a slash command, approves sensitive steps with native interactive elements, and receives severity-routed alerts, all without leaving the chat platform.
- **Webhooks** — Standard Webhooks compliant inbound and outbound delivery. Inbound endpoints bind to workflows and verify signatures per connector. Outbound subscriptions fan out internal events to external systems with signed, retried, replay-protected delivery.

Private-network reachability is a first-class concept: a small companion agent binary opens an outbound WebSocket Tunnel to the engine, registers target names, and routes specific connector calls through the open socket. The agent ships from the same codebase as a separate compile target.

## Non-goals

subkit is explicit about what it does not do:

- **No GUI.** There is no visual dashboard, no web console, no drag-and-drop canvas.
- **No low-code visual builder.** Workflows are authored through the typed REST API, the MCP server, the CLI, or a chat thread — never a graphical editor.
- **No email notifications.** Email is not a notification channel. A tenant who needs email can build an email connector and drive it from a workflow.
- **No workflow templates.** Only connector templates are curated. Complete pre-built workflows are out of scope.
- **No automatic skill evolution.** Skills are hand-authored. The engine does not generate, mutate, or reflect on skills from past executions.
- **No horizontal cluster mode.** Multiple instances can share Postgres behind a load balancer, but there is no formal cluster protocol.
- **No pluggable queue.** The queue is `pg-boss` and only `pg-boss`. Postgres is the only stateful dependency the engine itself requires.

## Operating principle: compact dependency surface

The stack is tuned for a single Bun-compiled binary with the smallest credible dependency tree. The rules are:

- Postgres is the only stateful dependency. Queues, cron, pub/sub, and the outbox all live inside Postgres via `pg-boss` and raw `pg.Client` LISTEN.
- Where one library covers two concerns, prefer it. `openid-client` handles both OIDC user login and headless connector OAuth2 flows. `jose` handles JWT verification for Teams, Google Chat, and signed session cookies.
- Refuse libraries for what is honestly fifty lines of application code. API-key hashing, webhook signing, LISTEN reconnect, Docker Engine HTTP calls, Slack signature verification, tunnel framing, and the in-process event bus are all hand-written.
- Native Web Streams and AsyncIterables replace RxJS everywhere. The only WebSocket surface is the Tunnel agent — everything else streams over SSE with `Last-Event-ID` resumption.
- Every technology pick carries a one-line trade-off. Choices that cannot be justified in one sentence get replaced with application code.

The result is a binary that boots in seconds, ships as a distroless image, and is cheap to read in full. The dependency budget sits at roughly twenty runtime packages and is enforced in the lockfile.
