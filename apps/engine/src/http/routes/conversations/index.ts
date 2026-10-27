import type { OpenAPIHono } from "@hono/zod-openapi";
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
    if (c.req.method === "GET") {
      return requireAnyPermission(["conversation:list", "workflow:read"])(c, next);
    }
    if (c.req.method === "POST") {
      return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
    }
    return next();
  });
  app.use("/v1/conversations/:id", async (c, next) => {
    if (c.req.method === "GET") {
      return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
    }
    if (c.req.method === "PATCH" || c.req.method === "DELETE") {
      return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
    }
    return next();
  });
  app.use("/v1/conversations/:id/compact", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
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
  app.use("/v1/conversations/:id/context-snapshot", async (c, next) => {
    return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
  });
  app.use("/v1/conversations/:id/cancel", async (c, next) => {
    return requireAnyPermission(["conversation:cancel", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/fork-from-message/:message_id", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/stream", async (c, next) => {
    return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
  });
  app.use("/v1/conversations/:id/suggest-next/feedback", async (c, next) => {
    return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
  });
  app.use("/v1/conversations/:id/preview", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/probe", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/draft/patch", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/draft/snapshots", async (c, next) => {
    return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
  });
  app.use("/v1/conversations/:id/draft/snapshots/restore", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/tool-policies", async (c, next) => {
    if (c.req.method === "GET") {
      return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
    }
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/workflow-reviews", async (c, next) => {
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/workflow-reviews/:receipt_id", async (c, next) => {
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/workflow-reviews/:receipt_id/finalize", async (c, next) => {
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });

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
