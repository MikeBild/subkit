// Maintenance / lifecycle endpoints — none drive the LLM, so no SSE
// branch needed.
//
//   POST /v1/conversations/{id}/cancel
//   GET  /v1/conversations/{id}/context-snapshot
//   POST /v1/conversations/{id}/compact
//   POST /v1/conversations/{id}/fork-from-message/{message_id}

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { actorType } from "../../../audit/actor.ts";
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
    /**
     * True when the fork hit the per-fork copy cap and only the most
     * recent N messages up to the anchor were copied. The anchor
     * message is always preserved. Audit metadata records the
     * original source-side count alongside this flag.
     */
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
    // Document the auth + RBAC error shapes so generated CLIs see the
    // envelope. 401 fires from `requireAuth` (no/invalid bearer); 403
    // fires from `requireAnyPermission(["conversation:write",
    // "workflow:write"])` registered alongside the route.
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
        // Thread the principal kind through so the audit row uses
        // the same `actor_type` taxonomy as every other emit site —
        // `system_account` callers no longer get collapsed to
        // `user`. `actorType()` is the canonical projector hoisted
        // out into `audit/actor.ts`.
        actor_type: actorType(principal),
        // Every HTTP entry into the fork service tags the audit row
        // as `api`. Other channels (CLI direct invocation, scheduler)
        // pass their own value when they invoke `forkConversation`
        // directly.
        request_source: "api",
      },
      db,
    );
    if (!result) throw new NotFoundError("conversation");
    return c.json(result, 200);
  });
}
