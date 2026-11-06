import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  applyWorkflowBoundaryProposalsOperation,
  createWorkflowDraftOperation,
  getWorkflowDraftOperation,
  updateWorkflowDraftOperation,
  workflowBoundaryProposalsOperation,
} from "../../api/operations/workflow-drafts.ts";
import type { AppEnv } from "../openapi.ts";

export function registerWorkflowDraftRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, createWorkflowDraftOperation);
  toHonoRoute(app, updateWorkflowDraftOperation);
  toHonoRoute(app, workflowBoundaryProposalsOperation);
  toHonoRoute(app, applyWorkflowBoundaryProposalsOperation);
  toHonoRoute(app, getWorkflowDraftOperation);
}
