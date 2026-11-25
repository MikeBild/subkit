import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { hidesConversationFromReader } from "../../../conversations/public/lifecycle.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAnyPermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerCollectionRoutes } from "./collection.ts";
import { registerDirectToolRoutes } from "./direct-tools.ts";
import { registerElicitationRoutes } from "./elicitations.ts";
import { registerLifecycleRoutes } from "./lifecycle.ts";
import { registerMessagesRoutes } from "./messages.ts";
import { registerStreamRoutes } from "./stream.ts";
import { registerSuggestNextFeedbackRoute } from "./suggest-next-feedback.ts";
import { registerToolPoliciesRoutes } from "./tool-policies.ts";
import { registerWorkflowReviewRoutes } from "./workflow-reviews.ts";

export function registerConversationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/conversations", async (c, next) => {
    if (c.req.method === "POST") {
      return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
    }
    return next();
  });
  app.use("/v1/conversations/:id/messages", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/messages/upload", async (c, next) => {
    return requireAnyPermission(["conversation:write", "knowledge:write"])(c, next);
  });
  app.use("/v1/conversations/:id/elicitations/:elicitation_id/respond", async (c, next) => {
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/tool-calls/:tool_call_id/respond", async (c, next) => {
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/stream", async (c, next) => {
    return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
  });

  const conversationReadGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const principal = c.get("principal");
    const id = c.req.param("id");
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || !principal || !id) return next();
    const hidden = await hidesConversationFromReader(c.get("db"), {
      tenant_id: principal.tenant_id,
      conversation_id: id,
      principal,
    });
    if (hidden) throw new NotFoundError("conversation");
    return next();
  };
  app.use("/v1/conversations/:id", conversationReadGuard);
  app.use("/v1/conversations/:id/*", conversationReadGuard);

  registerCollectionRoutes(app);
  registerDirectToolRoutes(app);
  registerMessagesRoutes(app);
  registerElicitationRoutes(app);
  registerLifecycleRoutes(app);
  registerToolPoliciesRoutes(app);
  registerWorkflowReviewRoutes(app);
  registerStreamRoutes(app);
  registerSuggestNextFeedbackRoute(app);
}
