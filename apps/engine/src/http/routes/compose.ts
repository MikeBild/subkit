// GET /docker-compose.yml — the engine hands out the Compose file that runs it.
//
// The self-host guide's first step is `docker compose up -d`, and until now the
// only way to obtain that file was a repository checkout. The repository is
// private, so for anyone outside it the first step was not merely inconvenient,
// it was impossible: a baseline run on 2026-09-02 probed
// `<engine>/docker-compose.yml`, the GitHub repo and raw.githubusercontent, got
// 404 from all three, and had to reconstruct the topology by hand from prose.
//
// So the engine publishes it, the same way it already publishes `/install`,
// `/openapi.json` and `/llms.txt`: embedded at build time, served verbatim, and
// pinned to this binary's own version because the file itself carries the image
// tag. What you fetch from a running engine starts that engine's release.
//
//   curl -O https://<engine-host>/docker-compose.yml
//   MASTER_KEY=$(openssl rand -hex 32) docker compose up -d
//
// Public and unauthenticated by design, like its siblings: the file contains no
// secrets, only local-only defaults and one value the operator must supply.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
// Embedded at build time so the compiled binary serves it without a filesystem
// dependency. A drift test asserts the served bytes equal the repository file.
import composeYaml from "../../../../../docker-compose.yml" with { type: "text" };
import type { AppEnv } from "../openapi.ts";

/** The exact bytes served, exported so the drift test can compare them. */
export const COMPOSE_YAML = composeYaml;

const RESPONSE_HEADERS = {
  "content-type": "text/yaml; charset=utf-8",
  "cache-control": "public, max-age=3600",
  // Names the file when fetched with `curl -O` or a browser, so it lands as
  // docker-compose.yml rather than as the request path's last segment.
  "content-disposition": 'inline; filename="docker-compose.yml"',
} as const;

const route = createRoute({
  method: "get",
  path: "/docker-compose.yml",
  tags: ["install"],
  summary: "Compose file that runs this engine's release",
  description:
    "The Docker Compose topology for a self-hosted sk: this engine's pinned image, PostgreSQL, a private S3-compatible object store, and a one-shot bucket initializer. Served verbatim from the running binary, so the image tag matches the engine you fetched it from. `MASTER_KEY` is the only value you must supply.",
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
