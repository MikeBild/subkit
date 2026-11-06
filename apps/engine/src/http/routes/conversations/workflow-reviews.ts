import type { OpenAPIHono } from "@hono/zod-openapi";
import { conversationWorkflowReviewOperations } from "../../../api/operations/conversation-workflow-reviews.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerWorkflowReviewRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, conversationWorkflowReviewOperations.prepare);
  toHonoRoute(app, conversationWorkflowReviewOperations.get);
  toHonoRoute(app, conversationWorkflowReviewOperations.finalize);
}
