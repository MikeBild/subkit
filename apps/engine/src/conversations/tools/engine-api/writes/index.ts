import type { ConversationTool } from "../../index.ts";
import { intakeTools } from "../intake.ts";
import { analyzeKnowledgeSourceTool } from "./analyze-knowledge-source.ts";
import {
  approvePatchCandidateTool,
  approveSkillCandidateTool,
  rejectSkillCandidateTool,
} from "./candidates.ts";
import { cleanupWriteTools } from "./cleanup.ts";
import { createApiKeyTool } from "./create-api-key.ts";
import { createKnowledgeSourceTool } from "./create-knowledge-source.ts";
import { deleteSkillTool } from "./delete-skill.ts";
import { promoteConnectorTool } from "./promote-connector.ts";
import { rerunExecutionTool } from "./rerun-execution.ts";
import { runWorkflowTool } from "./run-workflow.ts";
import { scheduleTools } from "./schedules.ts";
import { updateConnectorTool } from "./update-connector.ts";
import { updateKnowledgeSourceTool } from "./update-knowledge-source.ts";
import { updateSkillTool } from "./update-skill.ts";
import { updateSubscriptionTool } from "./update-subscription.ts";
import { updateWorkflowTool } from "./update-workflow.ts";

export { analyzeKnowledgeSourceTool } from "./analyze-knowledge-source.ts";
export {
  approvePatchCandidateTool,
  approveSkillCandidateTool,
  rejectSkillCandidateTool,
} from "./candidates.ts";
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
export { deleteSkillTool } from "./delete-skill.ts";
export { promoteConnectorTool } from "./promote-connector.ts";
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

export const ALL_ENGINE_API_WRITE_TOOLS: ConversationTool[] = [
  runWorkflowTool,
  rerunExecutionTool,
  promoteConnectorTool,
  approveSkillCandidateTool,
  rejectSkillCandidateTool,
  approvePatchCandidateTool,
  createApiKeyTool,
  createKnowledgeSourceTool,
  analyzeKnowledgeSourceTool,
  updateSkillTool,
  deleteSkillTool,
  updateWorkflowTool,
  updateConnectorTool,
  updateKnowledgeSourceTool,
  updateSubscriptionTool,
  ...scheduleTools,
  ...cleanupWriteTools,
  ...intakeTools.filter((tool) => tool.category !== "tenant_read"),
];
