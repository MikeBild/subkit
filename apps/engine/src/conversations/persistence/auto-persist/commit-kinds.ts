import {
  CreateApiKeyInput,
  createApiKeyTool,
} from "../../tools/engine-api/writes/create-api-key.ts";
import {
  UpdateWorkflowInput,
  updateWorkflowTool,
} from "../../tools/engine-api/writes/update-workflow.ts";
import { executeConfirmedToolCall, grantRelayedToolCall } from "./confirmed-call-kinds.ts";
import { completeCredentialFlow } from "./credential-kinds.ts";
import {
  dispatchDeleteConnector,
  dispatchDeleteWorkflow,
  dispatchRollbackSkipped,
} from "./dispatch.ts";
import { commitHeldWorkflowWrites } from "./held-writes-kind.ts";
import { readString } from "./helpers.ts";
import { runWorkflowIntent } from "./run-kind.ts";
import { applyWorkflowPatch, saveConnectorDraft, saveWorkflowDraft } from "./save-kinds.ts";
import { intentToolName } from "./synthetic.ts";
import type { CommitEnv, CommitOutcome } from "./types.ts";

export async function dispatchCommitIntent(env: CommitEnv): Promise<CommitOutcome> {
  const { intent, ctx } = env;
  switch (intent.kind) {
    case "save_connector_draft":
      return { toolName: "save_connector_draft", result: await saveConnectorDraft(env) };
    case "save_workflow_draft":
      return { toolName: "save_workflow_draft", result: await saveWorkflowDraft(env) };
    case "apply_workflow_patch":
      return { toolName: "edit_workflow_patch", result: await applyWorkflowPatch(env) };
    case "delete_connector":
      return { toolName: "delete_connector", result: await dispatchDeleteConnector(ctx, intent) };
    case "delete_workflow":
      return { toolName: "delete_workflow", result: await dispatchDeleteWorkflow(ctx, intent) };
    case "rollback_after_execute":
      return {
        toolName: "rollback_after_execute",
        result: await dispatchRollbackSkipped(ctx, intent),
      };
    case "run_workflow":
      return { toolName: "run_workflow", result: await runWorkflowIntent(env) };
    case "commit_held_workflow_writes": {
      const toolName = intentToolName(intent);
      return { toolName, result: await commitHeldWorkflowWrites(env, toolName) };
    }
    case "execute_confirmed_tool_call": {
      const gatedToolName = readString(intent.payload, "tool");
      const approvalId = readString(intent.payload, "approval_id");
      return {
        toolName: gatedToolName ?? intentToolName(intent),
        result: await executeConfirmedToolCall(env, gatedToolName, approvalId),
      };
    }
    case "grant_relayed_tool_call": {
      const relayedTool = readString(intent.payload, "tool");
      const approvalId = readString(intent.payload, "approval_id");
      return {
        toolName: relayedTool ?? intentToolName(intent),
        result: await grantRelayedToolCall(env, relayedTool, approvalId),
      };
    }
    case "create_api_key":
      return {
        toolName: "create_api_key",
        result: await createApiKeyTool.execute(ctx, CreateApiKeyInput.parse(intent.payload)),
      };
    case "update_workflow_metadata":
      return {
        toolName: "update_workflow",
        result: await updateWorkflowTool.execute(ctx, UpdateWorkflowInput.parse(intent.payload)),
      };
    case "oauth_completed":
      return { toolName: "authenticate_oauth", result: await completeCredentialFlow(env, true) };
    case "credential_reissue_completed":
      return {
        toolName: "request_connector_reauth",
        result: await completeCredentialFlow(env, false),
      };
  }
}
