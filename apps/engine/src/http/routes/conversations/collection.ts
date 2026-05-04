// Collection-level conversation endpoints:
//   GET    /v1/conversations              — list
//   POST   /v1/conversations              — create (+ optional SSE turn)
//   GET    /v1/conversations/{id}         — fetch detail
//   PATCH  /v1/conversations/{id}         — patch metadata

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { buildMessagesV2 } from "../../../conversations/parts.ts";
import * as svc from "../../../conversations/service.ts";
import { serializeEvent } from "../../../conversations/streaming.ts";
import type { ConversationStatus, TurnEvent } from "../../../conversations/types.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  buildRuntimeContextFromRequest,
  ConversationDetailSchema,
  ConversationListResponse,
  ConversationSchema,
  CreateBody,
  errorFrame,
  outcomeFrame,
  PatchConversationBody,
  RunOutcomeSchema,
  serializeConversation,
  wantsSSE,
} from "./schemas.ts";

const listRoute = createRoute({
  method: "get",
  path: "/v1/conversations",
  tags: ["conversations"],
  summary: "List conversations",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        status: z.enum(["active", "awaiting_input", "committed", "abandoned"]).optional(),
        /**
         * When `me`, restrict to conversations owned by the calling
         * principal (conversations.owner_id). Other values are
         * reserved and rejected.
         */
        owner: z.literal("me").optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListConversationsQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationListResponse } },
    },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/conversations",
  tags: ["conversations"],
  summary: "Create a conversation",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: RunOutcomeSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRouteSpec = createRoute({
  method: "get",
  path: "/v1/conversations/{id}",
  tags: ["conversations"],
  summary: "Fetch a conversation with messages, tool calls, and draft",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationDetailSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/v1/conversations/{id}",
  tags: ["conversations"],
  summary: "Patch conversation metadata (model, title)",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: PatchConversationBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConversationSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerCollectionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const items = await svc.listConversations(
      {
        tenant_id: principal.tenant_id,
        ...(q.status ? { status: q.status as ConversationStatus } : {}),
        ...(q.owner === "me" ? { owner_id: principal.id } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const baseParams = {
      tenant_id: principal.tenant_id,
      actor_id: principal.id,
      ...(body.connector_id ? { connector_id: body.connector_id } : {}),
      ...(body.workflow_id ? { workflow_id: body.workflow_id } : {}),
      ...(body.initial_message ? { initial_message: body.initial_message } : {}),
      ...(body.memory !== undefined ? { memory: body.memory } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
      runtime_context: buildRuntimeContextFromRequest(c, principal),
    } as const;

    if (wantsSSE(c.req.header("accept"))) {
      // streamSSE returns plain Response; the openapi handler signature
      // wants a TypedResponse derived from the JSON schema. Cast — the
      // runtime is correct, and the OpenAPI doc still describes the
      // JSON branch faithfully (clients without `Accept: text/event-stream`
      // never see the SSE wire). Mirrors the hand-rolled `/stream`
      // replay route below that bypasses openapi for the same reason.
      return streamSSE(c, async (stream) => {
        try {
          const outcome = await svc.createConversation(
            {
              ...baseParams,
              onCreated: (record) => {
                void stream.writeSSE({
                  event: "conversation_started",
                  data: JSON.stringify({ conversation: record }),
                });
              },
              onEvent: (ev: TurnEvent) => {
                void stream.writeSSE(serializeEvent(ev));
              },
            },
            db,
          );
          await stream.writeSSE(outcomeFrame(outcome));
        } catch (error) {
          const err = error as Error;
          await stream.writeSSE(
            errorFrame({
              code: "internal",
              message: err?.message ?? "internal_error",
            }),
          );
        }
        // biome-ignore lint/suspicious/noExplicitAny: see comment above.
      }) as any;
    }

    const outcome = await svc.createConversation(baseParams, db);
    return c.json(serializeConversation(outcome), 201);
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const detail = await svc.getConversation(principal.tenant_id, id, db);
    if (!detail) throw new NotFoundError("conversation");
    const messages = buildMessagesV2(detail.messages, detail.tool_calls);
    return c.json(
      {
        conversation: detail.conversation,
        messages,
        tool_calls: detail.tool_calls,
        draft: detail.draft,
        ...(detail.resume_summary ? { resume_summary: detail.resume_summary } : {}),
      },
      200,
    );
  });

  app.openapi(patchRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await svc.patchConversation(
      {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
      },
      db,
    );
    if (!row) throw new NotFoundError("conversation");
    return c.json(row, 200);
  });
}
