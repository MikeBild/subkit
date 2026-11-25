import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { logger } from "../../../logging/index.ts";
import { scrubString, scrubStringsDeep } from "../../../logging/scrub-secrets.ts";
import { urlElicitationRequired } from "../../../mcp/transports/protocol-errors.ts";
import { recordAuthoringGateBlock } from "../../../observability/instrumentation.ts";
import { humanInBandAnswer } from "../../answer-actor.ts";
import { decidedByFor } from "../../decided-by.ts";
import {
  DRAFT_CREDENTIAL_SETUP_KIND,
  draftCredentialSetupNote,
  isDraftCredentialSetupAuthType,
  mintDraftCredentialSetupUrl,
} from "../../draft-credential-setup.ts";
import { ElicitationUnsupportedError, FORM_FAST_CANCEL_MS } from "../../elicitation-bridge.ts";
import { elicitationRefusalResult } from "../../elicitation-refusal.ts";
import {
  createElicitation,
  createNativeElicitation,
  demoteElicitationToPortal,
  resolveElicitationAndReactivate,
} from "../../elicitations.ts";
import { applyElicitationOutcome } from "../../persistence/apply-outcome.ts";
import { RESUME_FORM_MAX_FIELDS, resumeFormFields } from "../../resume-form.ts";
import { alreadyResolved, resolveAndError } from "../elicitation-resolve.ts";
import { INVALID_ELICIT_RESPONSE } from "../error-codes.ts";
import type { ToolContext, ToolResult } from "../index.ts";
import { elicitationInputForClient } from "./commit-intent.ts";
import {
  type FormBridgeToolName,
  mapAskUserToPrimitiveSchema,
  mapElicitResultToAskUserOutput,
} from "./elicit-bridge.ts";
import {
  describeDroppedHints,
  stripPlaceholderDestinationHints,
} from "./placeholder-destination.ts";
import { redactElicitationOutput } from "./redact-answer.ts";
import { detectSecretElicitation, type SecretElicitationHit } from "./secret-detection.ts";
import { validateElicitationAnswer } from "./validate-answer.ts";

type AskUserToolName = NonNullable<ToolResult["pause"]>["tool_name"];

export function unrenderableFormResult(input: unknown): ToolResult | null {
  const fields =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { fields?: unknown }).fields
      : undefined;
  if (resumeFormFields(fields)) return null;
  const message = `This form cannot be shown to the user, so nobody could answer it. Ask again with 1–${RESUME_FORM_MAX_FIELDS} fields, each with a unique name, a label and one of the field types ask_user_form documents.`;
  return {
    ok: false,
    error_code: "form_not_renderable",
    message,
    next_best_actions: ["ask_user_form"],
    data: { error_code: "form_not_renderable", message },
  };
}

export function scrubAskUserPayload<T extends { summary: string; input: unknown }>(p: T): T {
  return { ...p, summary: scrubString(p.summary), input: scrubStringsDeep(p.input) };
}

async function secretElicitationBlockedOverMcp(
  ctx: ToolContext,
  p: { tool_name: AskUserToolName; summary: string },
  hit: SecretElicitationHit,
): Promise<ToolResult> {
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
  const connector = ctx.getDraft().connector;
  const authType = connector?.auth_type ?? "none";
  if (connector && !connector.saved_connector_id && isDraftCredentialSetupAuthType(authType)) {
    const grant = mintDraftCredentialSetupUrl(ctx.conversation_id);
    if (!grant.ok) {
      return {
        ok: false,
        error_code: grant.error,
        message:
          "The engine has no public origin for secure credential entry. Configure server.public_base_url, then request the credential again.",
        next_best_actions: [p.tool_name],
      };
    }
    const label = connector.name ?? connector.slug ?? "connector";
    const routed = await pauseForUserInput(ctx, {
      tool_name: "ask_user_confirm",
      summary: `Enter the credential for ${label} in the secure setup flow.`,
      input: {
        kind: DRAFT_CREDENTIAL_SETUP_KIND,
        question: "Complete the secure credential setup, then return to this client.",
        summary:
          `Enter the ${authType} credential for ${label}. ` +
          "After submission the connector draft will be probed before it is saved.",
        setup_url: grant.url,
        note: draftCredentialSetupNote(grant.url, grant.expires_at),
        conversation_id: ctx.conversation_id,
        connector_slug: connector.slug ?? null,
        auth_type: authType,
        single_use: true,
        expires_at: grant.expires_at.toISOString(),
        next_best_actions: ["probe_connector_draft"],
      },
    });
    if (routed.ok && routed.pause) {
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type:
            ctx.engineClient.context.actor_type ?? (ctx.actor_id === null ? "system" : "unknown"),
          actor_id: ctx.engineClient.context.actor_id,
          action: AuditAction.CONNECTOR_CREDENTIAL_GRANT_ISSUED,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: "success",
          metadata: {
            draft_only: true,
            auth_type: authType,
            connector_slug: connector.slug ?? null,
            elicitation_id: routed.pause.elicitation_id,
          },
        },
        ctx.db,
      );
    }
    return routed;
  }
  const message =
    "A secret (API key / token / password) must never be requested as chat text over MCP — " +
    "route credential entry to the secure flow instead. " +
    "To repair a saved connector whose credential is dead, call request_connector_reauth: it starts " +
    "a native URL-mode sign-in or credential-setup flow without returning the URL as model text. " +
    "For an OAuth2 connector being authored, use authenticate_oauth. " +
    "For a brand-new static-credential connector, start and validate the connector draft first, " +
    "then request the credential again so the secure draft setup flow can be opened. " +
    "Do NOT ask the user to paste the secret in chat.";
  return {
    ok: false,
    error_code: "secret_elicitation_blocked",
    message,
    next_best_actions: ["request_connector_reauth", "authenticate_oauth"],
    data: { error_code: "secret_elicitation_blocked", reason: hit.reason, field: hit.field },
  };
}

function dropPlaceholderDestinationHints<T extends { tool_name: AskUserToolName; input: unknown }>(
  ctx: ToolContext,
  p: T,
): T {
  const stripped = stripPlaceholderDestinationHints(p.tool_name, p.input);
  if (stripped.dropped.length === 0) return p;
  logger.warn({
    module: "conversation",
    action: "ask_user.placeholder_destination_dropped",
    msg: "removed placeholder destinations from the question's hints and defaults — destinations come from the user",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    tool_name: p.tool_name,
    dropped: describeDroppedHints(stripped.dropped),
  });
  recordAuthoringGateBlock({ code: "ask_placeholder_destination", tool: p.tool_name });
  return { ...p, input: stripped.input };
}

export async function pauseForUserInput(
  ctx: ToolContext,
  p: { tool_name: AskUserToolName; summary: string; input: unknown },
  engineAuthorization?: { authorizationUrl: string },
): Promise<ToolResult> {
  p = scrubAskUserPayload(p);
  if (p.tool_name === "ask_user_form") {
    const unrenderable = unrenderableFormResult(p.input);
    if (unrenderable) return unrenderable;
  }
  p = dropPlaceholderDestinationHints(ctx, p);
  if (engineAuthorization && p.input && typeof p.input === "object" && !Array.isArray(p.input)) {
    p = { ...p, input: { ...p.input, authorization_url: engineAuthorization.authorizationUrl } };
  }
  if (ctx.surface === "mcp") {
    const secret = detectSecretElicitation(p.tool_name, p.input);
    if (secret) return await secretElicitationBlockedOverMcp(ctx, p, secret);
  }
  const bridge = ctx.elicitationBridge;
  if (bridge?.capabilities.form) {
    const mapped = mapAskUserToPrimitiveSchema(p.tool_name as FormBridgeToolName, p.input);

    if (mapped.degrade && "sensitive" in mapped) {
      const sensitiveOpening = await createNativeElicitation(
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
      if (!sensitiveOpening.ok) return elicitationRefusalResult(sensitiveOpening.reason);
      const sensitiveRow = sensitiveOpening.elicitation;

      if (bridge.capabilities.oob) {
        await resolveElicitationAndReactivate(
          {
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            id: sensitiveRow.id,
            output: null,
            decided_by: decidedByFor(ctx.actor_id, ctx.tenant_id, ctx.principal),
            status: "cancelled",
            reason: "sensitive_field_requires_url_elicitation",
            transport: "failed",
          },
          ctx.db,
        );
        throw urlElicitationRequired(
          "Secret/password fields must be collected via URL-mode elicitation (oob/url), not form-mode. Re-issue the request using elicitation mode: url.",
        );
      }

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
          input: elicitationInputForClient(p.input),
        },
      };
    }

    if (!mapped.degrade) {
      const opening = await createNativeElicitation(
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
      if (!opening.ok) return elicitationRefusalResult(opening.reason);
      const row = opening.elicitation;
      try {
        const sentAt = Date.now();
        let result = await bridge.elicitForm({
          message: mapped.message,
          requestedSchema: mapped.requestedSchema,
        });
        let roundtripMs = Date.now() - sentAt;
        let mappedOutput =
          result.action === "accept"
            ? mapElicitResultToAskUserOutput(
                p.tool_name as FormBridgeToolName,
                p.input,
                result.content,
              )
            : null;
        if (result.action === "accept" && mappedOutput !== null) {
          const verdict = validateElicitationAnswer(p.tool_name, p.input, mappedOutput);
          if (!verdict.ok) {
            const errText = verdict.field_errors.map((e) => `${e.name}: ${e.message}`).join("; ");
            const retrySentAt = Date.now();
            result = await bridge.elicitForm({
              message: `${mapped.message}\n\nThe previous answer was invalid — ${errText}. Please correct and resubmit.`,
              requestedSchema: mapped.requestedSchema,
            });
            roundtripMs = Date.now() - retrySentAt;
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
        if (result.action === "accept" && mappedOutput !== null) {
          const output = mappedOutput;
          const acceptResolution = await resolveElicitationAndReactivate(
            {
              tenant_id: ctx.tenant_id,
              conversation_id: ctx.conversation_id,
              id: row.id,
              output,
              decided_by: decidedByFor(ctx.actor_id, ctx.tenant_id, ctx.principal),
              status: "resolved",
              transport: "succeeded",
            },
            ctx.db,
          );
          if (acceptResolution.kind !== "resolved") {
            return alreadyResolved(row.id);
          }
          await applyElicitationOutcome({
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            actor_id: ctx.actor_id,
            answer_actor: humanInBandAnswer(ctx.principal),
            ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
            ...(ctx.surface ? { surface: ctx.surface } : {}),
            output,
            elicitation: { id: row.id, tool_name: p.tool_name, input: p.input },
            db: ctx.db,
          });
          return { ok: true, data: redactElicitationOutput(p.tool_name, p.input, output) };
        }
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
        if (result.action === "cancel" && roundtripMs < FORM_FAST_CANCEL_MS) {
          await demoteElicitationToPortal(ctx.tenant_id, row.id, ctx.db);
          logger.warn({
            module: "conversation",
            action: "elicitation.form_fast_cancel_demoted",
            msg: "client cancelled the form faster than a human could render it — demoting to DB-pause",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            elicitation_id: row.id,
            tool_name: p.tool_name,
            elapsed_ms: roundtripMs,
          });
          return {
            ok: true,
            data: { status: "awaiting_input", elicitation_id: row.id },
            pause: {
              tool_name: p.tool_name,
              summary: p.summary,
              elicitation_id: row.id,
              input: elicitationInputForClient(p.input),
            },
          };
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
              input: elicitationInputForClient(p.input),
            },
          };
        }
        await demoteElicitationToPortal(ctx.tenant_id, row.id, ctx.db);
        logger.warn({
          module: "conversation",
          action: "elicitation.bridge_transport_demoted",
          msg: "MCP elicitation transport failed — demoting to DB-pause; row stays pending and answerable",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          elicitation_id: row.id,
          tool_name: p.tool_name,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: true,
          data: { status: "awaiting_input", elicitation_id: row.id },
          pause: {
            tool_name: p.tool_name,
            summary: p.summary,
            elicitation_id: row.id,
            input: elicitationInputForClient(p.input),
          },
        };
      }
    }
  }

  const opening = await createElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: ctx.tool_call_id ?? null,
      ...(ctx.assistant_message_id ? { parent_message_id: ctx.assistant_message_id } : {}),
      tool_name: p.tool_name,
      summary: p.summary,
      input: p.input,
      actor_id: ctx.engineClient.context.actor_id,
      actor_type:
        ctx.engineClient.context.actor_type ?? (ctx.actor_id === null ? "system" : "unknown"),
    },
    ctx.db,
  );
  if (!opening.ok) return elicitationRefusalResult(opening.reason);
  const row = opening.elicitation;
  return {
    ok: true,
    data: { status: "awaiting_input", elicitation_id: row.id },
    pause: {
      tool_name: p.tool_name,
      summary: p.summary,
      elicitation_id: row.id,
      input: elicitationInputForClient(p.input),
    },
  };
}
