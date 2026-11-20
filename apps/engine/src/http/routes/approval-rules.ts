import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  acceptApprovalRuleOperation,
  dismissApprovalRuleOperation,
  listApprovalRulesOperation,
  renewApprovalRuleOperation,
  revokeApprovalRuleOperation,
} from "../../api/operations/approval-rules.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import type { AppEnv } from "../openapi.ts";

export function registerApprovalRuleRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listApprovalRulesOperation);
  toHonoRoute(app, acceptApprovalRuleOperation);
  toHonoRoute(app, dismissApprovalRuleOperation);
  toHonoRoute(app, renewApprovalRuleOperation);
  toHonoRoute(app, revokeApprovalRuleOperation);
}
