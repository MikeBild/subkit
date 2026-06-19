// Internal-only symbols shared across the http subsystem. Exports
// here are NOT public API — both `errors.ts` and `middleware/error.ts`
// import this for the brand-based envelope dispatch, but no consumer
// outside `apps/engine/src/http/` should reach in.
//
// Kept in a separate file (rather than inline in `errors.ts`) so the
// brand doesn't leak into the OpenAPI/IDE autocomplete surface of
// the public errors module.
//
// @internal

/**
 * Brand symbol stamped on `BrandedEnvelopeOptions` so the envelope
 * dispatcher can distinguish a legacy positional `details` bag from
 * the new `{hint, retry_after, details}` shape — without ever
 * shape-sniffing.
 *
 * `Symbol.for(...)` is used (not `Symbol(...)`) so a re-bundled
 * module under bun's parallel test runner sees the same symbol
 * identity as the engine's runtime.
 *
 * Trust model: `Symbol.for("sk.HttpErrorOptions")`
 * lives in the global symbol registry, so any code in-process can
 * re-fetch the same symbol and stamp a forged brand on a details
 * bag. This is acceptable for this codebase: the engine runs
 * in-process trust (no plugin/sandbox tier), and the brand exists
 * to prevent ACCIDENTAL shape-sniffing collisions when an existing
 * details bag happens to contain a `hint` key, not to defend
 * against malicious in-process code. If the trust model ever
 * changes, swap to `Symbol(...)` plus a per-module test export of
 * the brand and accept the rebundling-in-tests fallout.
 */
export const ENVELOPE_BRAND: unique symbol = Symbol.for("sk.HttpErrorOptions") as never;
