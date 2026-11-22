import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import { pingDatabase } from "../../operator/db-ping.ts";
import { getHealthState } from "../health-state.ts";
import type { AppEnv } from "../openapi.ts";
import { OPENAPI_INFO } from "../openapi.ts";

export const HealthResponse = z
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

export const ReadyResponse = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    service: z.literal("subkit"),
    version: z.string(),
    checks: z
      .object({
        lifecycle: z.enum(["pass", "fail"]),
        database: z.enum(["pass", "fail"]),
        schema: z
          .enum(["pass", "drift"])
          .describe(
            "drift means the database schema differs from this engine; it does not block readiness",
          ),
      })
      .strict(),
    failing: z
      .array(z.enum(["lifecycle", "database"]))
      .describe("The checks that keep the engine from being ready; empty when ready"),
  })
  .strict()
  .openapi("ReadyResponse");

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  tags: ["health"],
  summary: "Engine readiness (503 names the failing checks)",
  responses: {
    200: {
      description: "Ready",
      headers: NO_STORE_RESPONSE_HEADERS,
      content: { "application/json": { schema: ReadyResponse } },
    },
    503: {
      description: "Not ready; failing lists the checks that failed",
      headers: NO_STORE_RESPONSE_HEADERS,
      content: { "application/json": { schema: ReadyResponse } },
    },
  },
});

interface HealthDeps {
  db: Db;
}

interface HealthSnapshot {
  status: "ok";
  service: "subkit";
  version: string;
}

type ReadySnapshot = z.infer<typeof ReadyResponse>;

export function readiness(input: {
  databaseUp: boolean;
  draining: boolean;
  schemaDrift: boolean;
  version: string;
}): { body: ReadySnapshot; status: 200 | 503 } {
  const checks = {
    lifecycle: input.draining ? ("fail" as const) : ("pass" as const),
    database: input.databaseUp ? ("pass" as const) : ("fail" as const),
    schema: input.schemaDrift ? ("drift" as const) : ("pass" as const),
  };
  const failing = (["lifecycle", "database"] as const).filter((name) => checks[name] === "fail");
  return {
    body: {
      status: failing.length === 0 ? "ready" : "not_ready",
      service: "subkit",
      version: input.version,
      checks,
      failing,
    },
    status: failing.length === 0 ? 200 : 503,
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
  const state = getHealthState();
  return readiness({
    databaseUp: await pingDatabase(db),
    draining: state.draining,
    schemaDrift: state.schema_drift,
    version: OPENAPI_INFO.version,
  });
}

export function registerHealthRoute(app: OpenAPIHono<AppEnv>, deps: HealthDeps): void {
  app.openapi(route, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(livenessSnapshot(), 200);
  });

  app.openapi(readyRoute, async (c) => {
    c.header("Cache-Control", "no-store");
    const { body, status } = await readinessSnapshot(deps.db);
    return c.json(body, status);
  });
}
