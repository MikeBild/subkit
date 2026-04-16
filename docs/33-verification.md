# 33 — Verification

This document is the **end-to-end smoke test matrix** for a release. It is a checklist, not a tutorial. Each step has an action and a set of expected observations. A release is verified when every step passes against a freshly compiled binary running on the canonical `docker-compose.yml` from `32-deployment.md`. The expected observations refer to entities and tables defined in `02-domain-model.md` and `04-data-model.md`.

The matrix runs against a single tenant unless noted otherwise. Numbered checkboxes are the intended granularity for an operator stepping through it manually; an automated harness collapses each step into one assertion block.

> **Note:** Some steps reference CLI commands not yet implemented (e.g., `subkit tenants create`, `subkit users create`, `subkit system-accounts create`). These require direct REST API calls until the CLI commands are added. Steps marked with "(REST API)" indicate this.

---

## 1. Bring up the stack

- [ ] Run `docker compose up -d` against the canonical compose file.
- [ ] **Expect**: the `app` service reports healthy on `GET /v1/health` within 30 seconds.
- [ ] **Expect**: `postgres` is reachable from the `app` container; `app` log line `db: connected` appears.
- [ ] **Expect**: the metrics endpoint at `GET /v1/metrics` returns at least the `queue_depth` and `outbox_cursor_lag` series.

## 2. Bootstrap identity

- [ ] Create a Tenant (REST API): `POST /v1/identity/tenants` with `{ "slug": "acme", "display_name": "Acme" }`.
- [ ] Create a User with OIDC binding (REST API): `POST /v1/identity/users` with `{ "email": "alice@acme.test", "oidc_subject": "..." }`.
- [ ] Create a System Account (REST API): `POST /v1/identity/system-accounts` with `{ "name": "ci-bot" }`.
- [ ] Issue a personal API Key for the User: `subkit apikeys create --user alice@acme.test --scopes workflows:run`.
- [ ] Issue a machine API Key for the System Account: `subkit apikeys create --system-account ci-bot --scopes workflows:run,executions:read`.
- [ ] Issue a Portal Token for an end-user-style scope: `subkit portal-tokens create --workflows invoice-summary --ttl 24h`.
- [ ] **Expect**: each `apikey.issue` and `portal_token.issue` action writes one row to `audit_log` with the correct `actor_id` and `tenant_id`.
- [ ] **Expect**: each new key's `prefix` is visible in `subkit apikeys list`; the secret material is shown only once at creation.

## 3. Connector with documentation and a curated Skill

- [ ] Create a `dev` Connector for a public API (for example, a public weather or invoice fixture API): `subkit connectors create weather --base-url https://api.example.test --environment dev`.
- [ ] Ingest the OpenAPI documentation: `subkit connectors docs ingest weather --source https://api.example.test/openapi.json`.
- [ ] Author a Skill with best-practices and attach it to the Connector: `subkit skills create weather-best-practices --scope connector --connector weather`.
- [ ] **Expect**: the Connector row carries `environment = dev`.
- [ ] **Expect**: `connector_documents` rows exist for the ingested OpenAPI; the per-Connector documentation budget defined in `30-defaults-and-limits.md` is not exceeded.
- [ ] **Expect**: the Skill row exists in `active` lifecycle state and shows up in `subkit skills list`.

## 4. AI authoring via REST SSE and via MCP

- [ ] Start a Conversation through REST SSE: `curl -N -H "Authorization: Bearer <api-key>" https://.../v1/conversations -d ...`.
- [ ] **Expect**: SSE frames stream `propose_step`, `update_param`, `connect_steps`, `validate_draft`, and `request_human_approval` tool-call panels in the structured-intent loop.
- [ ] Start the same Conversation through MCP: `subkit mcp` then `tools/call conversations.start`.
- [ ] **Expect**: MCP `notifications/progress` messages fire with the same tool-call shape; the final result returns the draft Workflow.
- [ ] Approve the pending change and call `commit_draft`.
- [ ] **Expect**: a new Workflow Version row appears with the committed shape; the `audit_log` records the commit; the draft state is cleared.

## 5. Trigger the workflow from every Request Source

- [ ] **REST**: `subkit workflows run invoice-summary` → expect Execution with `request_source = api`.
- [ ] **MCP `tools/call`**: invoke the workflow tool through the MCP session → expect Execution with `request_source = mcp`.
- [ ] **Inbound webhook**: register `/v1/hooks/invoice-summary-trigger` and POST a sample payload → expect Execution with `request_source = webhook`.
- [ ] **Tool-chain `call`**: create a parent workflow whose `call` Step targets `invoice-summary`; run the parent → expect a child Execution with `request_source = tool-chain` and `parent_execution_id` set.
- [ ] **Expect**: in all four cases the Execution transitions `queued → running → succeeded`, with the correct `execution_mode = dev`.

## 6. Outbound subscription and Standard Webhooks signing

- [ ] Create a Subscription targeting a local sink (an HTTP endpoint the test harness controls): `subkit subscriptions create execution.succeeded --target https://sink.test/hook`.
- [ ] Trigger the workflow from step 5 again.
- [ ] **Expect**: the sink receives an HTTP POST with `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers populated according to the Standard Webhooks specification.
- [ ] Verify the HMAC externally: recompute `base64(hmac_sha256(secret, "id.timestamp.body"))` and confirm it matches the `v1,...` token in `webhook-signature`.
- [ ] **Expect**: `webhook_delivery_total{status="succeeded"}` increments by 1 in `/v1/metrics`.

## 7. Install the chat workspaces

- [ ] Install Slack: walk the OAuth v2 install flow against a test workspace.
- [ ] Install Microsoft Teams: register the app manifest in a test team and complete the Bot Framework client-credentials flow.
- [ ] Install Google Chat: complete the GCP OAuth and domain-wide install for a test space.
- [ ] **Expect**: three `chat_workspaces` rows exist, one per platform, each with encrypted bot credentials and the correct `workspace_id`.
- [ ] **Expect**: a smoke message can be posted to each workspace's default channel via `subkit notifications channels list` and a manual `subkit notifications test`.

## 8. Conversational authoring inside chat (per platform)

For each of Slack, Teams, and Google Chat:

- [ ] In a test channel, mention the bot with the prompt `create a workflow that fetches yesterday's Stripe invoices`.
- [ ] **Expect**: a Chat Session row binds the thread to a fresh Conversation.
- [ ] **Expect**: the bot edits its reply progressively as the LLM streams tokens, at roughly the documented cadence.
- [ ] **Expect**: when the structured-intent loop reaches `request_human_approval`, the adapter posts a native interactive element (Slack Block Kit Actions, Teams Adaptive Card Action.Submit, Google Chat Card v2 Button).
- [ ] Click "Approve".
- [ ] **Expect**: the interaction callback resolves to the same Conversation, the Chat Identity is verified, the tool loop resumes, and `commit_draft` produces a new Workflow Version with `audit_log` entries.

## 9. Notification rules and rate limits

- [ ] Create a Notification Rule that matches `event_pattern = execution.failed` with severity `error`, targeting one Slack channel and one Teams channel.
- [ ] Force a workflow failure (introduce a deliberate bad parameter and re-run).
- [ ] **Expect**: both chat platforms receive a delivery within seconds.
- [ ] **Expect**: `chat_delivery_total{status="succeeded", platform="slack"}` and `chat_delivery_total{status="succeeded", platform="teams"}` each increment by 1.
- [ ] Force a burst of failures to exceed the per-Tenant rate limit.
- [ ] **Expect**: the `chat.deliver` queue throttles deliveries to within the platform-published caps, and after enough consecutive failures (per the documented threshold) the per-channel circuit breaker opens.

## 10. Tunneled connector

- [ ] Start a local Tunnel agent: `subkit tunnel-agent run --tunnel-key <api-key>`.
- [ ] Create a Tunnel Target row pointing at a private host the agent can reach.
- [ ] Configure a Connector to route through the Tunnel and run a workflow that hits it.
- [ ] **Expect**: the request flows through the agent's WebSocket; the Execution succeeds; `tunnel_connected{tunnel_id=...} = 1`.
- [ ] **Expect**: a request to the same private host issued **without** the Tunnel binding is blocked by the egress policy described in `28-security.md`.

## 11. Schedules

- [ ] Create a Schedule against the workflow: `subkit schedules create invoice-summary --cron "*/5 * * * *"`.
- [ ] **Expect**: cron reconciliation enqueues an Execution within the next minute and at the documented cadence thereafter.
- [ ] **Expect**: `subkit executions list` shows the recurring runs with `request_source = scheduler`.
- [ ] **Expect**: `subkit executions tail <id>` streams Execution logs over SSE.

## 12. Self-healing on upstream drift

- [ ] Force an upstream drift: in the test fixture API, rename a response field that the workflow's `data_selector` reads.
- [ ] Re-run the workflow.
- [ ] **Expect**: the Step fails with a typed `drift` failure; the `workflow.repair` queue picks it up.
- [ ] **Expect**: a Patch Candidate row appears, classified `safe`, and is auto-applied under the default `safe-patches` policy.
- [ ] **Expect**: the `audit_log` records `patch.auto_apply` with the diff in `details`.
- [ ] Re-run the workflow → it now succeeds against the renamed field.

## 13. API key rotation with overlap

- [ ] Rotate the machine API key from step 2 with an overlap window: `subkit apikeys rotate <prefix> --overlap 1h`.
- [ ] **Expect**: a new key is issued; the old key's `rotated_from_id` is set; both keys are valid for the overlap window.
- [ ] During the overlap, run a workflow with the **old** key → expect success.
- [ ] During the overlap, run a workflow with the **new** key → expect success.
- [ ] After the overlap window expires, run a workflow with the old key → expect HTTP 401.
- [ ] Run a workflow with the new key → expect success.
- [ ] **Expect**: `audit_log` records `apikey.rotate` and the eventual implicit revocation of the old key.

## 14. Abort propagation

- [ ] Start a workflow whose `request` Step targets a deliberately slow endpoint.
- [ ] While it is running, call `POST /v1/executions/<id>/cancel` (or `subkit executions abort`).
- [ ] **Expect**: the running Step's `AbortSignal` fires; the underlying `fetch` is aborted; the Execution transitions to `aborted` within seconds.
- [ ] **Expect**: the Execution row records `status = aborted` and `audit_log` reflects the abort actor.

## 15. Crash and recover mid-execution

- [ ] Start a long-running workflow; while it is running, kill the `app` container with `docker kill`.
- [ ] **Expect**: graceful shutdown drains pg-boss jobs, flushes outbound webhook and chat deliveries up to the deadline, closes the LISTEN connection, and signals connected Tunnel agents (per `32-deployment.md`).
- [ ] Restart the `app` container.
- [ ] **Expect**: the outbox cursor catches up from `last_seen_id`; in-flight webhook deliveries resume from the durable queue; in-flight chat deliveries resume; partially-completed Executions either resume or fail cleanly per their Step state machine.
- [ ] **Expect**: no event is delivered twice **unless** the consumer's idempotency check is the only safety net — Standard Webhooks `webhook-id` is set so consumers can dedupe.

## 16. Promote dev → prod

- [ ] Promote the workflow from `dev` to `prod`: `subkit workflows promote invoice-summary --to prod`.
- [ ] **Expect**: the `prod` Connector binding uses an independent set of `connector_environments` rows with independent Credentials.
- [ ] **Expect**: a fresh Execution against the `prod` workflow carries `execution_mode = prod`.
- [ ] **Expect**: `dev` and `prod` Executions are filterable independently in `subkit executions list --execution-mode prod`.

## 17. Extract a PDF

- [ ] Run `subkit extract ./fixtures/sample.pdf`.
- [ ] **Expect**: the response shape matches `{ id, success, data, startedAt, completedAt }` per `22-extract.md`.
- [ ] **Expect**: `data` contains a structured representation of the PDF text and any tables; the call completes within the documented Extract budget; the upload is rejected if it exceeds 100 MB.
- [ ] **Expect**: no row is persisted in the executions table for the Extract call — `/v1/extract` is ephemeral.

---

## Reporting

A green run produces:

- Zero failed checkboxes above.
- Zero `error`-level lines in the structured log stream.
- `execution_total{status="succeeded"}` increments matching the test plan.
- `audit_log` rows for every identity action in steps 2, 6, 8, 9, 12, and 13.

A failed checkbox blocks the release. The next action is to capture the relevant `trace_id` from the structured log stream, pivot through `audit_log`, and file a regression test that reproduces the failure inside the unit or integration suites described in `31-developer-tooling.md`.
