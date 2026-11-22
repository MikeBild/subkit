import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import composeYaml from "../../../../../docker-compose.yml" with { type: "text" };
import type { AppEnv } from "../openapi.ts";

export const COMPOSE_YAML = composeYaml;

const RESPONSE_HEADERS = {
  "content-type": "text/yaml; charset=utf-8",
  "cache-control": "public, max-age=3600",
  "content-disposition": 'inline; filename="docker-compose.yml"',
} as const;

const route = createRoute({
  method: "get",
  path: "/docker-compose.yml",
  tags: ["install"],
  summary: "Compose file that runs this engine's release",
  description:
    "The Docker Compose topology for a self-hosted subkit: this engine's pinned image, PostgreSQL, a private S3-compatible object store, and a one-shot bucket initializer. Served verbatim from the running binary, so the image tag matches the engine you fetched it from. `MASTER_KEY` is the only value you must supply.",
  responses: {
    200: {
      description: "Compose file (text/yaml)",
      content: { "text/yaml": { schema: z.string() } },
    },
  },
});

export function registerComposeRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, (c) => c.text(COMPOSE_YAML, 200, RESPONSE_HEADERS));
}
