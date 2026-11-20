import type { z } from "@hono/zod-openapi";
import type { PgBoss } from "pg-boss";
import type { AuditActionValue } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ConversationTool, ToolContext, ToolResult } from "../../conversations/tools/index.ts";
import type { Db } from "../../db/client.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";

export interface OperationActor {
  readonly id: string | null;
  readonly type: "user" | "system_account" | "system" | "unknown";
}

export function actorOfPrincipal(principal: ResolvedPrincipal): OperationActor {
  return { id: principal.id, type: principal.kind };
}

export interface OperationScope {
  readonly db: Db;
  readonly tenant_id: string;
  readonly principal: ResolvedPrincipal | null;
  readonly actor: OperationActor;
  readonly request_source?: RequestSource;
  readonly boss?: PgBoss;
  readonly request?: Request;
  readonly locale?: "de" | "en";
  readonly trace_id?: string;
  ensurePermission?(permission: string, resource?: { type: string; id: string }): Promise<void>;
}

export type RejectionStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 502;

const REJECTION: unique symbol = Symbol("operation.rejection");

export interface Rejection {
  readonly [REJECTION]: true;
  readonly rejected: true;
  readonly status: RejectionStatus;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly hint?: string;
  readonly plain?: true;
  readonly bare?: true;
  readonly extra?: Record<string, unknown>;
}

function rejection(
  status: RejectionStatus,
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
  hint?: string,
): Rejection {
  return {
    [REJECTION]: true,
    rejected: true,
    status,
    code,
    message,
    ...(details ? { details } : {}),
    ...(hint ? { hint } : {}),
  };
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
  forbidden: (message: string, details?: Record<string, unknown>): Rejection =>
    rejection(403, "forbidden", message, details),
  payloadTooLarge: (message: string, details?: Record<string, unknown>): Rejection =>
    rejection(413, "payload_too_large", message, details),
  unprocessable: (
    message: string,
    details?: Record<string, unknown>,
    code = "unprocessable",
  ): Rejection => rejection(422, code, message, details),
  status: (
    status: RejectionStatus,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    hint?: string,
  ): Rejection => rejection(status, code, message, details, hint),
};

export function plainRejection(
  status: RejectionStatus,
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
): Rejection {
  return {
    [REJECTION]: true,
    rejected: true,
    status,
    code,
    message: message ?? "",
    plain: true,
    ...(message === undefined ? { bare: true } : {}),
    ...(extra ? { extra } : {}),
  };
}

export function isRejection(value: unknown): value is Rejection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [REJECTION]?: unknown })[REJECTION] === true
  );
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 502;

export interface HttpRequestParts {
  readonly param: unknown;
  readonly query: unknown;
  readonly json: unknown;
  readonly header: unknown;
}

export type SuccessStatus = 200 | 201 | 202 | 204;

export interface SuccessResponse {
  readonly status: SuccessStatus;
  readonly description: string;
  readonly empty?: true;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface HttpBinding<I, R> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tags: readonly string[];
  readonly description?: string;
  readonly params?: z.ZodTypeAny;
  readonly query?: z.ZodTypeAny;
  readonly body?: z.ZodTypeAny;
  readonly bodyRequired?: boolean;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[] | null;
  readonly targetTenant?: "body";
  readonly headers?: z.ZodTypeAny;
  readonly response: z.ZodTypeAny;
  readonly errors?: Partial<
    Record<ErrorStatus, string | { readonly description: string; readonly schema: z.ZodTypeAny }>
  >;
  readonly success?: SuccessResponse | readonly SuccessResponse[];
  statusFor?(result: R): SuccessStatus;
  invalid?(
    issues: readonly ValidationIssue[],
  ): Rejection | { readonly status: SuccessStatus; readonly body: unknown };
  responseHeaders?(result: R, scope: OperationScope): Readonly<Record<string, string>>;
  toInput(request: HttpRequestParts): I;
  toBody(result: R, scope: OperationScope): unknown;
}

export interface ToolBinding<I, R> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodTypeAny;
  readonly gate: "enforced" | "deferred";
  readonly strict?: boolean;
  readonly permission?: { readonly resourceType: string; readonly resourceIdArg?: string };
  readonly resourceType?: string;
  readonly resolveResourceId?: (
    ctx: ToolContext,
    args: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly use_case?: string;
  readonly important_notes?: readonly string[];
  readonly requires_draft?: boolean;
  precheck?: ConversationTool["precheck"];
  toInput(args: unknown, ctx: ToolContext): I | Promise<I>;
  guard?(input: I, ctx: ToolContext): Promise<ToolResult | null>;
  prepare?(input: I, ctx: ToolContext): Promise<unknown>;
  toResult(
    outcome: R | Rejection,
    input: I,
    ctx: ToolContext,
    prepared: unknown,
  ): ToolResult | Promise<ToolResult>;
  onError?(error: unknown, input: I, ctx: ToolContext, prepared: unknown): ToolResult;
}

interface OperationCore<I, R> {
  readonly id: string;
  readonly summary?: string;
  readonly permission: string | null;
  readonly alternatePermissions?: readonly string[];
  readonly requiredPermissions?: readonly {
    readonly permission: string;
    readonly resource?: { readonly type: string; readonly param: string };
  }[];
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
  const surfaces = [
    op.http?.params,
    op.http?.query,
    op.http?.targetTenant === "body" ? undefined : op.http?.body,
    op.tool?.input,
  ];
  if (surfaces.some((schema) => keysOf(schema).includes("tenant_id"))) {
    throw new Error(`operation ${op.id} takes tenant_id as input; the scope carries the tenant`);
  }
  const pathHas = (param: string) =>
    op.http !== undefined &&
    (op.http.path.includes(`{${param}}`) || op.http.path.includes(`:${param}`));
  const scoped = [op.resource, ...(op.requiredPermissions ?? []).map((extra) => extra.resource)];
  if (
    op.permission === null &&
    (op.alternatePermissions?.length || op.resource || op.tool?.gate === "enforced")
  ) {
    throw new Error(`operation ${op.id} has no permission but declares a permission scope`);
  }
  for (const resource of scoped) {
    if (resource && op.http && !pathHas(resource.param)) {
      throw new Error(`operation ${op.id} names resource param ${resource.param} not in its path`);
    }
  }
  if (op.resource && op.http && !pathHas(op.resource.param)) {
    throw new Error(`operation ${op.id} names resource param ${op.resource.param} not in its path`);
  }
  return Object.freeze(op);
}
