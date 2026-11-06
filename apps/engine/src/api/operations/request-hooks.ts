import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { lintHookSource } from "../../auth/hooks.ts";
import {
  createRequestHook,
  deleteRequestHook,
  findRequestHook,
  listRequestHooks,
  type RequestHookRow,
  updateRequestHook,
} from "../../auth/hooks-admin.ts";
import { policy } from "../../auth/policy.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getContext } from "../../logging/context.ts";
import { IdParam, paginatedResponse } from "../common-schemas.ts";
import { defineOperation, isRejection, type Rejection, reject } from "./index.ts";

const HookSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    role: z.string(),
    source: z.string(),
    description: z.string().nullable(),
    version: z.number().int(),
    enabled: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("RequestHook");

const ListResponse = paginatedResponse(HookSchema, "RequestHookListResponse");

const CreateBody = z
  .object({
    role: z.string().min(1),
    code: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("CreateRequestHookBody");

const UpdateBody = z
  .object({
    code: z.string().min(1).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("UpdateRequestHookBody");

type CreateInput = z.infer<typeof CreateBody>;
type UpdateFields = z.infer<typeof UpdateBody>;

interface IdInput {
  readonly id: string;
}

interface UpdateInput extends IdInput {
  readonly body: UpdateFields;
}

function serialize(row: RequestHookRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    role: row.role,
    source: row.source,
    description: row.description ?? null,
    version: row.version,
    enabled: row.enabled,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

function adminPrincipal(principal: ResolvedPrincipal | null): ResolvedPrincipal | Rejection {
  if (!principal) return reject.unauthorized();
  const decision = policy.adminOnly(principal);
  if (!decision.allowed) return reject.forbidden(decision.reason ?? "admin_required");
  return principal;
}

function hookActor(principal: ResolvedPrincipal) {
  return { principal, trace_id: getContext().trace_id ?? "" };
}

async function lintRejection(code: string): Promise<Rejection | null> {
  const lint = await lintHookSource(code);
  return lint.ok ? null : reject.badRequest("invalid hook source", { reason: lint.error });
}

export const listRequestHooksOperation = defineOperation<Record<string, never>, RequestHookRow[]>({
  id: "request_hook.list",
  summary: "List request hooks",
  permission: "rbac:read",
  effect: "read",
  async handler(scope) {
    const principal = adminPrincipal(scope.principal);
    if (isRejection(principal)) return principal;
    return await listRequestHooks(scope.db, scope.tenant_id);
  },
  http: {
    method: "get",
    path: "/v1/auth/request-hooks",
    tags: ["auth"],
    response: ListResponse,
    errors: { 403: "Forbidden" },
    toInput: () => ({}),
    toBody: (rows) => ({ items: rows.map(serialize) }),
  },
});

export const createRequestHookOperation = defineOperation<CreateInput, RequestHookRow>({
  id: "request_hook.create",
  summary: "Create a request hook",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.BEFORE_REQUEST_HOOK_CHANGED,
  async handler(scope, body) {
    const principal = adminPrincipal(scope.principal);
    if (isRejection(principal)) return principal;
    const invalid = await lintRejection(body.code);
    if (invalid) return invalid;
    return await createRequestHook(scope.db, hookActor(principal), body);
  },
  http: {
    method: "post",
    path: "/v1/auth/request-hooks",
    tags: ["auth"],
    body: CreateBody,
    response: HookSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Invalid", 403: "Forbidden" },
    toInput: ({ json }) => json as CreateInput,
    toBody: serialize,
  },
});

export const updateRequestHookOperation = defineOperation<UpdateInput, RequestHookRow>({
  id: "request_hook.update",
  summary: "Update a request hook",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.BEFORE_REQUEST_HOOK_CHANGED,
  async handler(scope, { id, body }) {
    const principal = adminPrincipal(scope.principal);
    if (isRejection(principal)) return principal;
    const cur = await findRequestHook(scope.db, scope.tenant_id, id);
    if (!cur) return reject.notFound("request_hook");
    if (body.code !== undefined) {
      const invalid = await lintRejection(body.code);
      if (invalid) return invalid;
    }
    const row = await updateRequestHook(scope.db, hookActor(principal), cur, body);
    return row ?? reject.notFound("request_hook");
  },
  http: {
    method: "patch",
    path: "/v1/auth/request-hooks/{id}",
    tags: ["auth"],
    params: IdParam,
    body: UpdateBody,
    response: HookSchema,
    errors: { 404: "Not found", 403: "Forbidden" },
    toInput: ({ param, json }) => ({ ...idFrom(param), body: json as UpdateFields }),
    toBody: serialize,
  },
});

export const deleteRequestHookOperation = defineOperation<IdInput, { deleted: true }>({
  id: "request_hook.delete",
  summary: "Delete a request hook",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.BEFORE_REQUEST_HOOK_CHANGED,
  async handler(scope, { id }) {
    const principal = adminPrincipal(scope.principal);
    if (isRejection(principal)) return principal;
    const row = await deleteRequestHook(scope.db, hookActor(principal), id);
    return row ? { deleted: true } : reject.notFound("request_hook");
  },
  http: {
    method: "delete",
    path: "/v1/auth/request-hooks/{id}",
    tags: ["auth"],
    params: IdParam,
    response: z.object({ deleted: z.boolean() }),
    errors: { 404: "Not found", 403: "Forbidden" },
    toInput: ({ param }) => idFrom(param),
    toBody: (result) => result,
  },
});
