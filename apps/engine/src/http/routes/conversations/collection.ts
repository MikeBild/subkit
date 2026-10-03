// Collection-level conversation endpoints:
//   GET    /v1/conversations              — list
//   POST   /v1/conversations              — create (+ optional SSE turn)
//   GET    /v1/conversations/{id}         — fetch detail
//   PATCH  /v1/conversations/{id}         — patch metadata

import {
  createRoute,
  type OpenAPIHono,
  type RouteConfigToTypedResponse,
  z,
} from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { principalOrigin } from "../../../auth/index.ts";
import type { ConversationStatus, TurnEvent } from "../../../conversations/index.ts";
import * as svc from "../../../conversations/index.ts";
import {
  buildMessagesV2,
  humanChatAnswer,
  registerConversationAbort,
  serializeEvent,
  surfaceFromClientHeader,
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
        /** `exclude` (default) keeps conversations the caller hid out of the list. */
        hidden: z.enum(["exclude", "only", "all"]).optional(),
        /** Only conversations owned by people, or only by machine accounts. */
        owner_kind: z.enum(["user", "system_account"]).optional(),
        target_workflow_id: z.string().uuid().optional(),
        target_connector_id: z.string().uuid().optional(),
        q: z.string().min(1).max(200).optional(),
        sort: z.enum(["title", "status", "created_at", "updated_at"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
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
    const params = {
      tenant_id: principal.tenant_id,
      ...(q.status ? { status: q.status as ConversationStatus } : {}),
      ...(q.owner === "me" ? { owner_id: principal.id } : {}),
      // The hide mark is the caller's own: only a person's list has one.
      ...(principal.kind === "user" ? { viewer_user_id: principal.id } : {}),
      ...(q.hidden ? { hidden: q.hidden } : {}),
      ...(q.owner_kind ? { owner_kind: q.owner_kind } : {}),
      ...(q.target_workflow_id ? { target_workflow_id: q.target_workflow_id } : {}),
      ...(q.target_connector_id ? { target_connector_id: q.target_connector_id } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.sort ? { sort: q.sort } : {}),
      ...(q.order ? { order: q.order } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.offset !== undefined ? { offset: q.offset } : {}),
    };
    const [items, total] = await Promise.all([
      svc.listConversations(params, db),
      svc.countConversations(params, db),
    ]);
    return c.json({ items, total }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const createParams = {
      tenant_id: principal.tenant_id,
      actor_id: principal.id,
      principal,
      ...(body.connector_id ? { connector_id: body.connector_id } : {}),
      ...(body.workflow_id ? { workflow_id: body.workflow_id } : {}),
      ...(body.initial_message ? { initial_message: body.initial_message } : {}),
      ...(body.memory !== undefined ? { memory: body.memory } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
      ...(body.playground ? { playground: body.playground } : {}),
      ...(body.references && body.references.length > 0 ? { references: body.references } : {}),
      origin_client: principalOrigin(principal),
      surface: surfaceFromClientHeader(c.req.header("x-subkit-client")),
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
            ...(created.references ? { user_references: created.references } : {}),
            answer_actor: humanChatAnswer(principal),
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
        let createdId: string | null = null;
        try {
          const created = await svc.createConversation(createParams, db);
          createdId = created.conversation.id;
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
          const failure = svc.describeTurnFailure(error);
          // The first turn fails like any later one: the conversation exists
          // and holds the request, so it keeps why the turn died. Without
          // this a reload — or a client that lost the stream — showed a
          // conversation that looked as if it were still thinking.
          if (createdId) {
            await svc
              .recordConversationTurnFailure(db, principal.tenant_id, createdId, failure)
              .catch(() => {});
          }
          await stream.writeSSE(errorFrame(svc.turnFailureFramePayload(failure)));
        }
      }) as Response & RouteConfigToTypedResponse<typeof createRouteSpec>;
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
    const usage = await svc.readConversationUsage(db, principal.tenant_id, id);
    return c.json(
      {
        conversation: detail.conversation,
        owner: detail.owner,
        created_resources: detail.created_resources,
        messages,
        tool_calls: detail.tool_calls,
        draft: detail.draft,
        ...(detail.resume_summary ? { resume_summary: detail.resume_summary } : {}),
        usage,
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
