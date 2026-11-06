import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAuth } from "../../http/middleware/auth.ts";
import { requirePermission } from "../../http/middleware/require-permission.ts";
import type { AppEnv } from "../../http/openapi.ts";
import { ErrorSchema } from "../common-schemas.ts";
import { isRejection, type Operation, type OperationScope } from "./index.ts";

interface OperationContext {
  get(key: "db"): Db;
  get(key: "principal"): ResolvedPrincipal | undefined;
  req: { valid(target: "param" | "query" | "json"): unknown };
  json(body: unknown, status: 200): Response;
}

function honoPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function permissionGate<I, R>(op: Operation<I, R>): MiddlewareHandler<AppEnv> {
  const resource = op.resource;
  return resource
    ? requirePermission(op.permission, (c) => ({
        type: resource.type,
        id: c.req.param(resource.param) ?? "",
      }))
    : requirePermission(op.permission);
}

export function toHonoRoute<I, R>(app: OpenAPIHono<AppEnv>, op: Operation<I, R>): void {
  const http = op.http;
  if (!http) throw new Error(`operation ${op.id} has no http binding`);
  const method = http.method.toUpperCase();
  const gate = permissionGate(op);
  app.use(honoPath(http.path), async (c, next) => {
    if (c.req.method === method) return gate(c, next);
    return next();
  });
  const route = createRoute({
    method: http.method,
    path: http.path,
    tags: [...http.tags],
    summary: op.summary,
    ...(http.description ? { description: http.description } : {}),
    security: [{ bearerAuth: [] }],
    request: {
      ...(http.params ? { params: http.params } : {}),
      ...(http.query ? { query: http.query } : {}),
      ...(http.body ? { body: { content: { "application/json": { schema: http.body } } } } : {}),
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: http.response } } },
      ...Object.fromEntries(
        Object.entries(http.errors ?? {}).map(([status, description]) => [
          status,
          { description, content: { "application/json": { schema: ErrorSchema } } },
        ]),
      ),
    },
  } as unknown as Parameters<typeof createRoute>[0]);
  const handler = async (c: OperationContext) => {
    const principal = requireAuth(c);
    const scope: OperationScope = { db: c.get("db"), tenant_id: principal.tenant_id, principal };
    const input = http.toInput({
      param: http.params ? c.req.valid("param") : undefined,
      query: http.query ? c.req.valid("query") : undefined,
      json: http.body ? c.req.valid("json") : undefined,
    });
    const outcome = await op.handler(scope, input);
    if (isRejection(outcome)) {
      throw new HttpError(
        outcome.status,
        outcome.code,
        outcome.message,
        outcome.details ? { details: outcome.details } : {},
      );
    }
    return c.json(await http.toBody(outcome, scope), 200);
  };
  app.openapi(route, handler as never);
}
