import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { isConversationReadable } from "../../../conversations/public/lifecycle.ts";
import type { Executor } from "../../../db/client.ts";
import { can } from "../../../rbac/evaluator.ts";
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

async function holdsConversationRead(db: Executor, principal: ResolvedPrincipal): Promise<boolean> {
  for (const permission of ["conversation:read", "workflow:read"]) {
    const decision = await can(db, { tenant_id: principal.tenant_id, principal, permission });
    if (decision.allow) return true;
  }
  return false;
}

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
    // Reads answer 404 for a conversation the caller may not read. Writes are
    // refused by assertConversationWriter in the handlers, after the permission check.
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || !principal || !id) return next();
    const readable = await isConversationReadable(c.get("db"), {
      tenant_id: principal.tenant_id,
      conversation_id: id,
      principal,
    });
    // Without read permission the route refuses with its own 403 first.
    if (!readable && (await holdsConversationRead(c.get("db"), principal)))
      throw new NotFoundError("conversation");
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
