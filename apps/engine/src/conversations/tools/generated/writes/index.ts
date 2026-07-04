// Hand-written tenant-write tool barrel. All tools:
//   - category: "tenant_write"
//   - write an audit_log row before returning
//   - surface structured errors when the tenant state disallows the op.

import type { ConversationTool } from "../../index.ts";
import { analyzeKnowledgeSourceTool } from "./analyze-knowledge-source.ts";
import { approvePatchCandidateTool, approveSkillCandidateTool } from "./candidates.ts";
import { cleanupWriteTools } from "./cleanup.ts";
import { createApiKeyTool } from "./create-api-key.ts";
import { createKnowledgeSourceTool } from "./create-knowledge-source.ts";
import { createSkillTool } from "./create-skill.ts";
import { deleteSkillTool } from "./delete-skill.ts";
import { rerunExecutionTool } from "./rerun-execution.ts";
import { runWorkflowTool } from "./run-workflow.ts";
import { scheduleTools } from "./schedules.ts";
import { updateConnectorTool } from "./update-connector.ts";
import { updateKnowledgeSourceTool } from "./update-knowledge-source.ts";
import { updateSkillTool } from "./update-skill.ts";
import { updateSubscriptionTool } from "./update-subscription.ts";
import { updateWorkflowTool } from "./update-workflow.ts";

export { analyzeKnowledgeSourceTool } from "./analyze-knowledge-source.ts";
export { approvePatchCandidateTool, approveSkillCandidateTool } from "./candidates.ts";
export {
  deleteConnectorTool,
  deleteKnowledgeSourceTool,
  deleteSubscriptionTool,
  deleteWorkflowTool,
  revokeApiKeyTool,
  revokePortalTokenTool,
} from "./cleanup.ts";
export { createApiKeyTool } from "./create-api-key.ts";
export { createKnowledgeSourceTool } from "./create-knowledge-source.ts";
export { createSkillTool } from "./create-skill.ts";
export { deleteSkillTool } from "./delete-skill.ts";
export { rerunExecutionTool } from "./rerun-execution.ts";
export { runWorkflowTool } from "./run-workflow.ts";
export {
  createScheduleTool,
  deleteScheduleTool,
  listSchedulesTool,
  updateScheduleTool,
} from "./schedules.ts";
export { updateConnectorTool } from "./update-connector.ts";
export { updateKnowledgeSourceTool } from "./update-knowledge-source.ts";
export { updateSkillTool } from "./update-skill.ts";
export { updateSubscriptionTool } from "./update-subscription.ts";
export { updateWorkflowTool } from "./update-workflow.ts";

export const ALL_GENERATED_WRITE_TOOLS: ConversationTool[] = [
  runWorkflowTool,
  rerunExecutionTool,
  approveSkillCandidateTool,
  approvePatchCandidateTool,
  createApiKeyTool,
  createKnowledgeSourceTool,
  analyzeKnowledgeSourceTool,
  createSkillTool,
  updateSkillTool,
  deleteSkillTool,
  updateWorkflowTool,
  updateConnectorTool,
  updateKnowledgeSourceTool,
  updateSubscriptionTool,
  ...scheduleTools,
  ...cleanupWriteTools,
];
