// Audit-source taxonomy — shared between the engine route boundary
// (apps/engine/src/audit/audit-source.ts re-exports from here when
// values overlap) and the `sk` CLI client (apps/sk/src/engine-client.ts).
//
// Lives in `packages/shared/` because both the engine (which validates
// the header at the route boundary via Zod) and the CLI (which sends
// the header on every settings PUT) need the same constant + enum
// literal. Without this, the CLI would carry hardcoded strings and a
// future rename in the engine would silently leave the CLI sending
// the old header name (the route's optional() schema would still 200,
// audit_source would just go missing on every operator-driven write).
//
// The engine package keeps the Zod schema (audit-source.ts in the
// engine) but takes the constant + literal-tuple from here so the
// header name lives in exactly one place.

/** HTTP header name that callers set to tag the audit row with the
 *  channel that initiated the write (operator CLI vs deploy bootstrap). */
export const AUDIT_SOURCE_HEADER = "x-subkit-audit-source" as const;

/** Companion header: deploy pipeline's release version. Recorded on
 *  `audit_source: "deploy_bootstrap"` rows so compliance can trace
 *  "which release SHA flipped this LLM key" without joining outside
 *  the audit log. Strict semver MAJOR.MINOR.PATCH — pre-release / build
 *  metadata kept out so the audit ledger stays trivially queryable. */
export const DEPLOY_VERSION_HEADER = "x-subkit-deploy-version" as const;

/** Allowed values for `AUDIT_SOURCE_HEADER`. Keep this list TIGHT:
 *  only values with a known caller today. Adding speculative entries
 *  clutters the audit ledger taxonomy. The historical v1 channel
 *  name (the term subkit retired in 4.0.x) is also explicitly
 *  disallowed by the terminology gate
 *  (scripts/terminology.banned.txt). */
export const AUDIT_SOURCE_VALUES = ["sk_cli", "deploy_bootstrap"] as const;
export type AuditSource = (typeof AUDIT_SOURCE_VALUES)[number];
