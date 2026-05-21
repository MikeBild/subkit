// Shared JSONata binding builder used by every step kind that
// evaluates author-written JSONata against the execution scope —
// `transform.expression`, `loop.over`, `branch.when`, future
// expression sites.
//
// The data-handling skill promises uniform `$scope.<id>.data` access
// across all sites. That promise was previously broken on
// loop/branch which passed no bindings, so `$scope.X` resolved to
// `undefined` and the LLM looped through "is it $scope.X.data or
// just X.data or X.data.field?" guesses (session ebd66982: 4×
// retries on the same loop, 105 307 turn tokens, hit the step
// budget). Centralising the bindings makes the contract trivially
// enforceable: every author-facing JSONata gets the same surface.

import type { Db } from "../db/client.ts";
import { containsOffloadRef, deepResolveOffloadRefs } from "./offload-rehydrate.ts";

/**
 * Build the JSONata bindings every author expression sees:
 *   $input      — the workflow's top-level input
 *   $scope      — the full per-step scope envelope record
 *   $steps      — alias of $scope (kept for skill-doc symmetry)
 *   $<key>      — every `$`-prefixed key on scope (`$loop_index`,
 *                 `$item`, …) unpacked so paths read `$loop_index`
 *                 not `$scope.$loop_index`.
 *
 * Plain (non-`$`) scope keys remain addressable as bare path
 * expressions against the root context object — the second arg of
 * `expr.evaluate(scope, bindings)`.
 */
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

/**
 * Re-hydrate the execution `scope` for a step that is about to evaluate
 * author JSONata against it.
 *
 * The loop runner substitutes `OffloadRef` placeholders into the scope
 * envelope of a loop step (`$scope.<loop>.data` becomes an array whose
 * large entries are references, not payloads — the OOM fix). When a
 * DOWNSTREAM step's expression reads that loop key, JSONata must see
 * the original array, not the placeholders. This helper produces a
 * scope COPY with every embedded `OffloadRef` resolved back to its
 * payload — the original scope object keeps the bounded references so
 * the run stays within memory.
 *
 * Laziness is at step granularity: only a step that actually evaluates
 * JSONata calls this, and the fast path returns the original scope
 * untouched when it holds no `OffloadRef` — so a loop with no
 * downstream consumer never re-materialises.
 *
 * A re-hydration failure throws `OffloadResolutionError`, failing the
 * consuming step with a typed error.
 *
 * `signal` is the execution abort signal: re-hydrating a multi-MB S3
 * object is an interruptible fetch, so a cancelled run must not run the
 * GET to completion. Threaded down to `resolveOffloaded`.
 */
export async function resolveScopeForJsonata(
  db: Db,
  tenant_id: string,
  scope: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Fast path: nothing offloaded → return the original reference.
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
