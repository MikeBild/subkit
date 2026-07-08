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
import { serializeEvent, withoutApprovalHandle } from "../../../conversations/index.ts";
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
      // orphans; `messages_v2` no longer guesses their placement.
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

      for (const msg of detail.messages) {
        await stream.writeSSE(
          serializeEvent({
            type: "message",
            role: msg.role,
            content: msg.content,
            id: msg.id,
            parent_message_id: msg.id,
          }),
        );
        const childCallsForMsg = childCalls.get(msg.id) ?? [];
        for (const call of childCallsForMsg) await emitCall(call);
        const childElicitsForMsg = childElicits.get(msg.id) ?? [];
        for (const elicit of childElicitsForMsg) await emitElicit(elicit);
      }
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
      let usage:
        | { turn_tokens: number; remaining_monthly_budget_tokens: number | null }
        | undefined;
      try {
        const used = await monthlyUsage(principal.tenant_id, db);
        const route = await resolveModelRoute(principal.tenant_id, db);
        const remaining =
          route.monthly_budget != null ? Math.max(0, route.monthly_budget - used) : null;
        usage = { turn_tokens: used, remaining_monthly_budget_tokens: remaining };
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
