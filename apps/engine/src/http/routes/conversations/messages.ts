// User-message turn-driving endpoints:
//   POST /v1/conversations/{id}/messages         — append + drive turn (+ optional SSE)
//   POST /v1/conversations/{id}/messages/upload  — multipart with file attachments

import { createRoute, type OpenAPIHono, type RouteConfigToTypedResponse } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
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

export function registerMessagesRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(appendRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    // Register the AbortController on the
    // synchronous frame of request-accept so a cancel arriving in the
    // first ~40ms always finds a controller. The registry key carries
    // the principal's tenant id, so a foreign tenant probing another
    // tenant's UUID lives in its own slot and cannot displace the
    // legitimate registration. Registering inside `runLoop` (the
    // earlier location) re-opens the race the cancel route silently
    // lost.
    const turnAbortCtrl = registerConversationAbort(principal.tenant_id, id);
    // Ownership of the registered controller transfers
    // to the SSE callback's own `finally` because Hono's `streamSSE`
    // does NOT await the callback — it kicks the callback off
    // fire-and-forget and returns a Response synchronously. An outer
    // `try { … } finally { unregister(...) }` would fire its `finally`
    // immediately after `streamSSE` returns and unregister the
    // controller while the SSE callback is still running, re-opening
    // the cancel race the synchronous registration set out to close.
    //
    // The `ownershipTransferred` flag is the seam: set true once
    // streamSSE has accepted ownership; the outer `finally` skips
    // unregister and lets the inner `finally` own it. Anything that
    // throws BEFORE we hand off — `buildRuntimeContextFromRequest`,
    // `wantsSSE`, `streamSSE` setup itself — leaves the flag false
    // and the outer `finally` cleans up. The non-SSE path keeps the
    // outer `finally` because `await svc.appendUserMessage(...)`
    // keeps the surrounding `try` alive until completion.
    let ownershipTransferred = false;
    try {
      const appendParams = {
        tenant_id: principal.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        message: body.message,
        ...(body.memory !== undefined ? { memory: body.memory } : {}),
        ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
      } as const;
      const runtimeContext = buildRuntimeContextFromRequest(c, principal);
      // The append + turn split: `appendUserMessage` validates + persists
      // the user message row, `runConversationTurn` drives the model loop.
      // The HTTP route runs both inline so the SSE surface keeps streaming.
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
            // A person typed this into an authenticated session, so a fast-path
            // "yes" in it is their approval.
            answer_actor: humanChatAnswer(principal),
            user_memory: appended.user_memory,
            turn_abort_ctrl: turnAbortCtrl,
            runtime_context: runtimeContext,
            ...(body.permission_mode ? { permission_mode: body.permission_mode } : {}),
            ...(body.step_budget !== undefined ? { step_budget: body.step_budget } : {}),
            ...(body.client_suppress !== undefined
              ? { next_suggestion_suppress: body.client_suppress }
              : {}),
            ...(onEvent ? { onEvent } : {}),
          },
          db,
        );

      if (wantsSSE(c.req.header("accept"))) {
        const response = streamSSE(c, async (stream) => {
          try {
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
          // streamSSE returns a plain Response; the openapi handler wants the
          // typed JSON shape — the SSE branch is runtime-correct (see the
          // createRouteSpec branch in collection.ts).
        }) as Response & RouteConfigToTypedResponse<typeof appendRoute>;
        // streamSSE accepted ownership — defer unregister to the
        // inner `finally`. Set the flag AFTER `streamSSE` returns
        // cleanly so a sync throw from streamSSE-setup still triggers
        // the outer `finally`.
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
            conversation_status: "awaiting_input",
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

  // ---- File attachment route -------------------------------------------------
  // POST /v1/conversations/:id/messages/upload
  //
  // Accepts multipart/form-data with:
  //   - message (text): the user's message
  //   - files[] (binary, 1-10): attached files
  //   - memory (text, optional): SUBKIT.md content
  //
  // Each file is auto-ingested as a Knowledge Source scoped to the
  // conversation's target workflow (or global). The user message + any
  // file references are then passed to the standard appendUserMessage flow.
  app.post("/v1/conversations/:id/messages/upload", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");

    const formData = await c.req.formData();
    const message = formData.get("message");
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return c.json({ error: "message field is required" }, 400);
    }

    const memory = formData.get("memory");
    const files = formData.getAll("files");

    // Resolve conversation to determine scope for knowledge sources
    const conv = await svc.getConversation(principal.tenant_id, id, db);
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const targetWorkflowId = conv.conversation.target_workflow_id;

    // Auto-ingest each file as a Knowledge Source
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
            actor_id: principal.id,
          },
          db,
        );
        ingestedSources.push(source.id);
        // Interactive auto-enrich (best-effort): description + tags when the
        // attachment landed without them. Outside the create transaction; a
        // failure (incl. LlmQuotaExhausted) never fails message ingestion.
        if (source.description === null || source.tags.length === 0) {
          try {
            await analyzeKnowledgeSource(
              { tenant_id: principal.tenant_id, id: source.id, actor_id: principal.id },
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

    // Append enriched message that references ingested files
    const enrichedMessage =
      ingestedSources.length > 0
        ? `${message}\n\n[Attached ${ingestedSources.length} file(s) as knowledge sources]`
        : message;

    // Register synchronously and unregister in
    // `finally` (non-SSE branch only — this route returns JSON, so the
    // single outer try/finally is sufficient).
    const turnAbortCtrl = registerConversationAbort(principal.tenant_id, id);
    try {
      const appended = await svc.appendUserMessage(
        {
          tenant_id: principal.tenant_id,
          conversation_id: id,
          actor_id: principal.id,
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
