// Engine version + update / drift posture diagnostics endpoint.
//
//   GET /v1/diagnostics/version
//
// The operational fields (engine version, latest available release,
// schema-drift posture) live here behind `audit:read` instead of on
// the public `/health`, so an unauthenticated caller cannot
// fingerprint the engine. Mirrors the layering of
// `diagnostics/drift.ts`: `audit:read` permission via the path-scoped
// middleware in `diagnostics/index.ts`, an `auditAwait`-bound row
// before the response goes out, and a Zod response shape registered
// as a named OpenAPI component.

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
    /** Engine binary version baked in at compile time. */
    engine_version: z.string(),
    /** Latest version the boot probe found on the configured channel.
     *  Absent when the probe is disabled by operations.update_check_enabled
     *  or has not
     *  finished its first cycle yet. */
    latest_version: z.string().optional(),
    /** Whether the boot probe observed a newer release. Defaults to
     *  false when no probe data is available. */
    update_available: z.boolean(),
    /** Whether tagged or missing journal identities disagree with the embedded set. */
    schema_drift: z.boolean(),
    /** How many migrations are baked into this binary. Lets operators
     *  cross-check that a deploy is what they expect without joining
     *  against `/v1/diagnostics/drift`. */
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

    // Mirror `diagnostics/drift.ts:64-86`: parse metadata through the
    // schema, then await the audit row before returning. Drift / version
    // reads are privilege-sensitive; the cost of a guaranteed compliance
    // row exceeds the negligible latency add.
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
