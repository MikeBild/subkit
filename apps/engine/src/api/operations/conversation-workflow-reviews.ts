import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { browserSessionForPrincipal, verifyBrowserCsrf } from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  finalizeWorkflowReview,
  getWorkflowReview,
  prepareWorkflowReview,
  WorkflowReviewError,
} from "../../conversations/workflow-review.ts";
import { HttpError } from "../../http/errors.ts";
import { requireSignedInPerson } from "../../http/middleware/auth.ts";
import {
  FinalizeWorkflowReviewSchema,
  PrepareWorkflowReviewSchema,
  WorkflowReviewReceiptSchema,
} from "../../workflows/review-receipt.ts";
import {
  defineOperation,
  type OperationScope,
  type Rejection,
  type RejectionStatus,
  reject,
} from "./index.ts";

const ConversationParam = z.object({ id: z.string().uuid() });
const ReviewParam = ConversationParam.extend({ receipt_id: z.string().uuid() });

type Receipt = z.infer<typeof WorkflowReviewReceiptSchema>;

interface PrepareInput {
  readonly id: string;
  readonly raw: unknown;
}

interface ReviewInput {
  readonly id: string;
  readonly receipt_id: string;
}

interface FinalizeInput extends ReviewInput {
  readonly raw: unknown;
}

const REJECTION_STATUSES: ReadonlySet<number> = new Set<RejectionStatus>([
  400, 401, 403, 404, 409, 410, 413, 422, 429,
]);

const PERMISSIONS = {
  permission: "conversation:approve",
  alternatePermissions: ["workflow:write"],
};

function reviewRejection(error: unknown): Rejection {
  if (!(error instanceof WorkflowReviewError)) throw error;
  if (!REJECTION_STATUSES.has(error.status))
    throw new HttpError(error.status, error.code, error.message);
  return reject.status(error.status as RejectionStatus, error.code, error.message);
}

async function browserHuman(
  scope: OperationScope,
  write: boolean,
): Promise<{ principal: ResolvedPrincipal; session_id: string; request: Request } | Rejection> {
  const principal = scope.principal;
  const request = scope.request;
  if (!principal || !request) return reject.unauthorized();
  requireSignedInPerson(principal, "a signed-in browser session is required to review a workflow");
  const session = await browserSessionForPrincipal(request, principal);
  if (!session) return reject.status(403, "human_session_required", "human session required");
  if (
    write &&
    (request.headers.get("sec-fetch-site") === "cross-site" ||
      !(await verifyBrowserCsrf(request.headers.get("x-subkit-csrf") ?? "", session)))
  )
    return reject.status(403, "csrf_rejected", "valid browser CSRF proof required");
  return { principal, session_id: session.session_id, request };
}

function same<T>(result: T): T {
  return result;
}

const prepare = defineOperation<PrepareInput, Receipt>({
  id: "conversation.workflow_review.prepare",
  ...PERMISSIONS,
  effect: "write",
  audit: AuditAction.WORKFLOW_REVIEW_PREPARED,
  async handler(scope, { id, raw }) {
    const human = await browserHuman(scope, true);
    if ("rejected" in human) return human;
    return prepareWorkflowReview(
      {
        tenant_id: scope.tenant_id,
        conversation_id: id,
        principal: human.principal,
        session_id: human.session_id,
        raw,
      },
      scope.db,
    ).catch(reviewRejection);
  },
  http: {
    method: "post",
    path: "/v1/conversations/{id}/workflow-reviews",
    tags: ["conversations"],
    params: ConversationParam,
    body: PrepareWorkflowReviewSchema,
    response: WorkflowReviewReceiptSchema,
    success: { status: 201, description: "Prepared review" },
    errors: {
      409: "Stale or unavailable review",
      403: "Human session required",
      410: "Review expired",
      422: "Review blocked",
    },
    toInput: ({ param, json }) => ({ id: (param as { id: string }).id, raw: json }),
    toBody: same,
  },
});

const get = defineOperation<ReviewInput, Receipt>({
  id: "conversation.workflow_review.get",
  ...PERMISSIONS,
  effect: "read",
  async handler(scope, { id, receipt_id }) {
    const human = await browserHuman(scope, false);
    if ("rejected" in human) return human;
    return getWorkflowReview(
      {
        tenant_id: scope.tenant_id,
        conversation_id: id,
        receipt_id,
        principal: human.principal,
        session_id: human.session_id,
      },
      scope.db,
    ).catch(reviewRejection);
  },
  http: {
    method: "get",
    path: "/v1/conversations/{id}/workflow-reviews/{receipt_id}",
    tags: ["conversations"],
    params: ReviewParam,
    response: WorkflowReviewReceiptSchema,
    success: { status: 200, description: "Workflow review" },
    errors: { 404: "Review not found", 403: "Human session required" },
    toInput: ({ param }) => param as ReviewInput,
    toBody: same,
  },
});

const finalize = defineOperation<FinalizeInput, Receipt>({
  id: "conversation.workflow_review.finalize",
  ...PERMISSIONS,
  effect: "write",
  audit: AuditAction.WORKFLOW_REVIEW_COMPLETED,
  async handler(scope, { id, receipt_id, raw }) {
    const human = await browserHuman(scope, true);
    if ("rejected" in human) return human;
    return finalizeWorkflowReview(
      {
        tenant_id: scope.tenant_id,
        conversation_id: id,
        receipt_id,
        principal: human.principal,
        request: human.request,
        raw,
      },
      scope.db,
    ).catch(reviewRejection);
  },
  http: {
    method: "post",
    path: "/v1/conversations/{id}/workflow-reviews/{receipt_id}/finalize",
    tags: ["conversations"],
    params: ReviewParam,
    body: FinalizeWorkflowReviewSchema,
    response: WorkflowReviewReceiptSchema,
    success: { status: 200, description: "Completed review" },
    errors: {
      409: "Stale review",
      403: "Human session required",
      404: "Review not found",
      410: "Review expired",
      422: "Review blocked",
    },
    toInput: ({ param, json }) => ({ ...(param as ReviewInput), raw: json }),
    toBody: same,
  },
});

export const conversationWorkflowReviewOperations = { prepare, get, finalize };
