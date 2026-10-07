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
  buildMessages,
  humanChatAnswer,
  registerConversationAbort,
  serializeEvent,
  surfaceFromClientHeader,
  unregisterConversationAbort,
} from "../../../conversations/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { ensurePermission } from "../../middleware/require-permission.ts";
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
        owner: z.literal("me").optional(),
        hidden: z.enum(["exclude", "only", "all"]).optional(),
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
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
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
    if (body.execution_id)
      await ensurePermission(c, "execution:read", { type: "execution", id: body.execution_id });
    const focus = body.execution_id
      ? await svc.loadFocusExecution(principal.tenant_id, body.execution_id, db, principal)
      : null;
    if (body.execution_id && !focus) throw new NotFoundError("execution");
    if (focus && body.workflow_id && focus.workflow_id !== body.workflow_id) {
      throw new BadRequestError("execution_id belongs to a different workflow than workflow_id", {
        execution_id: focus.execution_id,
        execution_workflow_id: focus.workflow_id,
        workflow_id: body.workflow_id,
      });
    }
    const createParams = {
      tenant_id: principal.tenant_id,
      actor_id: principal.id,
      principal,
      ...(body.connector_id ? { connector_id: body.connector_id } : {}),
      ...(body.workflow_id ? { workflow_id: body.workflow_id } : {}),
      ...(focus ? { focus_execution: focus } : {}),
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

    const driveTurn = async (
      created: svc.CreateConversationResult,
      onEvent?: (ev: TurnEvent) => void,
    ): Promise<svc.ConversationTurnOutcome> => {
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
      return streamSSE(c, async (stream) => {
        let createdId: string | null = null;
        try {
          const created = await svc.createConversation(createParams, db);
          createdId = created.conversation.id;
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
    const messages = buildMessages(detail.messages, detail.tool_calls);
    const usage = await svc.readConversationUsage(db, principal.tenant_id, id);
    const hidden =
      principal.kind === "user"
        ? await svc.isConversationHiddenFor(
            { tenant_id: principal.tenant_id, conversation_id: id, user_id: principal.id },
            db,
          )
        : false;
    return c.json(
      {
        conversation: { ...detail.conversation, hidden },
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
