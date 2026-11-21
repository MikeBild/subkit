import { z } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { users } from "../../db/schema/index.ts";
import {
  ApprovalPolicyError,
  type ApprovalPolicyState,
  changeApprovalPolicy,
  eligiblePairApprovers,
  readApprovalPolicy,
  type WorkflowApprovalPolicy,
} from "../../identity/approval-policy.ts";
import { principalHolds } from "../../rbac/evaluator.ts";
import { now } from "../../utils/clock.ts";
import { GrantWorkflowAuthoritySchema } from "../../workflows/execution-authorities.ts";
import {
  approvePairRequest,
  declinePairRequest,
  listPairRequests,
  type PairApprovalView,
  requestPairApproval,
  viewPairRequests,
  withdrawPairRequest,
} from "../../workflows/pair-approvals.ts";
import {
  defineOperation,
  isRejection,
  type OperationScope,
  type Rejection,
  reject,
} from "./index.ts";
import {
  AUTHORITY_ERROR_STATUSES,
  authorityRejection,
  authoritySchema,
  observeAuthority,
  workflowParam,
} from "./workflow-authorities.ts";

const PAIR_STATES = ["pending", "approved", "declined", "withdrawn", "expired", "stale"] as const;

const Person = z.object({ user_id: z.string().uuid(), name: z.string() });

export const ApprovalPolicySchema = z
  .object({
    workflow_approvals: z
      .enum(["single", "pair"])
      .describe(
        "single: one person with workflow:write approves a workflow. pair: two different people both approve the same reviewed boundary before it takes effect.",
      ),
    eligible_approvers: z
      .number()
      .int()
      .describe("Active people who hold workflow:write and may take one of the two slots."),
    ready: z
      .boolean()
      .describe("Whether pair approval can work: at least two eligible people exist."),
    changed_at: z.string().nullable(),
    changed_by: Person.nullable(),
  })
  .openapi("ApprovalPolicy");

const PutPolicyBody = z
  .object({ workflow_approvals: z.enum(["single", "pair"]) })
  .strict()
  .openapi("UpdateApprovalPolicyBody");

export const PairApprovalSchema = z
  .object({
    id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    execution_environment: z.enum(["dev", "prod"]),
    expected_manifest_digest: z.string(),
    valid_from: z.string(),
    valid_until: z.string().nullable(),
    max_runs: z.number().int().nullable(),
    state: z
      .enum(PAIR_STATES)
      .describe(
        "pending: waits for a second person. approved: both approved and the execution authority exists. declined, withdrawn: closed by a person. expired: nobody approved within 72 hours or before the approval would have ended. stale: the workflow changed or the person who asked can no longer approve.",
      ),
    stale_reason: z.enum(["manifest_changed", "first_approver_unavailable"]).nullable(),
    first_approver: Person,
    second_approver: Person.nullable(),
    created_at: z.string(),
    expires_at: z.string(),
    decided_at: z.string().nullable(),
    authority_id: z.string().uuid().nullable(),
    viewer_can_approve: z
      .boolean()
      .describe(
        "Whether the caller may take the second slot right now; never true for the first approver.",
      ),
  })
  .openapi("PairApproval");

const PairApprovalList = z
  .object({ items: z.array(PairApprovalSchema) })
  .openapi("PairApprovalList");

const ApprovedPairSchema = z
  .object({ pair_approval: PairApprovalSchema, authority: authoritySchema })
  .openapi("ApprovedPairApproval");

const RequestBody = GrantWorkflowAuthoritySchema.extend({}).openapi("RequestPairApprovalBody");

const pairParam = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
});

const ListQuery = z.object({ state: z.enum(PAIR_STATES).optional() });

const PAIR_ERRORS: Record<string, { status: 403 | 404 | 409 | 422; message?: string }> = {
  pair_request_not_found: { status: 404 },
  pair_same_person: { status: 403 },
  pair_not_requester: { status: 403 },
  pair_not_required: { status: 409 },
  pair_request_closed: { status: 409 },
  pair_request_expired: { status: 409 },
  pair_request_stale: { status: 409 },
  pair_start_run_unsupported: { status: 422 },
};

function pairRejection(error: unknown): Rejection {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && PAIR_ERRORS[code])
    return reject.status(PAIR_ERRORS[code].status, code, (error as Error).message);
  if (typeof code === "string" && AUTHORITY_ERROR_STATUSES[code]) return authorityRejection(error);
  throw error;
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

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function pairBody(view: PairApprovalView): z.infer<typeof PairApprovalSchema> {
  const grant = view.row.grant as {
    valid_from?: string;
    valid_until?: string | null;
    max_runs?: number | null;
  };
  return {
    id: view.row.id,
    workflow_id: view.row.workflow_id,
    workflow_version_id: view.row.workflow_version_id,
    execution_environment: view.row.execution_environment,
    expected_manifest_digest: view.row.expected_manifest_digest,
    valid_from: grant.valid_from ?? view.row.created_at.toISOString(),
    valid_until: grant.valid_until ?? null,
    max_runs: grant.max_runs ?? null,
    state: view.state,
    stale_reason: view.row.stale_reason,
    first_approver: view.first_approver,
    second_approver: view.second_approver,
    created_at: view.row.created_at.toISOString(),
    expires_at: view.row.expires_at.toISOString(),
    decided_at: iso(view.row.decided_at),
    authority_id: view.row.authority_id,
    viewer_can_approve: view.viewer_can_approve,
  };
}

async function policyBody(
  scope: OperationScope,
  state: ApprovalPolicyState,
  eligible?: number,
): Promise<z.infer<typeof ApprovalPolicySchema>> {
  const count = eligible ?? (await eligiblePairApprovers(scope.db, scope.tenant_id)).length;
  let changed_by: { user_id: string; name: string } | null = null;
  if (state.changed_by) {
    const [person] = await scope.db
      .select({ id: users.id, name: users.display_name, email: users.email })
      .from(users)
      .where(and(eq(users.tenant_id, scope.tenant_id), inArray(users.id, [state.changed_by])))
      .limit(1);
    changed_by = person
      ? { user_id: person.id, name: person.name?.trim() || person.email }
      : { user_id: state.changed_by, name: state.changed_by };
  }
  return {
    workflow_approvals: state.workflow_approvals,
    eligible_approvers: count,
    ready: count >= 2,
    changed_at: iso(state.changed_at),
    changed_by,
  };
}

type PolicyBody = z.infer<typeof ApprovalPolicySchema>;

export const getApprovalPolicyOperation = defineOperation<null, PolicyBody>({
  id: "workspace.approval_policy.get",
  summary: "Read whether one person or two people approve a workflow in this workspace",
  permission: "workflow:read",
  effect: "read",
  async handler(scope) {
    return policyBody(scope, await readApprovalPolicy(scope.db, scope.tenant_id));
  },
  http: {
    method: "get",
    path: "/v1/workspace/approval-policy",
    tags: ["workflows"],
    response: ApprovalPolicySchema,
    errors: { 401: "Unauthorized", 403: "Forbidden" },
    toInput: () => null,
    toBody: (body) => body,
  },
});

export const putApprovalPolicyOperation = defineOperation<
  { workflow_approvals: WorkflowApprovalPolicy },
  PolicyBody
>({
  id: "workspace.approval_policy.put",
  summary: "Switch between one-person and two-person workflow approval",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.WORKSPACE_APPROVAL_POLICY_CHANGED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const changed = await changeApprovalPolicy(scope.db, {
        tenant_id: scope.tenant_id,
        next: body.workflow_approvals,
        actor: { type: principal.kind === "user" ? "user" : "system", id: principal.id },
        source: "policy",
      });
      return policyBody(scope, changed.state, changed.eligible);
    } catch (error) {
      if (error instanceof ApprovalPolicyError && error.code === "pair_needs_two_approvers")
        return reject.conflict(
          "Two-person approval needs at least two active people who may approve workflows.",
          { eligible_approvers: error.eligible },
          "pair_needs_two_approvers",
        );
      throw error;
    }
  },
  http: {
    method: "put",
    path: "/v1/workspace/approval-policy",
    tags: ["workflows"],
    description:
      "Under `pair`, every way that would let one person approve a workflow alone answers 409 `pair_approval_required`: the direct grant, the chat approval card, task permissions and turning an approval into until-revoked. Approvals then go through `/v1/workflows/{id}/pair-approvals`. Switching back to `single` is the only fallback and is audited; pending requests stay open.",
    body: PutPolicyBody,
    response: ApprovalPolicySchema,
    errors: {
      401: "Unauthorized",
      403: "Forbidden — rbac:write is required",
      409: "pair_needs_two_approvers — fewer than two people may approve workflows",
    },
    toInput: ({ json }) => json as { workflow_approvals: WorkflowApprovalPolicy },
    toBody: (body) => body,
  },
});

type RequestBodyInput = z.infer<typeof RequestBody>;

async function viewOne(
  scope: OperationScope,
  principal: ResolvedPrincipal,
  row: PairApprovalView["row"],
) {
  const [view] = await viewPairRequests(scope.db, principal, [row], new Date(now()));
  if (!view) throw new Error("pair request view missing");
  return view;
}

export const requestPairApprovalOperation = defineOperation<
  { id: string; body: RequestBodyInput },
  PairApprovalView
>({
  id: "workflows.pair_approvals.request",
  summary: "Give the first of two approvals for a reviewed workflow boundary",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_PAIR_APPROVAL_REQUESTED,
  async handler(scope, { id, body }) {
    const human = humanScope(scope);
    if (isRejection(human)) return human;
    try {
      const row = await requestPairApproval(id, body, human);
      return await viewOne(scope, human.principal, row);
    } catch (error) {
      return pairRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/workflows/{id}/pair-approvals",
    tags: ["workflows"],
    description:
      "Records the first person's decision on exactly the reviewed boundary: version, effect digest, environment, window and run limit. Nothing may run yet. A different person with workflow:write approves the same request to create the execution authority. The request expires after 72 hours, or earlier when its window would end.",
    params: workflowParam,
    body: RequestBody,
    response: PairApprovalSchema,
    success: { status: 201, description: "First approval recorded; waiting for a second person" },
    errors: {
      400: "The validity window is not allowed",
      403: "A signed human browser session with workflow:write is required",
      404: "Workflow version not found",
      409: "pair_not_required, authority_manifest_changed or authority_effect_unbound",
      422: "pair_start_run_unsupported",
    },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      body: json as RequestBodyInput,
    }),
    toBody: pairBody,
  },
});

export const listPairApprovalsOperation = defineOperation<
  { id: string; state?: (typeof PAIR_STATES)[number] | undefined },
  PairApprovalView[]
>({
  id: "workflows.pair_approvals.list",
  summary: "List the pair approval requests of a workflow, newest first",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  effect: "read",
  async handler(scope, { id, state }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const stored =
      state === "expired"
        ? ["pending", "expired"]
        : state === "pending"
          ? ["pending"]
          : state
            ? [state]
            : [];
    const rows = await listPairRequests(scope.db, scope.tenant_id, {
      workflow_id: id,
      states: stored as (typeof PAIR_STATES)[number][],
    });
    const views = await viewPairRequests(scope.db, principal, rows, new Date(now()));
    return state ? views.filter((view) => view.state === state) : views;
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/pair-approvals",
    tags: ["workflows"],
    params: workflowParam,
    query: ListQuery,
    response: PairApprovalList,
    errors: { 401: "Unauthorized", 403: "Forbidden" },
    toInput: ({ param, query }) => ({
      id: (param as { id: string }).id,
      ...(query as z.infer<typeof ListQuery>),
    }),
    toBody: (views) => ({ items: views.map(pairBody) }),
  },
});

type PairParam = z.infer<typeof pairParam>;

export const approvePairApprovalOperation = defineOperation<
  PairParam,
  { view: PairApprovalView; authority: z.infer<typeof authoritySchema> }
>({
  id: "workflows.pair_approvals.approve",
  summary: "Give the second approval; the execution authority takes effect now",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_PAIR_APPROVAL_APPROVED,
  async handler(scope, { id, request_id }) {
    const human = humanScope(scope);
    if (isRejection(human)) return human;
    try {
      const approved = await approvePairRequest(id, request_id, human);
      const authority = await observeAuthority(
        scope.db,
        scope.tenant_id,
        id,
        approved.authority_id,
      );
      if (!authority) return reject.notFound("execution authority");
      return { view: await viewOne(scope, human.principal, approved.request), authority };
    } catch (error) {
      return pairRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/workflows/{id}/pair-approvals/{request_id}/approve",
    tags: ["workflows"],
    description:
      "Only a person other than the first approver may approve. The boundary is checked again: when the workflow changed since the first approval the request turns `stale` and nothing is granted.",
    params: pairParam,
    response: ApprovedPairSchema,
    success: { status: 201, description: "Both approved; the execution authority exists" },
    errors: {
      403: "pair_same_person, or a signed human browser session with workflow:write is required",
      404: "pair_request_not_found",
      409: "pair_request_closed, pair_request_expired, pair_request_stale or authority_manifest_changed",
    },
    toInput: ({ param }) => param as PairParam,
    toBody: (result) => ({ pair_approval: pairBody(result.view), authority: result.authority }),
  },
});

export const declinePairApprovalOperation = defineOperation<PairParam, PairApprovalView>({
  id: "workflows.pair_approvals.decline",
  summary: "Decline a pair approval request as the second person",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_PAIR_APPROVAL_DECLINED,
  async handler(scope, { id, request_id }) {
    const human = humanScope(scope);
    if (isRejection(human)) return human;
    try {
      const row = await declinePairRequest(id, request_id, human);
      return await viewOne(scope, human.principal, row);
    } catch (error) {
      return pairRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/workflows/{id}/pair-approvals/{request_id}/decline",
    tags: ["workflows"],
    params: pairParam,
    response: PairApprovalSchema,
    errors: {
      403: "pair_same_person — the person who asked withdraws instead",
      404: "pair_request_not_found",
      409: "pair_request_closed or pair_request_expired",
    },
    toInput: ({ param }) => param as PairParam,
    toBody: pairBody,
  },
});

export const withdrawPairApprovalOperation = defineOperation<PairParam, PairApprovalView>({
  id: "workflows.pair_approvals.withdraw",
  summary: "Withdraw a pending pair approval request",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_PAIR_APPROVAL_WITHDRAWN,
  async handler(scope, { id, request_id }) {
    const human = humanScope(scope);
    if (isRejection(human)) return human;
    try {
      const admin = await principalHolds(scope.db, human.principal, "rbac:write");
      const row = await withdrawPairRequest(id, request_id, human, admin);
      return await viewOne(scope, human.principal, row);
    } catch (error) {
      return pairRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/workflows/{id}/pair-approvals/{request_id}/withdraw",
    tags: ["workflows"],
    params: pairParam,
    response: PairApprovalSchema,
    errors: {
      403: "pair_not_requester — only the person who asked or an administrator withdraws",
      404: "pair_request_not_found",
      409: "pair_request_closed or pair_request_expired",
    },
    toInput: ({ param }) => param as PairParam,
    toBody: pairBody,
  },
});
