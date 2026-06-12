# subkit Agent Guide

Canonical repo-wide instructions for coding agents working in this project.
Use this file as the default contract. `.claude/CLAUDE.md`, `SKILLS.md`, and tool-specific
instruction files are compatibility layers or indexes — not competing sources of truth.

## Product Boundaries

- **subkit is the operational AI execution layer — a shared system for organisational
  agentic operationalisation.** It is not a chat product, not an LLM provider, and not a
  general workflow-automation tool. It owns: identity & access (RBAC/ABAC, encrypted
  credentials, portal tokens, API keys), unified data/tool interfaces (9 typed drivers,
  90 connector templates), governed execution (immutable audit log, human-in-the-loop
  approvals, versioned workflows with full snapshots), observability (Prometheus,
  structured logs, drift detection), and multi-tenant conversation-first surfaces (CLI,
  `sk`, Slack, Teams, Google Chat, MCP).
- For the full strategic framing of this category — the theory of organisational
  agentic operationalisation, the requirements it imposes, and sk's realisation — see
  `docs/thesis.md`, `docs/system-requirements.md`, `docs/positioning.md` (in that
  order). These are the canonical source for *product framing*; this file remains the
  canonical source for the *dev contract*.
- Every piece of state is **tenant-scoped**. Every row carries `tenant_id`. Do not add
  globals or cross-tenant reads without explicit RBAC + audit plumbing.
- **Audit everything that changes state.** Workflow commits, credential writes, approvals,
  skill promotions, schedule fires — all must produce an immutable `audit_log` entry.
- **Skills are human-approved only.** Skill Candidates are proposed from execution patterns;
  they become Skills only through explicit operator action. Do not auto-promote.
- **Dual vocabulary, intentional.** In strategy and external surfaces (README,
  `docs/thesis.md`, `docs/positioning.md`, public docs) use *drift-assisted repair
  suggestions* / *operator-reviewed remediation*. In the codebase, the technical name
  *self-healing* (directory `apps/engine/src/self-healing/`, module identifiers, log
  events) is preserved and must not be renamed. Same applies to `apps/engine/src/rbac/`
  vs. external "fine-grained action-level identity" phrasing — same concept, different
  audience.
- **Category-vocabulary triad** (for product framing, see `docs/02-concepts.md` Group
  0). The category sk occupies has three official names, used at three levels and never
  mixed inside one sentence: *organisational agentic operationalisation* (theory term,
  `docs/thesis.md`); *operational AI execution layer* (market term, `docs/positioning.md`
  and most product copy); **The Operating Model** (iconic short term, the reframed
  strategic-management phrase — *"your operating model used to live in PowerPoint. Now
  it runs."*). All three are canonical; do not invent a fourth.
- Keep public / marketing / documentation surfaces separate from authenticated engine routes.

## Canonical Sources

Read the smallest relevant set of sources before changing behavior.

Priority when sources conflict:

1. Code, types, tests, and verified inline decisions.
2. Canonical docs in `docs/` (numbered) and workflow/config files.
3. Existing implementation examples (e.g. the 90 templates, the 9 drivers).

High-value references (by task type):

- **Project shape & build** — `package.json`, `biome.json`, `tsconfig.json`, `docker-compose.yml`,
  `.github/workflows/ci.yml`, `release-please-config.json`, `.commitlintrc.json`
- **Strategy & product framing** — `docs/thesis.md` (Document A, theory),
  `docs/system-requirements.md` (Document B, vendor-agnostic requirements),
  `docs/positioning.md` (Document C, how sk realises them). Read in that order when you
  need to reason about positioning, vocabulary, or category claims.
- **Platform & concepts** — `docs/01-platform.md`, `docs/02-concepts.md`
- **Input surfaces** — `docs/03-input-surfaces.md`. The sk REPL exposes a 10-tab
  `/settings` palette (`Settings · Status · Config · Usage · Stats · Skills ·
  Permissions · Knowledge · Profile · Admin`) embedded in-process via the
  `kind: "settings"` PaneSpec; the Admin tab is hidden unless the principal
  holds an admin-scoped permission. Slash registry is in
  `apps/sk/src/slash.ts`; deleted-slash redirects in
  `apps/sk/src/repl/slash/dispatcher.ts:REMOVED_SLASH_GUIDANCE`.
- **AI authoring** — `docs/04-authoring.md`
- **Connectors & integration** — `docs/05-connectors.md`
- **Execution** — `docs/06-execution.md`
- **Security & governance** — `docs/07-security-governance.md`
- **Operations** — `docs/08-operations.md`
- **Agent-task navigation** — `.claude/docs/agent-navigation.md` (task-oriented index)

## Working Rules

- Start with the doc/spec that owns the behavior you are about to change. Do not reinvent
  an existing subsystem.
- Prefer small, reviewable diffs that preserve existing architecture over broad rewrites.
- Put shared guidance in this file or a directory-local `AGENTS.md`, never in tool-specific shims.
- **Use `bun`, not `npm` or `yarn`.** Scripts assume the `bun` runtime.
- **Imports are ESM.** The project is `"type": "module"`. Use explicit extensions
  (`.ts` for source imports only if the existing code does; otherwise match file-local style).
- **Every HTTP boundary uses Zod schemas.** Add a `@hono/zod-openapi` schema for every
  route in `apps/engine/src/http/routes/` — inputs and outputs. OpenAPI is generated from Zod;
  do not hand-edit the OpenAPI surface.
- **Structured LLM flows use submit/abort.** `generate`, `extract`, `repair`, `discover`
  all call `AiSdkModel.generateObject` with `toolChoice:"required"` and a submit/abort
  tool pair, capped at `MAX_TOOL_LOOP_ATTEMPTS = 8`. Don't drop a flow back to
  text + best-effort JSON parsing — the eval gate (`verify:ai`) will catch it.
- **CLI parity with the conversational gates.** `sk workflows {validate, preview, create}`
  and `sk connectors {inspect, probe, create}` enforce the same
  `inspect → validate → preview/probe → commit/save` state machine the conversation loop
  enforces. `--skip-checks` is the only escape hatch; use it sparingly.
- **Dry-run warnings feed the next turn.** When `dry_run_workflow` / `dry_run_step`
  emit warnings (`unresolved_identifier`, rate limits, pagination edges), they land on
  `draft.latest_preview.warnings` and the loop folds them into the next turn's
  `prior_failures` automatically.
- **Use the structured logger** (`apps/engine/src/logging/`) in engine, CLI, agent, and `sk`
  code. Do not introduce raw `console.log / warn / error` there. Build scripts under
  `scripts/` may use console output.
- **Untrusted JavaScript runs in `quickjs-emscripten` sandboxes only.** Before-request hooks,
  transforms, and self-healing patches must use the sandbox facility in
  `apps/engine/src/sandboxes/` with interrupt budgets set.
- **Never commit secrets.** `.env*`, `*.pem`, `*.key` are off-limits to agents. The pre-bash
  hook will refuse to read them.
- **Never bypass the audit log.** If a change mutates tenant-visible state, write an
  `audit_log` entry with request-source, actor, and structured diff.

## Chat-First Authoring Contract

Every conversation-driven authoring flow (Conversation, Discovery, Diagnosis/Repair) follows
these invariants. Engine prompts, tool palettes, and skills must reinforce them; never weaken
one to make the model "easier to drive".

- **Chat is the operator surface.** Every action a user can take in the product, the agent
  can take through a tool call. When asked to do something, the agent calls the matching
  tool — it does not instruct the user to run `sk` CLI commands, paste shell prompts, or
  open a separate UI. If the matching tool does not exist, the agent calls `cannot_help`
  with a chat-actionable `suggest_alternative`, never a CLI suggestion.
- **Proof before proposal.** Before `author_workflow` (or a repair-stage `propose_step`), run
  `probe_connector` to verify the credential resolves and the base URL responds. Skipping
  the probe is the largest single source of authoring-time errors.
- **Dry-run before first commit.** A brand-new workflow draft must pass
  `dry_run_workflow` or step-by-step `dry_run_step` before `save_workflow_draft`. An in-place
  re-commit on a persisted workflow needs a fresh `validate_draft`; a fresh dry-run is
  optional once the change is small and validated.
- **Repair-in-chat is a first-class authoring phase.** When a persisted workflow fails,
  the conversation enters diagnosis mode (`diagnose_latest_execution` → edit → validate →
  commit). The same `save_workflow_draft` tool that creates a workflow also updates a persisted
  one in place. There is no separate repair tool and no CLI fallback.
- **Approval gates are governance, not UX.** `ask_user_confirm(kind: "save_workflow_draft")`,
  `ask_user_confirm(kind: "external_write")`, and the patch-candidate approval flow are
  load-bearing. Do not invent escape hatches, `--skip-checks` flags, or "auto-commit if
  validated" shortcuts.
- **Never auto-promote.** Skill Candidates and Patch Candidates surface as proposals; they
  become active Skills / applied patches only via explicit operator action through their
  approval tools. This holds even when the candidate is classified `safe`.
- **Stale checkpoints block state-advancing moves.** A draft mutation invalidates later
  checkpoints (inspect → validate → probe / preview). The state machine enforces this;
  prompts and tools must respect it instead of routing around it.
- **`load_skill` is internal.** The agent loads skills silently and never narrates the
  load, names the skill in user-facing prose, or tells the user to read documentation.
- **Tenant snapshot before list_*.** Every converse turn carries a TENANT SNAPSHOT block
  with workflow + connector ids. Enumeration questions ("show my workflows", "welche
  connectoren habe ich") answer from the snapshot in zero tool calls. `list_*` tools are
  for pagination, filtered views, or explicit refresh — not double-checking.

## Architecture And Domain Safety

Preserve the current responsibility split. If you find yourself adding logic in the wrong
layer, stop and move it.

- **`apps/engine/`** — the server. All domain logic, HTTP routes, MCP server, queue workers,
  webhooks, scheduler, pub/sub, connector drivers, AI flows, self-healing, audit log.
- **`apps/sk/`** — the `sk` unified CLI (Ink-based TUI + citty subcommands). Persona-aware:
  end-users get the REPL; operators and admins get the full admin surface too. No domain logic.
- **`packages/cli-core/`** — shared CLI utilities (updater, version, prompts). Pure,
  reusable, no `apps/*` imports.
- **`packages/shared/`** — shared domain types & helpers. Pure, deterministic, no
  `apps/*` imports. See `packages/shared/AGENTS.md` for stricter rules.

Subsystem map inside `apps/engine/src/` (43 directories + 5 loose root files):

| Concern | Directory | Key docs |
|---|---|---|
| OpenAPI types (source of truth) | `api/` | `docs/03-input-surfaces.md` |
| Immutable audit log | `audit/` | `docs/07-security-governance.md` |
| Auth providers (OIDC, API key, portal token) | `auth/` | `docs/07-security-governance.md` |
| Chat adapters (Slack, Teams, Google Chat) | `chat/` | `docs/03-input-surfaces.md` |
| 9 drivers + 90 templates | `connectors/` | `docs/05-connectors.md` |
| AI authoring loop + tool use | `conversations/` | `docs/04-authoring.md` |
| Encrypted secret storage + OAuth2 refresh + credential rotation | `credentials/` (incl. `credentials/oauth2/`) | `docs/07-security-governance.md` |
| AES-256-GCM + redaction | `crypto/` | `docs/07-security-governance.md` |
| Drizzle schema + migrations + seed + transactional outbox events | `db/` | `docs/07-security-governance.md` |
| Unified file resource (chat attachments, workflow inputs/outputs, LLM context, MCP); `{$file: fid_uuid}` wire shape; `requireFileForTenant` chokepoint, `files` table + `file_links` polymorphic join, inline (≤5MB) vs presigned upload, scanner interface, soft-delete + cleanup cron with in-flight grace | `files/` | `docs/06-execution.md` |
| File → connector/skill proposals | `discovery/` | `docs/04-authoring.md` |
| OpenAPI / GraphQL / HTML → searchable context | `docs-ingestion/` | `docs/04-authoring.md` |
| Core domain types | `domain/` | `docs/02-concepts.md` |
| Typed engine HTTP client (used by sk + agent) | `engine-client/` | `docs/03-input-surfaces.md` |
| DAG engine + step dispatch | `execution/` | `docs/06-execution.md` |
| Hono routes + middleware + errors | `http/` | `docs/03-input-surfaces.md` |
| SSO / OIDC / user provisioning | `identity/` | `docs/07-security-governance.md` |
| Semantic search on tenant KB | `knowledge/` | `docs/04-authoring.md` |
| Prompt assembly, token budgets, repairs | `llm/` | `docs/04-authoring.md` |
| Structured logger + context | `logging/` | `docs/08-operations.md` |
| MCP server (streamable HTTP + stdio) | `mcp/` | `docs/03-input-surfaces.md` |
| Unified tool palette + dispatcher (registry, providers, policy, adapters) | `tools/` | `docs/10-tool-palette.md` |
| Rule-based fan-out (Slack, webhook) | `notifications/` | `docs/03-input-surfaces.md` |
| Prometheus metrics + tracing | `observability/` | `docs/08-operations.md` |
| First-run bootstrap + demo seed | `onboarding/` | `docs/08-operations.md` |
| PG LISTEN/NOTIFY streaming | `pubsub/` | `docs/06-execution.md` |
| pg-boss handler dispatch | `queue/` | `docs/06-execution.md` |
| RBAC (40+ permissions) + ABAC + policies | `rbac/` | `docs/07-security-governance.md` |
| 5-tier QuickJS-WASM isolation | `sandboxes/` | `docs/06-execution.md` |
| Cron reconciler + schedule fires | `scheduler/` | `docs/06-execution.md` |
| Connector endpoint schema tracking | `schema-versions/` | `docs/06-execution.md` |
| Drift detection + bounded repair | `self-healing/` | `docs/06-execution.md` |
| Pattern detection → proposed skills | `skill-candidates/` | `docs/04-authoring.md` |
| Curated LLM-context records | `skills/` | `docs/04-authoring.md` |
| Tenant-scoped time-bucketed runtime stats aggregation | `stats/` | `docs/08-operations.md` |
| Object/blob storage | `storage/` | `docs/06-execution.md` |
| Engine-internal cross-subsystem fixtures + helpers | `test-helpers/` | (test infrastructure) |
| Top-level integration suites | `tests/` | (test infrastructure) |
| Cross-subsystem utilities | `utils/` | (shared helpers) |
| Inbound + outbound webhooks (incl. transactional outbox dispatch) | `webhooks/` | `docs/03-input-surfaces.md` |
| DAG versioning + locking + execution | `workflows/` | `docs/06-execution.md` |

Loose root files in `apps/engine/src/`:

- `index.ts` — process entry point.
- `env.ts` + `env.test.ts` — Zod-parsed env loader; the only place process.env reads happen at boot.
- `self-update.ts` + `update-state.ts` — engine self-update channel for dev.

Directory-local overrides:

- `apps/engine/AGENTS.md` — strict rules for engine code.
- `apps/sk/AGENTS.md` — `sk` unified CLI (Ink REPL + citty admin subcommands).
- `packages/shared/AGENTS.md` — pure/deterministic code only.

## Code Quality Enforcement

- **Biome** (`biome.json`) is the only formatter and linter. 100 char line width, 2-space
  indent, double quotes, semicolons, trailing commas. Run `bun run lint` before calling done.
- **TypeScript strict mode.** No `any` in new code. No non-null assertions without a
  documented invariant. Run `bun run typecheck` before calling done.
- **Zod at boundaries.** Every REST route, every MCP tool, every webhook, every CLI
  input — schema first.
- **Conventional commits** (`.commitlintrc.json`). Allowed types: `feat`, `fix`, `docs`,
  `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`. Header ≤ 100 chars.
  Release-please (`release-please-config.json`) will read these to cut the next version.
- **No `console.*` in app/engine code.** Use the structured logger.
- **Inline comments explain WHY, not WHAT.** Remove any comment that restates what the
  function or variable name already says. Keep only non-obvious constraints, workarounds
  for specific bugs, and subtle invariants. One line max; no multi-line docblocks.
- **No ticket coupling in comments or docs.** Inline comments, `TODO`s, and docs must not
  reference PR numbers, issue IDs, `bug-N` labels, review-wave letters (`W1`, `S3`, `R2-W4`,
  `P0-1`), or round numbers. Either the invariant is permanent and belongs in code, or the
  follow-up is real and belongs in the issue tracker — not in source. Enforced by
  `bun run check:terminology`.

## Validation And Testing

Three test layers (picked by subsystem and command):

| Layer | Command | When | What runs |
|---|---|---|---|
| unit | `bun run test:unit` | Fast inner loop. Requires a running Postgres (compose) for the subset that uses `createTestDb`; otherwise no external dependencies. | `observability`, `logging`, `audit`, `llm`, `workflows`, `execution/tests` |
| integration | `bun run test:integration` | Needs Postgres + pg-boss (Docker Compose). | `db`, `queue`, `http`, `webhooks`, `credentials/oauth2` |
| e2e | `bun run test:e2e` | Compiles `sk` as needed and runs against a live engine. | `tests/e2e/` |
| eval | `bun run verify:ai` | Prompting, context assembly, routing, and authoring-contract changes. | `apps/engine/eval/*` |

- Unit tests co-located as `*.test.ts` alongside source.
- Integration tests use a disposable Postgres database per test file (`createTestDb`) against the running compose instance.
- E2E tests drive compiled CLIs — they will build them if missing.
- CI currently runs lint, typecheck, migrations, `bun test apps/ packages/`, `build:all`, e2e,
  engine smoke, and compose validation. The local `bun run verify` gate is stricter: it also runs
  terminology checks, determinism lint, and the AI/eval contract suite.

## Quality Gate Before Done

Before marking any code task done, run (or have a reason not to):

1. `bun run lint` — biome check, no warnings.
2. `bun run typecheck` — tsc clean.
3. `bun run check:terminology` — terminology drift clean.
4. `bun run test:determinism` — determinism lint clean.
5. `bun run test:unit` — unit tests green.
6. `bun run verify:ai` — eval fixtures green when the change touches prompting, context,
   routing, authoring, or verification behavior.
7. Integration/e2e where the change touches those layers (`test:integration`, `test:e2e`).
8. Verify audit log + Zod schemas were updated if the change mutates state or hits a
   route.

Or use the `/verify` command, which runs the full local release gate (`bun run verify`).

## Useful Commands

Day-to-day:

- `bun run dev` — engine in watch mode.
- `bun run lint` / `bun run lint:fix` / `bun run format`
- `bun run typecheck`
- `bun run verify` / `bun run verify:ai` / `bun run eval`
- `bun run test:unit` / `bun run test:integration` / `bun run test:e2e`
- `bun run build:all` — compile all 3 repo binaries into `dist/`.

Database & infra:

- `bun run compose:up` / `compose:down` / `compose:reset` / `compose:logs` — Docker Compose.
- `bun run db:generate` — drizzle-kit generate.
- `bun run db:migrate` — apply migrations.
- `bun run db:seed` — seed dev data.
- `bun run db:issue-admin-key` — mint an admin API key locally.
- `bun run metrics` — curl `/metrics` from the running engine.

## Project Agent Files

Companion files live under `.claude/`:

- `.claude/CLAUDE.md` — Claude Code bootstrap shim; delegates here.
- `.claude/agents/` — specialist sub-agents (`domain-architect`, `connector-builder`,
  `test-generator`).
- `.claude/skills/` — project-local skills; see root `SKILLS.md` for the index.
- `.claude/commands/` — thin `/verify` and `/review` commands.
- `.claude/settings.json` + `.claude/hooks/pre-bash-dispatch.sh` — bash safety net.

Directory-local overrides:

- `apps/engine/AGENTS.md`
- `apps/sk/AGENTS.md`
- `packages/shared/AGENTS.md`

When in doubt, start here, then follow the most specific pointer downward.
