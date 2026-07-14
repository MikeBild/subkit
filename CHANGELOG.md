# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.13.1] – 2026-07-14

### Added
- Coding-agent integration guide (`docs/developers/coding-agent-integration.md`)
  — the full briefing → lookup → capture → review → sync loop for Claude Code
  and Codex, beginner-first; served via `/llms.txt` and `/llms-full.txt`.

### Changed
- The embedded platform-reference knowledge seeds (`sk-ref-cli`,
  `sk-ref-rest-api`, `sk-ref-mcp-tools`, knowledge-and-skills) and the
  default skills (`sk-cli-reference`, `domain-setup-onboarding`) now cover
  the coding-agent surface, so in-product grounding answers match the
  shipped commands and routes.

### Fixed
- The dead-letter reconciliation now stamps `mcp_tasks.failure_reason` and
  writes the `conversation.turn_failed` audit entry in one transaction —
  no more observation window where the state change is visible without its
  audit evidence.

## [1.13.0] – 2026-07-14

### Added
- `sk skills sync` materializes active, domain-tagged skills as
  Agent-Skills-standard `SKILL.md` directories into `.claude/skills/`
  and `.agents/skills/` of the repo declaring the domains. Only
  sk-managed directories (marker comment) are created, updated, or
  pruned — hand-authored skills are never touched.

### Fixed
- Deleting a promoted skill no longer fails on the candidate's foreign
  key: `skill_candidates.promoted_skill_id` is set null on skill delete
  and the candidate keeps its approved status as history.

## [1.12.1] – 2026-07-14

### Fixed
- `GET /v1/skill-candidates` accepts every `pattern_kind` filter value —
  a hand-copied subset enum silently rejected `session_learning` and
  `authoring_capability`, breaking `sk learnings list`.

## [1.12.0] – 2026-07-14

### Added
- Coding-agent session capture: `POST /v1/agent/sessions` accepts a
  session transcript and distills durable, human-taught learnings into
  `session_learning` skill candidates (new `skill:propose` permission;
  analysis runs on the `agent-session.analyze` queue). Nothing goes live
  without human review.
- `save_learning` tool (conversation + MCP): explicitly capture a rule
  the user taught mid-session as a proposed candidate. Additive and
  confirmation-free; proposing never implies the authority to approve.
- `sk learnings review` / `sk learnings list`: interactive curation of
  proposed learnings — approve (optionally after editing) promotes to an
  ACTIVE, domain-tagged skill that the next session briefing carries;
  reject retires the learning for good.
- `sk agent capture` and SessionEnd hook wiring in `sk agent init`:
  finished Claude Code sessions in domain-declared repos are captured
  automatically (Codex uses the printed Stop-hook snippet).

### Changed
- Skill candidates carry `tags`; approval copies them onto the promoted
  skill. Session learnings are fingerprint-identified (normalized title +
  domains): re-taught rules accrue evidence instead of duplicating, and
  distinct learnings coexist in the review queue.

## [1.11.0] – 2026-07-14

### Added
- `GET /v1/agent/briefing` — budgeted, domain-scoped grounding block for
  external coding agents (Claude Code, Codex): active skills tagged
  `domain:<slug>` as conventions, a knowledge index (full documents stay
  behind `search_knowledge_v2`), a search-first grounding rule, and the
  open-candidate counter. Deterministic budget trim: index entries drop
  first, then skill bodies collapse to pointer lines, last skill first.
- Domain convention: the tag `domain:<slug>` on skills and knowledge
  sources scopes them to a business domain; a repo declares its domains
  in `.sk/agent.json`.
- `sk agent briefing` (SessionStart-hook mode reads the hook payload from
  stdin and never fails the session) and `sk agent init` (writes
  `.sk/agent.json`, wires the Claude Code SessionStart hook idempotently,
  prints the Codex hook snippet and MCP registration commands).

### Changed
- MCP connect instructions now carry the search-first grounding rule;
  `search_knowledge_v2` and `find_skill` are exempted from client-side
  deferred tool loading (`anthropic/alwaysLoad`).

## [1.10.0] – 2026-07-13

### Added
- The full HTTP API is now documented: all previously spec-invisible
  routes (the `/v1/rbac/*` family, discovery runs, knowledge-source and
  conversation uploads, the credential-setup form) carry OpenAPI
  registrations, and the undocumented-route ratchet tests are pinned
  empty so new drift fails CI.
- Typed `request_credential_form` conversation event: when the sk
  composer intercepts a pasted secret, the engine now opens the masked
  credential form deterministically (no model call); the prose fallback
  still works for older CLIs.
- Cross-tenant executor isolation is proven end-to-end over MCP: a
  principal that passes RBAC still cannot reach another tenant's
  connector (tenant-scoped SELECT defense).

### Changed
- Discovery archives and knowledge uploads persist their bytes into the
  canonical `files` table (deduplicated, scanned, linked and audited)
  instead of writing past it; `knowledge_sources.file_id` is populated
  for file-backed sources.
- The `http/routes` coverage floor is enforced (was deferred at 0), and
  the coverage runner no longer dies on large test output.

## [1.9.6] – 2026-07-13

### Fixed
- Honest run results: `on_error: continue` failures surface as warnings instead of a
  false-positive success or a false error.
- MCP conversation approvals are reconciled after engine restarts — no more zombie
  pending approvals.

## [1.9.5] – 2026-07-09

### Fixed
- Wildcard-scope principals resolve to the authoring catalog on the MCP surface.

## [1.9.4] – 2026-07-09

### Changed
- MCP advertises the full authoring catalog; removed `find_tool` and the
  token-budget catalog trim.

## [1.9.3] – 2026-07-09

### Changed
- Writes over MCP are gated via the client's native `destructiveHint` dialog
  instead of the approval portal (re-cut of 1.9.0/1.9.2).

### Fixed
- Reground the `mcp-tool-contract` skill to the client-dialog write gate;
  English-only skill content.

## [1.8.2] – 2026-07-09

### Fixed
- Portal-only write approval on MCP plus `find_tool` catalog discovery.

## [1.8.1] – 2026-07-09

### Added
- Human-in-the-loop write governance for MCP via the approval portal (1.8.0,
  re-cut as 1.8.1).

### Fixed
- RBAC runs before tool-name canonicalization on the MCP surface.

## [1.7.1] – 2026-07-07

### Added
- Cross-layer regression test for the install-answer output guard.

## [1.7.0] – 2026-07-07

### Added
- Credential-setup portal for connector re-authentication.
- Graceful drain on deploy — in-flight executions finish before shutdown.
- Row-first workflow descriptions.

## [1.6.0] – 2026-07-07

### Changed
- `tenant_read` inventory tools are RBAC-gated on the chat and MCP surfaces;
  self-status answers are grounded.

## [1.5.0] – 2026-07-07

### Added
- `sk chat install-space` with pending-space discovery for Google Chat.
- Google Search Console connector template.

## [1.4.3] – 2026-07-07

### Fixed
- Chat-surface guard exempts the sk installer instructions (1.4.1–1.4.3:
  authoring-leak fix, engine-URL grounding, output-guard follow-ups).

## [1.4.0] – 2026-07-06

### Added
- Grounded skills-vs-knowledge answers and guided domain setup in chat.

## [1.3.6] – 2026-07-06

### Fixed
- Chat channel end-to-end polish (1.3.0–1.3.6): run workflows from prose, native
  chat formatting, surface-gated install grounding, table rendering, honest
  self-update failures with private-repo token support, sk served from the
  engine `/install` endpoint.

## [1.2.0] – 2026-07-05

### Security
- Secret input mode: elicitation answers and secret tool arguments never
  transit the transcript or LLM context.

## [1.1.1] – 2026-07-05

### Fixed
- Data-fidelity root causes in held writes and vendor payload shaping;
  `conversation_commit` derives its reply from the persisted rows; bounded
  per-turn memory in model-message assembly.

### Changed
- Generic stdlib surface names — vendor wire formats hidden behind shape
  detection; dependency refresh (TypeScript 6, Biome 2.5, js-yaml 5).

## [1.0.0] – 2026-07-04

First public release.

- **Engine** — self-hostable workflow engine: versioned workflow definitions,
  deterministic execution with step-level auditing, multi-tenant RBAC,
  encrypted credential storage, OAuth2 flows, inbound webhooks, scheduler,
  and self-healing patch candidates behind human approval.
- **AI-assisted authoring** — describe an outcome in natural language; the
  engine drafts a grounded workflow, dry-runs it against recorded previews,
  and commits only on explicit approval. Execution never re-decides control
  flow at runtime.
- **Connectors** — a template catalog across HTTP, GraphQL, PostgreSQL, and
  S3 drivers, with endpoint discovery, docs ingestion, and vendor-drift
  sweeps.
- **Surfaces** — `sk` CLI (REPL + admin), REST API with generated OpenAPI,
  MCP server for AI clients, chat adapters, and inbound webhooks.
- **Operations** — structured logs, metrics, traces, token-budget
  accounting, immutable audit trail, signed release binaries, and Docker
  images.
