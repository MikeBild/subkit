// Maintenance / lifecycle endpoints — none drive the LLM, so no SSE
// branch needed.
//
//   POST /v1/conversations/{id}/cancel
//   GET  /v1/conversations/{id}/context-snapshot
//   POST /v1/conversations/{id}/compact
//   POST /v1/conversations/{id}/fork-from-message/{message_id}

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import * as svc from "../../../conversations/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
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
  security: [{ bearerAuth: [] }],
  request: { params: ForkFromMessageParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ForkFromMessageResponse } },
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
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerLifecycleRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(cancelRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await svc.cancelConversation(principal.tenant_id, id, principal.id, db);
    if (!row) throw new NotFoundError("conversation");
    return c.json(row, 200);
  });

  app.openapi(contextSnapshotRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const snapshot = await svc.getContextSnapshot(principal.tenant_id, id, db);
    if (!snapshot) throw new NotFoundError("conversation");
    return c.json(snapshot, 200);
  });

  app.openapi(compactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await svc.compactConversation(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        ...(body.keep_last !== undefined ? { keep_last: body.keep_last } : {}),
      },
      db,
    );
    return c.json(result, 200);
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
      },
      db,
    );
    if (!result) throw new NotFoundError("conversation");
    return c.json(result, 200);
  });
}
