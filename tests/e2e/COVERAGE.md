# E2E Coverage Matrix

> **Living document.** Every new CLI surface (slash command or `sk`
> subcommand) MUST land with a corresponding entry in this file AND a
> covering test. The `pre-push` guard at `scripts/check-e2e-coverage.sh`
> fails when a slash/subcommand is introduced without an entry below.

## Tracks

Two tracks against a real engine + Postgres + RBAC + audit. Only the
LLM provider differs:

| Track | When                              | LLM            | Determinism      |
|-------|-----------------------------------|----------------|------------------|
| real  | default — `boot(label)`           | `.env` provider| outcome-based    |
| mock  | opt-in — `boot(label, { llm: "mock" })` | in-process     | trace-based      |

The mock track exists for tests that pin a specific tool sequence (the
canned plans in `apps/engine/src/llm/mock-provider.ts`). Prefer real
+ outcome-based assertions ("a connector was persisted") over
trace-based ("start_connector_from_description was called for vendor X").

---

## Authoring regressions (mock LLM, deterministic tool plans)

`tests/e2e/authoring-regressions.e2e.test.ts`

| Journey | Status |
|---------|--------|
| onboarding without template | ✅ |
| onboarding with template | ✅ |
| resume pending approval | ✅ |
| workflow version restore | ✅ |
| HTTP probe 401 | ✅ |
| HTTP probe timeout | ✅ |
| preview failure placeholder path | ✅ |
| preview cancellation | ✅ |
| tenant isolation on conversation read | ✅ |
| GraphQL / Postgres / S3 draft probe parity | ✅ |

`tests/e2e/guided-authoring.e2e.test.ts`

| Journey | Status |
|---------|--------|
| connector-first guided onboarding through save + commit approvals | ✅ |

`tests/e2e/sk-interactive-smoke.e2e.test.ts`

| Journey | Status |
|---------|--------|
| startup boot path (`whoami` / RBAC / `status`) | ✅ |
| quick-start starter action 1: resume | ✅ |
| quick-start starter action 2: connector onboarding prompt | ✅ |
| quick-start starter action 3: workflow onboarding prompt | ✅ |
| quick-start starter action 4: docs/spec import prompt | ✅ |
| quick-start starter action 5: help | ✅ |

---

## Tier 1 — Conversation lifecycle (real LLM)

`tests/e2e/tier1-conversation-lifecycle.e2e.test.ts`

| # | Surface                          | Status |
|---|----------------------------------|--------|
| 1.1 | POST `/v1/conversations` simple  | ✅     |
| 1.2 | Multi-turn `/messages`            | ✅     |
| 1.3 | Connector authoring via chat      | ✅     |
| 1.4 | Workflow authoring + commit       | ✅     |
| 1.5 | Resume via `sk -r <id>`           | ✅     |
| 1.6 | Elicitation reject                | ✅     |

---

## Tier 2 — Slash → engine endpoints

`tests/e2e/tier2-slash-matrix.e2e.test.ts`

| Slash       | Endpoint                                     | Test |
|-------------|----------------------------------------------|------|
| `/status`   | `GET /v1/status`                              | ✅ |
| `/resume`   | `GET /v1/conversations?owner=me`              | ✅ |
| `/skills`   | `GET /v1/skills`                              | ✅ |
| `/knowledge`| `GET /v1/knowledge-sources`                   | ✅ |
| `/audit`    | `GET /v1/audit-log` (+ 403 for member)        | ✅ |
| `/logs`     | `GET /v1/diagnostics/errors` (+ 403)          | ✅ |
| `/compact`  | `POST /v1/conversations/:id/compact`          | ✅ |
| `/permissions` | `POST /v1/rbac/can`                        | ✅ |
| `/approve` `/reject` | covered by Tier 1.3 / 1.4 / 1.6     | ✅ |
| `/help` `/clear` `/exit` `/bug` `/profile` `/memory` `/init` `/paste` `/attach` `/queue` `/history` `/debug` `/config` `/login` `/logout` `/model` `/tenant` `/cost` | client-side, covered by `apps/sk/src/tests/` | – |

Additional slash commands tracked for the current surface:

| Slash | Coverage source |
|-------|-----------------|
| `/draft` `/connector` `/workflow` `/context` | `apps/sk/src/tests/`, `guided-authoring.e2e.test.ts` |
| `/templates` | `guided-authoring.e2e.test.ts`, `authoring-regressions.e2e.test.ts` |
| `/probe` | `authoring-regressions.e2e.test.ts`, `guided-authoring.e2e.test.ts` |
| `/preview` | `authoring-regressions.e2e.test.ts`, `guided-authoring.e2e.test.ts` |
| `/versions` | `authoring-regressions.e2e.test.ts` |
| `/approvals` | `guided-authoring.e2e.test.ts`, `apps/sk/src/tests/` |
| `/view` `/export` | `apps/sk/src/tests/` |
| `/install-slack` `/install-teams` `/install-github` `/install-google-workspace` `/install-salesforce` `/install-jira` `/install-hubspot` | `sk-interactive-smoke.e2e.test.ts`, `apps/sk/src/tests/` |

---

## Tier 3 — `sk` admin engine surface

`tests/e2e/tier3-subkit-matrix.e2e.test.ts`

Read matrix (every collection responds 200 + JSON):

- `/v1/connectors`, `/v1/skills`, `/v1/skill-candidates`,
  `/v1/knowledge-sources`, `/v1/discovery/runs`,
  `/v1/identity/portal-tokens`, `/v1/identity/api-keys`,
  `/v1/identity/users`, `/v1/identity/system-accounts`,
  `/v1/identity/tenants`, `/v1/identity/whoami`,
  `/v1/webhooks/inbound`, `/v1/executions`, `/v1/subscriptions`,
  `/v1/notifications/{channels,rules,deliveries}`,
  `/v1/patch-candidates`, `/v1/rbac/{permissions,roles}`,
  `/v1/mcp/{tools,prompts,resources}`,
  `/v1/diagnostics/{errors,llm}`

Write round-trips (create + delete):

- `POST /v1/connectors`
- `POST /v1/workflows` + history
- `POST /v1/identity/api-keys`
- `POST /v1/identity/portal-tokens`
- `POST /v1/subscriptions`
- `POST /v1/webhooks/inbound`

---

## Tier 4 — Edge cases

`tests/e2e/tier4-edge-cases.e2e.test.ts`

- Auth/RBAC matrix: 401 (no header), 401 (bogus token), 403 (member on
  audit), 403 (enduser on diagnostics), 4xx for missing/invalid id.
- Validation envelope: empty body, malformed step kind, unknown
  connector driver — all 4xx, never 5xx.
- Tenant header isolation: foreign `x-subkit-tenant` MUST NOT broaden
  access.
- Concurrency: parallel POSTs return distinct ids.
- Error envelope shape: 4xx always returns JSON with code/error/message
  populated.

---

## Tier-pinned mock tests

These suites use `boot(label, { llm: "mock" })` because they assert on
the canned tool sequence:

- `weather-workflow.e2e.test.ts` — `cannedOpenMeteoBerlinPlan`
- `sk-user-story.e2e.test.ts` — same
- `conversation-deep-surface.e2e.test.ts` — same
- `sk-cli.e2e.test.ts` — deterministic mock responses
- `sk-interactive-smoke.e2e.test.ts` — PTY-backed interactive `sk` smoke
- `cross-cli.e2e.test.ts`, `personas.e2e.test.ts`,
  `tool-surface-expansion.e2e.test.ts` — also pinned to mock for
  determinism

---

## sk top-level and admin subcommands

Coverage map for `sk <subcommand>` invocations. The headless `sk -p
<prompt>` path is exercised by Tier 1 + `sk-cli.e2e.test.ts`.

| Subcommand    | Test file                       |
|---------------|---------------------------------|
| `sk login`    | `sk-cli.e2e.test.ts` ✅         |
| `sk logout`   | `sk-cli.e2e.test.ts` (after login) |
| `sk status`   | `sk-cli.e2e.test.ts` ✅         |
| `sk tenants`  | `sk-cli.e2e.test.ts` ✅         |
| `sk profile`  | `sk-cli.e2e.test.ts` ✅         |
| `sk mcp`      | `mcp-surface.e2e.test.ts` ✅    |
| `sk update`   | `update.e2e.test.ts` ✅         |
| `sk -p` (headless) | `tier1-conversation-lifecycle.e2e.test.ts` + `sk-cli.e2e.test.ts` ✅ |
| `sk -r <id>` (resume) | tier1 1.5 ✅              |

Admin command groups exposed from `apps/sk/src/index.ts`:

| Subcommand | Coverage source |
|------------|-----------------|
| `sk workflows` | `subkit-cli.e2e.test.ts`, `tier3-subkit-matrix.e2e.test.ts` |
| `sk connectors` | `subkit-cli.e2e.test.ts`, `tier3-subkit-matrix.e2e.test.ts` |
| `sk connector-templates` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk credentials` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk skills` | `subkit-cli.e2e.test.ts`, `tier3-subkit-matrix.e2e.test.ts` |
| `sk skill-candidates` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk knowledge-sources` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk discovery` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk executions` | `subkit-cli.e2e.test.ts`, `tier3-subkit-matrix.e2e.test.ts` |
| `sk patch-candidates` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk hooks` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk subscriptions` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk events` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk notifications` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk diagnostics` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk install` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk auth` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk extract` | `subkit-cli.e2e.test.ts` |
| `sk health` | `subkit-cli.e2e.test.ts`, `remote-health.smoke.ts` |
| `sk sessions` / `sk ls` / `sk show` / `sk rename` / `sk rm` | `sk-cli.e2e.test.ts`, `apps/sk/src/tests/` |
| `sk rbac` | `subkit-cli.e2e.test.ts`, `tier3-subkit-matrix.e2e.test.ts` |
| `sk audit` | `subkit-cli.e2e.test.ts`, `apps/engine/src/tests/journeys/30-cli-audit.journey.test.ts` |
| `sk apikeys` | `subkit-cli.e2e.test.ts`, `tier3-subkit-matrix.e2e.test.ts` |
| `sk portal-tokens` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk users` | `tier3-subkit-matrix.e2e.test.ts` |
| `sk system-accounts` | `tier3-subkit-matrix.e2e.test.ts` |

## Continuous coverage rules

1. **Every new slash command** added to `apps/sk/src/slash.ts` MUST
   either appear in Tier 2 with an engine probe OR be marked
   "client-side" with a unit test in `apps/sk/src/tests/`.
2. **Every new `sk` subcommand-group** added to
   `apps/sk/src/index.ts` (`SUB_COMMANDS`) MUST land with a Tier 3 entry.
3. **Every new HTTP route** added to `apps/engine/src/http/routes/` MUST
   be reachable from at least one test in this matrix (read OR write).
4. **Every new `code` value** thrown by `apps/engine/src/http/errors.ts`
   MUST appear in a Tier 4 envelope assertion.
5. **No 5xx in Tier 4**: any new endpoint that 5xxes on bad input is a
   bug — fix the engine, not the test.
6. **Real LLM by default**, mock only when the test explicitly needs a
   pinned tool sequence.

The `scripts/check-e2e-coverage.sh` script greps for new
slash-command / subcommand registrations and fails if no test under
`tests/e2e/` references them. Run via the `pre-push` hook (see
`.husky/pre-push` or whatever hook the repo uses).
