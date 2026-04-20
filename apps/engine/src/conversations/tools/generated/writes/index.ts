// Hand-written tenant-write tool barrel. All tools:
//   - category: "tenant_write"
//   - write an audit_log row before returning
//   - surface structured errors when the tenant state disallows the op.

import type { ConversationTool } from "../../index.ts";
import { approvePatchCandidateTool, approveSkillCandidateTool } from "./candidates.ts";
import { cleanupWriteTools } from "./cleanup.ts";
import { createApiKeyTool } from "./create-api-key.ts";
import { runWorkflowTool } from "./run-workflow.ts";

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

export const ALL_GENERATED_WRITE_TOOLS: ConversationTool[] = [
  runWorkflowTool,
  approveSkillCandidateTool,
  approvePatchCandidateTool,
  createApiKeyTool,
  ...cleanupWriteTools,
];
