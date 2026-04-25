// Hand-written tenant-write tool barrel. All tools:
//   - category: "tenant_write"
//   - write an audit_log row before returning
//   - surface structured errors when the tenant state disallows the op.

import type { ConversationTool } from "../../index.ts";
import { approvePatchCandidateTool, approveSkillCandidateTool } from "./candidates.ts";
import { cleanupWriteTools } from "./cleanup.ts";
import { createApiKeyTool } from "./create-api-key.ts";
import { runWorkflowTool } from "./run-workflow.ts";
import { scheduleTools } from "./schedules.ts";
import { updateConnectorTool } from "./update-connector.ts";
import { updateKnowledgeSourceTool } from "./update-knowledge-source.ts";
import { updateSubscriptionTool } from "./update-subscription.ts";
import { updateWorkflowTool } from "./update-workflow.ts";

export { approvePatchCandidateTool, approveSkillCandidateTool } from "./candidates.ts";
export {
  deleteConnectorTool,
  deleteKnowledgeSourceTool,
  deleteSubscriptionTool,
  deleteTunnelTool,
  deleteWorkflowTool,
  revokeApiKeyTool,
  revokePortalTokenTool,
} from "./cleanup.ts";
export { createApiKeyTool } from "./create-api-key.ts";
export { runWorkflowTool } from "./run-workflow.ts";
export {
  createScheduleTool,
  deleteScheduleTool,
  listSchedulesTool,
  updateScheduleTool,
} from "./schedules.ts";
export { updateConnectorTool } from "./update-connector.ts";
export { updateKnowledgeSourceTool } from "./update-knowledge-source.ts";
export { updateSubscriptionTool } from "./update-subscription.ts";
export { updateWorkflowTool } from "./update-workflow.ts";

export const ALL_GENERATED_WRITE_TOOLS: ConversationTool[] = [
  runWorkflowTool,
  approveSkillCandidateTool,
  approvePatchCandidateTool,
  createApiKeyTool,
  updateWorkflowTool,
  updateConnectorTool,
  updateKnowledgeSourceTool,
  updateSubscriptionTool,
  ...scheduleTools,
  ...cleanupWriteTools,
];
