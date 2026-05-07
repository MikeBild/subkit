// Internal-only symbols shared across the http subsystem. Exports
// here are NOT public API — both `errors.ts` and `middleware/error.ts`
// import this for the brand-based envelope dispatch, but no consumer
// outside `apps/engine/src/http/` should reach in.
//
// Kept in a separate file (rather than inline in `errors.ts`) so the
// brand doesn't leak into the OpenAPI/IDE autocomplete surface of
// the public errors module. R5-S5 review fix.
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
 */
export const ENVELOPE_BRAND: unique symbol = Symbol.for("sk.HttpErrorOptions") as never;
