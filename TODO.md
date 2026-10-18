# TODO

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
