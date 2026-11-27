import { getConnector as loadConnector } from "../../../connectors/index.ts";
import { logger } from "../../../logging/index.ts";
import {
  describeLocalCommand,
  isConfirmedLocalCommand,
  isStdioDraft,
  localCommandFingerprint,
  readLocalCommand,
} from "../../local-command.ts";
import {
  confirmLocalCommandForConnector,
  localCommandRefusal,
  localCommandRefusalFor,
  OWNER_MUST_CONFIRM,
} from "../../local-command-confirm.ts";
import type { ToolResult } from "../../tools/index.ts";
import { resolveConversationPrincipal } from "../../tools/permission-gate.ts";
import { probeConnectorDraftTool } from "../../tools/probe-connector-draft.ts";
import { saveConnectorAtomic } from "../save-connector.ts";
import { maybeAutoFreshenCheckpointsForSave } from "./dispatch.ts";
import { readString } from "./helpers.ts";
import type { CommitEnv } from "./types.ts";

function savedIdFrom(result: ToolResult): string | null {
  const data =
    result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
  const connector =
    data.connector && typeof data.connector === "object"
      ? (data.connector as Record<string, unknown>)
      : null;
  if (typeof connector?.id === "string") return connector.id;
  return typeof data.resource_id === "string" ? data.resource_id : null;
}

export async function confirmLocalCommandIntent({
  p,
  intent,
  ctx,
}: CommitEnv): Promise<ToolResult> {
  if (p.answer_actor.kind !== "human") {
    logger.warn({
      module: "conversation_persistence",
      action: "auto_persist.local_command_not_confirmed_by_relay",
      msg: "a local command confirmation was answered by a non-human actor; nothing was started",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation.id,
      relay_reason: p.answer_actor.reason,
    });
    return localCommandRefusal(
      "mcp_local_command_unconfirmed",
      `Nothing was started. Only a person can allow a local command; an answer relayed by a model or a machine client does not count. ${OWNER_MUST_CONFIRM}`,
      ["cannot_help"],
    );
  }
  const connector = ctx.getDraft().connector;
  const spec = readLocalCommand(connector?.config);
  if (!connector || !isStdioDraft(connector) || !spec) {
    return localCommandRefusal(
      "invalid_commit_intent",
      "The draft no longer describes a local command, so nothing was confirmed or started.",
      ["inspect_connector_draft"],
    );
  }
  if (readString(intent.payload, "command_sha256") !== localCommandFingerprint(spec)) {
    return localCommandRefusal(
      "mcp_local_command_changed",
      `The command changed after the question was shown, so nothing was confirmed or started. Probe again to ask about the current command:\n${describeLocalCommand(spec)}`,
      ["probe_connector_draft"],
    );
  }
  const principal = p.principal ?? (await resolveConversationPrincipal(ctx));
  if (!principal || principal.kind !== "user" || principal.id !== p.answer_actor.user_id) {
    return localCommandRefusal(
      "mcp_local_command_unconfirmed",
      `Nothing was started. The person who answered could not be matched to this conversation's account. ${OWNER_MUST_CONFIRM}`,
      ["cannot_help"],
    );
  }

  await maybeAutoFreshenCheckpointsForSave(ctx);
  const saved = await saveConnectorAtomic({
    ctx,
    environment: connector.environment ?? "dev",
    reason: "local_command_confirmation",
    emitAutoPersistAudit: true,
    commitIntentKind: intent.kind,
    skipBackgroundDiscovery: true,
    localCommandConfirmation: true,
  });
  if (!saved.ok) return saved;
  const connectorId = ctx.getDraft().connector?.saved_connector_id ?? savedIdFrom(saved);
  if (!connectorId) {
    return localCommandRefusal(
      "connector_not_saved",
      "The connector could not be saved, so the command was not confirmed or started.",
      ["inspect_connector_draft", "save_connector_draft"],
    );
  }

  const outcome = await confirmLocalCommandForConnector({
    db: p.db,
    tenant_id: p.tenant_id,
    connector_id: connectorId,
    principal,
    expected_command_hash: localCommandFingerprint(spec),
  });
  if (!outcome.ok) return localCommandRefusalFor(outcome.code, outcome.message);
  const row = await loadConnector(p.tenant_id, connectorId, p.db);
  if (!isConfirmedLocalCommand((row?.config ?? null) as Record<string, unknown> | null, spec)) {
    return localCommandRefusal(
      "mcp_local_command_unconfirmed",
      "The engine did not record the confirmation for this exact command, so nothing was started. Ask an owner or admin to allow it in the Cockpit.",
      ["cannot_help"],
    );
  }

  const probeArgs =
    intent.payload.probe_args && typeof intent.payload.probe_args === "object"
      ? (intent.payload.probe_args as Record<string, unknown>)
      : {};
  return probeConnectorDraftTool.execute(ctx, probeArgs);
}
