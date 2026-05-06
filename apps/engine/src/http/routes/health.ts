// GET /v1/health — public, returns engine status + db connectivity.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { getUpdateState } from "../../update-state.ts";
import type { AppEnv } from "../openapi.ts";
import { OPENAPI_INFO } from "../openapi.ts";

// /v1/health is unauthenticated and reachable from the public internet.
// It MUST stay minimal — no fields that leak operational posture
// (which secrets are present, which provider is wired, model names).
// Detailed LLM-routing diagnostics live behind `audit:read` at
// `/v1/diagnostics/llm` so probing requires a real API key.

const HealthResponse = z
  .object({
    status: z.literal("ok"),
    version: z.string(),
    db_connected: z.boolean(),
    uptime_seconds: z.number(),
    update_available: z.boolean().optional(),
    latest_version: z.string().optional(),
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
    const updateState = getUpdateState();
    return c.json(
      {
        status: "ok" as const,
        version: OPENAPI_INFO.version,
        db_connected,
        uptime_seconds: Math.floor((Date.now() - BOOT_AT) / 1000),
        ...(updateState
          ? {
              update_available: updateState.update_available,
              latest_version: updateState.latest_version,
            }
          : {}),
      },
      200,
    );
  });
}
