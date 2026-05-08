// Audit-source — engine-side Zod wrappers.
//
// The constants + literal tuple + `AuditSource` type live in
// `packages/shared/src/audit-source.ts` so the engine route boundary
// AND the `sk` CLI client both read from the same source. This
// module adds the engine-only Zod schemas (`AuditSourceEnum`,
// `DeployVersionSchema`) on top, with `.openapi()` annotations so
// the generated client surfaces them.
//
// Importers that need only the constants (header name, allowed
// values) should pull from `@shared/audit-source` directly; this
// module is for code that also needs Zod validation at a route
// boundary.

import { z } from "@hono/zod-openapi";
import { AUDIT_SOURCE_VALUES } from "@shared/audit-source.ts";

export const AuditSourceEnum = z.enum(AUDIT_SOURCE_VALUES).openapi("AuditSource");

export const DeployVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be MAJOR.MINOR.PATCH semver")
  .openapi("DeployVersion");
