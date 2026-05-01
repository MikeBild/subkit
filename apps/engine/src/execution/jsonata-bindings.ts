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
