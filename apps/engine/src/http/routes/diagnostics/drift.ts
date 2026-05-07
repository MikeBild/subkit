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
import { getDb } from "../../../db/client.ts";
import { detectDrift, listEmbeddedMigrations } from "../../../db/migrate.ts";
import type { AppEnv } from "../../openapi.ts";
import { OPENAPI_INFO } from "../../openapi.ts";

const UnknownRow = z.object({
  row_id: z.number().int(),
  hash: z.string(),
  created_at: z.number().int().nullable(),
});

const MissingRow = z.object({
  idx: z.number().int(),
  tag: z.string(),
  hash: z.string(),
});

const DriftResponse = z
  .object({
    /** Engine binary version that produced this report. */
    engine_version: z.string(),
    /** Number of migrations baked into this binary at build time. */
    embedded_migration_count: z.number().int(),
    /** Number of rows currently in `drizzle.__drizzle_migrations`. */
    db_migration_count: z.number().int(),
    /** Migrations the DB has but this binary doesn't recognise — the
     *  #149 alarm. */
    unknown_in_db: z.array(UnknownRow),
    /** Migrations this binary has but the DB doesn't yet — informational;
     *  the boot path applies these on the same boot. */
    missing_in_db: z.array(MissingRow),
  })
  .openapi("DriftReport");

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
    const db = c.get("db") ?? getDb();
    const report = await detectDrift(db);
    const embedded = listEmbeddedMigrations();
    // total rows in drizzle.__drizzle_migrations = (embedded ∩ DB) ∪ (unknown rows)
    //                                           = (embedded.length - missing_in_db.length) + unknown_in_db.length
    const db_migration_count =
      embedded.length - report.missing_in_db.length + report.unknown_in_db.length;
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
