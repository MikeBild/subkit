import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  ActivateWorkflowDraftSchema,
  activateWorkflowDraft,
  GrantWorkflowAuthoritySchema,
  grantWorkflowAuthority,
  MakeWorkflowAuthorityUntilRevokedSchema,
  makeWorkflowAuthorityUntilRevoked,
  revokeWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import {
  defineOperation,
  isRejection,
  type OperationScope,
  type Rejection,
  reject,
} from "./index.ts";
import {
  AUTHORITY_DESCRIPTION,
  authorityFailures,
  authorityParam,
  authorityRejection,
  authoritySchema,
  observeAuthority,
  workflowParam,
} from "./workflow-authorities.ts";

const LiveTestSchema = z.object({
  state: z.enum(["not_requested", "blocked", "queued", "running", "succeeded", "failed"]),
  execution_id: z.string().uuid().optional(),
});

type LiveTest = z.infer<typeof LiveTestSchema>;

export type LiveTestContinuation = (request: {
  readonly scope: OperationScope;
  readonly principal: ResolvedPrincipal;
  readonly conversation_id: string;
  readonly workflow_id: string;
  readonly workflow_version_id: string;
}) => Promise<LiveTest>;

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

interface LiveTestRequest {
  readonly execution_environment: "dev" | "prod";
  readonly conversation_id?: string | undefined;
  readonly start_run?: boolean | undefined;
}

async function liveTestFor(
  continueLiveTest: LiveTestContinuation,
  scope: OperationScope,
  human: HumanScope,
  body: LiveTestRequest,
  workflow_id: string,
  workflow_version_id: string,
): Promise<LiveTest> {
  if (body.start_run !== true || body.execution_environment !== "dev" || !body.conversation_id)
    return { state: "not_requested" };
  return continueLiveTest({
    scope,
    principal: human.principal,
    conversation_id: body.conversation_id,
    workflow_id,
    workflow_version_id,
  });
}

const authorityNotFound = () => reject.notFound("execution authority");

type Authority = z.infer<typeof authoritySchema>;

const ActivatedSchema = z.object({
  workflow_version_id: z.string().uuid(),
  activated: z.literal(true),
  execution_authorized: z.literal(false),
  live_test: LiveTestSchema,
});

type ActivateBody = z.infer<typeof ActivateWorkflowDraftSchema>;
type GrantBody = z.infer<typeof GrantWorkflowAuthoritySchema>;

export function workflowDraftActivationOperation(continueLiveTest: LiveTestContinuation) {
  return defineOperation<{ id: string; body: ActivateBody }, z.infer<typeof ActivatedSchema>>({
    id: "workflows.drafts.activate",
    summary:
      "Activate a reviewed saved draft from a human browser without authorizing runs; a run starts only when start_run is set",
    permission: "workflow:write",
    resource: { type: "workflow", param: "id" },
    effect: "write",
    audit: AuditAction.WORKFLOW_UPDATED,
    async handler(scope, { id, body }) {
      const human = humanScope(scope);
      if (isRejection(human)) return human;
      try {
        const activated = await activateWorkflowDraft(id, body, human);
        const live_test = await liveTestFor(
          continueLiveTest,
          scope,
          human,
          body,
          id,
          activated.workflow_version_id,
        );
        return { ...activated, live_test };
      } catch (error) {
        return authorityRejection(error);
      }
    },
    http: {
      method: "post",
      path: "/v1/workflows/{id}/activate-draft",
      tags: ["workflows"],
      params: workflowParam,
      body: ActivateWorkflowDraftSchema,
      response: ActivatedSchema,
      success: {
        status: 200,
        description: "Activated without execution authority; no run starts unless start_run is set",
      },
      errors: authorityFailures,
      toInput: ({ param, json }) => ({
        id: (param as { id: string }).id,
        body: json as ActivateBody,
      }),
      toBody: (activated) => activated,
    },
  });
}

export function grantWorkflowAuthorityOperation(continueLiveTest: LiveTestContinuation) {
  return defineOperation<{ id: string; body: GrantBody }, Authority>({
    id: "workflows.authorities.grant",
    summary:
      "Grant a reviewed finite boundary from an authenticated human browser; no run starts unless start_run is set",
    permission: "workflow:write",
    resource: { type: "workflow", param: "id" },
    effect: "write",
    audit: AuditAction.WORKFLOW_AUTHORITY_GRANTED,
    async handler(scope, { id, body }) {
      const human = humanScope(scope);
      if (isRejection(human)) return human;
      try {
        const row = await grantWorkflowAuthority(id, body, human);
        const live_test = await liveTestFor(
          continueLiveTest,
          scope,
          human,
          body,
          id,
          row.workflow_version_id,
        );
        const observed = await observeAuthority(scope.db, scope.tenant_id, id, row.id);
        if (!observed) return authorityNotFound();
        return { ...observed, live_test };
      } catch (error) {
        return authorityRejection(error);
      }
    },
    http: {
      method: "post",
      path: "/v1/workflows/{id}/execution-authorities",
      tags: ["workflows"],
      params: workflowParam,
      body: GrantWorkflowAuthoritySchema,
      response: authoritySchema,
      success: { status: 201, description: AUTHORITY_DESCRIPTION },
      errors: authorityFailures,
      toInput: ({ param, json }) => ({ id: (param as { id: string }).id, body: json as GrantBody }),
      toBody: (authority) => authority,
    },
  });
}

export const revokeWorkflowAuthorityOperation = defineOperation<
  { id: string; authority_id: string },
  Authority
>({
  id: "workflows.authorities.revoke",
  summary: "Revoke the exact execution authority from an authenticated human browser",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_AUTHORITY_REVOKED,
  async handler(scope, { id, authority_id }) {
    const human = humanScope(scope);
    if (isRejection(human)) return human;
    try {
      await revokeWorkflowAuthority(id, authority_id, human);
      return (
        (await observeAuthority(scope.db, scope.tenant_id, id, authority_id)) ?? authorityNotFound()
      );
    } catch (error) {
      return authorityRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/workflows/{id}/execution-authorities/{authority_id}/revoke",
    tags: ["workflows"],
    params: authorityParam,
    response: authoritySchema,
    success: { status: 200, description: AUTHORITY_DESCRIPTION },
    errors: authorityFailures,
    toInput: ({ param }) => param as { id: string; authority_id: string },
    toBody: (authority) => authority,
  },
});

type UntilRevokedBody = z.infer<typeof MakeWorkflowAuthorityUntilRevokedSchema>;

export const makeWorkflowAuthorityUntilRevokedOperation = defineOperation<
  { id: string; authority_id: string; body: UntilRevokedBody },
  Authority
>({
  id: "workflows.authorities.until_revoked",
  summary:
    "Replace a time-limited approval with one until revoked for the identical boundary from an authenticated human browser",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_AUTHORITY_EXPIRY_REMOVED,
  async handler(scope, { id, authority_id, body }) {
    const human = humanScope(scope);
    if (isRejection(human)) return human;
    try {
      const row = await makeWorkflowAuthorityUntilRevoked(id, authority_id, body, human);
      return (await observeAuthority(scope.db, scope.tenant_id, id, row.id)) ?? authorityNotFound();
    } catch (error) {
      return authorityRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/workflows/{id}/execution-authorities/{authority_id}/until-revoked",
    tags: ["workflows"],
    params: authorityParam,
    body: MakeWorkflowAuthorityUntilRevokedSchema,
    response: authoritySchema,
    success: {
      status: 200,
      description:
        "The approval that now applies until revoked; the time-limited one is superseded in the same transaction",
    },
    errors: authorityFailures,
    toInput: ({ param, json }) => ({
      ...(param as { id: string; authority_id: string }),
      body: json as UntilRevokedBody,
    }),
    toBody: (authority) => authority,
  },
});
