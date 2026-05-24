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

import { registerConversationAbort, unregisterConversationAbort } from "../conversations/abort.ts";
import { respondElicitation } from "../conversations/service.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import { validateElicitationOutput } from "./api.ts";
import type { DispatchOutcome } from "./dispatcher-types.ts";
import type { ChatEvent, ElicitationKind } from "./types.ts";

/** Parse a Block-Kit action `value` JSON envelope `{c, o}` carrying
 *  the conversation_id (`c`) and typed elicitation output (`o`).
 *  Invalid / non-JSON values return null so the caller can ignore. */
function parseEnvelope(raw: string): { c: string; o?: unknown } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.c === "string") {
      return parsed as { c: string; o?: unknown };
    }
    logger.warn({
      module: "chat",
      action: "interaction.envelope_malformed",
      msg: "interaction value JSON-parsed but did not match the {c,o} envelope shape",
    });
  } catch (err) {
    logger.warn({
      module: "chat",
      action: "interaction.envelope_parse_failed",
      msg: "interaction value is not valid JSON — Block-Kit renderer regression?",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/** Parse the Slack modal `private_metadata` JSON `{c, e, k}` carrying
 *  conversation_id, elicitation_id, and the elicitation kind. */
function parseViewMetadata(raw: string): { c: string; e: string; k: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.c === "string" &&
      typeof parsed.e === "string" &&
      typeof parsed.k === "string"
    ) {
      return parsed as { c: string; e: string; k: string };
    }
    logger.warn({
      module: "chat",
      action: "interaction.view_metadata_malformed",
      msg: "view.private_metadata JSON-parsed but did not match the {c,e,k} shape",
    });
  } catch (err) {
    logger.warn({
      module: "chat",
      action: "interaction.view_metadata_parse_failed",
      msg: "view.private_metadata is not valid JSON — modal-view builder regression?",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

export interface RouteChatInteractionArgs {
  ev: ChatEvent;
  tenant_id: string;
  user_id: string;
  db: Db;
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
  const { ev, tenant_id, user_id, db } = args;
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
    elicitation_id = legacy[2] ?? "";
    conversation_id = actionValue;
    kind = "confirm";
    rawOutput = { confirmed: legacy[1] === "approve" };
  } else {
    const elicit = /^elicit:([^:]+):(confirm|choice|multi:submit)$/.exec(action_id);
    if (elicit) {
      elicitation_id = elicit[1] ?? "";
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
  // mid-turn dispose can cleanly interrupt the loop.
  const turnAbortCtrl = registerConversationAbort(tenant_id, conversation_id);
  try {
    await respondElicitation(
      {
        tenant_id,
        conversation_id,
        elicitation_id,
        actor_id: user_id,
        output,
        turn_abort_ctrl: turnAbortCtrl,
      },
      db,
    );
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
