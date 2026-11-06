import type { z } from "@hono/zod-openapi";
import type { AuditActionValue } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ToolResult } from "../../conversations/tools/index.ts";
import type { Executor } from "../../db/client.ts";

export interface OperationScope {
  readonly db: Executor;
  readonly tenant_id: string;
  readonly principal: ResolvedPrincipal | null;
}

export type RejectionStatus = 400 | 401 | 404 | 409;

export interface Rejection {
  readonly rejected: true;
  readonly status: RejectionStatus;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

function rejection(
  status: RejectionStatus,
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
): Rejection {
  return { rejected: true, status, code, message, ...(details ? { details } : {}) };
}

export const reject = {
  unauthorized: (): Rejection =>
    rejection(401, "unauthorized", "missing_or_invalid_credentials", undefined),
  notFound: (resource: string): Rejection =>
    rejection(404, "not_found", `${resource} not found`, undefined),
  badRequest: (message: string, details?: Record<string, unknown>): Rejection =>
    rejection(400, "bad_request", message, details),
  conflict: (message: string, details?: Record<string, unknown>, code = "conflict"): Rejection =>
    rejection(409, code, message, details),
};

export function isRejection(value: unknown): value is Rejection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { rejected?: unknown }).rejected === true
  );
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type ErrorStatus = 400 | 404 | 409 | 422;

export interface HttpRequestParts {
  readonly param: unknown;
  readonly query: unknown;
  readonly json: unknown;
}

export interface HttpBinding<I, R> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tags: readonly string[];
  readonly description?: string;
  readonly params?: z.ZodTypeAny;
  readonly query?: z.ZodTypeAny;
  readonly body?: z.ZodTypeAny;
  readonly response: z.ZodTypeAny;
  readonly errors?: Partial<Record<ErrorStatus, string>>;
  toInput(request: HttpRequestParts): I;
  toBody(result: R, scope: OperationScope): unknown;
}

export interface ToolBinding<I, R> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodTypeAny;
  readonly gate: "enforced" | "deferred";
  readonly use_case?: string;
  readonly important_notes?: readonly string[];
  toInput(args: unknown): I;
  toResult(outcome: R | Rejection, input: I): ToolResult;
}

interface OperationCore<I, R> {
  readonly id: string;
  readonly summary: string;
  readonly permission: string;
  readonly resource?: { readonly type: string; readonly param: string };
  handler(scope: OperationScope, input: I): Promise<R | Rejection>;
  readonly http?: HttpBinding<I, R>;
  readonly tool?: ToolBinding<I, R>;
}

export type Operation<I, R> = OperationCore<I, R> &
  (
    | { readonly effect: "read"; readonly audit?: never }
    | { readonly effect: "write"; readonly audit: AuditActionValue }
  );

function keysOf(schema: z.ZodTypeAny | undefined): string[] {
  const shape = (schema as { shape?: unknown } | undefined)?.shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : [];
}

export function defineOperation<I, R>(op: Operation<I, R>): Operation<I, R> {
  const surfaces = [op.http?.params, op.http?.query, op.http?.body, op.tool?.input];
  if (surfaces.some((schema) => keysOf(schema).includes("tenant_id"))) {
    throw new Error(`operation ${op.id} takes tenant_id as input; the scope carries the tenant`);
  }
  if (op.resource && op.http && !op.http.path.includes(`{${op.resource.param}}`)) {
    throw new Error(`operation ${op.id} names resource param ${op.resource.param} not in its path`);
  }
  return Object.freeze(op);
}
