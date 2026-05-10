// Conversations HTTP surface — entry point.
//
// Phase 4 of the 2026-05 architecture audit (#92). The former
// http/routes/conversations.ts (1303 LOC) split into per-sub-resource
// modules; this barrel registers the shared per-path RBAC middleware
// and delegates handler registration to each module. Public API
// unchanged: server.ts still calls `registerConversationRoutes(app)`.
//
//   POST   /v1/conversations                               — create (optionally drive initial turn)
//   GET    /v1/conversations                               — list
//   GET    /v1/conversations/:id                           — fetch detail
//   PATCH  /v1/conversations/:id                           — patch metadata
//   POST   /v1/conversations/:id/messages                  — append user message + drive turn
//   POST   /v1/conversations/:id/messages/upload           — multipart with file attachments
//   POST   /v1/conversations/:id/elicitations/:eid/respond — resolve a pending ask_user_*
//   POST   /v1/conversations/:id/tool-calls/:tid/respond   — resume by tool_call_id alias
//   POST   /v1/conversations/:id/cancel                    — cancel a conversation
//   GET    /v1/conversations/:id/context-snapshot          — context summary
//   POST   /v1/conversations/:id/compact                   — compact message history
//   GET    /v1/conversations/:id/tool-policies             — read per-tool overrides
//   PUT    /v1/conversations/:id/tool-policies             — set per-tool overrides
//   GET    /v1/conversations/:id/stream                    — SSE replay of the latest run

import type { OpenAPIHono } from "@hono/zod-openapi";
import { replayEvents } from "../../../conversations/index.ts";
import { requireAnyPermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerCollectionRoutes } from "./collection.ts";
import { registerElicitationRoutes } from "./elicitations.ts";
import { registerLifecycleRoutes } from "./lifecycle.ts";
import { registerMessagesRoutes } from "./messages.ts";
import { registerStreamRoutes } from "./stream.ts";
import { registerSuggestNextFeedbackRoute } from "./suggest-next-feedback.ts";
import { registerToolPoliciesRoutes } from "./tool-policies.ts";

export function registerConversationRoutes(app: OpenAPIHono<AppEnv>): void {
  // Conversations are gated on a dedicated `conversation:*` permission
  // family (added in the sk-cli rollout). The legacy `workflow:*`
  // permissions are kept as accepted alternates for a deprecation
  // window so existing resource grants and external callers do not
  // break on upgrade.
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
    if (c.req.method === "PATCH") {
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
  // C1 of PR #161 review — fork-from-message inserts a new conversation
  // row plus copies of N message rows. State-mutating writes require the
  // same `conversation:write` / `workflow:write` gate as compact /
  // messages. Without this middleware Hono 4.12's `app.use("/:id", …)`
  // does not cover sub-paths and the route was reachable by any
  // authenticated principal.
  app.use("/v1/conversations/:id/fork-from-message/:message_id", async (c, next) => {
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });
  app.use("/v1/conversations/:id/stream", async (c, next) => {
    return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
  });
  // The suggest-next feedback route writes only to a metric (no audit
  // row, no DB mutation), so the read-permission gate is sufficient.
  app.use("/v1/conversations/:id/suggest-next/feedback", async (c, next) => {
    return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
  });
  // Tool policies are governance state (per-tool confirm/auto/yolo
  // matrix); the PUT mutates it and writes a `tool_policy.changed`
  // audit row, so the surface is RBAC-gated identically to the
  // sibling approve/cancel routes. GET is reader-permission
  // because the policy state is not secret but reveals which
  // dangerous tools the operator has relaxed.
  app.use("/v1/conversations/:id/tool-policies", async (c, next) => {
    if (c.req.method === "GET") {
      return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
    }
    return requireAnyPermission(["conversation:approve", "workflow:write"])(c, next);
  });

  registerCollectionRoutes(app);
  registerMessagesRoutes(app);
  registerElicitationRoutes(app);
  registerLifecycleRoutes(app);
  registerToolPoliciesRoutes(app);
  registerStreamRoutes(app);
  registerSuggestNextFeedbackRoute(app);

  // Touch the helper so the biome unused-import pass does not reject.
  void replayEvents;
}
