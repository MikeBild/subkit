// Shared helper for the `ask_user_*` tool family.
//
// Two paths:
//
//   1. DB-pause (HTTP/SSE portal surface, or MCP clients without the
//      `elicitation` capability) — insert-persist an elicitation row
//      and return a `pause` payload the loop surfaces as an
//      `awaiting_input` completion. Resume via `respondElicitation`.
//
//   2. MCP-native form elicitation (MCP surface, client advertises
//      `elicitation`, tool input maps to flat primitives) — still
//      insert the elicitation row (audit + single-pending invariant)
//      marked `protocol_native`, then issue a server→client
//      `elicitation/create` request and await the operator's answer
//      IN-PROCESS. On accept, resolve the row, run the credential-cache
//      + auto-persist sequence, flip the conversation back to `active`,
//      and return WITHOUT a `pause` so the loop continues this turn.
//
// The loop treats any `ToolResult.pause` the same way it treats the
// existing approval pause, so the pause contract stays compatible.

import { logger } from "../../../logging/logger.ts";
import { ElicitationUnsupportedError } from "../../elicitation-bridge.ts";
import {
  createElicitation,
  createNativeElicitation,
  demoteElicitationToPortal,
  resolveElicitationAndReactivate,
} from "../../elicitations.ts";
import { applyElicitationOutcome } from "../../persistence/apply-outcome.ts";
import { alreadyResolved, resolveAndError } from "../elicitation-resolve.ts";
import { ELICITATION_TRANSPORT_FAILED, INVALID_ELICIT_RESPONSE } from "../error-codes.ts";
import type { ToolContext, ToolResult } from "../index.ts";
import {
  type FormBridgeToolName,
  mapAskUserToPrimitiveSchema,
  mapElicitResultToAskUserOutput,
} from "./elicit-bridge.ts";
import { validateElicitationAnswer } from "./validate-answer.ts";

type AskUserToolName = NonNullable<ToolResult["pause"]>["tool_name"];

export async function pauseForUserInput(
  ctx: ToolContext,
  p: { tool_name: AskUserToolName; summary: string; input: unknown },
): Promise<ToolResult> {
  // ── MCP-native form elicitation ────────────────────────────────────
  // Take the in-process bridge when: the client advertised the
  // elicitation capability AND the tool input maps to flat primitives.
  const bridge = ctx.elicitationBridge;
  if (bridge?.capabilities.form) {
    const mapped = mapAskUserToPrimitiveSchema(p.tool_name as FormBridgeToolName, p.input);
    if (!mapped.degrade) {
      // Still persist the row — audit trail + single-pending-elicitation
      // invariant — but mark it protocol_native so observability can
      // distinguish a wire elicitation from a DB-pause one.
      const row = await createNativeElicitation(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          tool_call_id: ctx.tool_call_id ?? null,
          ...(ctx.assistant_message_id ? { parent_message_id: ctx.assistant_message_id } : {}),
          tool_name: p.tool_name,
          summary: p.summary,
          input: p.input,
          actor_id: ctx.actor_id,
        },
        ctx.db,
      );
      try {
        let result = await bridge.elicitForm({
          message: mapped.message,
          requestedSchema: mapped.requestedSchema,
        });
        let mappedOutput =
          result.action === "accept"
            ? mapElicitResultToAskUserOutput(
                p.tool_name as FormBridgeToolName,
                p.input,
                result.content,
              )
            : null;
        // Server-side answer validation (same contract as the DB-pause
        // respond path). On failure: ONE bridge retry with the field
        // errors appended to the message; a second invalid answer
        // collapses to the invalid-accept path below.
        if (result.action === "accept" && mappedOutput !== null) {
          const verdict = validateElicitationAnswer(p.tool_name, p.input, mappedOutput);
          if (!verdict.ok) {
            const errText = verdict.field_errors.map((e) => `${e.name}: ${e.message}`).join("; ");
            result = await bridge.elicitForm({
              message: `${mapped.message}\n\nThe previous answer was invalid — ${errText}. Please correct and resubmit.`,
              requestedSchema: mapped.requestedSchema,
            });
            mappedOutput =
              result.action === "accept"
                ? mapElicitResultToAskUserOutput(
                    p.tool_name as FormBridgeToolName,
                    p.input,
                    result.content,
                  )
                : null;
            if (result.action === "accept" && mappedOutput !== null) {
              const retryVerdict = validateElicitationAnswer(p.tool_name, p.input, mappedOutput);
              if (!retryVerdict.ok) mappedOutput = null;
            }
          }
        }
        // A protocol-violating `accept` — the client returned an
        // `accept` action but an answer that breaks the requested
        // schema (an out-of-enum `ask_user_choice`, a non-boolean
        // `ask_user_confirm`), so `mapElicitResultToAskUserOutput`
        // returned `null`. Honouring the `accept` would resolve the row
        // `resolved` / audit `APPROVAL_APPROVED` while the real decision
        // is a non-answer. Collapse it into the decline/cancel path
        // instead: resolve `cancelled` with `invalid_elicit_response`.
        if (result.action === "accept" && mappedOutput !== null) {
          const output = mappedOutput;
          // Resolve the row AND flip the conversation back to `active`
          // as one atomic unit (see `resolveElicitationAndReactivate`).
          // A concurrent `respondElicitation` may have resolved this row
          // first (lost race) — that must not be treated as a fresh
          // accept.
          const acceptResolution = await resolveElicitationAndReactivate(
            {
              tenant_id: ctx.tenant_id,
              conversation_id: ctx.conversation_id,
              id: row.id,
              output,
              decided_by: ctx.actor_id,
              status: "resolved",
              transport: "succeeded",
            },
            ctx.db,
          );
          if (acceptResolution.kind !== "resolved") {
            return alreadyResolved(row.id);
          }
          // Credential-cache + auto-persist runs AFTER the transition
          // commits — same ordering as the DB-pause resume path
          // (`service/elicit.ts`). Each internal write it dispatches is
          // already individually atomic and idempotent; nesting it
          // inside the transition tx would diverge from that path and
          // change the dispatched writes' isolation semantics.
          await applyElicitationOutcome({
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            actor_id: ctx.actor_id,
            output,
            elicitation: { id: row.id, tool_name: p.tool_name, input: p.input },
            db: ctx.db,
          });
          // No `pause` — the loop continues with the answer in hand.
          return { ok: true, data: output };
        }
        // decline / cancel / protocol-violating-accept — resolve as
        // cancelled, no continuation. `resolveAndError` runs the same
        // atomic transition unit (and same lost-race guard) as the accept
        // path. An `accept` whose mapped output is `null` lands here as
        // `invalid_elicit_response`. The form round-trip completed in all
        // three cases — the operator answered — so `transport: "succeeded"`.
        const invalidAccept = result.action === "accept";
        if (invalidAccept) {
          return resolveAndError(ctx, row.id, {
            reason: INVALID_ELICIT_RESPONSE,
            errorCode: INVALID_ELICIT_RESPONSE,
            message:
              "The MCP client returned an answer that violates the requested schema (an out-of-enum choice or a non-boolean confirm). It was recorded as a decline; ask the user again only if their answer is still needed.",
            transport: "succeeded",
            status: "invalid_elicit_response",
            output: result.content ?? null,
            data: { elicitation_id: row.id },
          });
        }
        return resolveAndError(ctx, row.id, {
          reason: result.action === "decline" ? "user_declined" : "user_cancelled",
          errorCode: result.action === "decline" ? "user_declined" : "user_cancelled",
          message:
            result.action === "decline"
              ? "The user declined to provide the requested input."
              : "The user cancelled the input request.",
          transport: "succeeded",
          status: result.action,
          output: result.content ?? null,
        });
      } catch (err) {
        if (err instanceof ElicitationUnsupportedError) {
          // Capability raced away between the constructor probe and the
          // call — fall back to DB-pause. The row already exists and is
          // pending; surface it as a normal pause.
          //
          // The row was opened via `createNativeElicitation`
          // (`protocol_native: true`), but it will now be satisfied by a
          // portal POST to `respondElicitation`. Demote it so
          // `resolveElicitation`'s `surface` audit metadata resolves to
          // `portal`, not `mcp_elicitation`.
          await demoteElicitationToPortal(ctx.tenant_id, row.id, ctx.db);
          logger.warn({
            module: "conversation",
            action: "elicitation.bridge_unsupported_fallback",
            msg: "MCP elicitation capability unavailable mid-call — falling back to DB-pause",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            elicitation_id: row.id,
            tool_name: p.tool_name,
          });
          return {
            ok: true,
            data: { status: "awaiting_input", elicitation_id: row.id },
            pause: {
              tool_name: p.tool_name,
              summary: p.summary,
              elicitation_id: row.id,
              input: p.input,
            },
          };
        }
        // Non-`ElicitationUnsupportedError` — a generic transport /
        // timeout failure (client disconnected, never answered). The
        // elicitation row is pending and the conversation is wedged in
        // `awaiting_input`. Resolve the row `cancelled` and flip the
        // conversation back to `active` so the loop is not stuck, then
        // return a structured error instead of re-throwing.
        logger.warn({
          module: "conversation",
          action: "elicitation.bridge_transport_failed",
          msg: "MCP elicitation transport failed — resolving row cancelled and unwedging the conversation",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          elicitation_id: row.id,
          tool_name: p.tool_name,
          error: err instanceof Error ? err.message : String(err),
        });
        // Resolve the row `cancelled` AND flip the conversation back to
        // `active` as one atomic unit so a partial failure cannot leave
        // the conversation wedged. A lost race (a concurrent
        // `respondElicitation` already resolved this row) returns
        // `already_resolved` — the conversation is no longer wedged, so
        // `resolveAndError` reports that rather than the transport failure.
        return resolveAndError(ctx, row.id, {
          reason: ELICITATION_TRANSPORT_FAILED,
          errorCode: ELICITATION_TRANSPORT_FAILED,
          message:
            "The MCP elicitation request failed in transit — the client may have disconnected or did not answer. The conversation is no longer waiting on input; ask the user again if their answer is still needed.",
          transport: "failed",
          status: "transport_failed",
          data: { elicitation_id: row.id },
        });
      }
    }
  }

  // ── DB-pause path (unchanged) ──────────────────────────────────────
  const row = await createElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: ctx.tool_call_id ?? null,
      ...(ctx.assistant_message_id ? { parent_message_id: ctx.assistant_message_id } : {}),
      tool_name: p.tool_name,
      summary: p.summary,
      input: p.input,
      actor_id: ctx.actor_id,
    },
    ctx.db,
  );
  return {
    ok: true,
    data: { status: "awaiting_input", elicitation_id: row.id },
    pause: {
      tool_name: p.tool_name,
      summary: p.summary,
      elicitation_id: row.id,
      input: p.input,
    },
  };
}
