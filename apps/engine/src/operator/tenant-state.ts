type Invalidator = (tenantId?: string) => void;

const invalidators = new Set<Invalidator>();

export function registerTenantStateCache(invalidate: Invalidator): void {
  invalidators.add(invalidate);
}

export function invalidateTenantState(tenantId?: string): void {
  for (const invalidate of invalidators) invalidate(tenantId);
}
