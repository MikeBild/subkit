// POST /v1/identity/cli-session — one-time OAuth-to-personal-key exchange for
// the `sk` CLI. The credential is authenticated by its dedicated OAuth
// audience and scope, not by the normal API RBAC middleware.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { readRequestSource } from "../../../audit/index.ts";
import { consumeCliLoginToken } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { ForbiddenError, UnauthorizedError } from "../../errors.ts";
import type { AppEnv } from "../../openapi.ts";

const CliSessionResponse = z
  .object({
    api_key: z.string().min(1),
    principal_id: z.string().uuid(),
    context_id: z.string().uuid(),
    email: z.string().email(),
  })
  .strict()
  .openapi("CliSessionResponse");

const route = createRoute({
  method: "post",
  path: "/v1/identity/cli-session",
  tags: ["MCP authentication"],
  summary: "Exchange a one-time CLI OAuth token for a personal API key",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Personal CLI session credential",
      content: { "application/json": { schema: CliSessionResponse } },
    },
    401: {
      description: "Invalid or expired token",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Token lacks the CLI login scope",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function bearerToken(header: string | undefined): string | null {
  if (!header || header.length <= 7 || header.slice(0, 7).toLowerCase() !== "bearer ") return null;
  return header.slice(7).trim() || null;
}

export function registerCliSessionRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    c.header("Cache-Control", "no-store");
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      throw new UnauthorizedError("missing_or_invalid_cli_oauth_token", 'Bearer realm="sk-cli"');
    }
    const result = await consumeCliLoginToken({
      db: c.get("db"),
      token,
      publicBaseUrl: getConfig().server.public_base_url,
      requestSource: readRequestSource(c) ?? "cli",
      userAgent: c.req.header("user-agent"),
    });
    if (!result.ok) {
      if (result.error === "insufficient_scope") {
        throw new ForbiddenError("cli OAuth token lacks sk:login scope");
      }
      throw new UnauthorizedError("invalid_or_expired_cli_oauth_token", 'Bearer realm="sk-cli"');
    }
    return c.json(
      {
        api_key: result.api_key,
        principal_id: result.principal_id,
        context_id: result.context_id,
        email: result.email,
      },
      200,
    );
  });
}
