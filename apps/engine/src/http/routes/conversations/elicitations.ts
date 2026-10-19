import { createRoute, type OpenAPIHono, type RouteConfigToTypedResponse } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import * as svc from "../../../conversations/index.ts";
import {
  humanChatAnswer,
  registerConversationAbort,
  serializeEvent,
  unregisterConversationAbort,
} from "../../../conversations/index.ts";
import { HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamTenantSSE as streamSSE } from "../../tenant-stream.ts";
import {
  ElicitationParam,
  errorFrame,
  outcomeFrame,
  RespondElicitationBody,
  RunOutcomeSchema,
  serializeConversation,
  ToolCallRespondParam,
  wantsSSE,
} from "./schemas.ts";

const respondElicitationRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/elicitations/{elicitation_id}/respond",
  tags: ["conversations"],
  summary: "Resolve a pending ask_user_* elicitation with the user's answer",
  security: [{ bearerAuth: [] }],
  request: {
    params: ElicitationParam,
    body: { content: { "application/json": { schema: RespondElicitationBody } } },
  },
  responses: {
    409: {
      description: "A response is already running for this conversation",
      content: { "application/json": { schema: ErrorSchema } },
    },
    200: { description: "OK", content: { "application/json": { schema: RunOutcomeSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description:
        "Answer failed validation against the originating ask_user_* input — the elicitation stays pending; fix the flagged fields (details.field_errors) and re-submit",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const respondByToolCallRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/tool-calls/{tool_call_id}/respond",
  tags: ["conversations"],
  summary:
    "Resolve the pending ask_user_* elicitation linked to the given tool_call (resumeToolCallId alias)",
  security: [{ bearerAuth: [] }],
  request: {
    params: ToolCallRespondParam,
    body: { content: { "application/json": { schema: RespondElicitationBody } } },
  },
  responses: {
    409: {
      description: "A response is already running for this conversation",
      content: { "application/json": { schema: ErrorSchema } },
    },
    200: { description: "OK", content: { "application/json": { schema: RunOutcomeSchema } } },
    404: {
      description: "Not found — no elicitation links to that tool_call",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description:
        "Answer failed validation against the originating ask_user_* input — the elicitation stays pending; fix the flagged fields (details.field_errors) and re-submit",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerElicitationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(respondElicitationRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, elicitation_id } = c.req.valid("param");
    const body = c.req.valid("json");
    const turnAbortCtrl = await registerConversationAbort(principal.tenant_id, id, db);
    let ownershipTransferred = false;
    try {
      const baseParams = {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        elicitation_id,
        actor_id: principal.id,
        principal,
        answer_actor: humanChatAnswer(principal),
        output: body.output,
        turn_abort_ctrl: turnAbortCtrl,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
      } as const;

      if (wantsSSE(c.req.header("accept"))) {
        const response = streamSSE(c, async (stream) => {
          try {
            await svc.clearConversationTurnFailure(db, principal.tenant_id, id).catch(() => {});
            const outcome = await svc.respondElicitation(
              {
                ...baseParams,
                onEvent: (ev) => {
                  void stream.writeSSE(serializeEvent(ev));
                },
              },
              db,
            );
            await unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
            await stream.writeSSE(outcomeFrame(outcome));
          } catch (error) {
            if (error instanceof svc.ElicitationAlreadyResolvedError) {
              await stream.writeSSE(
                errorFrame({
                  code: "elicitation_already_resolved",
                  message: error.message,
                }),
              );
              return;
            }
            if (error instanceof svc.ElicitationValidationError) {
              await stream.writeSSE(
                errorFrame({
                  code: "elicitation_validation_failed",
                  message: error.message,
                  details: {
                    field_errors: error.field_errors,
                    pending_elicitation: error.pending_elicitation,
                  },
                }),
              );
              return;
            }
            const failure = svc.describeTurnFailure(error);
            await svc
              .recordConversationTurnFailure(db, principal.tenant_id, id, failure)
              .catch(() => {});
            await stream.writeSSE(errorFrame(svc.turnFailureFramePayload(failure)));
          } finally {
            await unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
          }
        }) as Response & RouteConfigToTypedResponse<typeof respondElicitationRoute>;
        ownershipTransferred = true;
        return response;
      }

      let outcome: Awaited<ReturnType<typeof svc.respondElicitation>>;
      try {
        outcome = await svc.respondElicitation(baseParams, db);
      } catch (error) {
        if (error instanceof svc.ElicitationAlreadyResolvedError) {
          throw new HttpError(409, "elicitation_already_resolved", error.message, {
            details: {
              elicitation_id: error.elicitation_id,
              previous_status: error.status,
              previous_output: error.previous_output,
              previous_decision_reason: error.previous_decision_reason,
            },
          });
        }
        if (error instanceof svc.ElicitationValidationError) {
          throw new HttpError(422, "elicitation_validation_failed", error.message, {
            details: {
              elicitation_id: error.elicitation_id,
              field_errors: error.field_errors,
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

  app.openapi(respondByToolCallRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, tool_call_id } = c.req.valid("param");
    const body = c.req.valid("json");
    const { getPendingElicitationByToolCall } = await import(
      "../../../conversations/elicitations.ts"
    );
    const elicit = await getPendingElicitationByToolCall(principal.tenant_id, id, tool_call_id, db);
    if (!elicit) {
      throw new NotFoundError("elicitation_for_tool_call");
    }
    const turnAbortCtrl = await registerConversationAbort(principal.tenant_id, id, db);
    let ownershipTransferred = false;
    try {
      const baseParams = {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        elicitation_id: elicit.id,
        actor_id: principal.id,
        principal,
        answer_actor: humanChatAnswer(principal),
        output: body.output,
        turn_abort_ctrl: turnAbortCtrl,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
      } as const;

      if (wantsSSE(c.req.header("accept"))) {
        const response = streamSSE(c, async (stream) => {
          try {
            await svc.clearConversationTurnFailure(db, principal.tenant_id, id).catch(() => {});
            const outcome = await svc.respondElicitation(
              {
                ...baseParams,
                onEvent: (ev) => {
                  void stream.writeSSE(serializeEvent(ev));
                },
              },
              db,
            );
            await unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
            await stream.writeSSE(outcomeFrame(outcome));
          } catch (error) {
            if (error instanceof svc.ElicitationAlreadyResolvedError) {
              await stream.writeSSE(
                errorFrame({
                  code: "elicitation_already_resolved",
                  message: error.message,
                }),
              );
              return;
            }
            if (error instanceof svc.ElicitationValidationError) {
              await stream.writeSSE(
                errorFrame({
                  code: "elicitation_validation_failed",
                  message: error.message,
                  details: {
                    field_errors: error.field_errors,
                    pending_elicitation: error.pending_elicitation,
                  },
                }),
              );
              return;
            }
            const failure = svc.describeTurnFailure(error);
            await svc
              .recordConversationTurnFailure(db, principal.tenant_id, id, failure)
              .catch(() => {});
            await stream.writeSSE(errorFrame(svc.turnFailureFramePayload(failure)));
          } finally {
            await unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
          }
        }) as Response & RouteConfigToTypedResponse<typeof respondByToolCallRoute>;
        ownershipTransferred = true;
        return response;
      }

      let outcome: Awaited<ReturnType<typeof svc.respondElicitation>>;
      try {
        outcome = await svc.respondElicitation(baseParams, db);
      } catch (error) {
        if (error instanceof svc.ElicitationAlreadyResolvedError) {
          throw new HttpError(409, "elicitation_already_resolved", error.message, {
            details: {
              elicitation_id: error.elicitation_id,
              previous_status: error.status,
              previous_output: error.previous_output,
              previous_decision_reason: error.previous_decision_reason,
            },
          });
        }
        if (error instanceof svc.ElicitationValidationError) {
          throw new HttpError(422, "elicitation_validation_failed", error.message, {
            details: {
              elicitation_id: error.elicitation_id,
              field_errors: error.field_errors,
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
}
