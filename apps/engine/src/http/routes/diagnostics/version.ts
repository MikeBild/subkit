import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  AuditAction,
  auditAwait,
  DiagnosticsVersionReadMetadataSchema,
} from "../../../audit/index.ts";
import { getDb } from "../../../db/client.ts";
import { listEmbeddedMigrations } from "../../../db/migrate.ts";
import { getUpdateState } from "../../../update-state.ts";
import { getHealthState } from "../../health-state.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { OPENAPI_INFO } from "../../openapi.ts";

const VersionResponse = z
  .object({
    engine_version: z.string(),
    latest_version: z.string().optional(),
    update_available: z.boolean(),
    schema_drift: z.boolean(),
    embedded_migrations_count: z.number().int().nonnegative(),
  })
  .openapi("DiagnosticsVersionResponse");

const route = createRoute({
  method: "get",
  path: "/v1/diagnostics/version",
  tags: ["diagnostics"],
  summary: "Engine version, update posture, and schema-drift snapshot",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: VersionResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerVersionRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db") ?? getDb();
    const updateState = getUpdateState();
    const healthState = getHealthState();
    const embeddedCount = listEmbeddedMigrations().length;

    const engine_version = OPENAPI_INFO.version;
    const latest_version = updateState?.latest_version;
    const update_available = updateState?.update_available ?? false;
    const schema_drift = healthState.schema_drift;

    const metadata = DiagnosticsVersionReadMetadataSchema.parse({
      engine_version,
      latest_version,
      update_available,
      schema_drift,
    });
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.DIAGNOSTICS_VERSION_READ,
        resource_type: "engine",
        resource_id: null,
        result: "success",
        metadata,
      },
      db,
    );

    return c.json(
      {
        engine_version,
        ...(latest_version !== undefined ? { latest_version } : {}),
        update_available,
        schema_drift,
        embedded_migrations_count: embeddedCount,
      },
      200,
    );
  });
}
