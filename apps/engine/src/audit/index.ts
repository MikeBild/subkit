// Public API barrel for the `audit` subsystem. Routes and other
// subsystems must import from this entry point only — see the
// route_layering check at apps/engine/scripts/audit-invariants.ts.

export * from "./audit.ts";
// `audit-source.ts` exports Zod schemas only (constants + types live
// in `@shared/audit-source`); re-exported here so existing
// `from "../../audit"` imports keep working without churn.
export * from "./audit-source.ts";
export * from "./buckets.ts";
export * from "./query.ts";
// `readRequestSource` is the single helper every route uses to
// project the trace-middleware-set `request_source` onto audit
// metadata. Re-exported from the audit barrel so the route boundary
// has one import path for the audit surface.
export * from "./request-source.ts";
export * from "./types.ts";
