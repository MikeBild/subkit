// GET /v1/health — public, returns engine status + db connectivity.
// GET /v1/readyz — public readiness probe.
// GET /health, GET /ready — the same two handlers under the unversioned
// names an infrastructure probe reaches for by default.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { getHealthState } from "../health-state.ts";
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

interface HealthSnapshot {
  status: "ok";
  version: string;
  db_connected: boolean;
  uptime_seconds: number;
}

interface ReadySnapshot {
  status: "ready" | "unavailable";
  db_connected: boolean;
}

async function livenessSnapshot(db: Db): Promise<HealthSnapshot> {
  return {
    status: "ok" as const,
    version: OPENAPI_INFO.version,
    db_connected: await pingDb(db),
    uptime_seconds: Math.floor((Date.now() - BOOT_AT) / 1000),
  };
}

async function readinessSnapshot(db: Db): Promise<{ body: ReadySnapshot; status: 200 | 503 }> {
  const db_connected = await pingDb(db);
  // Draining (graceful shutdown in progress) is also "not ready": we want
  // the load balancer / systemd gate to stop routing new traffic here while
  // in-flight conversation turns finish, without leaking that posture on the
  // public /v1/health route.
  const ready = db_connected && !getHealthState().draining;
  return {
    body: { status: ready ? ("ready" as const) : ("unavailable" as const), db_connected },
    status: ready ? 200 : 503,
  };
}

export function registerHealthRoute(app: OpenAPIHono<AppEnv>, deps: HealthDeps = {}): void {
  const resolveDb = (c: { get: (k: "db") => Db | undefined }): Db =>
    deps.db ?? c.get("db") ?? getDb();

  app.openapi(route, async (c) => c.json(await livenessSnapshot(resolveDb(c)), 200));

  app.openapi(readyRoute, async (c) => {
    const { body, status } = await readinessSnapshot(resolveDb(c));
    return c.json(body, status);
  });

  // UNVERSIONED ALIASES.
  //
  // The versioned pair above is the documented contract and stays the only
  // probe in the OpenAPI document. These two add no behaviour of their own:
  // same handlers, same bodies, same status codes, pinned by
  // `apps/engine/src/http/tests/health.test.ts`. They exist because a probe
  // pointed at this process without knowledge of subkit's versioned paths
  // reads the 404 as "the service is down", which sends the reader to the
  // wrong service. Registered as plain routes rather than `app.openapi` for
  // the same reason /metrics is: an operational endpoint is not a second name
  // in the published API.
  app.get("/health", async (c) => c.json(await livenessSnapshot(resolveDb(c))));

  app.get("/ready", async (c) => {
    const { body, status } = await readinessSnapshot(resolveDb(c));
    return c.json(body, status);
  });
}
