// Audit-source taxonomy.
//
// Tags an audit_log row's `metadata.audit_source` so compliance
// review can distinguish "operator hand-typed via sk CLI" from
// automated paths (currently the deploy-body bootstrap PUT). The
// row's `actor_type`/`actor_id` always reflect the authenticated
// principal — this enum surfaces the *channel*, not the actor.
//
// The constant + literal-tuple ARE shared with the `sk` CLI via
// `@shared/audit-source`. The Zod-typed schema lives here (engine
// route boundary), but takes its enum members from
// `AUDIT_SOURCE_VALUES` so a future addition lands in one place
// (the shared package) and propagates to both the route validator
// and the CLI client. Without this, the CLI would carry hardcoded
// strings and a future rename would silently leave the CLI sending
// the old header name (the route's `.optional()` schema would still
// 200, audit_source would just go missing on every operator-driven
// write).

import { z } from "@hono/zod-openapi";
import { AUDIT_SOURCE_VALUES } from "@shared/audit-source.ts";

export {
  AUDIT_SOURCE_HEADER,
  type AuditSource,
  DEPLOY_VERSION_HEADER,
} from "@shared/audit-source.ts";

export const AuditSourceEnum = z.enum(AUDIT_SOURCE_VALUES).openapi("AuditSource");

export const DeployVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be MAJOR.MINOR.PATCH semver")
  .openapi("DeployVersion");
