// Driver egress fetch seam.
//
// Every production egress call site (http driver transport, s3 ranged
// reads, oauth2 token/registration exchanges, token-mint) goes through
// `getDriverFetch()` instead of the global. Two reasons:
//
//   1. Cross-file test pollution: `bun test` runs files concurrently in
//      one process, and suites that stub `globalThis.fetch` (discovery
//      tests use an always-200 mock) leak mid-flight into sibling
//      suites — caught live as a 404 probe observing a 200 (CI run
//      27425002067). Drivers read the seam, never the global.
//   2. Precise egress tripwires: tests that assert "this code path
//      makes NO live HTTP" install through the seam and intercept
//      exactly driver egress.
//
// The override is ASYNC-CONTEXT-SCOPED (AsyncLocalStorage), not a
// module global: a first cut used a plain variable and merely MOVED
// the cross-file race into the seam (CI run 27428076111 — an oauth
// suite's 200-for-any-URL mock answered a sibling's 404 probe).
//
// The override is installed EXCLUSIVELY via the explicit wrapper
// `_withDriverFetchForTests(fn, body)` (= `store.run`), never via
// `enterWith`. A second cut exposed `_setDriverFetchForTests` backed by
// `AsyncLocalStorage.enterWith` and called it from `beforeEach`; under
// bun that binding did NOT reliably propagate from the hook's async
// chain into the test bodies — the cognito oauth2 suite saw no override
// at all, hit the real network, and timed out at 10s × 7 tests, while
// an identically-structured sibling suite happened to pass. Propagation
// is chain-structure-dependent and therefore unusable as a contract.
// `store.run` scopes the override to the wrapped body deterministically:
// everything awaited inside sees it, concurrently-running sibling test
// files (different async roots) never do.
//
// `_withDriverFetchForTests` is a gated test seam — production code must
// never import it (enforced by the `test_seams_gated` invariant; tests
// go through `test-helpers/driver-fetch.ts`).

import { AsyncLocalStorage } from "node:async_hooks";

const LOAD_TIME_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

const overrideStore = new AsyncLocalStorage<typeof fetch>();

export function getDriverFetch(): typeof fetch {
  return overrideStore.getStore() ?? LOAD_TIME_FETCH;
}

/** Test seam: run `body` with the driver-egress fetch bound to `fn`
 *  (`null` = the load-time-captured real fetch). The override is visible
 *  to everything awaited inside `body` and to nothing else — never to
 *  concurrently-running sibling test files. */
export function _withDriverFetchForTests<T>(
  fn: typeof fetch | null,
  body: () => Promise<T>,
): Promise<T> {
  return overrideStore.run(fn ?? LOAD_TIME_FETCH, body);
}
