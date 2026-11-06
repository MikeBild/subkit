import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  approvePendingSecretVersionOperation,
  listPendingSecretVersionsOperation,
  rejectPendingSecretVersionOperation,
} from "../../api/operations/secret-approval.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

function gateUnroutedSecretApprovalRequests(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/secret-approvals", requirePermission("settings:read:global"));
  app.use("/v1/secret-approvals/*", requirePermission("settings:write:global"));
}

export function registerSecretApprovalRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listPendingSecretVersionsOperation);
  toHonoRoute(app, approvePendingSecretVersionOperation);
  toHonoRoute(app, rejectPendingSecretVersionOperation);
  gateUnroutedSecretApprovalRequests(app);
}
