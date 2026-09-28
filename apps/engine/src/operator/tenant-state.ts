// One call that says "this tenant's operator state changed".
//
// The operational overview and the attention list each cache a tenant's facts
// for 10 s. A decision (a fix approved, a skill rejected, execution authority
// granted, a connection renewed, a secret version approved…) changes both, and
// a writer that cleared only one left the decided item on the other surface
// for up to ten seconds — long enough to be decided a second time.
//
// Writers call `invalidateTenantState`; caches register themselves. This
// module imports nothing, so any subsystem can call it without a cycle.

type Invalidator = (tenantId?: string) => void;

const invalidators = new Set<Invalidator>();

/** A per-tenant cache that must drop its entry when the tenant's state changes. */
export function registerTenantStateCache(invalidate: Invalidator): void {
  invalidators.add(invalidate);
}

/** Drop every cached view of `tenantId` (or of every tenant). */
export function invalidateTenantState(tenantId?: string): void {
  for (const invalidate of invalidators) invalidate(tenantId);
}
