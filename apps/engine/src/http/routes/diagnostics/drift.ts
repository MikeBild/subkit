// Schema-drift diagnostics endpoint.
//
//   GET /v1/diagnostics/drift
//
// Surfaces the structured drift report so `sk doctor` can show the
// operator the rows that don't belong in this engine's lineage. Read
// from `drizzle.__drizzle_migrations` and compared against the
// migrations embedded in the binary at compile time. Issue #149.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  AuditAction,
  auditAwait,
  DiagnosticsDriftReadMetadataSchema,
} from "../../../audit/index.ts";
import { getDb } from "../../../db/client.ts";
import { DriftReportSchema, detectDrift, listEmbeddedMigrations } from "../../../db/migrate.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { OPENAPI_INFO } from "../../openapi.ts";

// Reuse the runtime schema as the wire shape — single source of truth
// (review W3). The route adds three derived fields (engine_version,
// embedded_migration_count, db_migration_count) so the operator
// dashboard can render counts without summing client-side.
const DriftResponse = DriftReportSchema.extend({
  /** Engine binary version that produced this report. */
  engine_version: z.string(),
  /** Number of migrations baked into this binary at build time. */
  embedded_migration_count: z.number().int(),
  /** Number of rows currently in `drizzle.__drizzle_migrations`. */
  db_migration_count: z.number().int(),
}).openapi("DriftReport");

const route = createRoute({
  method: "get",
  path: "/v1/diagnostics/drift",
  tags: ["diagnostics"],
  summary: "Schema-drift report — embedded vs. applied migration set",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: DriftResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerDriftRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db") ?? getDb();
    const report = await detectDrift(db);
    const embedded = listEmbeddedMigrations();
    // total rows in drizzle.__drizzle_migrations = (embedded ∩ DB) ∪ (unknown rows)
    //                                           = (embedded.length - missing_in_db.length) + unknown_in_db.length
    const db_migration_count =
      embedded.length - report.missing_in_db.length + report.unknown_in_db.length;

    // W1 + W2 (review #2) — parse metadata through the schema, then
    // await the audit row before returning. Drift reads are
    // privilege-sensitive; the cost of a guaranteed compliance row
    // exceeds the negligible latency add.
    const metadata = DiagnosticsDriftReadMetadataSchema.parse({
      embedded: embedded.length,
      db: db_migration_count,
      unknown: report.unknown_in_db.length,
      missing: report.missing_in_db.length,
    });
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.DIAGNOSTICS_DRIFT_READ,
        resource_type: "migrations_journal",
        resource_id: null,
        result: "success",
        metadata,
      },
      // Bind the audit insert to the request's db handle so the row
      // lands on the same database the route just read from. In
      // production `c.get("db")` is the shared `getDb()`; in tests
      // it's the per-suite handle bound by `createHttpTestServer`.
      db,
    );

    return c.json(
      {
        engine_version: OPENAPI_INFO.version,
        embedded_migration_count: embedded.length,
        db_migration_count,
        unknown_in_db: report.unknown_in_db,
        missing_in_db: report.missing_in_db,
      },
      200,
    );
  });
}
