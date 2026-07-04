// GET /v1/health — public, returns engine status + db connectivity.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import type { AppEnv } from "../openapi.ts";
import { OPENAPI_INFO } from "../openapi.ts";

// /v1/health is unauthenticated and reachable from the public internet.
// It MUST stay minimal — no fields that leak operational posture
// (which secrets are present, which provider is wired, model names,
// schema-drift state, update availability). The operational fields
// (`db_schema_drift`, `update_available`, `latest_version`) live
// behind `audit:read` at `GET /v1/diagnostics/version`.

const HealthResponse = z
  .object({
    status: z.literal("ok"),
    version: z.string(),
    db_connected: z.boolean(),
    uptime_seconds: z.number(),
  })
  .openapi("HealthResponse");

const route = createRoute({
  method: "get",
  path: "/v1/health",
  tags: ["health"],
  summary: "Engine health and DB connectivity",
  responses: {
    200: {
      description: "Health snapshot",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

// Readiness is distinct from liveness: /v1/health is a liveness probe (the
// process is up → 200, with db_connected as an informational field), while
// /v1/readyz is a readiness probe that returns 503 when the engine cannot
// serve real traffic because its database is unreachable. Load balancers /
// orchestrators should gate routing on /readyz, not /health.
const ReadyResponse = z
  .object({
    status: z.enum(["ready", "unavailable"]),
    db_connected: z.boolean(),
  })
  .openapi("ReadyResponse");

const readyRoute = createRoute({
  method: "get",
  path: "/v1/readyz",
  tags: ["health"],
  summary: "Engine readiness (503 when the database is unreachable)",
  responses: {
    200: {
      description: "Ready",
      content: { "application/json": { schema: ReadyResponse } },
    },
    503: {
      description: "Not ready — database unreachable",
      content: { "application/json": { schema: ReadyResponse } },
    },
  },
});

const BOOT_AT = Date.now();

async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch (err) {
    logger.warn({
      module: "http",
      action: "health.db_ping_failed",
      msg: "db ping failed in /v1/health",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface HealthDeps {
  db?: Db;
}

export function registerHealthRoute(app: OpenAPIHono<AppEnv>, deps: HealthDeps = {}): void {
  app.openapi(route, async (c) => {
    const db = deps.db ?? c.get("db") ?? getDb();
    const db_connected = await pingDb(db);
    return c.json(
      {
        status: "ok" as const,
        version: OPENAPI_INFO.version,
        db_connected,
        uptime_seconds: Math.floor((Date.now() - BOOT_AT) / 1000),
      },
      200,
    );
  });

  app.openapi(readyRoute, async (c) => {
    const db = deps.db ?? c.get("db") ?? getDb();
    const db_connected = await pingDb(db);
    return c.json(
      {
        status: db_connected ? ("ready" as const) : ("unavailable" as const),
        db_connected,
      },
      db_connected ? 200 : 503,
    );
  });
}
