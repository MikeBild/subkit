import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { actorType } from "../../../audit/index.ts";
import * as svc from "../../../conversations/index.ts";
import { hasBuiltinAdminRole } from "../../../rbac/index.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { conversationLocale } from "./locale.ts";
import {
  CompactConversationBody,
  CompactConversationResponse,
  ContextSnapshotSchema,
  ConversationSchema,
} from "./schemas.ts";

const ForkFromMessageParam = z.object({
  id: z.string().uuid(),
  message_id: z.string().uuid(),
});

const ForkFromMessageResponse = z
  .object({
    conversation: ConversationSchema,
    source_conversation_id: z.string().uuid(),
    anchor_message_id: z.string().uuid(),
    copied_message_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .openapi("ForkFromMessageResponse");

const cancelRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/cancel",
  tags: ["conversations"],
  summary: "Cancel a conversation",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const DeleteConversationResponse = z
  .object({
    id: z.string().uuid(),
    deleted: z.literal(true),
  })
  .openapi("DeleteConversationResponse");

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/conversations/{id}",
  tags: ["conversations"],
  summary: "Delete a conversation for everyone",
  description:
    "Removes the conversation with its messages, tool calls and file links; the " +
    "files themselves stay. Only the owner or an administrator may delete. Refused " +
    "with 409 while a turn is running. Hiding (`/hide`) only takes it out of the " +
    "caller's own list.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "Deleted",
      content: { "application/json": { schema: DeleteConversationResponse } },
    },
    403: {
      description: "Forbidden — neither the owner nor an administrator",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "A turn is still running",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const hideRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/hide",
  tags: ["conversations"],
  summary: "Hide a conversation from the caller's own list (reversible, never a delete)",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationSchema } },
    },
    403: {
      description: "Forbidden — hiding is available for user-owned conversation lists",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const unhideRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/unhide",
  tags: ["conversations"],
  summary: "Put a hidden conversation back into the caller's list",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationSchema } },
    },
    403: {
      description: "Forbidden — visibility is available for user-owned conversation lists",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const contextSnapshotRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{id}/context-snapshot",
  tags: ["conversations"],
  summary: "Summary of the context currently in scope for a conversation",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ContextSnapshotSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const forkFromMessageRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/fork-from-message/{message_id}",
  tags: ["conversations"],
  summary: "Fork a conversation, copying messages up to and including the anchor",
  description:
    "Creates a new conversation owned by the same tenant + actor and copies " +
    "messages [0..anchor] in created_at order. Tool calls and elicitations are " +
    "NOT copied — re-running them would duplicate side effects. Caveat: " +
    "assistant message content that references `tool_call_id` values from the " +
    "source will retain those refs even though the corresponding tool_call " +
    "rows are not in the fork; the CLI renderer treats unknown ids as plain " +
    "text, but audit-log readers should be aware. Each copied message gets a " +
    "fresh `created_at` (set to fork-time) so the fork's timeline orders " +
    "cleanly; the source's original timestamps are preserved in the source " +
    "conversation, joinable via `forked_from` in the audit metadata. The " +
    `fork is hard-capped at the most recent ${svc.FORK_COPY_MESSAGE_CAP.toLocaleString("en-US")} messages up to and ` +
    "including the anchor; when the cap fires the response sets " +
    "`truncated: true` and the audit row records the original source count.",
  security: [{ bearerAuth: [] }],
  request: { params: ForkFromMessageParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ForkFromMessageResponse } },
    },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden — principal lacks conversation:write or workflow:write",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const compactRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/compact",
  tags: ["conversations"],
  summary: "Compact a conversation's message history into a summary",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: CompactConversationBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: CompactConversationResponse } },
    },
    409: {
      description: "Conversation turn already running",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerLifecycleRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(cancelRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await svc.cancelConversation(
      principal.tenant_id,
      id,
      principal.id,
      db,
      actorType(principal),
    );
    if (!row) throw new NotFoundError("conversation");
    return c.json(row, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await svc.deleteConversation(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        actor_type: actorType(principal),
        actor_is_admin: hasBuiltinAdminRole(principal),
        request_source: "api",
      },
      db,
    );
    if (result.kind === "not_found") throw new NotFoundError("conversation");
    if (result.kind === "forbidden") throw new ForbiddenError("not_conversation_owner");
    if (result.kind === "turn_running") {
      throw new ConflictError("A turn is still running in this conversation; stop it first.", {
        reason: "turn_running",
      });
    }
    return c.json({ id: result.id, deleted: true as const }, 200);
  });

  for (const [route, hidden] of [
    [hideRoute, true],
    [unhideRoute, false],
  ] as const) {
    app.openapi(route, async (c) => {
      const principal = requireAuth(c);
      if (principal.kind !== "user") {
        throw new ForbiddenError("conversation_list_visibility_requires_user");
      }
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const row = await svc.setConversationHidden(
        { tenant_id: principal.tenant_id, conversation_id: id, user_id: principal.id, hidden },
        db,
      );
      if (!row) throw new NotFoundError("conversation");
      return c.json(row, 200);
    });
  }

  app.openapi(contextSnapshotRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const snapshot = await svc.getContextSnapshot(
      principal.tenant_id,
      id,
      db,
      principal,
      conversationLocale(c.req.header("cookie"), c.req.header("accept-language")),
    );
    if (!snapshot) throw new NotFoundError("conversation");
    return c.json(snapshot, 200);
  });

  app.openapi(compactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const ctrl = await svc.registerConversationAbort(principal.tenant_id, id, db);
    try {
      const result = await svc.compactConversation(
        {
          tenant_id: principal.tenant_id,
          conversation_id: id,
          actor_id: principal.id,
          actor_type: actorType(principal),
          ...(body.keep_last !== undefined ? { keep_last: body.keep_last } : {}),
        },
        db,
      );
      return c.json(result, 200);
    } finally {
      await svc.unregisterConversationAbort(principal.tenant_id, id, ctrl);
    }
  });

  app.openapi(forkFromMessageRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, message_id } = c.req.valid("param");
    const result = await svc.forkConversation(
      {
        tenant_id: principal.tenant_id,
        source_conversation_id: id,
        anchor_message_id: message_id,
        actor_id: principal.id,
        actor_type: actorType(principal),
        request_source: "api",
      },
      db,
    );
    if (!result) throw new NotFoundError("conversation");
    return c.json(result, 200);
  });
}
