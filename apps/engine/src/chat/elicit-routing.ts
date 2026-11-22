import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { humanChatAnswer } from "../conversations/public/authoring.ts";
import {
  ConversationNotFoundError,
  deviceConfirmationPort,
  ElicitationActorMismatchError,
  ElicitationAlreadyResolvedError,
  ElicitationNotFoundError,
  ElicitationValidationError,
  respondElicitation,
} from "../conversations/public/elicitation.ts";
import {
  assertTaskRunWriter,
  registerConversationAbort,
  unregisterConversationAbort,
} from "../conversations/public/lifecycle.ts";
import type { Db } from "../db/client.ts";
import { isNoSuchTool } from "../llm/runtime/sdk-errors.ts";
import { logger } from "../logging/index.ts";
import {
  ChatInteractionEnvelopeSchema,
  ChatViewMetadataSchema,
  validateElicitationOutput,
} from "./api.ts";
import type { DispatchOutcome } from "./dispatcher-types.ts";
import { resolveChatPrincipal } from "./principal.ts";
import { withConversationTurnLock } from "./turn-lock.ts";
import type { ChatEvent, ElicitationKind } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatAnswer {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly elicitation_id: string;
  readonly user_id: string;
  readonly kind: ElicitationKind;
  readonly output: unknown;
}

export type ChatAnswerOutcome =
  | { readonly kind: "invalid" }
  | {
      readonly kind: "answered";
      readonly output: unknown;
      readonly result: Awaited<ReturnType<typeof respondElicitation>>["result"];
    };

export async function answerChatElicitation(db: Db, a: ChatAnswer): Promise<ChatAnswerOutcome> {
  const output = validateElicitationOutput(a.kind, a.output);
  if (output === null) return { kind: "invalid" };
  const principal = await resolveChatPrincipal(db, a.tenant_id, a.user_id);
  await assertTaskRunWriter(db, {
    tenant_id: a.tenant_id,
    conversation_id: a.conversation_id,
    actor_id: a.user_id,
    principal,
  });
  const turnAbortCtrl = await registerConversationAbort(a.tenant_id, a.conversation_id, db);
  try {
    const resolved = await withConversationTurnLock(a.tenant_id, a.conversation_id, () =>
      respondElicitation(
        {
          tenant_id: a.tenant_id,
          conversation_id: a.conversation_id,
          elicitation_id: a.elicitation_id,
          actor_id: a.user_id,
          principal,
          answer_actor: humanChatAnswer(principal),
          output,
          turn_abort_ctrl: turnAbortCtrl,
          require_same_actor: true,
          surface: "chat",
          local_confirmations: deviceConfirmationPort(db),
        },
        db,
      ),
    );
    return { kind: "answered", output, result: resolved.result };
  } finally {
    await unregisterConversationAbort(a.tenant_id, a.conversation_id, turnAbortCtrl);
  }
}

function parseEnvelope(raw: string): { c: string; o?: unknown } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({
      module: "chat",
      action: "interaction.envelope_parse_failed",
      msg: "interaction value is not valid JSON — Block-Kit renderer regression",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const result = ChatInteractionEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({
      module: "chat",
      action: "interaction.envelope_malformed",
      msg: "interaction value did not match the {c,o} envelope schema",
      issues: result.error.issues.map((i) => i.message),
    });
    return null;
  }
  return result.data;
}

function parseViewMetadata(raw: string): { c: string; e: string; k: string } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({
      module: "chat",
      action: "interaction.view_metadata_parse_failed",
      msg: "view.private_metadata is not valid JSON — modal-view builder regression",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const result = ChatViewMetadataSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({
      module: "chat",
      action: "interaction.view_metadata_malformed",
      msg: "view.private_metadata did not match the {c,e,k} schema",
      issues: result.error.issues.map((i) => i.message),
    });
    return null;
  }
  return result.data;
}

type ChatElicitErrorClass =
  | { kind: "actor_mismatch"; audit_reason: "actor_not_owner"; user_text: string }
  | {
      kind: "validation";
      user_text: string;
      field_errors: Array<{ name: string; message: string }>;
    }
  | { kind: "already_resolved" }
  | {
      kind: "not_found";
      audit_reason: "conversation_not_found_for_actor" | "elicitation_not_found";
    }
  | { kind: "surface_unsupported"; user_text: string; tool_name: string }
  | { kind: "rethrow" };

export function classifyChatElicitError(err: unknown): ChatElicitErrorClass {
  if (isNoSuchTool(err)) {
    return {
      kind: "surface_unsupported",
      tool_name: err.toolName,
      user_text:
        "Creating or editing connectors, workflows, skills, or knowledge sources isn't available from chat — this channel is read-only (I can look things up and run your saved workflows). To set that up, use the subkit CLI or the web portal.",
    };
  }
  if (err instanceof ElicitationActorMismatchError) {
    return {
      kind: "actor_mismatch",
      audit_reason: "actor_not_owner",
      user_text: "Only the person who started this request can confirm it.",
    };
  }
  if (err instanceof ElicitationValidationError) {
    const detail = err.field_errors.map((e) => `${e.name}: ${e.message}`).join("; ");
    return {
      kind: "validation",
      field_errors: err.field_errors,
      user_text: `That answer didn't pass validation — ${detail}. Please submit again.`,
    };
  }
  if (err instanceof ElicitationAlreadyResolvedError) return { kind: "already_resolved" };
  if (err instanceof ConversationNotFoundError) {
    return { kind: "not_found", audit_reason: "conversation_not_found_for_actor" };
  }
  if (err instanceof ElicitationNotFoundError) {
    return { kind: "not_found", audit_reason: "elicitation_not_found" };
  }
  return { kind: "rethrow" };
}

interface RouteChatInteractionArgs {
  ev: ChatEvent;
  tenant_id: string;
  user_id: string;
  db: Db;
  notify?: (text: string) => Promise<void>;
}

export async function routeChatInteraction(
  args: RouteChatInteractionArgs,
): Promise<DispatchOutcome> {
  const { ev, tenant_id, user_id, db, notify } = args;
  if (ev.kind !== "interaction" || !ev.interaction) return { status: "ignored" };

  const action_id = ev.interaction.action_id;
  const actionValue = ev.interaction.value ?? "";

  if (/^elicit:[^:]+:multi:select$/.test(action_id)) {
    return { status: "ignored" };
  }
  if (/^open_elicit:/.test(action_id)) {
    return { status: "ignored" };
  }

  let conversation_id = "";
  let elicitation_id = "";
  let rawOutput: unknown = null;
  let kind: ElicitationKind | null = null;

  const approval = /^(approve|reject):(.+)$/.exec(action_id);
  if (approval) {
    if (actionValue.startsWith("{")) {
      logger.warn({
        module: "chat",
        action: "interaction.approval_value_shape_mismatch",
        msg: "approve/reject action carries an envelope-shaped value — renderer regression?",
        action_id,
      });
      return { status: "ignored" };
    }
    const approvalElicId = approval[2] ?? "";
    if (!UUID_RE.test(approvalElicId) || !UUID_RE.test(actionValue)) {
      logger.warn({
        module: "chat",
        action: "interaction.approval_ids_malformed",
        msg: "approve/reject action carries non-UUID ids — discarding",
        action_id,
      });
      return { status: "ignored" };
    }
    elicitation_id = approvalElicId;
    conversation_id = actionValue;
    kind = "confirm";
    rawOutput = { confirmed: approval[1] === "approve" };
  } else {
    const elicit = /^elicit:([^:]+):(confirm|choice|multi:submit)$/.exec(action_id);
    if (elicit) {
      elicitation_id = elicit[1] ?? "";
      const envelope = parseEnvelope(actionValue);
      conversation_id = envelope?.c ?? "";
      const suffix = elicit[2];
      kind = suffix === "confirm" ? "confirm" : suffix === "choice" ? "choice" : "multi";
      if (suffix === "multi:submit") {
        rawOutput = ev.interaction.form_values ?? null;
      } else {
        rawOutput = envelope?.o ?? null;
      }
      if (rawOutput === null) {
        logger.warn({
          module: "chat",
          action: "interaction.elicit_missing_output",
          msg: "elicit:* action arrived without an output envelope — discarding",
          action_id,
        });
        return { status: "ignored" };
      }
    } else if (action_id === "view_submission") {
      const meta = parseViewMetadata(actionValue);
      if (!meta) return { status: "ignored" };
      conversation_id = meta.c;
      elicitation_id = meta.e;
      const fv = ev.interaction.form_values ?? {};
      if (meta.k === "text") {
        rawOutput = { text: typeof fv.answer === "string" ? fv.answer : "" };
        kind = "text";
      } else {
        rawOutput = fv;
        kind = "form";
      }
    } else {
      return { status: "ignored" };
    }
  }

  if (!conversation_id || !elicitation_id || kind === null) {
    return { status: "ignored" };
  }

  let output: unknown;
  try {
    const answered = await answerChatElicitation(db, {
      tenant_id,
      conversation_id,
      elicitation_id,
      user_id,
      kind,
      output: rawOutput,
    });
    if (answered.kind === "invalid") {
      logger.warn({
        module: "chat",
        action: "interaction.output_shape_invalid",
        msg: "elicitation output failed schema validation — discarding",
        kind,
        action_id,
      });
      return { status: "ignored" };
    }
    output = answered.output;
  } catch (err) {
    const classified = classifyChatElicitError(err);
    switch (classified.kind) {
      case "actor_mismatch": {
        if (notify) {
          try {
            await notify(classified.user_text);
          } catch {}
        }
        await auditAwait(
          {
            tenant_id,
            actor_type: "user",
            actor_id: user_id,
            action: AuditAction.CHAT_MESSAGE_DENIED,
            resource_type: "conversation_elicitation",
            resource_id: elicitation_id,
            result: "denied",
            reason: classified.audit_reason,
            metadata: {
              conversation_id,
              kind,
            },
          },
          db,
        );
        return { status: "ignored", conversation_id };
      }
      case "validation": {
        if (notify) {
          try {
            await notify(classified.user_text);
          } catch {}
        }
        logger.warn({
          module: "chat",
          action: "interaction.elicitation_validation_failed",
          msg: "elicitation answer failed validation — row stays pending, user re-prompted",
          tenant_id,
          elicitation_id,
          conversation_id,
          field_errors: classified.field_errors,
        });
        return { status: "ignored", conversation_id };
      }
      case "surface_unsupported": {
        if (notify) {
          try {
            await notify(classified.user_text);
          } catch {}
        }
        logger.warn({
          module: "chat",
          action: "interaction.surface_unsupported_tool",
          msg: "resumed chat turn called a tool absent from the read-only palette — redirected user, swallowed",
          tenant_id,
          elicitation_id,
          conversation_id,
          tool_name: classified.tool_name,
        });
        return { status: "ignored", conversation_id };
      }
      case "already_resolved": {
        return { status: "ignored", conversation_id };
      }
      case "not_found": {
        await auditAwait(
          {
            tenant_id,
            actor_type: "user",
            actor_id: user_id,
            action: AuditAction.CHAT_MESSAGE_DENIED,
            resource_type: "conversation_elicitation",
            resource_id: elicitation_id,
            result: "denied",
            reason: classified.audit_reason,
            metadata: {
              conversation_id,
              kind,
              action_id,
            },
          },
          db,
        );
        return { status: "ignored", conversation_id };
      }
      default:
        throw err;
    }
  }
  const isApprove =
    approval?.[1] === "approve" ||
    (typeof output === "object" &&
      output !== null &&
      (output as { confirmed?: boolean }).confirmed === true);
  return {
    status: isApprove ? "approved" : "rejected",
    conversation_id,
  };
}
