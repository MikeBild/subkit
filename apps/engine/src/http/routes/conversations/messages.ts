import {
  createRoute,
  type OpenAPIHono,
  type RouteConfigToTypedResponse,
  z,
} from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { actorOf } from "../../../audit/index.ts";
import type { TurnEvent } from "../../../conversations/index.ts";
import * as svc from "../../../conversations/index.ts";
import {
  humanChatAnswer,
  registerConversationAbort,
  serializeEvent,
  unregisterConversationAbort,
} from "../../../conversations/index.ts";
import { analyzeKnowledgeSource, createKnowledgeSource } from "../../../knowledge/index.ts";
import { logger } from "../../../logging/index.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamTenantSSE as streamSSE } from "../../tenant-stream.ts";
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
    200: { description: "OK", content: { "application/json": { schema: RunOutcomeSchema } } },
    409: { description: "Pending input", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const UploadErrorSchema = z.object({ error: z.string() });

export const UploadRunOutcomeSchema = RunOutcomeSchema.extend({
  ingested_knowledge_source_ids: z.array(z.string()),
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
                  "Attached files (1-10); each is auto-ingested as a Knowledge Source scoped to the conversation's target workflow (or global)",
              },
              memory: { type: "string", description: "Optional SUBKIT.md content" },
            },
          },
        },
      },
    },
  },
  responses: {
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
    const turnAbortCtrl = registerConversationAbort(principal.tenant_id, id);
    let ownershipTransferred = false;
    try {
      const appendParams = {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        principal,
        message: body.message,
        ...(body.references && body.references.length > 0 ? { references: body.references } : {}),
        ...(body.memory !== undefined ? { memory: body.memory } : {}),
        ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
      } as const;
      const runtimeContext = buildRuntimeContextFromRequest(c, principal);
      const driveTurn = (
        appended: svc.AppendMessageResult,
        onEvent?: (ev: TurnEvent) => void,
      ): Promise<svc.ConversationTurnOutcome> =>
        svc.runConversationTurn(
          {
            tenant_id: principal.tenant_id,
            conversation_id: id,
            actor_id: principal.id,
            principal,
            user_message: appended.message,
            ...(appended.references ? { user_references: appended.references } : {}),
            answer_actor: humanChatAnswer(principal),
            user_memory: appended.user_memory,
            turn_abort_ctrl: turnAbortCtrl,
            runtime_context: runtimeContext,
            ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
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
            await svc.clearConversationTurnFailure(db, principal.tenant_id, id).catch(() => {});
            const appended = await svc.appendUserMessage(appendParams, db);
            const outcome = await driveTurn(appended, (ev: TurnEvent) => {
              void stream.writeSSE(serializeEvent(ev));
            });
            await stream.writeSSE(outcomeFrame(outcome));
          } catch (error) {
            if (error instanceof svc.PendingElicitationBlockedError) {
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
            const failure = svc.describeTurnFailure(error);
            await svc
              .recordConversationTurnFailure(c.get("db"), principal.tenant_id, id, failure)
              .catch(() => {});
            await stream.writeSSE(errorFrame(svc.turnFailureFramePayload(failure)));
          } finally {
            unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
          }
        }) as Response & RouteConfigToTypedResponse<typeof appendRoute>;
        ownershipTransferred = true;
        return response;
      }

      let outcome: svc.ConversationTurnOutcome;
      try {
        const appended = await svc.appendUserMessage(appendParams, db);
        outcome = await driveTurn(appended);
      } catch (error) {
        if (error instanceof svc.PendingElicitationBlockedError) {
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
        unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
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

    const conv = await svc.getConversation(principal.tenant_id, id, db);
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const targetWorkflowId = conv.conversation.target_workflow_id;

    const ingestedSources: string[] = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const source = await createKnowledgeSource(
          {
            tenant_id: principal.tenant_id,
            input: {
              name: file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
              scope: targetWorkflowId ? "workflow" : "global",
              ...(targetWorkflowId ? { workflow_id: targetWorkflowId } : {}),
            },
            upload: {
              buffer,
              filename: file.name,
              ...(file.type ? { mime: file.type } : {}),
            },
            actor: actorOf(principal),
          },
          db,
        );
        ingestedSources.push(source.id);
        if (source.description === null || source.tags.length === 0) {
          try {
            await analyzeKnowledgeSource(
              {
                tenant_id: principal.tenant_id,
                id: source.id,
                actor_id: principal.id,
                actor: actorOf(principal),
              },
              db,
            );
          } catch (enrichErr) {
            logger.warn({
              module: "conversations",
              action: "file_attachment.analyze_skipped",
              msg: `Failed to auto-analyze knowledge source: ${source.id}`,
              error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
              knowledge_source_id: source.id,
            });
          }
        }
      } catch (err) {
        logger.warn({
          module: "conversations",
          action: "file_attachment.ingest_failed",
          msg: `Failed to ingest file attachment: ${file.name}`,
          error: err instanceof Error ? err.message : String(err),
          filename: file.name,
        });
      }
    }

    const enrichedMessage =
      ingestedSources.length > 0
        ? `${message}\n\n[Attached ${ingestedSources.length} file(s) as knowledge sources]`
        : message;

    const turnAbortCtrl = registerConversationAbort(principal.tenant_id, id);
    try {
      const appended = await svc.appendUserMessage(
        {
          tenant_id: principal.tenant_id,
          conversation_id: id,
          actor_id: principal.id,
          principal,
          message: enrichedMessage,
          ...(typeof memory === "string" && memory.length > 0 ? { memory } : {}),
        },
        db,
      );
      const outcome = await svc.runConversationTurn(
        {
          tenant_id: principal.tenant_id,
          conversation_id: id,
          actor_id: principal.id,
          principal,
          user_message: appended.message,
          answer_actor: humanChatAnswer(principal),
          user_memory: appended.user_memory,
          turn_abort_ctrl: turnAbortCtrl,
          runtime_context: buildRuntimeContextFromRequest(c, principal),
        },
        db,
      );

      const serialized = serializeConversation(outcome);
      return c.json({ ...serialized, ingested_knowledge_source_ids: ingestedSources }, 200);
    } finally {
      unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
    }
  });
}
