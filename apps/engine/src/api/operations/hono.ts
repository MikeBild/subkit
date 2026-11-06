import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAuth } from "../../http/middleware/auth.ts";
import {
  requireAnyPermission,
  requirePermission,
} from "../../http/middleware/require-permission.ts";
import type { AppEnv } from "../../http/openapi.ts";
import { ErrorSchema } from "../common-schemas.ts";
import { isRejection, type Operation, type OperationScope } from "./index.ts";

interface OperationContext {
  get(key: "db"): Db;
  get(key: "principal"): ResolvedPrincipal | undefined;
  req: { valid(target: "param" | "query" | "json"): unknown };
  json(body: unknown, status: number): Response;
  body(data: null, status: 204): Response;
}

function honoPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function permissionGate<I, R>(op: Operation<I, R>): MiddlewareHandler<AppEnv> {
  const resource = op.resource;
  const resourceFrom = resource
    ? (c: { req: { param(name: string): string | undefined } }) => ({
        type: resource.type,
        id: c.req.param(resource.param) ?? "",
      })
    : undefined;
  if (op.alternatePermissions)
    return requireAnyPermission([op.permission, ...op.alternatePermissions], resourceFrom);
  return requirePermission(op.permission, resourceFrom);
}

export function toHonoRoute<I, R>(app: OpenAPIHono<AppEnv>, op: Operation<I, R>): void {
  const http = op.http;
  if (!http) throw new Error(`operation ${op.id} has no http binding`);
  const method = http.method.toUpperCase();
  const gatedMethods = method === "GET" ? ["GET", "HEAD"] : [method];
  const success = http.success ?? { status: 200, description: "OK" };
  const gate = permissionGate(op);
  app.use(honoPath(http.path), async (c, next) => {
    if (gatedMethods.includes(c.req.method)) return gate(c, next);
    return next();
  });
  const route = createRoute({
    method: http.method,
    path: http.path,
    tags: [...http.tags],
    ...(op.summary ? { summary: op.summary } : {}),
    ...(http.description ? { description: http.description } : {}),
    security: [{ bearerAuth: [] }],
    request: {
      ...(http.params ? { params: http.params } : {}),
      ...(http.query ? { query: http.query } : {}),
      ...(http.body ? { body: { content: { "application/json": { schema: http.body } } } } : {}),
    },
    responses: {
      [success.status]:
        success.status === 204
          ? { description: success.description }
          : {
              description: success.description,
              content: { "application/json": { schema: http.response } },
            },
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
      if (outcome.plain)
        return c.json(
          { code: outcome.code, message: outcome.message, ...outcome.extra },
          outcome.status,
        );
      throw new HttpError(
        outcome.status,
        outcome.code,
        outcome.message,
        outcome.details ? { details: outcome.details } : {},
      );
    }
    if (success.status === 204) return c.body(null, 204);
    return c.json(await http.toBody(outcome, scope), success.status);
  };
  app.openapi(route, handler as never);
}
