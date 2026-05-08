// Audit-source taxonomy.
//
// Tags an audit_log row's `metadata.audit_source` so compliance
// review can distinguish "operator hand-typed via sk CLI" from
// automated paths (currently the deploy-body bootstrap PUT). The
// row's `actor_type`/`actor_id` always reflect the authenticated
// principal — this enum surfaces the *channel*, not the actor.
//
// Lives in `audit/` rather than the route that consumes it because:
//   1. Multiple HTTP routes will eventually carry this header
//      (`/v1/connectors`, `/v1/credentials`, …); the enum is the
//      audit subsystem's contract, not a per-route concern.
//   2. AGENTS.md subsystem map: `apps/engine/src/audit/` owns
//      audit-log shapes. Defining the enum elsewhere makes the
//      taxonomy invisible to engine code that consumes audit rows
//      (`audit/query.ts`, future export pipelines).
//
// Keep this list TIGHT: only values with a known caller today.
// Adding speculative entries (e.g. "ui", "mcp", or other channel
// labels not yet wired up) clutters the audit ledger taxonomy.
// The historical v1 channel name "auto[m]ation" (the term subkit
// retired) is also explicitly disallowed by the terminology gate
// (scripts/terminology.banned.txt). Future callers extend the
// enum when they actually plumb the header.

import { z } from "@hono/zod-openapi";

export const AuditSourceEnum = z.enum(["sk_cli", "deploy_bootstrap"]).openapi("AuditSource");
export type AuditSource = z.infer<typeof AuditSourceEnum>;

/** HTTP header name that callers set to tag the audit row. Validated
 *  through `AuditSourceEnum` at the route boundary. */
export const AUDIT_SOURCE_HEADER = "x-subkit-audit-source";

/** Companion header: the deploy pipeline's release version, recorded
 *  on `audit_source: "deploy_bootstrap"` rows so compliance can
 *  trace "which release SHA flipped this LLM key" without joining
 *  outside the audit log. Strictly semver `MAJOR.MINOR.PATCH` —
 *  pre-release / build metadata kept out so the audit ledger stays
 *  trivially queryable. */
export const DEPLOY_VERSION_HEADER = "x-subkit-deploy-version";
export const DeployVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be MAJOR.MINOR.PATCH semver")
  .openapi("DeployVersion");
