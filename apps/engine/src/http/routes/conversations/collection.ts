import { createRoute, type OpenAPIHono, type RouteConfigToTypedResponse } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { conversationCollectionOperations } from "../../../api/operations/conversation-collection.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { principalOrigin } from "../../../auth/index.ts";
import {
  type ConversationTurnOutcome,
  type CreateConversationResult,
  createConversation,
  describeTurnFailure,
  humanChatAnswer,
  loadFocusExecution,
  runConversationTurn,
  serializeEvent,
  surfaceFromClientHeader,
  type TurnEvent,
  turnFailureFramePayload,
} from "../../../conversations/public/authoring.ts";
import {
  buildMessages,
  countConversations,
  getConversation,
  isConversationHiddenFor,
  listConversations,
  patchConversation,
  readConversationUsage,
  recordConversationTurnFailure,
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../../conversations/public/lifecycle.ts";
import * as intake from "../../../knowledge/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { ensurePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamTenantSSE as streamSSE } from "../../tenant-stream.ts";
import { conversationLocale } from "./locale.ts";
import {
  buildRuntimeContextFromRequest,
  CreateBody,
  errorFrame,
  outcomeFrame,
  RunOutcomeSchema,
  serializeConversation,
  wantsSSE,
} from "./schemas.ts";

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

export function registerCollectionRoutes(app: OpenAPIHono<AppEnv>): void {
  const operations = conversationCollectionOperations({
    buildMessages,
    countConversations,
    getConversation,
    isConversationHiddenFor,
    listConversations,
    patchConversation,
    readConversationUsage,
  });
  toHonoRoute(app, operations.list);

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const referencedIntakeItemIds = body.references
      ?.filter((reference) => reference.type === "intake_item")
      .map((reference) => reference.id);
    const intakeItemIds = [
      ...new Set([...(body.intake_item_ids ?? []), ...(referencedIntakeItemIds ?? [])]),
    ];
    if (intakeItemIds.length) {
      await ensurePermission(c, "intake:read", undefined);
      const visible = await Promise.all(
        intakeItemIds.map((id) => intake.getIntakeItem(principal.tenant_id, id, db)),
      );
      if (visible.some((item) => item === null)) throw new NotFoundError("intake_item");
    }
    if (body.execution_id)
      await ensurePermission(c, "execution:read", { type: "execution", id: body.execution_id });
    const focus = body.execution_id
      ? await loadFocusExecution(principal.tenant_id, body.execution_id, db, principal)
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
      ...(body.playbook_mode ? { playbook_mode: body.playbook_mode } : {}),
      ...(body.playground ? { playground: body.playground } : {}),
      ...(intakeItemIds.length ? { intake_item_ids: intakeItemIds } : {}),
      ...(body.references && body.references.length > 0 ? { references: body.references } : {}),
      origin_client: principalOrigin(principal),
      surface: surfaceFromClientHeader(c.req.header("x-subkit-client")),
    } as const;
    const runtimeContext = buildRuntimeContextFromRequest(c, principal);

    const driveTurn = async (
      created: CreateConversationResult,
      onEvent?: (ev: TurnEvent) => void,
    ): Promise<ConversationTurnOutcome> => {
      const turnAbortCtrl = await registerConversationAbort(
        principal.tenant_id,
        created.conversation.id,
        db,
      );
      try {
        return await runConversationTurn(
          {
            tenant_id: principal.tenant_id,
            conversation_id: created.conversation.id,
            actor_id: principal.id,
            principal,
            locale: conversationLocale(c.req.header("cookie"), c.req.header("accept-language")),
            user_message: created.initial_message ?? "",
            ...(created.references ? { user_references: created.references } : {}),
            answer_actor: humanChatAnswer(principal),
            user_memory: created.user_memory,
            turn_abort_ctrl: turnAbortCtrl,
            runtime_context: runtimeContext,
            ...(body.step_budget !== undefined ? { step_budget: body.step_budget } : {}),
            ...(onEvent ? { onEvent } : {}),
          },
          db,
        );
      } finally {
        await unregisterConversationAbort(
          principal.tenant_id,
          created.conversation.id,
          turnAbortCtrl,
        );
      }
    };

    if (wantsSSE(c.req.header("accept"))) {
      return streamSSE(c, async (stream) => {
        let createdId: string | null = null;
        try {
          const created = await createConversation(createParams, db);
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
          const failure = describeTurnFailure(error);
          if (createdId) {
            await recordConversationTurnFailure(db, principal.tenant_id, createdId, failure).catch(
              () => {},
            );
          }
          await stream.writeSSE(errorFrame(turnFailureFramePayload(failure)));
        }
      }) as Response & RouteConfigToTypedResponse<typeof createRouteSpec>;
    }

    const created = await createConversation(createParams, db);
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

  toHonoRoute(app, operations.detail);
  toHonoRoute(app, operations.patch);
}
