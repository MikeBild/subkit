import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  approvePairApprovalOperation,
  declinePairApprovalOperation,
  getApprovalPolicyOperation,
  listPairApprovalsOperation,
  putApprovalPolicyOperation,
  requestPairApprovalOperation,
  withdrawPairApprovalOperation,
} from "../../api/operations/pair-approvals.ts";
import {
  getWorkflowAuthorityOperation,
  listWorkflowAuthoritiesOperation,
  previewWorkflowAuthorityOperation,
} from "../../api/operations/workflow-authorities.ts";
import {
  grantWorkflowAuthorityOperation,
  type LiveTestContinuation,
  makeWorkflowAuthorityUntilRevokedOperation,
  revokeWorkflowAuthorityOperation,
  workflowDraftActivationOperation,
} from "../../api/operations/workflow-authority-grants.ts";
import {
  prepareReportAuthorityOperation,
  workflowAutomationStatusOperation,
} from "../../api/operations/workflow-authority-review.ts";
import { continueConversationDevLiveTest } from "../../conversations/public/authoring.ts";
import { getBoss } from "../../queue/index.ts";
import type { AppEnv } from "../openapi.ts";

const continueLiveTest: LiveTestContinuation = ({ scope, principal, ...request }) =>
  continueConversationDevLiveTest({
    db: scope.db,
    principal,
    boss: scope.boss ?? getBoss(),
    ...request,
  });

export function registerWorkflowAuthorityRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, workflowAutomationStatusOperation);
  toHonoRoute(app, prepareReportAuthorityOperation);
  toHonoRoute(app, workflowDraftActivationOperation(continueLiveTest));
  toHonoRoute(app, listWorkflowAuthoritiesOperation);
  toHonoRoute(app, previewWorkflowAuthorityOperation);
  toHonoRoute(app, grantWorkflowAuthorityOperation(continueLiveTest));
  toHonoRoute(app, getWorkflowAuthorityOperation);
  toHonoRoute(app, revokeWorkflowAuthorityOperation);
  toHonoRoute(app, makeWorkflowAuthorityUntilRevokedOperation);
  toHonoRoute(app, getApprovalPolicyOperation);
  toHonoRoute(app, putApprovalPolicyOperation);
  toHonoRoute(app, requestPairApprovalOperation);
  toHonoRoute(app, listPairApprovalsOperation);
  toHonoRoute(app, approvePairApprovalOperation);
  toHonoRoute(app, declinePairApprovalOperation);
  toHonoRoute(app, withdrawPairApprovalOperation);
}
