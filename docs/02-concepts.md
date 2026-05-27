# Concepts & Domain Model

Every system lives or dies by the clarity of its vocabulary. Ambiguous terms produce misaligned expectations, inconsistent implementations, and governance gaps.

This file is the authoritative glossary for this reference implementation. Every term used across all other documentation is defined exactly once here. When a doc uses a term from this list, the meaning is the meaning given here — not an approximation.

Terms are grouped by concern. Read the groups in order for a complete mental model, or jump to a specific group when you need a definition.

For the structural framing of the category, see [`thesis.md`](thesis.md);
for the system requirements that follow, see [`system-requirements.md`](system-requirements.md);
for how this reference implementation realises the requirements, see [`positioning.md`](positioning.md).

---

## Group 0: Strategy Vocabulary

These terms come from the three strategy documents and recur throughout this stack. They are kept stable across all documents.

The vocabulary for this category is a **triad** — three terms that say the same thing at three levels and are deliberately *not* mixed inside a single sentence:

**Organisational agentic operationalisation** — *theory term.* Used in [`thesis.md`](thesis.md) and theory passages of [`system-requirements.md`](system-requirements.md). Precise but long; not oral-stable.

**Operational AI execution layer** — *market term.* The shared system in which an organisation governs, executes, and learns from operational AI work. Used in [`positioning.md`](positioning.md) and in product-side discussion. Enterprise-compatible and accurate; not yet memetic.

**The Operating Model** — *iconic short term.* Deliberately reuses an existing strategic-management term and **reframes it as software**: the operating model used to live in PowerPoint as a static description of how the company runs; a reference implementation of this category makes it executable, versioned, audited, and actually running. Used as the punchline alongside the longer terms.

> ***Your operating model used to live in PowerPoint. Now it runs.***

**Central axiom** — recurs verbatim across all strategy documents:

> ***The operating model improves because the organisation learns — and that is the part the organisation can actually control.***

**The three core ideas:**

- *Idea 1 — Problem.* Agentic productivity does not automatically scale organisationally.
- *Idea 2 — Category.* The bottleneck is not intelligence (supplied externally by model vendors) and not workflow execution (supplied by mature platforms) — it is the **mediation of organisation-specific context** to those mature components; operationalisation is the form this mediation takes.
- *Idea 3 — Moat.* The moat emerges from organisational context accumulation, not from any single feature.

**Mediation bottleneck** — the gap that defines the category. Between mature models, mature agents, and mature workflow/integration platforms sits the question of *how organisation-specific structure, culture, knowledge, priorities, and ways of working reach those mature layers* — and how that knowledge is improved and applied daily. The numbers in [§1 of the thesis](thesis.md#the-mediation-bottleneck-is-operationally-measurable) describe its operational footprint; operationalisation is the form in which the bottleneck dissolves.

**Contextual learning loop** — also known as the *compounding loop*. *Run → Drift → Patch Candidate → Skill Candidate → Better Authoring → Better Run.* The mechanism by which the operating model improves over time. See [Git for operational organisational logic](thesis.md#53-operational-knowledge-becomes-accumulable-versionable-inheritable--git-for-operational-organisational-logic) and the [four platform effects](thesis.md#8-four-platform-effects--over-context-not-over-users) in the thesis, plus [closed learning loop](system-requirements.md#r5--closed-learning-loop-with-operator-reviewed-remediation) in the requirements.

**Scaling cliff** — the point at which solo agentic productivity stops aggregating into organisational operationalisation without a shared system. *More solo actors means more variation, not more coherence.* See [the real problem domain](thesis.md#3-the-real-problem-domain--solo-leverage-vs-organisational-operationalisation) in the thesis.

**Shadow AI scope decision** — this reference implementation does not eliminate shadow AI; it provides a governed lane for the operational subset that touches production systems. The rest stays free and that is the deliberate scope choice. See [scope decision](positioning.md#1-summary) and [what sk still lacks](positioning.md#8-part-3--what-sk-still-lacks-honestly) in positioning.

**Drift-assisted repair suggestion** — the external phrasing for the codebase's *self-healing* subsystem (also known as *operator-reviewed remediation* in governance contexts). Same concept, different audience.

> **Dual-vocabulary note.** Strategy and external surfaces (`README.md`, `docs/thesis.md`, `docs/positioning.md`, public-facing docs) use the external phrasing above. The codebase keeps technical names (`apps/engine/src/self-healing/`, `rbac/`, `credentials/`, etc.) — those names are stable identifiers and must not be renamed for vocabulary alignment.

### Acronyms used in the strategy stack

These appear across the strategy docs. Listed here so every reader has the same expansion at hand.

| Acronym | Expansion | One-line definition |
|---|---|---|
| AEAD | Authenticated Encryption with Associated Data | Encryption that also detects tampering of the ciphertext and the metadata it is bound to. |
| BPMN | Business Process Model and Notation | Classical visual workflow language; cited as a contrast to AI-assisted authoring. |
| DAG | Directed Acyclic Graph | The shape of a Workflow: steps flow forward, never loop back to themselves. |
| DCR | Dynamic Client Registration | OAuth 2.1 mechanism that lets a new external client self-register with the server (RFC 7591). |
| DLP | Data Loss Prevention | Policy layer that recognises sensitive fields (PII, secrets) and blocks them at the boundary. |
| MCP | Model Context Protocol | The standard by which AI clients (Claude Code, Codex, Copilot) connect to external systems. |
| OAuth 2.1 | — | The current consolidated OAuth standard (PKCE-by-default, refresh-token rotation, no implicit grant). |
| OIDC | OpenID Connect | Identity layer on top of OAuth 2.x; how the reference implementation verifies who a user is. |
| PII | Personally Identifiable Information | Data that identifies a natural person; subject to GDPR / SOC2 controls. |
| PKCE | Proof Key for Code Exchange | OAuth extension that protects the authorization-code flow on public clients. |
| RAG | Retrieval-Augmented Generation | LLM pattern: ground generation in retrieved tenant-specific context (Lewis et al. 2020). |
| RBAC | Role-Based Access Control | Permission model that grants actions through roles rather than per-user grants. |
| ReAct | Reasoning + Acting | Agent pattern that interleaves model reasoning and tool calls (Yao et al. 2023). |
| RLS | Row-Level Security | PostgreSQL feature that enforces tenant boundaries at the database, not the application. |
| RTO/RPO | Recovery Time / Point Objective | Disaster-recovery targets: how fast you recover, and how much data you may lose. |
| SAML | Security Assertion Markup Language | Enterprise SSO standard, alternative to OIDC. |
| SCIM | System for Cross-domain Identity Management | Standard for automated user provisioning and deprovisioning. |
| SSO | Single Sign-On | One login session unlocks multiple applications. |

### Requirement aliases (R1–R12)

[`system-requirements.md`](system-requirements.md) numbers its twelve requirements R1–R12. The aliases below are the plain-language handle that the strategy docs use in running text; the R-number stays as a parenthetical anchor. **Single source of truth — if the alias changes, change it here first.**

| R | Alias used in running text | One-line meaning | Full spec |
|---|---|---|---|
| R1 | shared substrate | One shared execution and review system per organisation, not n parallel installs. | [R1 in spec](system-requirements.md#r1--a-shared-operational-execution-layer) |
| R2 | context as authoring input | Five tenant-curated context sources ground every authoring action. | [R2 in spec](system-requirements.md#r2--context-as-a-first-class-input-to-authoring) |
| R3 | authoring-vs-execution split | Authoring may be probabilistic; execution is policy- and version-bound. | [R3 in spec](system-requirements.md#r3--separation-of-authoring-probabilistic-from-execution-controlled) |
| R4 | workflow as artefact | The approved workflow is a formal, reviewable, diffable, rollbackable artefact. | [R4 in spec](system-requirements.md#r4--workflow-as-a-versioned-organisational-artefact) |
| R5 | closed learning loop | Operator-reviewed drift repair plus skill promotion compound back into authoring. | [R5 in spec](system-requirements.md#r5--closed-learning-loop-with-operator-reviewed-remediation) |
| R6 | delegated AI action | External AI clients act through scoped, time-bound, revocable, audited authority. | [R6 in spec](system-requirements.md#r6--delegated-ai-action-with-scoped-time-bound-revocable-audited-authority) |
| R7 | action-level identity | Authorisation per resource and per action, uniformly across every entry surface. | [R7 in spec](system-requirements.md#r7--fine-grained-action-level-identity-and-authorisation) |
| R8 | secrets isolation | Credentials AEAD-encrypted, tenant-bound, never in the model context, audited on access. | [R8 in spec](system-requirements.md#r8--secrets-isolation-from-the-ai-context) |
| R9 | tenant isolation | Multi-tenancy as a structural property: storage, query, response — regression-tested. | [R9 in spec](system-requirements.md#r9--multi-tenant-isolation-as-a-structural-property) |
| R10 | cost attribution | Per-tenant ceiling, per-flow attribution, invoice-matching usage ledger. | [R10 in spec](system-requirements.md#r10--cost-attribution-and-per-tenant-budget) |
| R11 | audit-grade evidence | Append-only action log sufficient to feed a SOC2 / ISO27001 / GDPR programme. | [R11 in spec](system-requirements.md#r11--audit-grade-evidence-not-compliance) |
| R12 | one governance gate | Same approval gate and audit trail behind every surface — CLI, API, MCP, chat. | [R12 in spec](system-requirements.md#r12--multiple-entry-surfaces-one-governance-point) |

---

## Group 1: Platform Core

**Tenant** — the top-level isolation unit in this reference implementation. All resources — workflows, connectors, credentials, users, skills, conversations, and knowledge sources — belong to exactly one Tenant. Multi-tenancy is structural, not configurable; no shared state crosses tenant boundaries, and every platform operation is scoped to the tenant of the authenticated principal.

**User** — a human principal within a Tenant. A User has a role (admin, member, or end-user) that governs which resources they can see and which actions they are permitted to take. Users authenticate through an Auth Provider (OIDC or API Key) and their identity is linked to their chat-platform accounts when chat integrations are enabled.

**API Key** — a bearer token scoped to a Tenant and a set of permissions. Used for programmatic access, service-to-service integration, and CLI authentication. API Keys carry explicit scopes and can be constrained to specific workflows or connectors. They support overlap-window rotation so access is never interrupted during a key change.

**Portal Token** — a short-lived, scoped credential issued to an end user for single-purpose access. Portal Tokens allow external users to interact with specific workflows without becoming full Tenant members. They are a tighter variant of an API Key, with a shorter default lifetime and a narrower permission surface.

---

## Group 2: Authoring

**Conversation** — the primary authoring session in this reference implementation. A User and the AI exchange messages; the AI uses structured authoring actions internally to propose, validate, and assemble a workflow. Conversations are persistent and resumable — a session can be paused and continued without losing context. The Conversation is where Drafts are created, refined, and committed.

**Draft** — a workflow under construction within a Conversation. A Draft exists only in the context of the Conversation until a User explicitly commits it. Committing a Draft creates a versioned, immutable Workflow. Drafts are never executed directly; only committed Workflows run in the execution engine.

**Skill** — a reusable, curated piece of context loaded into the AI during Conversations and other AI-assisted authoring flows such as discovery, diagnosis, and bounded repair. Skills encode best practices, integration patterns, domain-specific knowledge, and known failure modes. They are authored or promoted by operators with explicit human approval. Skills are never auto-generated or auto-promoted from execution history, and committed deterministic workflow execution does not load them.

**Skill Candidate** — a pattern detected from execution history that might improve AI context quality. The platform proposes Skill Candidates automatically when it detects recurring patterns in successful or failed executions. A Skill Candidate becomes a Skill only through explicit operator approval — the platform never promotes one automatically.

**Knowledge Source** — a persistent document store attached to a Tenant or Workflow. Operators upload documents (PDFs, runbooks, compliance policies, architecture diagrams) which are chunked and indexed for semantic search. The AI searches Knowledge Sources during Conversations, discovery, and repair-oriented authoring flows to ground its proposals in tenant-specific context. Committed workflow execution does not query Knowledge Sources directly.

**Discovery** — a one-shot analysis where the AI examines uploaded files (API specifications, runbooks, architecture diagrams, OpenAPI docs) and proposes Connectors, Skills, and Knowledge Sources inferred from their content. The result is a set of proposals — called Discovery Artifacts — that operators can approve or reject individually. Discovery does not configure anything automatically.

---

## Group 3: Integration

**Connector** — a configured connection to an external integration boundary. A Connector is built from a template, a driver, and credentials. It represents a specific integration instance — for example, a Stripe production account or a GitHub organisation. Connectors are tenant-scoped and versioned.

**Connector Template** — a pre-built blueprint for a well-known service. Templates include the driver type, authentication configuration, documentation ingestion setup, and guided setup instructions. The reference implementation ships 90 Connector Templates covering services across payments, CRM, DevOps, data, communication, and cloud infrastructure. Templates are the starting point for creating a Connector; they are not Connectors themselves.

**Driver** — the protocol layer that executes Connector requests. The reference implementation has nine built-in drivers: HTTP, GraphQL, PostgreSQL, S3, FTP, SFTP, SMB, MSSQL, and Redis. Each driver handles request construction, response parsing, pagination, and error normalisation for its protocol. Drivers are not pluggable at runtime — the nine built-in drivers cover the intended integration surface.

**Credential** — an encrypted secret stored in the platform's credential vault. Credentials include API keys, OAuth2 tokens, connection strings, and similar sensitive values. Connectors reference Credentials by identifier; the raw secret value is never exposed outside the vault. All Credentials are encrypted at rest. OAuth2 Credentials refresh automatically.

---

## Group 4: Execution

**Workflow** — a versioned, directed acyclic graph (DAG) of Steps that produces a deterministic outcome. Workflows are authored through Conversations, approved by a human, and then committed as immutable versions. Each version is a complete snapshot of the workflow at the time of approval. Workflows are tenant-scoped and support a lifecycle of draft, active, and archived.

**Step** — a single unit of work within a Workflow DAG. Step types are: request (call a Connector), transform (reshape data), branch (conditional routing), loop (iterate over a collection), parallel (run Steps concurrently), wait (introduce a delay), call (invoke another Workflow), and tool (run a sandboxed container step). Each Step declares retry policy, timeout, error handling behaviour, and optional field masking for sensitive data.

**Execution** — a single run of a Workflow. An Execution carries its own state, step-by-step results, logs, and final status. Executions are immutable records — they are never modified after completion. Each Execution records its request source (API, CLI, scheduler, webhook, MCP, or chat) and its environment (dev or prod). Executions are queryable and searchable after the fact.

**Execution Fixture** — a recorded snapshot of a past Workflow execution, capturing the request and response at each Step. Fixtures serve as the dry-run corpus for Self-Healing proposals: before a Patch Candidate is presented to an operator for approval, it is validated against relevant Fixtures to confirm the repair does not break known-good behaviour.

**Schedule** — a cron expression or event trigger attached to a Workflow. The scheduler fires the Workflow at the configured time or in response to an inbound event. Schedules are reconciled at engine boot and on configuration changes. Scheduled fires are recorded in the Audit Log with source `scheduler`.

---

## Group 5: Governance

**Audit Log** — the immutable, append-only record of every state change in the platform. Every entry carries: what changed, who initiated it, from which surface (API, CLI, MCP, chat, scheduler, webhook), and when. The Audit Log cannot be modified or deleted. It is the authoritative record for compliance, debugging, and incident review.

**RBAC** — role-based access control enforced at every platform boundary. Every API route, MCP call, webhook trigger, and execution path checks the caller's role and permissions before proceeding. The reference implementation ships four built-in roles. Custom roles and resource-level grants are supported for more granular control. RBAC decisions are recorded in the Audit Log.

**Before-Request Hook** — a sandboxed script that runs before a Connector request executes. Hooks can inspect or modify the outbound request, enforce policy (such as blocking writes during maintenance windows), or abort execution entirely. Hooks run in an isolated sandbox with a strict CPU budget and no access to the host environment. Hook execution is audited. Any error or timeout fails closed and denies the request.

**Self-Healing** — the platform's drift detection and bounded repair system. When a Connector's schema or behaviour changes in a way that causes Step failures, the engine detects the drift, compares the new response against the last known Schema Version, proposes a repair using the AI within a narrow repair loop, and dry-runs the proposed repair against recorded Execution Fixtures. The result is a Patch Candidate presented to an operator for approval. Self-Healing never applies a repair automatically without operator approval.

**Patch Candidate** — a proposed repair generated by the Self-Healing process. Each Patch Candidate carries the proposed change, a classification of safe or unsafe based on the scope and risk of the repair, the Execution Fixtures it was validated against, and a full audit trail. Patch Candidates require explicit operator approval before they are applied to a live Workflow.

---

## Group 6: Surfaces

**sk CLI** — the unified command-line surface and primary human-facing interface for the reference implementation. Built on Ink plus citty commands, it provides a terminal UI that opens a Conversation for end users describing workflow goals, and top-level admin commands for operators managing the platform (`sk connectors`, `sk workflows`, `sk executions`, `sk audit`, and related groups). The sk CLI supports four authentication modes: API Key, OIDC, Portal Token, and headless (stdin pipe for scripted usage). Persona-aware: the surface adapts based on the authenticated user's role.

**MCP Server** — the Model Context Protocol server embedded in the sk engine. It exposes Workflows as callable `wf.<slug>` entries inside the MCP callable surface, Connectors as structured resources, and Skills as curated prompts that can be injected into an AI's context. Any MCP-compatible client — including Claude Code, GitHub Copilot, Codex CLI, and Gemini — can connect to the MCP Server and interact with the platform. All MCP calls are governed by the same RBAC and Audit Log as direct API calls.

**Chat Adapter** — the integration layer for enterprise chat platforms (Slack, Microsoft Teams, Google Chat). Each adapter normalises platform-specific events — mentions, slash commands, interaction callbacks — into the reference implementation's Conversation model, and renders responses back as native platform messages. Approval flows surface as interactive cards with approve and reject buttons. Identity linking connects a chat user's platform identity to their Tenant account.

**Notification Rule** — a tenant-scoped row that selects which engine events fan out to which channel. Carries an event-type pattern, an optional workflow pattern, a severity, an optional `request_source_filter`, and the target `(workspace_id, channel_id)` tuple. Backed by the dispatcher in `apps/engine/src/notifications/service.ts` with a leaky-bucket rate limiter and a three-state circuit breaker. See [docs/09-notifications.md](09-notifications.md).

**Notification Delivery** — the per-attempt outcome of dispatching a Notification Rule against an event. Possible statuses: `sent`, `rate_limited`, `breaker_open`, `failed`, `skipped`. Each row is the audit-grade record of what was (or was not) delivered, mirrored in the audit log via `chat.message.sent`, `chat.message.denied`, or `webhook.outbound.failed`.

**Service Metadata** — the identity envelope every engine code path carries: `{ trace_id, tenant_id, actor_id, actor_email, request_source }`. Constructed at every entry point (HTTP middleware, MCP server, scheduler, CLI bin, conversation tool-chain recursion) and threaded through every log line, audit row, and telemetry event. Defined in `apps/engine/src/observability/service-metadata.ts`. The trace_id is what an operator follows across surfaces during incident triage.

**Result Storage URI** — the pointer in `executions.result_storage_uri` (and per-step rows) that resolves a spilled payload back to its full content. Inline payloads up to `STEP_RESULT_DB_BYTES` (10 KB) live in the row; larger payloads spill to S3 (`s3://<bucket>/<key>`) or the `execution_fixtures` table (`fixture://<uuid>`). A 512-byte text preview always lands inline.

**LLM Judge** — an opt-in scoring layer invoked by the eval runner only when (a) `SUBKIT_EVAL_LLM_JUDGE=1` is set AND (b) the deterministic validator returns `pass=false` with `function_passed=true` (structurally fine, semantically dubious). The judge emits a `passes`/`partial`/`failed` verdict that enriches the report; it never overrides the deterministic gate.

---

## What to Read Next

- [docs/03-input-surfaces.md](03-input-surfaces.md) — How users and systems reach sk: the CLI, REST API, MCP server, chat platforms, webhooks, and scheduled triggers.
