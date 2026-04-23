# AI-Assisted Authoring

Traditional workflow automation tools put the burden of construction on the builder. You need to know the integration, understand the configuration syntax, and map it all onto a blank canvas. The result is automation that reflects what developers can build, not what the business actually needs.

sk inverts that burden. The authoring layer is a conversational interface where a user describes a goal in natural language and the AI does the structural work: proposing steps, looking up connectors, validating the draft, and asking clarifying questions. The user's job is to review and approve — not to build.

This is what separates sk from traditional workflow tools, and it is what this document explains: how Conversations produce governed, production-ready automation, and why the human-in-the-loop model is the right architecture for enterprise AI.

---

## The Conversation Model

A Conversation is the primary authoring interface in sk. When a user starts one, they describe what they want in natural language. The AI responds not with advice or summaries but with a structured proposal — a Draft workflow that can be inspected, modified, and eventually approved.

Conversations are persistent and resumable. They survive page reloads, reconnects, and multi-day authoring sessions. A user can start a Conversation on Monday, return on Wednesday, and pick up exactly where they left off. The AI recalls the context, the draft state, and the pending questions.

Internally, the AI operates over a palette of structured-intent tools. It does not generate free-form code or make autonomous decisions. It calls tools like "propose a step," "look up a connector," "validate the draft," and "ask for clarification." This structure is what makes the authoring process reliable and auditable — the AI's reasoning is visible as a sequence of tool calls, not as an opaque text generation.

---

## The Authoring State Machine

Conversations are no longer just a loose draft plus a few helper tools. The engine maintains an explicit Authoring State Machine for every conversation and uses it to decide which tools are visible, which actions are blocked, and what the next valid move is.

The canonical progression is:

1. Connector drafting
2. Connector inspection
3. Connector validation
4. Connector probe
5. Connector persisted
6. Workflow drafting
7. Workflow inspection
8. Workflow validation
9. Workflow preview
10. Workflow persisted
11. Workflow executed
12. Diagnosis and repair when needed

This state is persisted in the conversation draft summary and exposed as:

- `mode` — `connector`, `workflow`, `execution`, or `diagnosis`
- `stage` — the concrete state-machine stage such as `connector_probed` or `workflow_previewed`
- `lifecycle_state` — whether the active target is still `draft_only` or already `persisted`
- `blocked_by` — the exact missing checkpoints or fields that currently prevent the next durable action
- `next_required_action` — the next state-advancing action the assistant should take or ask the user to approve
- `checkpoints[]` — freshness state for `inspect`, `validate`, `probe`, `preview`, `persist`, `execute`, and `diagnose`

The authoring loop is designed so that the model does not have to infer progress from transcript history. The current stage, active target, and checkpoint freshness are part of the runtime contract, not just prompt advice.

---

## The Human-in-the-Loop Approval Gate

The most important architectural decision in sk is the approval gate.

Nothing reaches the execution engine without an explicit human approval. When the AI finishes building a Draft, it does not automatically promote it to a live workflow. It pauses the authoring loop and presents the Draft for human review. The operator sees every Step, every connector reference, every parameter, and every branching condition. They can push back, ask for changes, and iterate. When they are satisfied, they explicitly approve.

This is not a UX convenience — it is the governance model. The approval gate is what makes AI-authored workflows auditable and enterprise-safe. It is the structural answer to the question every compliance team asks: "How do we know the AI did the right thing?" The answer is: because a human checked and signed off before anything ran.

After approval, the Draft is committed as a new versioned Workflow. The Conversation transitions to an active state, and the workflow is ready to run.

The approval gate sits on top of additional hard quality gates:

- A connector cannot be saved from the guided conversation flow until inspection, validation, and probe checkpoints are fresh.
- A workflow cannot be committed from the guided conversation flow until inspection, validation, and preview checkpoints are fresh.
- A workflow run always targets a persisted workflow version, never an ambiguous draft.
- The normal conversation surface no longer exposes force-style bypasses for save or commit. Operators can still use explicit admin or development paths where appropriate, but the guided flow itself is strict.

This matters because the approval is not meant to compensate for missing technical checks. It is the final human sign-off after the state machine has already established that the draft is internally coherent.

---

## Probe Before Save, Preview Before Commit

The clean authoring experience depends on treating intermediate verification as first-class product steps rather than optional debugging.

For connectors, the canonical path is:

1. Start or update the connector draft
2. Inspect the current draft
3. Validate required fields and config shape
4. Probe the real upstream boundary
5. Save the connector

For workflows, the canonical path is:

1. Start or update the workflow draft
2. Inspect the current draft
3. Validate the graph and step schemas
4. Preview with `dry_run_step`, `dry_run_transform`, or `dry_run_workflow`
5. Commit the workflow
6. Run the persisted workflow

The engine tracks these as fresh or stale checkpoints. Any draft mutation invalidates later checkpoints automatically. For example, editing a workflow after a successful preview makes the preview checkpoint stale, so the workflow must be previewed again before it can be committed.

The result is a much more deterministic authoring loop: the assistant does not "think" a connector is ready or a workflow is runnable; it reads that from checkpoint state.

---

## Diagnosis Is Part of Authoring

Execution is not the end of the authoring loop. When a persisted workflow runs and produces warnings or a suspicious result, the conversation enters diagnosis mode instead of falling back to generic retry behaviour.

Diagnosis mode keeps the latest execution and its causal context attached to the draft summary:

- `latest_execution` records the exact persisted workflow id and version that ran
- `diagnosis_available` signals that the latest run should be inspected before editing
- `latest_diagnosis` captures the structured reason, warning sources, and step-level summaries from the diagnosis pass

This is especially important for expression-heavy workflows. A run may technically succeed while still carrying warnings such as unresolved identifiers in scope paths. In that case the right recovery is not "run it again" but "diagnose, repair the draft, preview again, commit again, then run again."

Diagnosis is therefore a first-class authoring phase, not an operator-only debugging escape hatch.

---

## Stage-Aware Prompting And Tool Narrowing

The authoring loop now constrains both prompt guidance and visible tool surface by mode and stage.

When the conversation is in connector mode, the model is guided to stay inside connector work until the connector is persisted. During workflow drafting, the prompt shifts to inspection, validation, preview, and commit guidance. During execution and diagnosis, the prompt focuses on the latest persisted run and its repair path.

The same state machine also narrows the visible tool palette. The model does not just see every authoring tool all the time and rely on runtime rejection. Premature actions such as connector save, workflow commit, or diagnosis only become visible when the relevant stage and checkpoint state permit them.

This is one of the key reasons the authoring flow stays consistent across turns: prompt, tool visibility, and runtime gates all read from the same state model.

---

## Multi-AI Provider

sk is not tied to a single AI model. The platform supports Claude (Anthropic), OpenAI GPT models, and Google Gemini. Providers are interchangeable: swapping models does not require changes to Connectors, workflows, or skills.

The platform routes to the best available provider based on operator configuration and task type. Token budgets are enforced per tenant and per Conversation to prevent runaway costs. An operator can set a monthly ceiling; the platform tracks consumption and surfaces usage in the audit log.

The AI provider is an implementation detail of the authoring layer. Once a workflow is approved and committed, the execution engine runs it without any AI involvement. The provider you chose during authoring has no bearing on what runs in production.

---

## Skills: Curated Context

The AI is only as useful as the context it has. Without organization-specific context, it can propose generic workflows — but it cannot propose a workflow that follows your GDPR handling policy, or one that uses your organization's specific Salesforce field mappings, or one that respects your internal API versioning conventions.

Skills are the mechanism for injecting that context. A Skill is a curated, reusable piece of context loaded into the AI's context window during a Conversation. Skills encode best practices, integration patterns, security policies, and domain knowledge specific to your organization. When the AI is proposing a workflow that involves your Stripe connector, the Stripe Skill is loaded automatically — and the AI's proposals reflect your organization's conventions, not just generic Stripe API knowledge.

Operators create and manage Skills. They can be scoped globally (available in all Conversations), per-Connector (loaded when that Connector is referenced), or per-Workflow.

Skills are not auto-generated and not auto-promoted. The platform detects recurring patterns from execution history and surfaces them as Skill Candidates for operator review. A candidate becomes an active Skill only through explicit operator promotion. The system learns from what works, but humans decide what becomes canonical guidance.

---

## Knowledge Sources: Enterprise Documents

Skills are concise and curated. For richer, document-scale context — runbooks, API specifications, compliance frameworks, architecture diagrams — sk provides Knowledge Sources.

A Knowledge Source is a persistent document store. Operators upload PDFs, runbooks, API specs, compliance documents, and architecture diagrams. The platform chunks and indexes them for semantic search. During a Conversation, the AI searches Knowledge Sources to ground its proposals in organization-specific context. A workflow that correctly follows your GDPR compliance runbook is possible because the runbook is a Knowledge Source the AI can search.

Knowledge Sources have configurable refresh strategies: manual, scheduled, or webhook-triggered. When a runbook is updated, the source can be refreshed automatically so the AI is always working from current documentation. Sources can be scoped to a tenant (available globally) or to specific workflows.

The distinction between Skills and Knowledge Sources matters. Skills are dense, operator-authored guidance — specific instructions the AI should follow. Knowledge Sources are broader organizational artifacts — the AI searches them for relevant context but does not treat them as prescriptive rules.

---

## The Connector Catalog

When a user mentions an external system — "pull data from our Salesforce instance" or "post a message to Slack" — the AI needs accurate, system-specific knowledge to propose a useful integration. Generic HTTP knowledge is not enough.

sk ships 89 Connector Templates covering the most common enterprise services. When a user mentions a system, the AI draws on the matching template to propose an accurate integration. Templates include the driver type, authentication configuration, documentation references, and setup guidance. The AI understands the system's actual API, not just the idea of it.

Documentation Ingestion is part of Connector setup. OpenAPI specs, GraphQL schemas, and HTML documentation are automatically indexed and become part of the AI's context for that Connector. The AI can refer to specific endpoints, parameters, and error codes because the documentation is available to it.

The central Credential Vault means users never handle raw secrets during authoring. The AI can propose "use your Stripe connector" without knowing or seeing the API key. Credentials are referenced by name, not by value, throughout the entire authoring process.

---

## Discovery: From Files to Proposals

Discovery is how sk accelerates onboarding new systems. Rather than requiring an operator to manually configure every connector and skill for a new integration, Discovery starts with the documentation that already exists.

An operator uploads files — API specs, data dictionaries, architecture diagrams, runbooks — and sk analyzes them to produce a set of structured proposals. Each Discovery Artifact is a proposed Connector, Skill, or Knowledge Source, with a confidence score and links to the specific evidence in the uploaded files. The operator reviews each proposal and decides what to approve.

Nothing is automatically configured. The proposals are starting points, not decisions.

Discovery is designed for the scenarios enterprises actually encounter: a new vendor relationship, an acquired company's systems, a newly discovered internal API. The goal is to turn documentation into a working starting point in minutes rather than weeks — while keeping every configuration decision in human hands.

---

## How Authoring Improves Over Time

sk's authoring layer is not static. It improves as the platform accumulates execution history and operator feedback.

Skill Candidates surface patterns from production. When the platform detects that certain Connectors or step sequences are used together frequently — and that those combinations tend to succeed — it proposes a new Skill. The proposal includes confidence scores and links to the executions that support it. Operators review and promote or reject.

Self-healing drift detection keeps workflows healthy as connected systems evolve. External APIs change: endpoints move, field names shift, new error codes appear. When a Connector's behavior diverges from what the workflow expects, the engine detects the drift and proposes a repair as a Patch Candidate. The AI analyzes the failure and proposes the smallest safe change. Operators review the proposal before anything is applied.

In both cases, the pattern is the same: the platform surfaces improvement proposals, humans make the decisions. The system gets smarter over time, but only with human approval at each step.

---

## What to Read Next

- [docs/05-connectors.md](05-connectors.md) — how Connectors, Drivers, Credentials, and Tunnels form the integration fabric that authoring draws on.
- [docs/06-execution.md](06-execution.md) — how approved workflows run deterministically, what governance looks like at execution time, and how self-healing keeps workflows healthy.
