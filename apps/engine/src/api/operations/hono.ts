import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { PgBoss } from "pg-boss";
import { readRequestSource } from "../../audit/request-source.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAuth } from "../../http/middleware/auth.ts";
import {
  ensurePermission,
  requireAnyPermission,
  requirePermission,
} from "../../http/middleware/require-permission.ts";
import type { AppEnv } from "../../http/openapi.ts";
import { ErrorSchema } from "../common-schemas.ts";
import {
  actorOfPrincipal,
  isRejection,
  type Operation,
  type OperationScope,
  type Rejection,
  type SuccessResponse,
  type ValidationIssue,
} from "./index.ts";

interface OperationContext {
  get(key: "db"): Db;
  get(key: "principal"): ResolvedPrincipal | undefined;
  get(key: "boss"): PgBoss | undefined;
  get(key: "trace_id"): string | undefined;
  req: { valid(target: "param" | "query" | "json" | "header"): unknown; raw: Request };
  json(body: unknown, status: number): Response;
  header(name: string, value: string): void;
  body(data: null, status: number): Response;
}

interface ValidationResult {
  success: boolean;
  error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
}

function successResponses(success: SuccessResponse | readonly SuccessResponse[] | undefined) {
  const list: readonly SuccessResponse[] =
    success === undefined
      ? [{ status: 200, description: "OK" }]
      : "status" in success
        ? [success]
        : success;
  if (list.length === 0) throw new Error("an http binding needs at least one success response");
  return list;
}

function isEmpty(response: SuccessResponse): boolean {
  return response.status === 204 || response.empty === true;
}

function rejectionResponse(c: OperationContext, outcome: Rejection): Response {
  if (outcome.plain)
    return c.json(
      outcome.bare
        ? { code: outcome.code, ...outcome.extra }
        : { code: outcome.code, message: outcome.message, ...outcome.extra },
      outcome.status,
    );
  throw new HttpError(outcome.status, outcome.code, outcome.message, {
    ...(outcome.details ? { details: outcome.details } : {}),
    ...(outcome.hint ? { hint: outcome.hint } : {}),
  });
}

function honoPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

type ResourceParam = { readonly type: string; readonly param: string } | undefined;

function resourceReader(resource: ResourceParam) {
  return resource
    ? (c: { req: { param(name: string): string | undefined } }) => ({
        type: resource.type,
        id: c.req.param(resource.param) ?? "",
      })
    : undefined;
}

function permissionGates<I, R>(op: Operation<I, R>): MiddlewareHandler<AppEnv>[] {
  const gates: MiddlewareHandler<AppEnv>[] = [];
  if (op.permission !== null) {
    const resourceFrom = resourceReader(op.resource);
    gates.push(
      op.alternatePermissions
        ? requireAnyPermission([op.permission, ...op.alternatePermissions], resourceFrom)
        : requirePermission(op.permission, resourceFrom),
    );
  }
  for (const extra of op.requiredPermissions ?? [])
    gates.push(requirePermission(extra.permission, resourceReader(extra.resource)));
  return gates;
}

function chain(gates: readonly MiddlewareHandler<AppEnv>[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let index = 0;
    const step = async (): Promise<void> => {
      const gate = gates[index];
      index += 1;
      if (!gate) return next();
      await gate(c, step);
    };
    await step();
  };
}

export function toHonoRoute<I, R>(app: OpenAPIHono<AppEnv>, op: Operation<I, R>): void {
  const http = op.http;
  if (!http) throw new Error(`operation ${op.id} has no http binding`);
  const method = http.method.toUpperCase();
  const gatedMethods = method === "GET" ? ["GET", "HEAD"] : [method];
  const successes = successResponses(http.success);
  const primary = successes[0] as SuccessResponse;
  const gates = permissionGates(op);
  const gate = chain(gates);
  if (gates.length > 0)
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
    ...(http.security === null ? {} : { security: http.security ?? [{ bearerAuth: [] }] }),
    request: {
      ...(http.params ? { params: http.params } : {}),
      ...(http.query ? { query: http.query } : {}),
      ...(http.headers ? { headers: http.headers } : {}),
      ...(http.body
        ? {
            body: {
              content: { "application/json": { schema: http.body } },
              ...(http.bodyRequired === undefined ? {} : { required: http.bodyRequired }),
            },
          }
        : {}),
    },
    responses: {
      ...Object.fromEntries(
        successes.map((response) => [
          response.status,
          isEmpty(response)
            ? { description: response.description }
            : {
                description: response.description,
                content: { "application/json": { schema: http.response } },
              },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(http.errors ?? {}).map(([status, entry]) => [
          status,
          typeof entry === "string"
            ? { description: entry, content: { "application/json": { schema: ErrorSchema } } }
            : {
                description: entry.description,
                content: { "application/json": { schema: entry.schema } },
              },
        ]),
      ),
    },
  } as unknown as Parameters<typeof createRoute>[0]);
  const handler = async (c: OperationContext) => {
    const principal = requireAuth(c);
    const boss = c.get("boss");
    const traceId = c.get("trace_id");
    const scope: OperationScope = {
      db: c.get("db"),
      tenant_id: principal.tenant_id,
      principal,
      actor: actorOfPrincipal(principal),
      request_source: readRequestSource(c as never) ?? "api",
      ...(boss ? { boss } : {}),
      request: c.req.raw,
      ...(traceId ? { trace_id: traceId } : {}),
      ensurePermission: (permission, resource) =>
        ensurePermission(c as never, permission, resource),
    };
    const input = http.toInput({
      param: http.params ? c.req.valid("param") : undefined,
      query: http.query ? c.req.valid("query") : undefined,
      json: http.body ? c.req.valid("json") : undefined,
      header: http.headers ? c.req.valid("header") : undefined,
    });
    const outcome = await op.handler(scope, input);
    if (isRejection(outcome)) return rejectionResponse(c, outcome);
    const status = http.statusFor ? http.statusFor(outcome) : primary.status;
    const response = successes.find((candidate) => candidate.status === status);
    if (!response) throw new Error(`operation ${op.id} answered undeclared status ${status}`);
    const headers = http.responseHeaders ? http.responseHeaders(outcome, scope) : undefined;
    if (headers) for (const [name, value] of Object.entries(headers)) c.header(name, value);
    if (isEmpty(response)) return c.body(null, status);
    return c.json(await http.toBody(outcome, scope), status);
  };
  const invalid = http.invalid;
  const hook = invalid
    ? (result: ValidationResult, c: OperationContext) => {
        if (result.success) return undefined;
        const issues: ValidationIssue[] = (result.error?.issues ?? []).map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        }));
        const answer = invalid(issues);
        if (isRejection(answer)) return rejectionResponse(c, answer);
        return c.json(answer.body, answer.status);
      }
    : undefined;
  if (hook) app.openapi(route, handler as never, hook as never);
  else app.openapi(route, handler as never);
}
