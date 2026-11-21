import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  grantTaskAuthority,
  listTaskGrants,
  previewTaskGrant,
  revokeTaskAuthority,
  type TaskAuthorityGrantInput,
  TaskAuthorityGrantInputSchema,
  type TaskAuthorityGrantResult,
  TaskAuthorityGrantResultSchema,
  type TaskAuthorityPreview,
  TaskAuthorityPreviewSchema,
  type TaskAuthorityRevokeResult,
  TaskAuthorityRevokeResultSchema,
  type TaskGrant,
  TaskGrantSchema,
} from "../../tasks/index.ts";
import { requireHumanBrowser } from "../../workflows/execution-authorities.ts";
import { IdParam } from "../common-schemas.ts";
import {
  defineOperation,
  isRejection,
  type OperationScope,
  type Rejection,
  type RejectionStatus,
  reject,
} from "./index.ts";

const GrantParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: "id", in: "path" } }),
  grant_id: z
    .string()
    .uuid()
    .openapi({ param: { name: "grant_id", in: "path" } }),
});

const TaskGrantListResponse = z
  .object({ items: z.array(TaskGrantSchema) })
  .openapi("TaskGrantListResponse");

const GRANT_ERRORS: Readonly<Record<string, { status: RejectionStatus; code?: string }>> = {
  task_not_found: { status: 404 },
  task_grant_not_found: { status: 404 },
  workflow_version_unavailable: { status: 404 },
  authority_not_found: { status: 404 },
  human_session_required: { status: 403 },
  human_session_expired: { status: 403 },
  csrf_rejected: { status: 403 },
  task_grant_permission_denied: { status: 403 },
  authority_permission_denied: { status: 403 },
  authority_window_invalid: { status: 400 },
  task_not_grantable: { status: 409 },
  task_fingerprint_changed: { status: 409, code: "task_grant_fingerprint_changed" },
  task_grant_preview_changed: { status: 409 },
  authority_manifest_changed: { status: 409 },
  authority_revoked: { status: 409 },
  pair_approval_required: { status: 409 },
};

const GrantFailures = {
  400: "The validity window is not allowed",
  403: "A signed human browser session with CSRF proof and task:grant is required",
  404: "Task or standing permission not found or not visible to the caller",
  409: "The task or a bound workflow changed since the preview",
} as const;

const PREVIEW_FORBIDDEN = "A signed human browser session on the same site is required";

function grantRejection(error: unknown): Rejection {
  const code = (error as { code?: unknown } | null)?.code;
  const known = typeof code === "string" ? GRANT_ERRORS[code] : undefined;
  if (typeof code !== "string" || !known) throw error;
  return reject.status(known.status, known.code ?? code, (error as Error).message);
}

interface HumanScope {
  readonly principal: ResolvedPrincipal;
  readonly request: Request;
  readonly db: OperationScope["db"];
}

function humanScope(scope: OperationScope): HumanScope | Rejection {
  if (!scope.principal) return reject.unauthorized();
  if (!scope.request)
    return reject.status(
      403,
      "human_session_required",
      "a signed human browser session is required",
    );
  return { principal: scope.principal, request: scope.request, db: scope.db };
}

interface TaskIdInput {
  readonly id: string;
}

function idFrom(param: unknown): TaskIdInput {
  return { id: (param as TaskIdInput).id };
}

export const previewTaskGrantOperation = defineOperation<TaskIdInput, TaskAuthorityPreview>({
  id: "task.grants.preview",
  summary:
    "Review from a human browser what a standing permission would allow: every bound workflow with its effects, the connectors and the schedule",
  permission: "task:read",
  resource: { type: "task", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    const human = humanScope(scope);
    if (isRejection(human)) return human;
    try {
      await requireHumanBrowser(human);
      return await previewTaskGrant(id, human);
    } catch (error) {
      return grantRejection(error);
    }
  },
  http: {
    method: "get",
    path: "/v1/tasks/{id}/grant-preview",
    tags: ["tasks"],
    params: IdParam,
    response: TaskAuthorityPreviewSchema,
    errors: { 403: PREVIEW_FORBIDDEN, 404: GrantFailures[404] },
    toInput: ({ param }) => idFrom(param),
    toBody: (preview) => preview,
  },
});

export const listTaskGrantsOperation = defineOperation<TaskIdInput, TaskGrant[]>({
  id: "task.grants.list",
  summary: "List the standing permissions of a task, newest first, revoked ones included",
  permission: "task:read",
  resource: { type: "task", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    if (!scope.principal) return reject.unauthorized();
    try {
      return await listTaskGrants(id, { principal: scope.principal, db: scope.db });
    } catch (error) {
      return grantRejection(error);
    }
  },
  http: {
    method: "get",
    path: "/v1/tasks/{id}/grants",
    tags: ["tasks"],
    params: IdParam,
    response: TaskGrantListResponse,
    errors: { 404: GrantFailures[404] },
    toInput: ({ param }) => idFrom(param),
    toBody: (items) => ({ items }),
  },
});

interface GrantInput extends TaskIdInput {
  readonly body: TaskAuthorityGrantInput;
}

export const grantTaskAuthorityOperation = defineOperation<GrantInput, TaskAuthorityGrantResult>({
  id: "task.grants.grant",
  summary:
    "Give a task its standing permission from an authenticated human browser; bound workflows receive matching execution authorities",
  permission: "task:grant",
  resource: { type: "task", param: "id" },
  effect: "write",
  audit: AuditAction.TASK_AUTHORITY_GRANTED,
  async handler(scope, { id, body }) {
    const human = humanScope(scope);
    if (isRejection(human)) return human;
    try {
      return await grantTaskAuthority(id, body, human);
    } catch (error) {
      return grantRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/tasks/{id}/grants",
    tags: ["tasks"],
    params: IdParam,
    body: TaskAuthorityGrantInputSchema,
    response: TaskAuthorityGrantResultSchema,
    success: [
      { status: 201, description: "Standing permission given" },
      { status: 200, description: "An identical standing permission already applies" },
    ],
    statusFor: (result) => (result.changed ? 201 : 200),
    errors: GrantFailures,
    toInput: ({ param, json }) => ({ ...idFrom(param), body: json as TaskAuthorityGrantInput }),
    toBody: (result) => result,
  },
});

interface RevokeInput extends TaskIdInput {
  readonly grant_id: string;
}

export const revokeTaskAuthorityOperation = defineOperation<RevokeInput, TaskAuthorityRevokeResult>(
  {
    id: "task.grants.revoke",
    summary:
      "Revoke a standing permission from an authenticated human browser, together with the workflow authorities it created",
    permission: "task:grant",
    resource: { type: "task", param: "id" },
    effect: "write",
    audit: AuditAction.TASK_AUTHORITY_REVOKED,
    async handler(scope, { id, grant_id }) {
      const human = humanScope(scope);
      if (isRejection(human)) return human;
      try {
        return await revokeTaskAuthority(id, grant_id, human);
      } catch (error) {
        return grantRejection(error);
      }
    },
    http: {
      method: "post",
      path: "/v1/tasks/{id}/grants/{grant_id}/revoke",
      tags: ["tasks"],
      params: GrantParam,
      response: TaskAuthorityRevokeResultSchema,
      errors: { 403: GrantFailures[403], 404: GrantFailures[404] },
      toInput: ({ param }) => param as RevokeInput,
      toBody: (result) => result,
    },
  },
);
