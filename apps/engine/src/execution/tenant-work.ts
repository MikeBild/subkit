import { randomUUID } from "node:crypto";

const bootId = randomUUID();
const work = new Map<string, Set<symbol>>();

export function beginTenantWork(tenantId: string): () => void {
  const token = Symbol();
  const active = work.get(tenantId) ?? new Set<symbol>();
  active.add(token);
  work.set(tenantId, active);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.delete(token);
    if (active.size === 0) work.delete(tenantId);
  };
}

export async function withTenantWork<T>(tenantId: string, operation: () => T): Promise<Awaited<T>> {
  const finish = beginTenantWork(tenantId);
  try {
    return await operation();
  } finally {
    finish();
  }
}

export function tenantWorkSnapshot(tenantId: string): { boot_id: string; in_flight: number } {
  return { boot_id: bootId, in_flight: work.get(tenantId)?.size ?? 0 };
}

export function tenantWorkInFlight(): number {
  let total = 0;
  for (const active of work.values()) total += active.size;
  return total;
}
