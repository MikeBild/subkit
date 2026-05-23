# sk — Operational AI Execution Layer (Positioning)

> *This is Document C of three. It explains how sk realises the system requirements
> ([`system-requirements.md`](./system-requirements.md)) that follow from the thesis
> ([`thesis.md`](./thesis.md)). Readers new to the topic should start with Document A.*

---

## 1. Summary

**sk is an operational AI execution layer** — the shared system that turns individual
agentic productivity into organisational agentic operationalisation (see
[`thesis.md`](./thesis.md) for the platform thesis behind that sentence). It is **not** a
chat product, **not** a replacement for general AI assistants, **not** a universal
AI-governance layer for an entire enterprise.

**Scope decision (deliberate, GTM-critical).** sk addresses one sharp slice: the
*governed execution of operationalised workflows* against production systems. Free
exploration, IDE coding assistance, and employee chat stay outside — they are
probabilistic by design and do not need execution governance. sk does *not* eliminate
shadow AI; it draws the *operational* subset of AI usage into a governed lane.

In one sentence:

> sk integrates three layers that organisations otherwise have to assemble themselves —
> **contextualised AI authoring**, **operational governance**, and **versioned,
> reproducible execution** — into a single product whose effect compounds per tenant
> over time. Context accumulation and the learning loop are the actual moat.

![Diagram 6 — Scope Map](./diagrams/06-scope-map.svg)

*Diagram 6. What sk governs (governed operational workflows) vs. what stays outside
(free exploration, IDE coding assistance, employee chat). The bridge between them is
controlled operational delegation via the MCP OAuth endpoint.*

Two hard sentences that recur throughout the three documents and ground this
positioning:

> *Enterprise AI does not fail at the models; it fails at the absence of controlled
> execution.*

> *Once AI touches operational systems, conversation governance is no longer enough.*

The three core ideas and the central axiom (carried verbatim from
[`thesis.md`](./thesis.md), they govern everything below):

> **Idea 1 — The Problem.** Agentic productivity does not automatically scale
> organisationally.

> **Idea 2 — The Category.** The bottleneck is not intelligence; it is operationalisation.

> **Idea 3 — The Moat.** The moat emerges from organisational context accumulation —
> not from any single feature.

> ***Central axiom: the operating model improves because the organisation learns — and
> that is the part the organisation can actually control.***

Bold formulation, also carried from [`thesis.md`](./thesis.md):

> *The next relevant software layer after SaaS is organisational agentic
> operationalisation.*

---

## 2. The Core: Contextualised Operational AI Authoring + Governed Execution

![Diagram 2 — Three Integrated Layers vs. Five-Tool Build](./diagrams/02-three-layers.svg)

*Diagram 2. Three integrated layers as a single product, contrasted with a chain of
five separate tools whose seams leak audit, identity and context.*

**What sk does in authoring.** sk runs a *contextualised* AI assistant in the authoring
phase — technically a domain-specialised "agent harness" in the sense of recent agent
literature (the interleaved reasoning + acting pattern of *ReAct*, Yao et al. 2023; a
means, not the headline). The difference from a generic coding assistant is the
**grounding on the tenant**: the assistant decides not from training knowledge alone
but from this organisation's own context — conceptually retrieval-augmented generation
(Lewis et al. 2020).

Five context sources ground the assistant ([`system-requirements.md`](./system-requirements.md)
R2):

- **Skills** — operator-approved best practices and failure modes.
- **Docs and knowledge** — ingested interface specifications, runbooks, policies.
- **Connectors** — governed integrations, not generic HTTP calls.
- **Workflows** — existing, versioned workflows used as reference cases.
- **Operational feedback** — drift-assisted repair suggestions from real runs flowing
  back into authoring.

The same assistant behaves differently per organisation and per team, because its
context is different.

**Why AI-assisted authoring at all? (the honest objection).** A CTO asks, rightly:
classical workflow systems are explicit, formal, reviewable — why have an LLM produce
operational processes, with implicit decisions and harder-to-validate semantics? The
answer is economic, not philosophical:

> *The bottleneck is not workflow execution. It is the cost, speed, and context depth of
> workflow **creation**.*

- **Classical builders / BPMN / low-code** push the intent → spec translation onto a
  human who understands both the builder *and* the target systems. That combination is
  scarce; it becomes the bottleneck. Maintenance under schema changes binds the same
  scarce resource.
- **Engineering implementation** is the most rigorous but the slowest and most
  expensive — every operational request from the business lands in a backlog.
- **Generic copilots** accelerate typing but do not know the org context; they suggest
  plausible, unverified code.

AI-assisted authoring grounded on tenant context hits the actual bottleneck. **But:
AI-assisted authoring is *creation help, not the output*.** The result is the same
explicit, formal, reviewable, versioned workflow artefact a classical workflow system
would produce. The probabilistic part is confined to authoring and ends with human
approval; AI-assisted authoring does not replace review — it gets faster to the thing
that gets reviewed.

**Why "AI-native" — and not just "Copilot for workflows"?** When the runtime is
deliberately not intelligent, the fair question is: why does the architecture need to
be AI-native at all? Because AI-native here does not mean "a generator bolted on the
front". It means a **closed loop**: author → govern → execute → observe drift → propose
repair → refine. Three things separate this fundamentally from a copilot sidecar:

- The assistant is contextualised on tenant-specific skills, knowledge, connectors,
  workflows — a generic copilot is not.
- Drift detection and repair loops feed signals from *production* back into authoring
  — a one-shot generator does not.
- Tenant context and operational feedback are *continuous, first-class inputs* to
  authoring — not a code-completion sidecar.

The runtime being non-intelligent is *the point*: it makes execution auditable. The
intelligence is concentrated and continuously improving in the authoring/repair loop.

**The irreducible moat.** Not "integration", but the *contextual learning loop*. The
build-it-yourself answer in §3 makes this concrete.

---

## 3. The Build-It-Yourself Question, Tool by Tool

The strongest sceptical attack: *"You are a workflow system with an LLM in front — I can
build this from standard parts (LangGraph + Vault + OAuth + an approval workflow)."* The
mechanic of sk really is buildable from standard parts. What is not buildable — and not
trivially added on — is the actual moat:

- **Organisational context accumulation.** Per tenant, a curated context grows over
  time: Skills, Knowledge, versioned Workflows as reference cases. The next authoring
  run is visibly better grounded than the previous one. A self-assembled stack does not
  have this accumulation as a first-class concept.
- **Drift-assisted remediation as a closed loop.** Schema and behaviour drift detected
  in production flows back as operator-reviewed Patch and Skill Candidates into
  authoring. The system learns from *real* production runs rather than generic training
  knowledge.
- **Reusable patterns and skills**, not ad-hoc knowledge in private chat histories.
  What worked once becomes visible, curated organisational knowledge inherited by
  other teams.
- **Compounding.** The model improves because vendors ship better models; the
  *operating model* improves because the organisation learns. The second part is what
  the organisation actually controls.

Tool by tool, what the build-it-yourself stack leaves open:

- **Temporal** solves durable execution (resilience), not contextualised authoring and
  not connector/credential governance. Workflows are written there as code by engineers.
- **LangGraph Platform** keeps the model in the runtime loop; sk takes it out — the
  execution is a frozen, versioned artefact, which is what the loop is meant to improve
  over time.
- **OpenAI Responses + internal RBAC** produces no versioned execution artefact, no
  audit at the workflow-version level, no connector control plane.
- **Retool Workflows + Copilot** separates authoring (Copilot, without org context)
  from execution (Retool); grounding and continuous governance across the seam are
  missing.

The irreducible core is not a single feature; it is the **integration**: contextualised
operational AI authoring with end-to-end governed, versioned execution — as one product,
not a self-assembled chain of five tools whose seams leak audit, identity, and context.

> *Other systems orchestrate tasks; sk accumulates operational context competence that
> grows with each run.*

---

## 4. Part 1 — The Problem (how sk maps the symptoms)

This is the compressed version; for the deeper framing of *why* ungoverned AI use
becomes operational action, see [`thesis.md`](./thesis.md) §4 and §3.

The problem is not just account sprawl. Account sprawl is the *visible* symptom of a
deeper transition: AI is moving from advice to action (Why Now?), and individual solo
productivity does not automatically become organisational operationalisation (the
category). Every ungoverned AI usage that touches a production system becomes
*operational action* — without approval, without version, without audit. The three
symptom axes below are consequences of that one transition, not an independent risk
list.

**4.1 Security symptoms.** Uncontrolled data egress into external chat UIs; no
who-did-what-when audit trail; credential sprawl across personal configurations; shadow
integrations against production systems; identity blurring between what the human did
and what AI did in their name; no controlled, versioned execution for operational steps.

**4.2 Cost symptoms.** Licence sprawl (n employees × m tools); no attribution per
team/project/workflow; no budgets/quotas; no caching leverage (each account rebuilds
context); hidden costs from rework on non-reproducible outputs.

**4.3 Organisational symptoms.** Knowledge trapped in private chat histories; no shared
organisational memory; inconsistency at scale; no enforceable governance, approval, or
four-eyes review; no central point for on-/offboarding; no tenant model for departments
or subsidiaries.

**4.4 What enterprise AI accounts already solve — and what stays open.** Honest
differentiation: OpenAI Enterprise, Anthropic Enterprise, and the Microsoft Copilot
stack are far beyond "just an account". They provide SSO/SAML, central retention,
partial DLP, audit logs of conversations, admin APIs, data residency, light RBAC, and
connector governance.

- **What they solve:** identity and billing — central login, seat management, cost
  bundling, coarse access control, conversation-grade compliance basics.
- **What they structurally do not solve:** their audit log records what was said to the
  model, not which workflow version ran with which inputs against which production
  system, approved by whom. Execution stays agentic. RBAC stays coarse (seat/feature).
  Connector governance controls access, not the governed, versioned execution against
  the connected system.

The defensible thesis is therefore not "enterprise AI accounts solve nothing":

> *Enterprise AI accounts solve **identity and billing** — but not **controlled,
> versioned execution of operationalised workflows**. That is where sk sits.*

---

## 5. Part 2 — Principles and Flows (no feature inventory)

Deliberately not a feature list. Feature lists kill momentum. Three short orientation
flows first, then per axis the carrying principles — each with its mechanism in one
sentence, cross-referenced to the requirement number from
[`system-requirements.md`](./system-requirements.md).

**Three orientation flows.**

- **Flow A — From idea to approved workflow.** A user describes the goal in chat ("on
  every Stripe charge.failed, notify Slack"). The contextualised assistant draws on the
  Stripe skill, the existing Slack connector, and a similar versioned workflow — and
  proposes a draft. The reviewer sees a structured diff and approves a version. The
  probabilistic part ends here.
- **Flow B — External AI client triggering an operational action.** An external client
  (a ChatGPT custom connector, Claude.ai, Cursor) wants to trigger the approved
  workflow on behalf of a user. It registers dynamically (standard OAuth 2.1, PKCE),
  receives a tightly scoped, expiring token, and can only trigger this one operational
  action. Each call is audited; access can be revoked at any moment — instead of a
  long-lived ungoverned API key in a client config.
- **Flow C — Drift in production, learning back into authoring.** Three weeks later
  Stripe changes the shape of charge.failed responses. Execution detects the drift,
  does *not* auto-repair, and instead presents the operator with a Patch Candidate
  including a diff and a dry-run against recorded fixtures. After approval, the new
  version runs; the insight enters the tenant context as a Skill Candidate inherited by
  the next workflow that touches the same interface.

**5.1 Security & Governance — principles.**

- *Identity is fine-grained per operational resource.* Permissions are enforced at every
  entry surface; every denial is audited. (R7)
- *Secrets stay outside the AI context.* Authenticated-encrypted at rest,
  cryptographically bound to tenant and record, redacted before persistence, audited on
  every access. (R8)
- *Delegated AI action is scoped, time-bound, revocable, audited* (Flow B; the mechanic
  is standard OAuth 2.1 with dynamic client registration, PKCE, refresh-token rotation,
  revocation). (R6)
- *Execution is policy- and version-bound — deliberately not "deterministic".* The
  approved workflow runs as approved; the control flow is fixed at authoring time and
  is not re-decided by inference at runtime. Step outputs may vary; the path does not.
  Every run is recorded as an immutable execution record; rollback by version change.
  (R3, R4)
- *Policy before every external call is possible* via a sandboxed, fail-closed hook for
  maintenance windows, approval gates, and data-residency rules. State-changing steps
  run only after explicit approval; Patch Candidates are never auto-applied.
- *Layered tenant isolation.* Tenant boundary enforced at storage, query, and response
  layers; covered by regression tests. Structurally enforced, not absolutely guaranteed.
  (R9)
- *Traceability, not compliance.* The append-only action log provides evidence and
  building blocks for a SOC2 / ISO27001 / GDPR programme; **sk is not a compliance
  solution** — compliance requires processes, operations, incident handling, vendor
  management. (R11)

**5.2 Cost — principles.**

- *One LLM provider identity per tenant*, not n personal keys — costs attributable and
  cappable. (R10)
- *Hard per-tenant monthly ceiling.* When the limit is reached, further LLM calls are
  refused — no end-of-month cost shock. A per-run budget additionally protects against
  prompt-bloat in a single execution.
- *Every LLM call is booked* in an append-only usage ledger (tenant, flow, model,
  tokens, latency, result). The monthly aggregation is the authoritative billing input,
  attributable by flow and model — and matches the provider invoice because cache effect
  is weighted into the bookkeeping.

**5.3 Organisation — principles.**

- *Organisational memory instead of private chat histories.* Skills (curated best
  practices, failure modes) and knowledge (runbooks, policies, interface specifications)
  are visible, searchable, tenant-specific. (R2)
- *Operational feedback flows back into authoring* (Flow C). Drift-assisted repair
  suggestions are operator-reviewed; no autonomous intervention. Skill Candidates
  emerge from recurring patterns and are never auto-promoted. (R5)
- *Connectors as a governed integration layer.* Credentials isolated in the vault,
  versioned integration behaviour with per-endpoint drift detection, one curated,
  audited integration point instead of scattered shadow integrations. (Honest open
  enterprise question: depth and SLA for large suites such as SAP / ServiceNow / Workday
  / Snowflake — see §8.)
- *Multiple entry surfaces, one governance point.* CLI, API, MCP, chat — same approval
  gate, same audit trail; on-/offboarding in one place. (R12)
- *Observability.* Metrics in a standard scrape format, structured JSON logs, per-step
  execution logs, live-tail of running workflows.

---

## 6. Worked Examples — Two Lifecycles in Detail

Concrete on purpose, so the principles do not stay abstract. Both examples show the full
lifecycle: authoring → approval → scoped execution → audit trail → drift detection →
reusable learning.

### Example 1 — "Deploy Service X to production"

*Starting point.* A platform team wants to roll the `customer-portal-svc` service
automatically to production once QA has signed off. Today: manual runbooks plus a wiki
page; the actual rollout is a heroic act.

1. **Authoring (contextualised).** In chat: *"When QA signs off `customer-portal-svc`,
   roll the image to production — canary 10 %, then 100 %, Slack notify on failure."*
   The assistant is grounded on the tenant: it uses the team's Kubernetes skill, the
   existing canary-rollout workflow of the platform team, and the in-house
   release-policies knowledge (maintenance windows, health-check thresholds). It
   proposes a workflow draft — not a generic kubectl call, but a sequence that fits the
   architecture of this house.
2. **Review and approval.** The reviewer sees a structured diff of the control flow:
   `validate-manifest → preflight → deploy-canary(10 %) → wait_for_event(metrics-ok,
   15 min) → ramp(100 %) → notify(slack#deploys)` — plus the referenced skill and
   knowledge snippets that justify each choice. Approval produces Version 1; the
   probabilistic part ends here.
3. **Scoped execution.** QA triggers via a signature-verified webhook. The engine
   assumes the workflow identity, fetches the Kubernetes credential from the vault
   (time- and scope-bound: only the `customer-portal` namespace, only deployment verbs);
   the secret never enters the AI context, never enters a log. A before-request hook
   checks the maintenance window — were it Friday evening, the hook would fail closed.
4. **Audit trail.** Every step writes an immutable line: actor (workflow identity, on
   behalf of which user), workflow version, inputs, outputs, latency, result. Trace
   correlation links the QA sign-off webhook, the workflow run, and every Kubernetes
   call. Result: in a post-mortem one can answer exactly *which version, with which
   inputs, approved by whom, ran against which cluster*.
5. **Drift detection (weeks later).** Kubernetes deprecates a field used in the
   manifest; the next rollout fails at `validate-manifest`. The engine detects a schema
   drift relative to the recorded response shape and runs the bounded repair loop: a
   repair proposal is classified, a fixture dry-run validates it against recorded
   responses. Rather than deploying the patch, it is presented as a **Patch Candidate**
   — no autonomous intervention in production.
6. **Operator approval and learning.** The platform operator sees: the manifest diff,
   "safe" classification, dry-run green. They approve; Version 1.1 is live.
   Simultaneously a **Skill Candidate** emerges from the repair ("replace K8s manifest
   field X by Y"); after operator approval it becomes part of the tenant context. The
   next deploy workflow that needs the same field semantics — `analytics-svc`,
   `billing-svc` — inherits the learning automatically at authoring time. Compounding
   becomes concretely measurable: each drift in one workflow makes the next workflow
   better.

### Example 2 — "Onboard a new B2B customer" (compact)

Sales closes an enterprise deal in Salesforce. A workflow should automatically create a
Stripe customer entity, provision a workspace in the internal tenant system, send a
welcome email via SendGrid, and register the customer in the analytics system.
*Authoring:* the assistant uses the Salesforce skill, the Stripe skill, the internal
tenant-system connector, the SendGrid connector, and the analytics skill — five systems,
five authentications, all known from the tenant context. The draft is a declarative
sequence with fan-out (parallel calls to independent systems) where possible. *Review:*
control-flow visible, versioned, approved. *Execution:* the Salesforce webhook
(signature-verified) triggers; each system speaks with its own vault-isolated
credentials; partial successes are modelled explicitly (e.g. "Stripe ok, SendGrid down"
→ compensating retry logic per approved pattern, not ad hoc). *Audit:* who closed which
deal, which workflow version was activated, which external calls succeeded or failed —
visible in a single trace span. *Drift later:* SendGrid renames a webhook field; drift
detected, Patch Candidate, operator approval, Version 2 runs. The repair produces a
"SendGrid webhook schema 2026" skill that applies to *all* workflows that talk to
SendGrid — not just the onboarding workflow.

**What exists organisationally afterwards** — that would not have existed under solo
work: a versioned, reviewable onboarding workflow; isolated, rotatable credentials for
five systems; an audit trail giving every onboarding run a reviewable history; a
growing catalogue of skills and patterns that lets the next B2B variant (partner
onboarding, trial onboarding) cost a fraction of the original.

---

## 7. Part 2b — Structural Changes (sk-specific, not generic outcomes)

This section deliberately avoids the interchangeable enterprise outcomes ("less risk /
better scaling / predictable cost") that any vault + RBAC stack could claim. Instead:
six structural changes that follow from sk being in place — and that are hard to claim
for a self-assembled stack without the integration of authoring + execution + learning
loop.

- **The operational workflow becomes, for the first time, a versioned organisational
  artefact.** Something the organisation *owns* — rollbackable, inheritable, reviewable
  — not a script in someone's repo, not a Confluence sketch, not "the AI is on it right
  now". The shift from heroic act to artefact is structural, not gradual.
- **Operational action decouples from individual vigilance.** The same action runs the
  same defined way on every repetition — at night, on vacation, after the original
  author's offboarding. Knowledge leaves private chat histories and becomes visible,
  searchable tenant property.
- **Drift becomes context accumulation, not isolated repair.** Each survived drift
  sharpens the tenant context (Patch → Skill Candidate) that the next workflow
  inherits. Maintenance *compounds* instead of degrading — the compounding loop becomes
  operational reality.
- **External AI clients become connectable without creating a second governance
  island.** A coding assistant, a chat connector, an external agent can trigger
  operational actions through the MCP OAuth endpoint scoped and audited — no new
  shadow-integration sprawl, no parallel identity/audit world.
- **Operational AI cost gets a vendor-decoupled structure.** One org identity per
  provider, one ledger per tenant, one monthly budget — tools can change, prices can
  shift; the operating model stays, and the cost stays attributable.
- **Onboarding a new team reduces to identity + roles + inherited context.** The team
  immediately inherits the tenant's skills, workflows, knowledge; it does not build its
  leverage from an empty repository.

---

## 8. Part 3 — What sk Still Lacks (Honestly)

The most important structural residual first, because it is GTM-critical: **sk does not
eliminate shadow AI.** sk governs only what flows through its surfaces. What a developer
does in Claude Code / Codex directly in the editor stays outside the sk audit boundary.
A reader who expects an all-covering AI governance layer reads the wrong category into
this document — the scope decision (operational execution layer, not universal governance
layer) is deliberate. The honest answer is a clear category (sk is valuable for the
*operational* part) plus the MCP OAuth endpoint that draws the operational portion of
external AI clients into the governed lane. A story for raw coding assistance still
needs to exist elsewhere in the organisation.

**P0 — critical for the enterprise story (blocks buyers):**

- **Cost/chargeback dashboard.** Budgets, usage ledger, and metrics exist; an
  operator-facing UI that visualises spend by tenant/workflow/model/team does not — only
  via external metric stacks today. Without a built-in dashboard, the cost-transparency
  claim stays weak.
- **Per-user / per-role quotas.** The budget is per-tenant only. No "members at most X
  runs/day", no "service account 1M tokens/month". Cost control stays coarse.
- **DLP / PII detection.** No built-in policy layer that recognises PII or sensitive
  fields and blocks them — only via hand-written before-request hooks. A hard blocker
  in regulated industries.
- **SCIM / automated pro-/deprovisioning.** OIDC login exists; SCIM, bidirectional role
  sync, and automatic offboarding do not.

**P1 — important (trust/compliance gaps):**

- Multi-step approval chains / four-eyes principle: a single human gate today.
- Compliance export templates: audit log is comprehensive; no ready-made SOC2 / HIPAA /
  PCI export formats.
- Tenant-wide usage reports: no "who runs what, which workflows consume tokens/time"
  out of the box.
- DR / RTO / RPO: only database backups documented; no SLA, no geo-redundancy.
- Operational hardening: unexplained memory spikes in production (mitigated, not root-
  caused) — root cause and capacity model still open.

**P2 — optimisation / differentiation:**

- Cost-based provider routing.
- Custom-driver plugin model.
- Email notifications.
- Tenant-scoped recipe overrides (already on the roadmap).

---

## 9. Visualisations index

This document references the shared diagram assets:

- **Diagram 2** — Three Integrated Layers vs. Five-Tool Build (§2 The Core).
- **Diagram 3** — The Compounding Loop (§7 Part 2b, "drift becomes context
  accumulation"); also referenced from §6 Example 1.
- **Diagram 6** — Scope Map (§1 Summary).
- **Diagram 1** (Solo → Scaling Cliff → Shared Operational System → Organisational
  Operationalisation) — referenced from §1 Summary for readers who skip the thesis.

All diagrams live under `docs/diagrams/`. Source-of-truth captions match
[`thesis.md`](./thesis.md) and [`system-requirements.md`](./system-requirements.md).

---

## 10. Verification

A reader can validate this document against the plan and the codebase:

- Every claim in §5 (principles) maps to an R-number from
  [`system-requirements.md`](./system-requirements.md); every R-number traces to a
  thesis section in [`thesis.md`](./thesis.md).
- The compounding formula appears verbatim:
  > **Run → Drift → Patch Candidate → Skill Candidate → Better Authoring → Better Run.**
- The central axiom appears verbatim wherever it is cited.
- No implementation details (library names, file paths, branch names, table names,
  hosting details) appear outside the dual-vocabulary note in
  [`02-concepts.md`](./02-concepts.md).
- Banned terms (*Software Factory*, *Agent Control Plane* as positioning, *Capability*
  in the strategic sense, *Substrat / execution substrate*, *deterministic* as a banner,
  *compliance by construction*, *Self-Healing* in external-facing copy) appear only in
  explicit "we do not call it that" notes.
- Markdown renders cleanly; all relative-path cross-references resolve.

---

## 11. Sources and 12. Cross-references

- Underlying theory: [`thesis.md`](./thesis.md).
- Vendor-agnostic system requirements: [`system-requirements.md`](./system-requirements.md).
- Vocabulary: [`02-concepts.md`](./02-concepts.md).
- Architecture for developers: [`01-platform.md`](./01-platform.md).
- Repository-wide developer contract: [`../AGENTS.md`](../AGENTS.md).

Bibliography is shared with [`thesis.md`](./thesis.md) §11 (research literature plus
industry/market context).
