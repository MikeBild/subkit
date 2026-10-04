import type { Db } from "../db/client.ts";
import { containsOffloadRef, deepResolveOffloadRefs } from "./offload-rehydrate.ts";

export function buildJsonataBindings(
  scope: Record<string, unknown>,
  input?: unknown,
): Record<string, unknown> {
  const bindings: Record<string, unknown> = {
    input,
    scope,
    steps: scope,
  };
  for (const [k, v] of Object.entries(scope)) {
    if (k.startsWith("$") && k.length > 1) {
      bindings[k.slice(1)] = v;
    }
  }
  return bindings;
}

export async function resolveScopeForJsonata(
  db: Db,
  tenant_id: string,
  scope: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let needsResolve = false;
  for (const v of Object.values(scope)) {
    if (containsOffloadRef(v)) {
      needsResolve = true;
      break;
    }
  }
  if (!needsResolve) return scope;
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(scope)) {
    resolved[k] = await deepResolveOffloadRefs(db, tenant_id, v, signal);
  }
  return resolved;
}
