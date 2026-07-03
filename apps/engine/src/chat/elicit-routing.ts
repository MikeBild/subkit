// Routing for inbound chat interactions (Block-Kit clicks, view
// submissions, legacy approve/reject) into the conversation
// pipeline's `respondElicitation`. Extracted from `dispatcher.ts`
// to keep that file under the audit-invariant size cap and because
// the interaction-routing block is self-contained: it takes the
// `ChatEvent`, the resolved `tenant_id` + `user_id`, the `Db`, and
// returns a `DispatchOutcome` — no closure over the rest of the
// dispatcher's per-turn state.
//
// Action-id family discrimination is documented in the dispatcher's
// header. This module owns the per-family parse + per-kind output
// validation (via `validateElicitationOutput` in `chat/api.ts`).

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../conversations/abort.ts";
import {
  ConversationNotFoundError,
  ElicitationActorMismatchError,
  ElicitationNotFoundError,
  ElicitationValidationError,
} from "../conversations/service/elicit.ts";
import { ElicitationAlreadyResolvedError, respondElicitation } from "../conversations/service.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import {
  ChatInteractionEnvelopeSchema,
  ChatViewMetadataSchema,
  validateElicitationOutput,
} from "./api.ts";
import type { DispatchOutcome } from "./dispatcher-types.ts";
import { resolveChatPrincipal } from "./principal.ts";
import { withConversationTurnLock } from "./turn-lock.ts";
import type { ChatEvent, ElicitationKind } from "./types.ts";

/** UUID v4-friendly shape check. Used before any string from an
 *  attacker-controlled Block-Kit envelope or modal `private_metadata`
 *  reaches a `uuid`-typed Postgres column — feeding `eq(uuid_col, "junk")`
 *  through drizzle would throw `invalid input syntax for type uuid`,
 *  which escapes the dispatcher → pg-boss retries the job 3× before
 *  DLQ-ing, with no deny audit row. Bouncing the click here turns it
 *  into one deterministic `ignored` outcome. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a Block-Kit action `value` JSON envelope `{c, o}` carrying
 *  the conversation_id (`c`, UUID) and typed elicitation output (`o`).
 *  Backed by `ChatInteractionEnvelopeSchema` so a contract drift
 *  (renamed field, non-UUID id) fails at the schema boundary. */
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

/** Parse the Slack modal `private_metadata` JSON `{c, e, k}` carrying
 *  conversation_id, elicitation_id, and the elicitation kind. Backed
 *  by `ChatViewMetadataSchema`. */
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

/** Classified reaction to a `respondElicitation` failure on the chat
 *  surface. Shared by `routeChatInteraction` (button/modal path) and
 *  the dispatcher's typed-reply salvage so the two paths can never
 *  drift in how they map the same error. Callers own their audit +
 *  notify + return shapes; this owns only the mapping. */
export type ChatElicitErrorClass =
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
  | { kind: "rethrow" };

export function classifyChatElicitError(err: unknown): ChatElicitErrorClass {
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

export interface RouteChatInteractionArgs {
  ev: ChatEvent;
  tenant_id: string;
  user_id: string;
  db: Db;
  /** Posts a short text back to the originating channel/thread. Used
   *  for the validation re-prompt — the elicitation stays pending, so
   *  the user can answer the same prompt again. */
  notify?: (text: string) => Promise<void>;
}

/**
 * Route a `kind: "interaction"` ChatEvent through `respondElicitation`.
 *
 * Action-id families:
 *   approve:<elic_id> / reject:<elic_id>
 *       Legacy ApprovalCard path (kept; the existing block-kit
 *       Approve/Reject card is still a valid render).
 *   elicit:<elic_id>:confirm | :choice | :multi:select | :multi:submit
 *       Native rendering. Value carries a JSON envelope
 *       `{c: conversation_id, o: <typed output>}`. `multi:select` is
 *       the per-checkbox change event; ignored — the dispatcher acts
 *       on `multi:submit` only.
 *   view_submission
 *       Slack modal submission. `value` is the modal's
 *       `private_metadata` JSON `{c, e, k}`; `form_values` is the
 *       flat `{field_name: primitive}` dict the adapter assembled.
 *   open_elicit:<elic_id>
 *       Handled synchronously by the route's `handleSyncInteraction`
 *       fast path; ignored defensively if it reaches here.
 */
export async function routeChatInteraction(
  args: RouteChatInteractionArgs,
): Promise<DispatchOutcome> {
  const { ev, tenant_id, user_id, db, notify } = args;
  if (ev.kind !== "interaction" || !ev.interaction) return { status: "ignored" };

  const action_id = ev.interaction.action_id;
  const actionValue = ev.interaction.value ?? "";

  // No-op: per-checkbox change. We resolve on the submit click.
  if (/^elicit:[^:]+:multi:select$/.test(action_id)) {
    return { status: "ignored" };
  }
  // No-op: opener click handled by the sync fast path.
  if (/^open_elicit:/.test(action_id)) {
    return { status: "ignored" };
  }

  let conversation_id = "";
  let elicitation_id = "";
  let rawOutput: unknown = null;
  let kind: ElicitationKind | null = null;

  const legacy = /^(approve|reject):(.+)$/.exec(action_id);
  if (legacy) {
    // Legacy ApprovalCard: value is the bare conversation_id (raw
    // string, NOT JSON). A JSON-shaped value here means a renderer
    // emitted the new `{c,o}` envelope under a legacy action_id —
    // fail-closed log so the renderer regression surfaces before
    // we feed a JSON string into `respondElicitation` as the
    // conversation_id.
    if (actionValue.startsWith("{")) {
      logger.warn({
        module: "chat",
        action: "interaction.legacy_value_shape_mismatch",
        msg: "approve/reject action carries an envelope-shaped value — renderer regression?",
        action_id,
      });
      return { status: "ignored" };
    }
    const legacyElicId = legacy[2] ?? "";
    // Crafted action_id (e.g. `approve:not-a-uuid`) or value would
    // reach a `uuid`-typed Postgres column as raw text and throw
    // `invalid input syntax for type uuid`, escaping into pg-boss
    // (3× retry storm, no deny audit). Validate up front; ignore
    // silently so SIEM sees the noise via the structured log alone.
    if (!UUID_RE.test(legacyElicId) || !UUID_RE.test(actionValue)) {
      logger.warn({
        module: "chat",
        action: "interaction.legacy_ids_malformed",
        msg: "approve/reject action carries non-UUID ids — discarding",
        action_id,
      });
      return { status: "ignored" };
    }
    elicitation_id = legacyElicId;
    conversation_id = actionValue;
    kind = "confirm";
    // Invariant: rawOutput here is engine-constructed from the
    // regex-validated `approve|reject` capture, NOT from any
    // attacker-controlled payload field. If a future caller adds a
    // new legacy action_id, it MUST keep `rawOutput` engine-constructed
    // — the validateElicitationOutput pass below trusts the kind
    // matches and would silently accept a maliciously-shaped output
    // that happened to fit the confirm schema.
    rawOutput = { confirmed: legacy[1] === "approve" };
  } else {
    const elicit = /^elicit:([^:]+):(confirm|choice|multi:submit)$/.exec(action_id);
    if (elicit) {
      elicitation_id = elicit[1] ?? "";
      // The conversation_id always rides in the envelope's `c` —
      // including for `multi:submit`, where the typed selections come
      // from `form_values` rather than the envelope's `o`. Renderer
      // invariant (`chat/slack/block-kit.ts` Submit button): the
      // Submit button's `value` is `envelope(conversation_id, {kind:
      // "multi"})`, so production never emits a malformed envelope
      // here. A malformed envelope on Submit therefore signals either
      // a renderer regression or a crafted click — discarding it is
      // safer than guessing the conversation from elsewhere.
      const envelope = parseEnvelope(actionValue);
      conversation_id = envelope?.c ?? "";
      // Map the action_id suffix to the elicitation kind so the per-
      // kind output schema below validates against the right shape.
      const suffix = elicit[2];
      kind = suffix === "confirm" ? "confirm" : suffix === "choice" ? "choice" : "multi";
      // For `multi:submit` the typed selections come from form_values
      // (the adapter re-encoded the checkbox state); for confirm /
      // choice the typed output rides in the envelope's `o`.
      if (suffix === "multi:submit") {
        rawOutput = ev.interaction.form_values ?? null;
      } else {
        rawOutput = envelope?.o ?? null;
      }
      // Reject when the envelope's `o` is missing for an elicit:*
      // action: silently passing `{}` would resolve the elicitation
      // under whatever branch `respondElicitation` treats as default
      // (e.g. a missing `confirmed:true` falls through to a reject)
      // — that's how a crafted button click could silently reject
      // another user's elicitation.
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
      // form_values is the flat dict the adapter assembled from
      // view.state.values; map it to the right output shape per
      // elicitation kind.
      const fv = ev.interaction.form_values ?? {};
      if (meta.k === "text") {
        // ask_user_text expects `{ text }`. The single-field modal
        // stores the answer under the field name `answer`.
        rawOutput = { text: typeof fv.answer === "string" ? fv.answer : "" };
        kind = "text";
      } else {
        // ask_user_form passes the whole field dict through.
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

  // Slack signed the outer payload so the user is authenticated, but
  // the SHAPE of `o` / form_values is still attacker-controlled.
  // Validate against the per-kind schema before handing the output
  // deep into the conversation pipeline; a mismatch is treated as a
  // crafted click and dropped with a warn.
  const output = validateElicitationOutput(kind, rawOutput);
  if (output === null) {
    logger.warn({
      module: "chat",
      action: "interaction.output_shape_invalid",
      msg: "elicitation output failed schema validation — discarding",
      kind,
      action_id,
    });
    return { status: "ignored" };
  }

  // Every respondElicitation caller threads an abort controller so a
  // mid-turn dispose can cleanly interrupt the loop. `require_same_actor`
  // gates against the same-tenant cross-actor case: a posted Block-Kit
  // button is visible to every user in the channel, so without this
  // check user B could resolve user A's pending elicitation.
  const turnAbortCtrl = registerConversationAbort(tenant_id, conversation_id);
  // Synthetic chat principal so the resumed turn gates on the linked
  // user's RBAC instead of failing `principal_required`.
  const principal = await resolveChatPrincipal(db, tenant_id, user_id);
  try {
    // Same per-conversation serialization the dispatcher's turn paths
    // use: the resume drives runLoop on the shared space conversation
    // and must not interleave with an in-flight mention turn.
    await withConversationTurnLock(tenant_id, conversation_id, () =>
      respondElicitation(
        {
          tenant_id,
          conversation_id,
          elicitation_id,
          actor_id: user_id,
          principal,
          output,
          turn_abort_ctrl: turnAbortCtrl,
          require_same_actor: true,
          // The RESUMED turn re-assembles the palette — without the chat
          // surface it would fall back to the full authoring set (the
          // fail-open this parameter exists to close).
          surface: "chat",
        },
        db,
      ),
    );
  } catch (err) {
    const classified = classifyChatElicitError(err);
    switch (classified.kind) {
      case "actor_mismatch": {
        // A space conversation is shared: every linked member sees the
        // approval card, but only the initiator may resolve it. Tell the
        // clicking user why nothing happened (best-effort) instead of
        // silently ignoring the click.
        if (notify) {
          try {
            await notify(classified.user_text);
          } catch {
            /* best-effort: the audit row below still records the denial */
          }
        }
        // Surface a denied audit row so the cross-actor attempt is
        // visible in SIEM; return ignored so the dispatcher's outer
        // outcome is unchanged.
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
        // Answer failed server-side validation — the row stays pending,
        // so a re-submit against the same elicitation works. Tell the
        // user what to fix (best-effort) and swallow the error: pg-boss
        // retrying this job would just re-submit the same invalid answer.
        if (notify) {
          try {
            await notify(classified.user_text);
          } catch {
            /* best-effort: the structured log below still records it */
          }
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
      case "already_resolved": {
        // Raced double-click / double-answer: someone (or a retry)
        // already resolved this elicitation. The winning resolution
        // posted its own reply — silently drop the loser instead of
        // escaping into pg-boss (retry → dedup-swallow, same failure
        // class the typed-reply salvage closes).
        return { status: "ignored", conversation_id };
      }
      case "not_found": {
        // Crafted click carrying a real UUID that belongs to another
        // tenant (or a stale id that's been deleted). Bare-throwing
        // would escape into pg-boss, which retries the job 3× before
        // DLQ — wasted compute AND no deny audit row. Audit + silent
        // drop is the right shape.
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
  } finally {
    unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl);
  }
  const isApprove =
    legacy?.[1] === "approve" ||
    (typeof output === "object" &&
      output !== null &&
      (output as { confirmed?: boolean }).confirmed === true);
  return {
    status: isApprove ? "approved" : "rejected",
    conversation_id,
  };
}
