// SSE replay of the most recent turn's events for a conversation.
//
//   GET /v1/conversations/{id}/stream
//
// Hand-rolled outside the openapi handler because streamSSE needs to
// commandeer the Hono Response — the same reason the create / append /
// elicit-respond SSE branches cast their return type.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import * as svc from "../../../conversations/index.ts";
import {
  harvestCitationsFromPersisted,
  keepResolvableCitations,
  messageHasText,
  serializeEvent,
  type TurnEvent,
  withoutApprovalHandle,
} from "../../../conversations/index.ts";
import { monthlyUsage, resolveModelRoute } from "../../../llm/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerStreamRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/conversations/:id/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const detail = await svc.getConversation(principal.tenant_id, id, db);
    if (!detail) throw new NotFoundError("conversation");

    return streamSSE(c, async (stream) => {
      const { listElicitationsForConversation } = await import(
        "../../../conversations/elicitations.ts"
      );
      const allElicitations = await listElicitationsForConversation(principal.tenant_id, id, db);
      const pendingElicitations = allElicitations.filter((e) => e.status === "pending");
      // Replay the conversation as a single chronologically-ordered
      // stream: for each message, emit it then immediately emit every
      // child row (tool_call lifecycle + tool_result + pending
      // elicitation) anchored to it via parent_message_id. Children
      // without an anchor (legacy rows) are emitted at the tail as raw
      // orphans; `messages` no longer guesses their placement.
      const childCalls = new Map<string, typeof detail.tool_calls>();
      for (const call of detail.tool_calls) {
        const anchor = call.parent_message_id ?? null;
        if (!anchor) continue;
        const list = childCalls.get(anchor) ?? [];
        list.push(call);
        childCalls.set(anchor, list);
      }
      const childElicits = new Map<string, typeof pendingElicitations>();
      for (const e of pendingElicitations) {
        // We re-import the type lazily; treat anchor as optional via cast.
        const anchor = (e as { parent_message_id?: string | null }).parent_message_id ?? null;
        if (!anchor) continue;
        const list = childElicits.get(anchor) ?? [];
        list.push(e);
        childElicits.set(anchor, list);
      }
      const orphanCalls = detail.tool_calls.filter((c) => !c.parent_message_id);
      const orphanElicits = pendingElicitations.filter(
        (e) => !(e as { parent_message_id?: string | null }).parent_message_id,
      );

      const emitCall = async (call: (typeof detail.tool_calls)[number]) => {
        await stream.writeSSE(
          serializeEvent({
            type: "tool_call_start",
            call_id: call.id,
            tool: call.tool,
            input_partial: call.input,
            ...(call.parent_message_id ? { parent_message_id: call.parent_message_id } : {}),
          }),
        );
        await stream.writeSSE(
          serializeEvent({
            type: "tool_call_end",
            call_id: call.id,
            input: call.input,
            ...(call.parent_message_id ? { parent_message_id: call.parent_message_id } : {}),
          }),
        );
        if (call.output !== null && call.output !== undefined) {
          await stream.writeSSE(
            serializeEvent({
              type: "tool_result",
              call_id: call.id,
              tool: call.tool,
              output: call.output,
              ...(call.parent_message_id ? { parent_message_id: call.parent_message_id } : {}),
            }),
          );
        }
      };
      const emitElicit = async (elicit: (typeof pendingElicitations)[number]) => {
        const anchor = (elicit as { parent_message_id?: string | null }).parent_message_id;
        // The persisted row is the harness's own record and may carry an
        // engine-authored approval handle. A replay is an outbound frame — strip
        // it, the same way the live `elicit_request` did when the turn paused.
        const rawInput =
          elicit.input && typeof elicit.input === "object" && !Array.isArray(elicit.input)
            ? (elicit.input as Record<string, unknown>)
            : {};
        await stream.writeSSE(
          serializeEvent({
            type: "elicit_request",
            elicitation_id: elicit.id,
            ...(elicit.tool_call_id ? { tool_call_id: elicit.tool_call_id } : {}),
            tool_name: elicit.tool_name,
            summary: elicit.summary,
            input: withoutApprovalHandle(rawInput),
            ...(anchor ? { parent_message_id: anchor } : {}),
          }),
        );
      };

      // Re-derive the terminal `citations` frame per historical turn (it is
      // never persisted — the live loop only streams it, see
      // conversations/loop.ts). A turn spans from one "user" message up to
      // (but not including) the next; the tool_result events emitted for
      // its children are the same envelope `harvestCitations` reads live.
      //
      // Mirror the live loop EXACTLY: it anchors to `lastAssistantMessageId`
      // (the LAST assistant message of the turn, text-bearing or not) and
      // gates emission on `lastAssistantText` (whether the turn produced ANY
      // assistant prose). So here: anchor to the last assistant message, and
      // emit only if some assistant message in the turn carried text — a
      // turn that ended tool-only or produced no prose shows no footer live,
      // and must show none on replay. (The one irreducible gap is a turn
      // cancelled AFTER producing prose: live suppresses via `!cancelled`,
      // but cancellation is not persisted, so replay cannot see it.)
      let turnToolResults: TurnEvent[] = [];
      let turnLastAssistantId: string | null = null;
      let turnHadText = false;
      const flushTurnCitations = async () => {
        if (turnLastAssistantId && turnHadText) {
          let citations = harvestCitationsFromPersisted(turnToolResults);
          // Drop citations whose source no longer resolves (deleted since the
          // turn), mirroring the live loop — the footer must never advertise a
          // provenance handle that isn't real. Fail-open on a resolve error.
          if (citations.length > 0) {
            try {
              citations = await keepResolvableCitations(citations, principal.tenant_id, db);
            } catch {
              // Keep the harvested set on a transient resolve error.
            }
          }
          if (citations.length > 0) {
            await stream.writeSSE(
              serializeEvent({
                type: "citations",
                citations,
                parent_message_id: turnLastAssistantId,
              }),
            );
          }
        }
        turnToolResults = [];
        turnLastAssistantId = null;
        turnHadText = false;
      };

      for (const msg of detail.messages) {
        if (msg.role === "user") await flushTurnCitations();
        await stream.writeSSE(
          serializeEvent({
            type: "message",
            role: msg.role,
            content: msg.content,
            id: msg.id,
            parent_message_id: msg.id,
          }),
        );
        if (msg.role === "assistant") {
          turnLastAssistantId = msg.id;
          if (messageHasText(msg.content)) turnHadText = true;
        }
        const childCallsForMsg = childCalls.get(msg.id) ?? [];
        for (const call of childCallsForMsg) {
          await emitCall(call);
          if (call.output !== null && call.output !== undefined) {
            turnToolResults.push({
              type: "tool_result",
              call_id: call.id,
              tool: call.tool,
              output: call.output,
            });
          }
        }
        const childElicitsForMsg = childElicits.get(msg.id) ?? [];
        for (const elicit of childElicitsForMsg) await emitElicit(elicit);
      }
      await flushTurnCitations();
      // Legacy rows without parent_message_id — emit at the end so
      // clients that consume parent_message_id place them under the
      // last assistant message of their time window.
      for (const call of orphanCalls) await emitCall(call);
      for (const elicit of orphanElicits) await emitElicit(elicit);
      if (detail.conversation.status === "committed" && detail.conversation.target_workflow_id) {
        await stream.writeSSE(
          serializeEvent({
            type: "committed",
            workflow_id: detail.conversation.target_workflow_id,
          }),
        );
      }
      // Compute turn usage for the completed event so CLI clients
      // (sk) can surface token counts without a second round-trip.
      // What this route can honestly say is how much of the month's budget is
      // left — and nothing about this turn.
      //
      // It used to fill `turn_tokens` with the tenant's month-to-date total.
      // The other emitter of that field, `conversations/loop.ts`, computes a
      // real per-turn delta, and `sk` renders it as "{turn_tokens}t" beside
      // the prompt. So one frame said a turn cost sixty thousand tokens and
      // the other said it cost thirty-four million, for the same field, on the
      // same screen. This route never runs the turn, so it holds no
      // before-value and cannot derive the delta — the field is therefore
      // omitted rather than filled with the nearest number to hand. `sk`
      // already reads it as optional and shows nothing when it is absent.
      let usage: { remaining_monthly_budget_tokens: number | null } | undefined;
      try {
        const used = await monthlyUsage(principal.tenant_id, db);
        const route = await resolveModelRoute(principal.tenant_id, db);
        const remaining =
          route.monthly_budget != null ? Math.max(0, route.monthly_budget - used) : null;
        usage = { remaining_monthly_budget_tokens: remaining };
      } catch {
        /* usage lookup is best-effort */
      }
      await stream.writeSSE(
        serializeEvent({
          type: "completed",
          status: detail.conversation.status,
          ...(usage ? { usage } : {}),
        }),
      );
    });
  });
}
