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
//      27425002067). Capturing the real fetch at module load makes
//      driver egress immune to sibling stubs.
//   2. Precise egress tripwires: tests that assert "this code path
//      makes NO live HTTP" install through `_setDriverFetchForTests`
//      (via the test-helpers shim) and intercept exactly driver
//      egress — instead of stubbing the global and hoping the driver
//      reads it at the right instant.
//
// `_setDriverFetchForTests` is a gated test seam — production code must
// never import it (enforced by the `test_seams_gated` invariant; tests
// go through `test-helpers/driver-fetch.ts`).

const LOAD_TIME_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

let driverFetch: typeof fetch = LOAD_TIME_FETCH;

export function getDriverFetch(): typeof fetch {
  return driverFetch;
}

/** Test seam: override (or reset with `null`) the driver egress fetch. */
export function _setDriverFetchForTests(fn: typeof fetch | null): void {
  driverFetch = fn ?? LOAD_TIME_FETCH;
}
