// Shared OpenAPIHono instance and document metadata. Routes import this
// file to register themselves on a single document.

import { OpenAPIHono } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { VERSION } from "@cli-core/version.ts";

export type AppEnv = {
  Variables: {
    trace_id: string;
    request_source: "api" | "mcp" | "webhook" | "chat";
    request_started_at: number;
    db: Db;
    principal?: ResolvedPrincipal;
  };
};

export function createOpenApiApp(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            code: "bad_request",
            message: "request validation failed",
            details: result.error.flatten(),
          },
          400,
        );
      }
      return undefined;
    },
  });
}

export const OPENAPI_INFO = {
  title: "subkit engine",
  version: process.env.ENGINE_VERSION ?? VERSION ?? "0.0.0-dev",
  description:
    "Backend workflow engine. See /docs for the interactive reference and /openapi.json for the raw spec.",
} as const;

export const SECURITY_SCHEMES = {
  bearerAuth: {
    type: "http" as const,
    scheme: "bearer" as const,
    description: "API key issued via /v1/identity/api-keys",
  },
};
