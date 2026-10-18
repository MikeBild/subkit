# TODO

## High priority: hosted self-service offering (register, own tenant, start immediately)

Direction: one shared engine, one isolated tenant per registered account, platform LLM
key with a fixed budget per tenant, open registration with throttling. The hosted
deployment is a separate deployment path next to the existing one; the existing release
and deploy path stays unchanged. Product position documents must change from
self-hosting-only to include the hosted offering before registration opens.

Done: separation of engine-operator authority from tenant authority.

Remaining increments, in order. Each one is shippable on its own; open registration
requires all of them up to the isolation review.

1. Database connection robustness: keepalive and bounded connect, query and statement
   timeouts on the pool and the listener, configurable pool maximum, `search_path` set
   per connection so the boot assertion does not depend on role settings.
2. Tenant model: tenant origin and status columns, one domain operation that provisions
   a tenant (insert only, random slug, owner role without engine-wide rights, idempotent
   through a global unique identity binding, only for verified emails), central status
   enforcement (login, principals, hooks, cron, dequeue, seeds, session and key
   revocation on suspend), operator-set budget that fails closed and is measured in
   money with a global monthly ceiling, atomic budget reservation with every direct LLM
   call covered, no runtime-config overlay for self-service tenants, tenants cannot set
   their own budget, model or limits.
3. Login per identity: ignore the tenant query parameter, resolve the tenant in the
   callback, per-provider signup policy instead of the global flag, join an existing
   tenant only through an existing link or an invite token, verified email required,
   adapt the identity assertion, `sk` login and token exchange.
4. Fairness and abuse protection: per-tenant job grouping and concurrency, per-tenant
   limit for inline chat turns, rate limits per principal and tenant stored in
   PostgreSQL, trusted proxy hop for forwarded addresses, throttled tenant creation and
   MCP client registration, SSRF gaps (database and object-store connectors, redirects,
   DNS rebinding, missing address ranges, internal platform networks), storage quota and
   smaller file limit per tenant, capped tenant-scoped resource limits, chat workspaces
   locked until ownership is proven.
5. Tenant lifecycle: erasure (data, objects, secrets, config entries, audit event),
   owner-initiated deletion in the Cockpit (design from Lovable), scheduler for trial
   expiry and grace period, lifecycle webhook route that verifies the signed event and
   maps (issuer, subject) to a tenant.
6. Authentication mail: Upraft Auth delivery webhook to the SubKit workflow with the
   execution marked sensitive so action links are never stored in clear text; verify
   step outputs, logs and spans; end-to-end test with a dedicated account before
   switching off the built-in mail; uptime monitor on the hook.
7. Hosted deployment runbook (outside this repository, every mutation approved):
   Git build of the release commit, session-mode writer binding with owner access,
   compatibility repair of managed schemas, app revision with memory, stop-grace,
   drain and probe values, single replica until limits are in PostgreSQL, object-store
   binding with conformance run, fresh master key with offline escrow, domain and TLS,
   dedicated Auth realm with open signup, paired database and bucket backup, rollback
   rule, uptime monitors. Review all `tenant-filter:exempt` sites and add cross-tenant
   journeys for self-service before registration opens.
8. Product position and legal: update `LAUNCH.md`, `LAUNCH_STATUS.md`, `README.md` and
   generated `llms*.txt`; imprint, privacy policy, data-processing agreement and terms.

Known smaller findings to fold into the increments above: a failed tenant activation
blocks other tenants' settings writes until the operator activates; the operator
backfill in a multi-tenant installation picks silently and should log its choice.

## Open verification after the operator separation

- Run `bun run verify`, the contract and end-to-end suites, `verify:functional-cockpit`
  and `demo:local:verify` before the next release tag; none ran for this change.
- `query-fragment.test.ts` fails in batch runs and passes alone; find the shared state.
- The sandbox helper drift check fails with a Bun version other than the pinned one;
  make the pre-push hook or `verify` fail early with a clear message about the pinned version.
- Not reviewed in depth: inbound hooks, read tools of the chat, the apps listing.
- Optional hardening left out: composite foreign keys and tenant filters in API-key row
  and role lookups, a deterministic test for a token refresh racing a client revoke,
  a drift test that every example scope is a known permission.

## Decisions needed before the hosted offering

- One tenant per person, or several memberships with a tenant switch.
- Budget unit and limits per tenant (amount per month, global monthly ceiling, model allowlist).
- Replica count at launch; more than one requires the limits to live in PostgreSQL first.
- Erasure grace period, retention of old config revisions and audit metadata, behaviour
  when an invited member is deleted.
- Legal texts (imprint, privacy policy, data-processing agreement, terms) and who signs them off.
- Whether the tagged release images kept for local demos stay on the development machine.

## Row-Level Security as a second line of tenant isolation

Deferred for the hosted self-service offering. Tenant isolation currently relies on
application-level tenant filters enforced by the tenant-filter invariant and the
cross-tenant isolation journeys.

- Enable PostgreSQL row-level security on tenant-scoped tables with a per-connection
  tenant setting, so a missing application filter fails closed.
- Cover tables without a tenant column first (runtime config revisions, runtime secret
  versions) or document why they stay operator-only.
- Re-review every `tenant-filter:exempt` site against the policy model.
- Measure the query-plan and connection-pooling impact (session pool mode) before enabling.
