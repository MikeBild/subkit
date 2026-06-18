// Collection-level conversation endpoints:
//   GET    /v1/conversations              — list
//   POST   /v1/conversations              — create (+ optional SSE turn)
//   GET    /v1/conversations/{id}         — fetch detail
//   PATCH  /v1/conversations/{id}         — patch metadata

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import type { ConversationStatus, TurnEvent } from "../../../conversations/index.ts";
import * as svc from "../../../conversations/index.ts";
import {
  buildMessagesV2,
  registerConversationAbort,
  serializeEvent,
  unregisterConversationAbort,
} from "../../../conversations/index.ts";
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
    const createParams = {
      tenant_id: principal.tenant_id,
      actor_id: principal.id,
      ...(body.connector_id ? { connector_id: body.connector_id } : {}),
      ...(body.workflow_id ? { workflow_id: body.workflow_id } : {}),
      ...(body.initial_message ? { initial_message: body.initial_message } : {}),
      ...(body.memory !== undefined ? { memory: body.memory } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
    } as const;
    const runtimeContext = buildRuntimeContextFromRequest(c, principal);

    // Conversation create is a two-step split: `createConversation`
    // inserts the row + persists the first user-message row, then
    // `runConversationTurn` drives the model loop. The HTTP route runs
    // both inline so the SSE streaming surface keeps working; the MCP
    // async-Tasks path runs the turn in a background worker instead.
    const driveTurn = async (
      created: svc.CreateConversationResult,
      onEvent?: (ev: TurnEvent) => void,
    ): Promise<svc.ConversationTurnOutcome> => {
      // Register the AbortController on the synchronous frame right
      // after the row insert; unregister in `finally` so the
      // registry slot is released on every code path.
      const turnAbortCtrl = registerConversationAbort(principal.tenant_id, created.conversation.id);
      try {
        return await svc.runConversationTurn(
          {
            tenant_id: principal.tenant_id,
            conversation_id: created.conversation.id,
            actor_id: principal.id,
            principal,
            user_message: created.initial_message ?? "",
            user_memory: created.user_memory,
            turn_abort_ctrl: turnAbortCtrl,
            runtime_context: runtimeContext,
            ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
            ...(body.step_budget !== undefined ? { step_budget: body.step_budget } : {}),
            ...(onEvent ? { onEvent } : {}),
          },
          db,
        );
      } finally {
        unregisterConversationAbort(principal.tenant_id, created.conversation.id, turnAbortCtrl);
      }
    };

    if (wantsSSE(c.req.header("accept"))) {
      // streamSSE returns plain Response; the openapi handler signature
      // wants a TypedResponse derived from the JSON schema. Cast — the
      // runtime is correct, and the OpenAPI doc still describes the
      // JSON branch faithfully (clients without `Accept: text/event-stream`
      // never see the SSE wire). Mirrors the hand-rolled `/stream`
      // replay route below that bypasses openapi for the same reason.
      return streamSSE(c, async (stream) => {
        try {
          const created = await svc.createConversation(createParams, db);
          // Emit the `conversation_started` frame as soon as the row
          // exists so the client learns the conversation_id before the
          // turn finishes.
          await stream.writeSSE({
            event: "conversation_started",
            data: JSON.stringify({ conversation: created.conversation }),
          });
          if (!created.initial_message) {
            await stream.writeSSE(
              outcomeFrame({
                conversation: created.conversation,
                result: { events: [], status: "active" },
              }),
            );
            return;
          }
          const outcome = await driveTurn(created, (ev: TurnEvent) => {
            void stream.writeSSE(serializeEvent(ev));
          });
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

    const created = await svc.createConversation(createParams, db);
    if (!created.initial_message) {
      return c.json(
        serializeConversation({
          conversation: created.conversation,
          result: { events: [], status: "active" },
        }),
        201,
      );
    }
    const outcome = await driveTurn(created);
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
