// Test-only seam for boot dependency probes.
//
// AGENTS.md subsystem map: `apps/engine/src/test-helpers/` is the
// canonical home for engine-internal cross-subsystem fixtures.
// Production code uses `validateBootDependencies()` (which calls
// `process.exit(1)` on a blocker failure); tests need the same probe
// pipeline without the fatal exit so they can assert blocker
// classification.
//
// Importing the underscore-prefixed `_validateBootDependenciesForTests`
// directly from the production module worked, but lived in
// `apps/engine/src/observability/`. Re-exporting from this dir keeps
// production callers from accidentally reaching for the non-fatal
// variant — anyone touching it is now visibly in test territory.

export { _validateBootDependenciesForTests } from "../observability/boot-dependencies.ts";
