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

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../../../logging/logger.ts";
import { scrubString, scrubStringsDeep } from "../../../logging/scrub-secrets.ts";
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
import { redactElicitationOutput } from "./redact-answer.ts";
import { detectSecretElicitation, type SecretElicitationHit } from "./secret-detection.ts";
import { validateElicitationAnswer } from "./validate-answer.ts";

type AskUserToolName = NonNullable<ToolResult["pause"]>["tool_name"];

/**
 * Pattern-only secret scrub over an `ask_user_*` payload — the single
 * chokepoint ahead of every downstream copy of the payload (native
 * bridge message, DB-pause `pause` payloads, persisted elicitation
 * rows). `scrubStringsDeep` walks string LEAVES only, so nested
 * `fields[]` labels/placeholders/defaults and select option labels are
 * covered while structural key names (`token`, `credential`) and
 * Mustache values like `Bearer {{token}}` in `commit_intent.payload`
 * survive untouched.
 */
export function scrubAskUserPayload<T extends { summary: string; input: unknown }>(p: T): T {
  return { ...p, summary: scrubString(p.summary), input: scrubStringsDeep(p.input) };
}

/**
 * D7 — the reference integration-authoring architecture NEVER asks for a
 * secret in chat: sensitive credential entry always routes to a secure UI
 * (portal / OAuth). Over MCP, a paused `ask_user_*` elicitation is
 * surfaced to the client as an in-chat "awaiting input" prompt — there is
 * no in-band portal UI — so eliciting a secret-shaped field here would
 * collect the raw API key / token / password as free chat text. Refuse it
 * and point the model at the secure flow instead.
 *
 * The directive is a structured `ok: false` result (never a `pause`), so
 * the loop folds `next_best_actions` into `prior_failures` and the model
 * re-routes without ever surfacing the secret prompt to the user.
 */
function secretElicitationBlockedOverMcp(
  ctx: ToolContext,
  p: { tool_name: AskUserToolName; summary: string },
  hit: SecretElicitationHit,
): ToolResult {
  logger.warn({
    module: "conversation",
    action: "ask_user.secret_elicitation_blocked",
    msg: "refused to elicit a secret as chat text over MCP — routing to the secure credential flow",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    tool_name: p.tool_name,
    reason: hit.reason,
    field: hit.field,
  });
  const message =
    "A secret (API key / token / password) must never be requested as chat text over MCP — " +
    "route credential entry to the secure flow instead. " +
    "To repair a saved connector whose credential is dead, call request_connector_reauth: it returns " +
    "a one-time OAuth sign-in URL for OAuth2 connectors, or a secure credential-setup URL " +
    "(method: portal_setup) for basic/bearer/header/query connectors — present that URL verbatim for " +
    "the user to open. For an OAuth2 connector being authored, use authenticate_oauth. " +
    "For a brand-new connector, save the connector first (save_connector_draft), then call " +
    "request_connector_reauth to mint a secure setup URL. " +
    "Do NOT ask the user to paste the secret in chat.";
  return {
    ok: false,
    error_code: "secret_elicitation_blocked",
    message,
    next_best_actions: ["request_connector_reauth", "authenticate_oauth", "save_connector_draft"],
    data: { error_code: "secret_elicitation_blocked", reason: hit.reason, field: hit.field },
  };
}

export async function pauseForUserInput(
  ctx: ToolContext,
  p: { tool_name: AskUserToolName; summary: string; input: unknown },
): Promise<ToolResult> {
  // The model occasionally echoes a user-pasted secret back into the
  // question/summary it asks with — scrub the whole payload before any
  // path (bridge, DB pause, elicitation row) can persist or render it.
  p = scrubAskUserPayload(p);
  // ── D7: no secret is ever elicited as chat text over MCP ───────────
  // Scoped to `surface === "mcp"`: sk-cli (sk_headless/sk_interactive)
  // and the web portal are secure input surfaces — a local operator may
  // paste a secret into the CLI — so those paths are untouched. Over MCP
  // there is no secure in-band UI, so a secret-shaped elicitation is
  // refused and routed to the secure flow (portal-setup URL / OAuth).
  if (ctx.surface === "mcp") {
    const secret = detectSecretElicitation(p.tool_name, p.input);
    if (secret) return secretElicitationBlockedOverMcp(ctx, p, secret);
  }
  // ── MCP-native form elicitation ────────────────────────────────────
  // Take the in-process bridge when: the client advertised the
  // elicitation capability AND the tool input maps to flat primitives.
  const bridge = ctx.elicitationBridge;
  if (bridge?.capabilities.form) {
    const mapped = mapAskUserToPrimitiveSchema(p.tool_name as FormBridgeToolName, p.input);

    // ── Sensitive-field guard ───────────────────────────────────────────
    // Spec MUST: form-mode elicitation MUST NOT request passwords/API
    // keys/secrets. The mapper returns { degrade: true; sensitive: true }
    // when a sensitive field is detected — `degrade: true` keeps the
    // existing `if (!mapped.degrade)` block from running, and `sensitive`
    // lets us distinguish this arm from an ordinary schema-mapping failure
    // so we can raise the right signal.
    if (mapped.degrade && "sensitive" in mapped) {
      // Open the governance row (APPROVAL_REQUESTED audit) so the audit
      // trail has a paired entry regardless of which path we take.
      const sensitiveRow = await createNativeElicitation(
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

      if (bridge.capabilities.oob) {
        // Cancel the governance row (APPROVAL_REJECTED) before raising
        // the error so APPROVAL_REQUESTED stays paired — no orphan row.
        await resolveElicitationAndReactivate(
          {
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            id: sensitiveRow.id,
            output: null,
            decided_by: ctx.actor_id,
            status: "cancelled",
            reason: "sensitive_field_requires_url_elicitation",
            transport: "failed",
          },
          ctx.db,
        );
        // Raise the SDK's canonical signal: the client MUST use URL/oob
        // mode to collect a secret — form-mode is not permitted.
        throw new McpError(
          ErrorCode.UrlElicitationRequired,
          "Secret/password fields must be collected via URL-mode elicitation (oob/url), not form-mode. Re-issue the request using elicitation mode: url.",
        );
      }

      // No oob capability: demote the native row to portal so the operator
      // can submit the secret through the portal DB-pause path. The
      // ELICITATION_DEMOTED_TO_PORTAL audit row is emitted inside demote.
      await demoteElicitationToPortal(ctx.tenant_id, sensitiveRow.id, ctx.db);
      logger.warn({
        module: "conversation",
        action: "elicitation.sensitive_field_demoted_to_portal",
        msg: "sensitive form field — client has no oob capability; demoting to portal DB-pause",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        elicitation_id: sensitiveRow.id,
        tool_name: p.tool_name,
      });
      return {
        ok: true,
        data: { status: "awaiting_input", elicitation_id: sensitiveRow.id },
        pause: {
          tool_name: p.tool_name,
          summary: p.summary,
          elicitation_id: sensitiveRow.id,
          input: p.input,
        },
      };
    }

    if (!mapped.degrade) {
      // ── Normal form-mode path ───────────────────────────────────────
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
            ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
            ...(ctx.surface ? { surface: ctx.surface } : {}),
            output,
            elicitation: { id: row.id, tool_name: p.tool_name, input: p.input },
            db: ctx.db,
          });
          // No `pause` — the loop continues with the answer in hand. The
          // credential cache + auto-persist above already consumed the RAW
          // `output`; the value returned as tool-call `data` (persisted at
          // invoke.ts) must not carry a masked secret, so redact it the
          // same way the elicitation row is (#304). Replay prefers the
          // redacted elicitation row anyway; this closes the at-rest
          // tool-call-output copy.
          return { ok: true, data: redactElicitationOutput(p.tool_name, p.input, output) };
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
