// In-band confirm resolver for an MCP tools/call.
//
// A `confirm_before_execution` gate needs a HUMAN, and the approval portal is
// where that human always is. When the client advertises elicitation, one may
// ALSO be reachable inside the call: `elicitation/create` puts the prompt in
// front of them and this resolver returns their answer to the caller's gate.
//
// So the in-band prompt is an OPTIMIZATION over the portal round-trip, never a
// substitute for it. Production settles the point: 29 `elicitation/create`
// timeouts across the full journal retention, and not one fulfilled prompt,
// ever. Three consequences:
//   - When the call ALREADY carries a confirm marker (`_meta.sk_confirm` /
//     `sk_confirm_id`), the caller is TRIGGERING an approval a human already
//     granted. Attaching a resolver would force a second prompt, so we return
//     `undefined` and let `consumeApproval` (tools/approval.ts) claim the
//     single-use approval and replay the args the engine already holds.
//   - An explicit `decline` (or an `accept` that answers "no") is an ANSWER. The
//     caller declines the approval; it is terminal and never becomes claimable.
//     A decline that lands after this resolver's own timeout still reaches the
//     caller's `declineApproval`, and is still honored — the approval was never
//     granted, so nothing could have been claimed in the meantime.
//   - An elicitation that is never fulfilled — the client advertised the
//     capability but did not answer, or the round-trip exceeded the bridge's
//     bounded timeout — is `unreachable`, NOT a decline. The engine holds no
//     decision from anyone. The approval stays UNGRANTED and its `approval_url`
//     goes back to the caller, so a person can still decide.

import { logger } from "../../logging/logger.ts";
import { CONFIRM_REASON_LABELS } from "../../tools/policy.ts";
import type { ConfirmDecision, ConfirmEnvelope, ConfirmResolver } from "../../tools/types.ts";
import type { ElicitationBridge } from "./bridge.ts";

/** One-line operator prompt for an in-band confirm elicitation. Renders the
 *  envelope's structured preview — never the call payload, which the engine
 *  already holds under `tool_call_id`. */
function buildConfirmPrompt(confirm: ConfirmEnvelope): string {
  const reason = CONFIRM_REASON_LABELS[confirm.reason];
  if (!confirm.pending_output) return `Approve ${confirm.tool} (${reason})?`;
  let preview: string;
  try {
    const json = JSON.stringify(confirm.pending_output);
    preview = json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    preview = "(unserializable)";
  }
  return `Approve ${confirm.tool} (${reason})? ${preview}`;
}

/** Single-field confirm schema accepted by MCP `elicitation/create` form mode. */
const CONFIRM_ELICIT_SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "Proceed?",
      description: "Confirm to run the call; decline to cancel.",
    },
  },
  required: ["confirm"],
};

/**
 * Build the in-band confirm resolver for a tools/call, or `undefined` when no
 * resolver should be attached (a confirm marker is present, or the client cannot
 * do form elicitation). See the file header for the rationale.
 */
export function buildElicitConfirmResolver(opts: {
  bridge: ElicitationBridge;
  carriesInbandConfirm: boolean;
  toolName: string;
  principalId: string;
  tenantId: string;
}): ConfirmResolver | undefined {
  const { bridge, carriesInbandConfirm, toolName, principalId, tenantId } = opts;
  if (carriesInbandConfirm || !bridge.capabilities.form) return undefined;
  return async (confirm: ConfirmEnvelope): Promise<ConfirmDecision> => {
    try {
      const res = await bridge.elicitForm({
        message: buildConfirmPrompt(confirm),
        requestedSchema: CONFIRM_ELICIT_SCHEMA,
      });
      const approved = res.action === "accept" && res.content?.confirm === true;
      if (approved) return "approved";
      // A person answered. `decline`, `cancel`, and an `accept` carrying
      // `confirm:false` are all a "no" — the one outcome that is terminal.
      logger.info({
        module: "mcp",
        action: "mcp.elicit.declined",
        msg: "a person answered the in-band approval prompt with no; nothing ran",
        tool: toolName,
        elicit_action: res.action,
        principal_id: principalId,
        tenant_id: tenantId,
      });
      return "declined";
    } catch (err) {
      // Advertisement ≠ fulfilment: a client may advertise the elicitation
      // capability yet never answer the elicitation/create round-trip (or exceed
      // its bounded timeout). The engine holds no decision — which does not mean
      // nobody was asked; this client may be showing its operator the prompt
      // right now. Reporting it as a decline would put words in a person's mouth.
      // The approval stays ungranted and the caller hands back its approval_url.
      logger.warn({
        module: "mcp",
        action: "mcp.elicit.unreachable",
        msg: "client advertised elicitation but did not answer the prompt; the engine holds no decision — the approval waits for a human at its approval_url",
        tool: toolName,
        approval_id: confirm.tool_call_id,
        error: err instanceof Error ? err.message : String(err),
        principal_id: principalId,
        tenant_id: tenantId,
      });
      return "unreachable";
    }
  };
}
