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

const DriftResponse = DriftReportSchema.extend({
  engine_version: z.string(),
  embedded_migration_count: z.number().int(),
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
    const db_migration_count =
      embedded.length -
      report.missing_in_db.length +
      report.unknown_in_db.length +
      report.historical_in_db.length;

    const metadata = DiagnosticsDriftReadMetadataSchema.parse({
      embedded: embedded.length,
      db: db_migration_count,
      unknown: report.unknown_in_db.length,
      historical: report.historical_in_db.length,
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
      db,
    );

    return c.json(
      {
        engine_version: OPENAPI_INFO.version,
        embedded_migration_count: embedded.length,
        db_migration_count,
        unknown_in_db: report.unknown_in_db,
        historical_in_db: report.historical_in_db,
        missing_in_db: report.missing_in_db,
      },
      200,
    );
  });
}
