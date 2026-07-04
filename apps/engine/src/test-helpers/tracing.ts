// Test-only seam for the OTel tracing reconfigure path.
//
// `reconfigureTracing()` (apps/engine/src/observability/tracing.ts)
// reads-and-clears a module-level "fail next reconfigure" flag at
// the top of each call. Tests that exercise the loader's
// `metadata.reconfigure_failed=true` branch need to flip this flag
// without subclassing the SDK.
//
// Mirrors the `test-helpers/boot.ts` shape: the underscore-prefixed
// production export stays in its module so the symbol is grep-able
// from a single source, but the canonical import path for tests is
// this file. `apps/engine/scripts/audit-invariants.ts` enforces that
// production code never imports the underscore symbol directly —
// any future regression to the wrong import path trips
// `checkTestSeamsGated`.

export {
  _clearReconfigureFailureForTests,
  _failNextReconfigureForTests,
} from "../observability/tracing.ts";
