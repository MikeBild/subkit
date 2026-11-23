import {
  createRoute,
  type OpenAPIHono,
  type RouteConfigToTypedResponse,
  z,
} from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { isRejection, storeConversationAttachment } from "../../../api/index.ts";
import {
  type AppendMessageResult,
  appendUserMessage,
  type ConversationTurnOutcome,
  describeTurnFailure,
  humanChatAnswer,
  runConversationTurn,
  serializeEvent,
  type TurnEvent,
  turnFailureFramePayload,
} from "../../../conversations/public/authoring.ts";
import { PendingElicitationBlockedError } from "../../../conversations/public/elicitation.ts";
import {
  assertTaskRunWriter,
  clearConversationTurnFailure,
  conversationTurnId,
  getConversation,
  recordConversationTurnFailure,
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../../conversations/public/lifecycle.ts";
import { logger } from "../../../logging/index.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamTenantSSE as streamSSE } from "../../tenant-stream.ts";
import { conversationLocale } from "./locale.ts";
import {
  AppendMessageBody,
  buildRuntimeContextFromRequest,
  errorFrame,
  outcomeFrame,
  RunOutcomeSchema,
  serializeConversation,
  wantsSSE,
} from "./schemas.ts";

const appendRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/messages",
  tags: ["conversations"],
  summary: "Append a user message and drive another turn",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AppendMessageBody } } },
  },
  responses: {
    409: {
      description: "A response is running or a pending question must be answered",
      content: { "application/json": { schema: ErrorSchema } },
    },
    200: { description: "OK", content: { "application/json": { schema: RunOutcomeSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const UploadErrorSchema = z.object({ error: z.string() });

const UploadRunOutcomeSchema = RunOutcomeSchema.extend({
  attached_file_ids: z.array(z.string()),
}).openapi("ConversationUploadRunOutcome");

const uploadRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/messages/upload",
  tags: ["conversations"],
  summary: "Append a user message with file attachments and drive another turn",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: ["message"],
            properties: {
              message: { type: "string", description: "The user's message" },
              files: {
                type: "array",
                items: { type: "string", format: "binary" },
                description:
                  "Attached files (1-10); each stays a file of this conversation and never becomes team knowledge by itself",
              },
              memory: { type: "string", description: "Optional SUBKIT.md content" },
            },
          },
        },
      },
    },
  },
  responses: {
    409: {
      description: "A response is running or a pending question must be answered",
      content: { "application/json": { schema: ErrorSchema } },
    },
    200: {
      description: "OK",
      content: { "application/json": { schema: UploadRunOutcomeSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: UploadErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: UploadErrorSchema } },
    },
  },
});

export function registerMessagesRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(appendRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await assertTaskRunWriter(db, {
      tenant_id: principal.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
    });
    const turnAbortCtrl = await registerConversationAbort(principal.tenant_id, id, db);
    let ownershipTransferred = false;
    try {
      const appendParams = {
        turn_id: conversationTurnId(turnAbortCtrl),
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        principal,
        message: body.message,
        ...(body.references && body.references.length > 0 ? { references: body.references } : {}),
        ...(body.memory !== undefined ? { memory: body.memory } : {}),
      } as const;
      const runtimeContext = buildRuntimeContextFromRequest(c, principal);
      const driveTurn = (
        appended: AppendMessageResult,
        onEvent?: (ev: TurnEvent) => void,
      ): Promise<ConversationTurnOutcome> =>
        runConversationTurn(
          {
            tenant_id: principal.tenant_id,
            conversation_id: id,
            actor_id: principal.id,
            principal,
            locale: conversationLocale(c.req.header("cookie"), c.req.header("accept-language")),
            user_message: appended.message,
            ...(appended.references ? { user_references: appended.references } : {}),
            answer_actor: humanChatAnswer(principal),
            user_memory: appended.user_memory,
            turn_abort_ctrl: turnAbortCtrl,
            runtime_context: runtimeContext,
            ...(body.step_budget !== undefined ? { step_budget: body.step_budget } : {}),
            ...(body.client_suppress !== undefined
              ? { next_suggestion_suppress: body.client_suppress }
              : {}),
            ...(body.event ? { event: body.event } : {}),
            ...(onEvent ? { onEvent } : {}),
          },
          db,
        );

      if (wantsSSE(c.req.header("accept"))) {
        const response = streamSSE(c, async (stream) => {
          try {
            await clearConversationTurnFailure(db, principal.tenant_id, id).catch(() => {});
            const appended = await appendUserMessage(appendParams, db);
            const outcome = await driveTurn(appended, (ev: TurnEvent) => {
              void stream.writeSSE(serializeEvent(ev));
            });
            await unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
            await stream.writeSSE(outcomeFrame(outcome));
          } catch (error) {
            if (error instanceof PendingElicitationBlockedError) {
              await stream.writeSSE(
                errorFrame({
                  code: "pending_elicitation_blocked",
                  message: error.message,
                  details: {
                    conversation_status: "awaiting_input",
                    pending_elicitation: error.pending_elicitation,
                  },
                }),
              );
              return;
            }
            const failure = describeTurnFailure(error);
            await recordConversationTurnFailure(
              c.get("db"),
              principal.tenant_id,
              id,
              failure,
            ).catch(() => {});
            await stream.writeSSE(errorFrame(turnFailureFramePayload(failure)));
          } finally {
            await unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
          }
        }) as Response & RouteConfigToTypedResponse<typeof appendRoute>;
        ownershipTransferred = true;
        return response;
      }

      let outcome: ConversationTurnOutcome;
      try {
        const appended = await appendUserMessage(appendParams, db);
        outcome = await driveTurn(appended);
      } catch (error) {
        if (error instanceof PendingElicitationBlockedError) {
          throw new HttpError(409, "pending_elicitation_blocked", error.message, {
            details: {
              conversation_status: "awaiting_input",
              pending_elicitation: error.pending_elicitation,
            },
          });
        }
        throw error;
      }
      return c.json(serializeConversation(outcome), 200);
    } finally {
      if (!ownershipTransferred) {
        await unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
      }
    }
  });

  app.openapi(uploadRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");

    const formData = await c.req.formData();
    const message = formData.get("message");
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return c.json({ error: "message field is required" }, 400);
    }

    const memory = formData.get("memory");
    const files = formData.getAll("files");

    const conv = await getConversation(principal.tenant_id, id, db);
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    await assertTaskRunWriter(db, {
      tenant_id: principal.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
    });

    const turnAbortCtrl = await registerConversationAbort(principal.tenant_id, id, db);
    try {
      const attachedFileIds: string[] = [];
      const attachmentTokens: string[] = [];
      for (const file of files) {
        if (!(file instanceof File)) continue;
        const stored = await storeConversationAttachment(
          { db, tenant_id: principal.tenant_id, principal, request_source: "api" },
          id,
          {
            filename: file.name,
            ...(file.type ? { content_type: file.type } : {}),
            content_base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
          },
        );
        if (isRejection(stored)) {
          logger.warn({
            module: "conversations",
            action: "file_attachment.store_failed",
            msg: "a chat attachment could not be stored",
            filename: file.name,
            code: stored.code,
          });
          continue;
        }
        attachedFileIds.push(stored.id);
        attachmentTokens.push(`@attachment:${stored.slug}`);
      }

      const enrichedMessage =
        attachmentTokens.length > 0 ? `${message}\n\n${attachmentTokens.join(" ")}` : message;

      const appended = await appendUserMessage(
        {
          tenant_id: principal.tenant_id,
          conversation_id: id,
          actor_id: principal.id,
          principal,
          message: enrichedMessage,
          turn_id: conversationTurnId(turnAbortCtrl),
          ...(typeof memory === "string" && memory.length > 0 ? { memory } : {}),
        },
        db,
      );
      const outcome = await runConversationTurn(
        {
          tenant_id: principal.tenant_id,
          conversation_id: id,
          actor_id: principal.id,
          principal,
          locale: conversationLocale(c.req.header("cookie"), c.req.header("accept-language")),
          user_message: appended.message,
          answer_actor: humanChatAnswer(principal),
          user_memory: appended.user_memory,
          turn_abort_ctrl: turnAbortCtrl,
          runtime_context: buildRuntimeContextFromRequest(c, principal),
        },
        db,
      );

      const serialized = serializeConversation(outcome);
      return c.json({ ...serialized, attached_file_ids: attachedFileIds }, 200);
    } finally {
      await unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
    }
  });
}
