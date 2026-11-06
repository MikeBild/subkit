import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { pingDatabase } from "../../operator/db-ping.ts";
import { getHealthState } from "../health-state.ts";
import type { AppEnv } from "../openapi.ts";
import { OPENAPI_INFO } from "../openapi.ts";

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

interface HealthDeps {
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
  const database = (await pingDatabase(db)) ? ("pass" as const) : ("fail" as const);
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
