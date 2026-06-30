# MCP 2025-11-25 Compliance Plan

This plan turns the MCP 2025-11-25 specification into implementable, testable
work for subkit. It covers the engine Streamable HTTP server, the engine MCP
capabilities, OAuth discovery, RBAC/audit safety, and the `sk` CLI/REPL surfaces
that expose or consume MCP behavior.

Primary spec references:

- `https://modelcontextprotocol.io/specification/2025-11-25`
- `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
- `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
- `https://modelcontextprotocol.io/specification/2025-11-25/server/tools`
- `https://modelcontextprotocol.io/specification/2025-11-25/server/resources`
- `https://modelcontextprotocol.io/specification/2025-11-25/server/prompts`
- `https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation`

## Goals

1. `/mcp` behaves according to MCP 2025-11-25 for Streamable HTTP, lifecycle,
   version headers, OAuth challenges, sessions, SSE framing, and errors.
2. Engine MCP capabilities are complete for the features subkit advertises:
   tools, resources, resource templates, prompts, completion, elicitation,
   async tasks, pagination, list-change notifications, metadata, RBAC, and audit.
3. Unsupported MCP features are explicit and tested as unsupported, not left as
   accidental gaps.
4. `sk` E2E coverage proves that the compiled CLI, stdio MCP proxy, and Ink REPL
   remain compatible with the engine MCP surface.
5. Every state transition and edge case has a positive test, a negative test, or
   a documented unsupported-by-design assertion.

## Coverage Model

Use four statuses in the implementation tracker:

- `implement`: required by the spec and supported by subkit.
- `already-covered`: current code and tests prove the requirement.
- `unsupported-by-design`: subkit intentionally does not advertise the capability;
  tests assert the absence or method rejection.
- `defer-with-evidence`: known follow-up that is outside the current compliance
  target, with a reason and a concrete future trigger.

Do not mark any requirement done until there is a named test or command proving it.

## Test Homes

- Engine MCP HTTP/SSE:
  `apps/engine/src/mcp/tests/*.test.ts`
- Capability units:
  `apps/engine/src/mcp/capabilities/*.test.ts`
- Elicitation units:
  `apps/engine/src/mcp/elicitation/*.test.ts`
- OAuth discovery/challenge:
  `apps/engine/src/auth/oauth/*.test.ts`
- sk binary and REPL E2E:
  `tests/e2e/mcp-surface.e2e.test.ts`,
  `tests/e2e/sk-cli.e2e.test.ts`,
  `tests/e2e/repl-conversational.e2e.test.ts`,
  new `tests/e2e/sk-mcp-proxy.e2e.test.ts`,
  new `tests/e2e/repl-mcp-catalog.e2e.test.ts`
- Docker smoke when packaging/runtime is relevant:
  `tests/docker/repl-smoke.docker.test.ts`

## Cross-Cutting Base Protocol Tests

These tests sit below individual capabilities and prove that the JSON-RPC/MCP
session contract is stable.

Implementation targets:

- Initialize returns `serverInfo`, `protocolVersion`, advertised capabilities,
  and instructions without tenant-secret data.
- Capability snapshots are deterministic for product/admin/read-only modes.
- JSON-RPC parse errors, invalid requests, unknown methods, and invalid params
  return controlled protocol errors.
- `ping` behavior is pinned if the SDK handles it automatically.
- Cancellation/progress notifications are either implemented where used or
  asserted unsupported-by-design.
- Request ids are echoed correctly for success and error envelopes.
- Notifications never include JSON-RPC ids.
- Batch requests are accepted or rejected according to the SDK/spec behavior and
  are pinned by tests.

Engine tests:

- Initialize response snapshot for admin, member, enduser, and portal principal.
- Initialize instructions are present for allowed principals and omit operator
  digest when `stats:read` is denied.
- Invalid JSON returns JSON-RPC parse error without leaking stack traces.
- Unknown method returns method-not-found and the session remains usable.
- `ping` request succeeds if supported by SDK, otherwise unsupported behavior is
  pinned.
- Cancellation notification for an unknown request is ignored or rejected without
  closing the session.
- Progress token request metadata is accepted and ignored unless a handler emits
  progress.
- Batch request behavior has one explicit test so SDK upgrades cannot silently
  change it.

sk/E2E tests:

- Live `/mcp` E2E checks initialize capability snapshot includes only supported
  capabilities.
- `sk mcp` stdio E2E checks initialize capability snapshot exposes only proxy
  tools, not engine resources/prompts by accident.

Acceptance evidence:

- Capability snapshots are reviewed whenever a new MCP feature is advertised.

## Phase 1: Streamable HTTP Transport

Implementation targets:

- Add a pre-transport guard before `session.transport.handleRequest()`.
- Validate any present `Origin` header against the request origin and configured
  `server.public_base_url` origin.
- Reject invalid `Origin` before auth with `403`.
- Validate `MCP-Protocol-Version` on post-initialize requests.
- Accept the negotiated/current version and any explicitly supported versions.
- Reject malformed or unsupported versions with `400`.
- Preserve existing stale-session `404`, missing-session `400`, SSE framing,
  and unauthenticated OAuth challenge behavior.

Engine tests:

- `POST /mcp initialize` with valid auth and no `Origin` succeeds.
- Valid same-origin `Origin` succeeds.
- Configured public origin succeeds.
- Invalid cross-site `Origin` returns `403`.
- Invalid `Origin` plus missing credentials returns `403`, proving DNS rebinding
  protection runs before auth.
- Missing credentials with valid/missing origin returns `401`.
- Initialize without `mcp-session-id` creates a session and returns the header.
- `notifications/initialized` with a valid session returns `202`.
- Operation with valid session and protocol header succeeds.
- Operation without required session returns `400`.
- Unknown or stale session returns `404`.
- `DELETE /mcp` behavior is pinned: close session if implemented, otherwise
  return a documented `405`.
- Stale session after close returns `404`.
- SSE responses parse as `event`/`data` frames and contain JSON-RPC envelopes.

Negative tests:

- Malformed `Origin` returns `403`.
- `MCP-Protocol-Version: nonsense` returns `400`.
- Unsupported valid-looking version returns `400`.
- Version header on initialize does not override
  `initialize.params.protocolVersion`.
- Session id from another tenant or another engine process does not leak state.

sk/E2E tests:

- `tests/e2e/mcp-surface.e2e.test.ts` initializes a live engine and calls
  `tools/list` with `MCP-Protocol-Version: 2025-11-25`.
- Add a raw HTTP E2E case for invalid origin and unsupported protocol version
  against the live engine.

Acceptance evidence:

- Focused MCP transport tests pass.
- `bun run test:integration` includes `apps/engine/src/mcp/tests`.
- E2E `mcp-surface` proves the compiled test harness can talk to live `/mcp`.

## Phase 2: OAuth Discovery And Challenges

Implementation targets:

- Add `scope="mcp:read"` to unauthenticated `/mcp` `WWW-Authenticate`.
- Include `resource_metadata="<base>/.well-known/oauth-protected-resource"`.
- Add `scopes_supported` to Protected Resource Metadata root and `/mcp` variant.
- Source scopes from `auth.mcp_oauth.scopes_supported`.
- Keep Authorization Server metadata aligned with implemented flows only.
- Do not advertise OAuth features that subkit does not implement.

Engine tests:

- Unauthenticated `/mcp` returns `401` with parseable Bearer challenge.
- Challenge contains `resource_metadata` when `server.public_base_url` is set.
- Challenge contains `scope="mcp:read"`.
- Challenge contains no access tokens, API keys, cookies, or tenant secrets.
- PRM root and `/mcp` variant include `resource`, `authorization_servers`,
  and `scopes_supported`.
- `scopes_supported` is non-empty and matches config.
- AS metadata exposes endpoints, PKCE `S256`, public client auth method `none`,
  and supported scopes.
- If `client_id_metadata_document_supported` is not implemented, tests assert
  it is absent.
- Discovery routes return the documented error when config is unavailable.

sk/E2E tests:

- Add an E2E unauthenticated fetch against `/mcp` to verify the challenge header
  from a live engine.
- Existing `sk mcp-servers authorize` tests remain scoped to external MCP client
  behavior and should not be used as proof for engine `/mcp` OAuth.

Acceptance evidence:

- OAuth unit/integration tests pass.
- No discovery/challenge response includes secrets under redaction tests.

## Phase 3: Protocol Version Transitions

Implementation targets:

- Target protocol: `2025-11-25`.
- Missing version on a known initialized session uses session-negotiated version
  or the SDK-supported fallback.
- Missing version without a session falls back only where the spec allows.
- Record the selected behavior in tests so future SDK upgrades cannot drift.

Engine tests:

- Initialize negotiates `2025-11-25`.
- Subsequent request with `MCP-Protocol-Version: 2025-11-25` succeeds.
- Missing version on known session succeeds if the SDK/session supports it.
- Missing version without session follows the pinned fallback behavior.
- Known older compatible version behavior is explicit: accepted or rejected with
  a test name explaining why.
- Unsupported version returns `400`.

E2E tests:

- Live engine E2E initializes with `2025-11-25`, then calls at least
  `tools/list`, `resources/list`, and `prompts/list` with the header.

Acceptance evidence:

- Version tests fail loudly when `@modelcontextprotocol/sdk` changes supported
  versions.

## Phase 4: Elicitation

Implementation targets:

- Derive form support from `client.capabilities.elicitation.form`.
- Treat empty `elicitation: {}` as form-only for backward compatibility.
- Derive URL support only from `client.capabilities.elicitation.url`.
- Never send URL-mode elicitation unless URL support is advertised.
- Wire request mode as `url`, not `oob`.
- Keep existing conversation fallback behavior for clients that cannot elicit.

Unit tests:

- No elicitation capability means no form and no URL.
- Empty elicitation object means form-only.
- `{ form: {} }` means form-only.
- `{ url: {} }` means URL-only.
- `{ form: {}, url: {} }` means both.
- Form request contains `mode: "form"`, message, schema, and related request id.
- URL request contains `mode: "url"`, message, URL, and elicitation id.
- URL request is rejected before sending when client is form-only.
- Form request is rejected before sending when client is URL-only.
- Decline/cancel/invalid client responses normalize to existing behavior.
- Timeout returns through the existing fallback path without hanging the tool call.

Round-trip tests:

- MCP client handler receives a form elicitation request and responds accepted.
- MCP client handler receives a URL elicitation request only when URL is
  advertised.
- Client without elicitation support gets the non-elicitation confirmation path.

Acceptance evidence:

- Unit capability matrix plus Streamable HTTP round-trip tests pass.

## Phase 5: Tools

Implementation targets:

- `tools/list` returns `name`, `title`, `description`, `inputSchema`,
  `annotations`, `_meta.subkit`, and `execution.taskSupport`.
- Conversation tools that can run as MCP tasks are `taskSupport: "optional"`.
- Workflow/run tools remain `taskSupport: "forbidden"` unless task execution is
  implemented for them.
- Tool names satisfy the MCP name guidance and subkit's stricter local limit.
- Pagination uses opaque cursors and returns `nextCursor` only when more items
  are available.
- Existing catalog-budget fitting remains deterministic and compatible with
  pagination.
- Unknown tools and validation failures return tool-level errors where the model
  should self-correct; protocol-level errors are reserved for protocol mistakes.
- `notifications/tools/list_changed` fires for workflow catalog changes.

Engine tests:

- Every listed tool has valid name, title, description, input schema, and
  `execution.taskSupport`.
- Conversation tools are task-optional.
- Workflow tools are task-forbidden until implemented otherwise.
- Invalid cursor returns JSON-RPC `InvalidParams`.
- Helper-level cursor tests cover positive next-cursor sequencing.
- Workflow creation emits `tools/list_changed`.
- Unknown tool returns structured tool error and does not close the session.
- Destructive tool first returns `needs_confirm`, then succeeds with
  `_meta.sk_confirm`.
- Task-capable client can run a conversation tool through the existing task flow.
- Read-only MCP mode hides write tools.

sk/E2E tests:

- `mcp-surface.e2e.test.ts` asserts live `tools/list` has title and
  `execution.taskSupport`.
- Add an E2E task-capable client scenario for `conversation_start` if not already
  covered by engine integration.
- Add a `sk mcp` stdio E2E that starts the compiled `sk mcp` server with an MCP
  client, calls `tools/list`, `sk.ping`, `sk.conversation.create`, and
  `sk.conversation.list`.

Acceptance evidence:

- Tool metadata tests pass at engine and live E2E layers.
- `sk mcp` stdio proxy is tested with the compiled binary, not only imports.

## Phase 6: Resources And Templates

Implementation targets:

- `resources/list` returns paginated resources with `uri`, `name`, `title`,
  `description`, `mimeType`, and `size` where known.
- List visibility matches read visibility for connectors, knowledge sources,
  skill candidates, workflows, files, and operator digest.
- Portal-scope narrowing applies before list output.
- `resources/templates/list` returns URI templates for:
  `workflow://{id}`, `connector://{id}`, `knowledge://{id}`,
  `skill-candidate://{id}`, `file://{id}`, `fixture://{id}`, and
  `subkit://operator/health-digest`.
- Templates are listed only if the principal can read that resource family.
- `fixture://` stays read-on-demand unless subscription support is explicitly
  implemented.
- `resources/subscribe` rejects unsupported URI prefixes without growing the
  subscription set.
- Subscription cap remains enforced.
- `resources/updated` is emitted only for subscribed resources and only after
  RBAC re-check.
- `resources/list_changed` is emitted for membership or visibility changes.

Engine tests:

- List/read connector positive path.
- Read file returns text or blob according to content type.
- Read fixture positive, malformed id, and unknown id.
- Resource templates list includes all visible templates for admin.
- Member/custom role missing `stats:read` does not see operator digest in any
  resource page.
- Portal principal only sees allowed workflows/connectors.
- Custom role lacking `knowledge:read`, `skill:read`, or `file:read` does not
  list those resources and cannot read them.
- Invalid resource URI returns controlled JSON-RPC error.
- Unsupported subscribe URI is rejected.
- Subscribe cap remains pinned.
- `resources/updated` fires only for subscribed URI.
- RBAC revoked after subscription suppresses future update notifications.
- `resources/list_changed` fires on workflow/connector/file/knowledge/skill
  candidate changes.
- Invalid cursor returns `InvalidParams`; helper test covers positive pages.

sk/E2E tests:

- `mcp-surface.e2e.test.ts` calls live `resources/list` and
  `resources/templates/list` with pagination.
- REPL `/mcp` smoke verifies the resource count and at least one visible URI is
  rendered from the live REST catalog route.
- Member persona REPL `/mcp` verifies operator digest is absent.

Acceptance evidence:

- RBAC list/read parity has both engine integration and live sk-facing coverage.

## Phase 7: Prompts

Implementation targets:

- `prompts/list` paginates and includes `name`, `title`, `description`, and
  declared `arguments`.
- `prompts/get` accepts `arguments`.
- Required prompt arguments are enforced.
- Unknown prompt arguments are rejected with `InvalidParams`.
- Substitution is deliberately minimal: declared `{{name}}` placeholders in
  body/examples only, no arbitrary template engine.
- RBAC denied skill prompts are not listed and cannot be fetched.
- `prompts/list_changed` fires on active skill lifecycle changes.

Engine tests:

- List and get active skill prompt.
- `prompts/list` exposes declared arguments.
- `prompts/get` substitutes body and examples.
- Missing required arg returns `InvalidParams`.
- Unknown arg returns `InvalidParams`.
- Unknown prompt returns controlled error.
- Pagination has next cursor and invalid cursor negative.
- Skill lifecycle events fire list-changed within tenant only.
- Cross-tenant skill event does not fire list-changed.
- RBAC denied skill is absent from list and cannot be fetched.

sk/E2E tests:

- Live `/mcp` E2E calls `prompts/list` and `prompts/get` with arguments.
- REPL `/mcp` renders prompt names with descriptions.
- Add a headless `sk --p` or slash-driven flow that loads a skill-backed prompt
  only through engine APIs, proving the CLI surface does not invent prompt
  behavior client-side.

Acceptance evidence:

- Prompt argument and notification tests pass at engine level.
- REPL smoke proves prompt catalog visibility over sk.

## Phase 8: Completion

Implementation targets:

- `completion/complete` remains advertised only when implemented.
- Prompt completions read declared skill arguments.
- Tool completions read workflow input schema property names.
- Resource completions return empty values unless resource parameters are added.
- Completion responses obey limits and are stable.

Engine tests:

- Prompt ref returns matching argument names.
- Prompt enum descriptors return matching enum values when supported.
- Tool ref returns matching workflow input properties.
- Resource ref returns empty list.
- Unknown refs return empty list, not session failure.
- RBAC denied prompt/tool completions do not leak hidden names.

sk/E2E tests:

- No direct REPL completion contract is required unless sk exposes MCP
  completion UI. If added later, test with PTY tab-completion.

Acceptance evidence:

- Existing completion tests are extended for RBAC leak prevention.

## Phase 9: Async Tasks

Implementation targets:

- Server advertises tasks only for implemented task flows.
- Task-capable clients can call eligible conversation tools as tasks.
- Non-task tools are marked task-forbidden or return a controlled error when
  task-augmented incorrectly.
- Task list/get/result/cancel semantics are pinned through SDK task store.

Engine tests:

- Task-capable client sees task capability in initialize.
- `conversation_start` can be invoked as a task and returns task id/result.
- `tasks/list` returns the created task for the tenant.
- `tasks/cancel` cancels pending task when possible.
- Task id from another tenant is not visible.
- Non-task workflow tool cannot be invoked as a task unless implemented.

sk/E2E tests:

- Live MCP E2E covers one task-capable conversation start.
- REPL does not need to expose tasks unless UI support is added.

Acceptance evidence:

- Task tests prove both positive and cross-tenant negative behavior.

## Phase 10: Metadata And JSON Schema

Implementation targets:

- Tools, resources, resource templates, and prompts include `title`.
- Icons are omitted unless stable public asset URLs exist.
- Tool `execution.taskSupport` is present and accurate.
- JSON Schema for `inputSchema` and `outputSchema` is object-shaped and
  compatible with MCP expectations.
- No-argument tools should use a closed object schema where feasible:
  `{ "type": "object", "additionalProperties": false }`.
- subkit-specific `_meta` never replaces required MCP-standard fields.

Tests:

- Snapshot/parity test verifies required fields across tools/resources/prompts.
- JSON-schema parity test verifies schema conversion does not produce `any` or
  invalid schema roots.
- Optional icons are absent and accepted.
- Tool metadata test proves `_meta.subkit` and MCP fields coexist.

Acceptance evidence:

- Metadata tests fail if a tool/resource/prompt regresses to description-only
  objects.

## Phase 11: RBAC, Tenant Isolation, And Audit

Implementation targets:

- Every MCP list/read/call path is tenant scoped.
- List views must not disclose IDs or names that read would deny.
- Portal tokens are narrowed consistently for workflows/connectors/files.
- State-changing MCP tool calls audit request source, actor, resource, result,
  and confirmation state.
- Notification paths re-check RBAC where timing or URI disclosure matters.

Tests:

- Tenant A cannot list/read/subscribe to Tenant B resources.
- Portal principal only lists allowed resources.
- Custom role lacking each permission family sees no corresponding list entries.
- Direct read/call for hidden resources returns controlled denial.
- A resource subscribed before permission removal stops receiving updates after
  permission is revoked.
- Destructive MCP call without confirmation returns confirm envelope and audit
  approval requested.
- Destructive MCP call with `_meta.sk_confirm` records successful mutation audit.
- OAuth/API-key authentication events stay audited without leaking secrets.

Acceptance evidence:

- RBAC parity tests exist at list, read, notification, and call layers.
- Audit tests query `audit_log`, not just returned tool text.

## Phase 12: Unsupported-By-Design MCP Features

For every unsupported MCP capability, assert one of:

- The server does not advertise the capability.
- Calling the method returns a controlled JSON-RPC error.
- The sk proxy omits the capability.

Minimum unsupported matrix:

- Roots: not advertised by engine server unless implemented for client-provided
  root discovery.
- Sampling: not advertised unless engine asks clients for sampling.
- Logging/setLevel: not advertised unless client-controlled log level is added.
- Resource subscription for `fixture://`: not supported unless explicitly
  implemented.
- Prompt icons/resource icons: omitted unless stable public assets exist.
- Client `client_id_metadata_document_supported`: absent unless implemented.

Tests:

- Initialize capability snapshot proves unsupported capabilities are absent.
- Calls to unsupported methods do not crash the session.
- Docs and test names explain why the feature is unsupported.

Acceptance evidence:

- Unsupported matrix is part of the compliance checklist.

## Phase 13: sk CLI And REPL E2E

The engine MCP tests prove server behavior. The sk tests prove the operator
surfaces remain usable with the compliant server.

### `sk mcp` stdio proxy

Add `tests/e2e/sk-mcp-proxy.e2e.test.ts`.

Scenarios:

- Build and spawn compiled `dist/sk mcp` with persona config.
- Connect using MCP stdio client.
- `initialize` returns `serverInfo.name = "sk-cli"` and tool capability only.
- `tools/list` returns `sk.ping`, `sk.conversation.create`,
  `sk.conversation.append`, `sk.conversation.get`, `sk.conversation.list`.
- Each proxy tool has `title`, `description`, and object `inputSchema`.
- `sk.ping` calls live engine health.
- `sk.conversation.create` creates a conversation through the engine.
- `sk.conversation.append` appends to that conversation.
- `sk.conversation.get` returns messages/tool history.
- `sk.conversation.list` includes the created conversation.
- Unknown tool returns `isError: true` without killing stdio.
- Missing login/profile exits with a clear error and non-zero status.

Negative and edge tests:

- Invalid API key profile returns tool error, not malformed MCP.
- Engine unavailable returns tool error and preserves stdio process until client
  closes.
- No secrets are printed in tool errors.

### `sk` REPL `/mcp` catalog

Add `tests/e2e/repl-mcp-catalog.e2e.test.ts`.

Scenarios:

- Boot compiled REPL in PTY.
- Run `/mcp`.
- Verify prompts/resources/tools sections render.
- Verify at least one prompt, one resource, and one tool from live engine
  catalog appears for admin.
- Verify member persona does not see operator health digest.
- Verify `/mcp` handles empty catalog families gracefully.
- Verify `/mcp` does not surface HTTP 500/internal error on catalog route
  failures; it should show empty sections or controlled error text.

### Headless sk and MCP-adjacent flows

Extend `tests/e2e/sk-cli.e2e.test.ts` or add a focused file:

- `sk status` still succeeds when `/mcp` is configured.
- `sk --p` conversation turn can use engine MCP tool palette without CLI-side
  protocol knowledge.
- `sk mcp-servers` external server CRUD remains separate from engine `/mcp`
  compliance and should not be used as proof for engine server behavior.

Acceptance evidence:

- `bun run test:e2e` includes the new files.
- PTY tests are skipped only when `expect` is unavailable outside CI; CI treats
  missing `expect` as a failure.

## Phase 14: End-To-End Acceptance Matrix

Required commands before claiming compliance:

1. `bun run lint`
2. `bun run typecheck`
3. `bun run test:determinism`
4. `bun test apps/engine/src/mcp apps/engine/src/auth/oauth`
5. `bun run test:unit`
6. `bun run test:integration`
7. `bun run build:sk`
8. `bun run test:e2e`
9. `bun run verify:ai` if tool descriptions, prompts, conversation routing, or
   authoring behavior changed.
10. `bun run verify` before release if runtime is available.

Do not accept a narrow focused test as proof for the full matrix. Focused tests
are inner-loop evidence only.

## Implementation Order

1. Base protocol snapshots and JSON-RPC error discipline.
2. Transport guard and OAuth discovery.
3. Version transition tests.
4. Elicitation capability matrix.
5. Shared pagination helper.
6. Tools metadata and pagination.
7. Resources RBAC parity, templates, pagination, list-changed.
8. Prompts arguments, pagination, list-changed.
9. Completion and task edge coverage.
10. Unsupported capability snapshot.
11. sk stdio MCP proxy E2E.
12. sk REPL `/mcp` PTY E2E.
13. Full integration/e2e/verify gates.

## Current Gap Checklist

Track this list during implementation. Every item needs either a test name or
an unsupported-by-design assertion.

- [x] Live E2E initializes with `2025-11-25`, not an older sample version.
- [x] Initialize capability snapshots exist for engine and `sk mcp` stdio proxy.
- [x] JSON-RPC parse/unknown-method/malformed-params behavior is pinned.
  `streamable-http-jsonrpc.test.ts` records the current SDK transport behavior:
  malformed initialize params return a controlled JSON-RPC error with code
  `-32000`, not the stricter JSON-RPC `-32602`. Treat this as an explicit
  compatibility decision before calling the transport fully spec-normalized.
- [x] Ping, cancellation, progress metadata, and batch behavior are implemented
  or tested unsupported-by-design.
- [x] Live E2E covers invalid origin and invalid protocol version.
- [x] `tools/list` live E2E asserts `title` and `execution.taskSupport`.
- [x] Live E2E covers `resources/templates/list`.
- [x] Live E2E covers `prompts/get` with arguments.
- [x] RBAC list/read parity includes knowledge, skill candidates, files, and
  operator digest.
- [x] Notification tests include permission revoked after subscription.
- [x] Completion tests include RBAC non-leak.
- [x] Async task tests include task list/result/cancel and cross-tenant negative.
- [x] Unsupported capability snapshot exists.
- [x] `sk mcp` stdio proxy E2E exists.
- [x] REPL `/mcp` PTY E2E exists for admin and member.
- [x] Full `test:integration` and `test:e2e` are run before final compliance
  completion.

## Acceptance Definition

MCP compliance is complete only when:

- Every advertised engine capability has positive, negative, edge, RBAC, and
  tenant-isolation tests.
- Every unsupported MCP capability is absent by initialize snapshot or returns a
  controlled error by test.
- Streamable HTTP/OAuth/version/session behavior is covered at unit/integration
  and live E2E layers.
- sk CLI stdio proxy and REPL catalog behavior are covered with compiled binary
  E2E tests.
- Full local gates pass or any unavailable external dependency is recorded with
  exact command output and remaining risk.
