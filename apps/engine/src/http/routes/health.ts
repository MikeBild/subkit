// GET /health — public liveness probe.
// GET /ready — public readiness probe.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { getHealthState } from "../health-state.ts";
import type { AppEnv } from "../openapi.ts";
import { OPENAPI_INFO } from "../openapi.ts";

// /health is unauthenticated and reachable from the public internet.
// It MUST stay minimal — no fields that leak operational posture
// (which secrets are present, which provider is wired, model names,
// schema-drift state, update availability). The operational fields
// (`db_schema_drift`, `update_available`, `latest_version`) live
// behind `audit:read` at `GET /v1/diagnostics/version`.

const HealthResponse = z
  .object({
    status: z.literal("ok"),
    service: z.literal("subkit"),
    version: z.string(),
  })
  .strict()
  .openapi("HealthResponse");

const NO_STORE_RESPONSE_HEADERS = {
  "Cache-Control": {
    description: "Availability responses are always evaluated live and must not be cached.",
    schema: { type: "string" as const, enum: ["no-store"] },
  },
};

const route = createRoute({
  method: "get",
  path: "/health",
  tags: ["health"],
  summary: "Engine liveness",
  responses: {
    200: {
      description: "Health snapshot",
      headers: NO_STORE_RESPONSE_HEADERS,
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

// Readiness is distinct from liveness: /health is a liveness probe (the
// process is up → 200), while /ready is a readiness probe that returns 503
// when the engine cannot serve real traffic because its database is
// unreachable. Load balancers / orchestrators should gate routing on /ready,
// not /health.
const ReadyResponse = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    service: z.literal("subkit"),
    version: z.string(),
    checks: z
      .object({
        lifecycle: z.enum(["pass", "fail"]),
        database: z.enum(["pass", "fail"]),
      })
      .strict(),
  })
  .strict()
  .openapi("ReadyResponse");

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  tags: ["health"],
  summary: "Engine readiness (503 when the database is unreachable)",
  responses: {
    200: {
      description: "Ready",
      headers: NO_STORE_RESPONSE_HEADERS,
      content: { "application/json": { schema: ReadyResponse } },
    },
    503: {
      description: "Not ready — database unreachable",
      headers: NO_STORE_RESPONSE_HEADERS,
      content: { "application/json": { schema: ReadyResponse } },
    },
  },
});

async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch (err) {
    logger.warn({
      module: "http",
      action: "health.db_ping_failed",
      msg: "db ping failed in /ready",
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
  service: "subkit";
  version: string;
}

interface ReadySnapshot {
  status: "ready" | "not_ready";
  service: "subkit";
  version: string;
  checks: {
    lifecycle: "pass" | "fail";
    database: "pass" | "fail";
  };
}

function livenessSnapshot(): HealthSnapshot {
  return {
    status: "ok" as const,
    service: "subkit" as const,
    version: OPENAPI_INFO.version,
  };
}

async function readinessSnapshot(db: Db): Promise<{ body: ReadySnapshot; status: 200 | 503 }> {
  const database = (await pingDb(db)) ? ("pass" as const) : ("fail" as const);
  // Draining (graceful shutdown in progress) is also "not ready": we want
  // the load balancer / systemd gate to stop routing new traffic here while
  // in-flight conversation turns finish, without leaking that posture on the
  // public /health route.
  const lifecycle = getHealthState().draining ? ("fail" as const) : ("pass" as const);
  const ready = database === "pass" && lifecycle === "pass";
  return {
    body: {
      status: ready ? ("ready" as const) : ("not_ready" as const),
      service: "subkit",
      version: OPENAPI_INFO.version,
      checks: { lifecycle, database },
    },
    status: ready ? 200 : 503,
  };
}

export function registerHealthRoute(app: OpenAPIHono<AppEnv>, deps: HealthDeps = {}): void {
  const resolveDb = (c: { get: (k: "db") => Db | undefined }): Db =>
    deps.db ?? c.get("db") ?? getDb();

  app.openapi(route, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(livenessSnapshot(), 200);
  });

  app.openapi(readyRoute, async (c) => {
    c.header("Cache-Control", "no-store");
    const { body, status } = await readinessSnapshot(resolveDb(c));
    return c.json(body, status);
  });
}
