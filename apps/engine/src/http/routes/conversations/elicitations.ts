// Elicitation-resolution endpoints. Both routes resolve a pending
// `ask_user_*` elicitation; the second route resumes by tool_call_id
// (alias for clients that tracked the originating tool call).
//
//   POST /v1/conversations/{id}/elicitations/{elicitation_id}/respond
//   POST /v1/conversations/{id}/tool-calls/{tool_call_id}/respond

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import * as svc from "../../../conversations/index.ts";
import {
  registerConversationAbort,
  serializeEvent,
  unregisterConversationAbort,
} from "../../../conversations/index.ts";
import { HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
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
    200: { description: "OK", content: { "application/json": { schema: RunOutcomeSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description:
        "Answer failed validation against the originating ask_user_* input — the elicitation stays pending; fix the flagged fields (details.field_errors) and re-submit",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// Resume by tool_call_id alias — mirrors the reference impl's
// `resumeToolCallId` chat parameter. Looks up the active elicitation
// linked to the given tool_call and resolves it with the same body
// shape as the canonical `/elicitations/:elicitation_id/respond`
// route. Lets clients that tracked the originating tool_call_id
// resume without a separate elicitation_id round-trip.
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
    // Register synchronously on request-accept so
    // a cancel arriving in the first ~40ms always finds a controller.
    // SSE branch transfers ownership to its inner `finally` (Hono's
    // `streamSSE` does not await its callback); non-SSE branch keeps
    // the outer `finally`. Same pattern as `messages.ts`.
    const turnAbortCtrl = registerConversationAbort(principal.tenant_id, id);
    let ownershipTransferred = false;
    try {
      const baseParams = {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        elicitation_id,
        actor_id: principal.id,
        // Thread the authenticated principal so the resumed turn can run
        // a workflow under RBAC. Without it `run_workflow` hits
        // `principal_required` and the loop guard blocks after 3 retries
        // (root cause of the `run_workflow.no_principal` warn floods).
        principal,
        output: body.output,
        turn_abort_ctrl: turnAbortCtrl,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
      } as const;

      // SSE branch — when the CLI sends `Accept: text/event-stream`,
      // stream every TurnEvent the resumed runLoop produces in real
      // time. Pre-fix this route was JSON-only, so an elicit response
      // that triggered a 1–2 minute LLM turn left the operator staring
      // at a `summarising N tool results · 1m43s` spinner with no
      // incremental progress until the buffered JSON came back.
      // Mirrors the SSE branch on `/messages`.
      if (wantsSSE(c.req.header("accept"))) {
        const response = streamSSE(c, async (stream) => {
          try {
            const outcome = await svc.respondElicitation(
              {
                ...baseParams,
                onEvent: (ev) => {
                  void stream.writeSSE(serializeEvent(ev));
                },
              },
              db,
            );
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
              // Row stays pending — the client re-renders the prompt with
              // the field errors and re-submits against the same id.
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
            const err = error as Error;
            await stream.writeSSE(
              errorFrame({
                code: "internal",
                message: err?.message ?? "internal_error",
              }),
            );
          } finally {
            unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
          }
          // biome-ignore lint/suspicious/noExplicitAny: streamSSE returns a plain Response; the openapi handler wants the typed shape.
        }) as any;
        ownershipTransferred = true;
        return response;
      }

      let outcome: Awaited<ReturnType<typeof svc.respondElicitation>>;
      try {
        outcome = await svc.respondElicitation(baseParams, db);
      } catch (error) {
        if (error instanceof svc.ElicitationAlreadyResolvedError) {
          throw new HttpError(409, "elicitation_already_resolved", error.message, {
            elicitation_id: error.elicitation_id,
            previous_status: error.status,
            previous_output: error.previous_output,
            previous_decision_reason: error.previous_decision_reason,
          });
        }
        if (error instanceof svc.ElicitationValidationError) {
          // Row stays pending — 422 carries the per-field errors plus the
          // original prompt (with error pins merged) so the client
          // re-renders the same dialog and re-submits.
          throw new HttpError(422, "elicitation_validation_failed", error.message, {
            elicitation_id: error.elicitation_id,
            field_errors: error.field_errors,
            pending_elicitation: error.pending_elicitation,
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

  // Resume-by-tool-call alias. Resolves tool_call_id → elicitation_id
  // by reading the active row, then delegates to the same service
  // handler the canonical route uses. Mirrors the reference impl's
  // `resumeToolCallId` chat parameter while keeping the
  // elicitation-id-based wire shape as the canonical resume key.
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
    // Same sync-register pattern as the canonical route above.
    const turnAbortCtrl = registerConversationAbort(principal.tenant_id, id);
    let ownershipTransferred = false;
    try {
      const baseParams = {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        elicitation_id: elicit.id,
        actor_id: principal.id,
        output: body.output,
        turn_abort_ctrl: turnAbortCtrl,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
      } as const;

      if (wantsSSE(c.req.header("accept"))) {
        const response = streamSSE(c, async (stream) => {
          try {
            const outcome = await svc.respondElicitation(
              {
                ...baseParams,
                onEvent: (ev) => {
                  void stream.writeSSE(serializeEvent(ev));
                },
              },
              db,
            );
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
              // Row stays pending — the client re-renders the prompt with
              // the field errors and re-submits against the same id.
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
            const err = error as Error;
            await stream.writeSSE(
              errorFrame({
                code: "internal",
                message: err?.message ?? "internal_error",
              }),
            );
          } finally {
            unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl);
          }
          // biome-ignore lint/suspicious/noExplicitAny: streamSSE returns plain Response.
        }) as any;
        ownershipTransferred = true;
        return response;
      }

      let outcome: Awaited<ReturnType<typeof svc.respondElicitation>>;
      try {
        outcome = await svc.respondElicitation(baseParams, db);
      } catch (error) {
        if (error instanceof svc.ElicitationAlreadyResolvedError) {
          throw new HttpError(409, "elicitation_already_resolved", error.message, {
            elicitation_id: error.elicitation_id,
            previous_status: error.status,
            previous_output: error.previous_output,
            previous_decision_reason: error.previous_decision_reason,
          });
        }
        if (error instanceof svc.ElicitationValidationError) {
          // Row stays pending — 422 carries the per-field errors plus the
          // original prompt (with error pins merged) so the client
          // re-renders the same dialog and re-submits.
          throw new HttpError(422, "elicitation_validation_failed", error.message, {
            elicitation_id: error.elicitation_id,
            field_errors: error.field_errors,
            pending_elicitation: error.pending_elicitation,
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
}
