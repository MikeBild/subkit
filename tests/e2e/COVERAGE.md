# E2E Coverage Matrix

> **Living document.** Every new CLI surface (slash command or `subkit`
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
trace-based ("propose_connector was called with slug X").

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

---

## Tier 3 — `subkit` admin engine surface

`tests/e2e/tier3-subkit-matrix.e2e.test.ts`

Read matrix (every collection responds 200 + JSON):

- `/v1/connectors`, `/v1/skills`, `/v1/skill-candidates`,
  `/v1/knowledge-sources`, `/v1/discovery/runs`,
  `/v1/identity/portal-tokens`, `/v1/identity/api-keys`,
  `/v1/identity/users`, `/v1/identity/system-accounts`,
  `/v1/identity/tenants`, `/v1/identity/whoami`,
  `/v1/webhooks/inbound`, `/v1/executions`, `/v1/subscriptions`,
  `/v1/notifications/{channels,rules,deliveries}`, `/v1/tunnels`,
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

## sk top-level subcommands

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

The tunnel-agent binary (`apps/agent`) is a separate concern — not
covered here, tracked separately.

## Continuous coverage rules

1. **Every new slash command** added to `apps/sk/src/slash.ts` MUST
   either appear in Tier 2 with an engine probe OR be marked
   "client-side" with a unit test in `apps/sk/src/tests/`.
2. **Every new `subkit` subcommand-group** added to
   `apps/cli/src/commands/` MUST land with a Tier 3 entry.
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
