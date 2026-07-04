// In-band confirm resolver for an MCP tools/call.
//
// A `confirm_before_execution` gate returns a `needs_confirm` envelope. When
// the client advertises elicitation, we can resolve that gate in-band by
// prompting the operator via `elicitation/create` instead of handing back an
// envelope the model cannot satisfy (a model-only client cannot set `_meta`).
//
// This in-band path is a best-effort OPTIMIZATION layered on top of the
// always-present `confirm_tool_call` responder — not the primary path:
//   - When the call ALREADY carries an in-band confirm marker
//     (`_meta.sk_confirm` / `sk_confirm_id`), the caller is resolving a
//     previously-issued durable confirmation out-of-band. Attaching a resolver
//     would force a SECOND prompt and dead-end a programmatic driver, so we
//     return `undefined` and let `verifyMcpConfirmation` adjudicate the token.
//   - When the elicitation is not fulfilled (the client advertised the
//     capability but never answers, or exceeds the bridge's bounded timeout),
//     we treat it as a decline so the dispatcher returns the durable
//     `needs_confirm` envelope and the model approves via `confirm_tool_call`.

import { logger } from "../../logging/logger.ts";
import type { ConfirmEnvelope } from "../../tools/types.ts";
import type { ConfirmResolver } from "../adapter.ts";
import type { ElicitationBridge } from "./bridge.ts";

/** One-line operator prompt for an in-band confirm elicitation. */
function buildConfirmPrompt(confirm: ConfirmEnvelope): string {
  const reason = confirm.reason.replace(/_/g, " ");
  let argsPreview = "";
  try {
    const json = JSON.stringify(confirm.args);
    argsPreview = json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    argsPreview = "(unserializable)";
  }
  return `Approve ${confirm.tool} (${reason})? Arguments: ${argsPreview}`;
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
 * resolver should be attached (an out-of-band confirm marker is present, or the
 * client cannot do form elicitation). See the file header for the rationale.
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
  return async (confirm: ConfirmEnvelope): Promise<boolean> => {
    try {
      const res = await bridge.elicitForm({
        message: buildConfirmPrompt(confirm),
        requestedSchema: CONFIRM_ELICIT_SCHEMA,
      });
      return res.action === "accept" && res.content?.confirm === true;
    } catch (err) {
      // Advertisement ≠ fulfilment: a client may advertise the elicitation
      // capability yet never answer the elicitation/create round-trip (or
      // exceed its bounded timeout). Treat any elicit failure as a decline —
      // the dispatcher then returns the durable needs_confirm envelope
      // (carrying tool_call_id + resume), and the model approves out-of-band
      // via the always-present confirm_tool_call tool. This is the same seam
      // as an explicit operator decline; it never auto-approves and keeps the
      // audit gate intact.
      logger.info({
        module: "mcp",
        action: "mcp.elicit.fallback",
        msg: "elicitation unfulfilled; returning durable confirm envelope for confirm_tool_call fallback",
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
        principal_id: principalId,
        tenant_id: tenantId,
      });
      return false;
    }
  };
}
