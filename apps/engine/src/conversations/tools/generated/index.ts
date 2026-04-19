// Generated read-tool families. One module per domain; each module
// exports an array of `ConversationTool` instances. All tools are
// `tenant_read` — safe to invoke in parallel, tenant-scoped via the
// EngineClient, and carry no side effects beyond audit-log entries
// written by the EngineClient.

export { auditReadTools } from "./audit.ts";
export { connectorReadTools } from "./connectors.ts";
export {
  approveDiscoveryArtifactTool,
  discoveryTools,
  getDiscoveryArtifactTool,
  listDiscoveryArtifactsTool,
} from "./discovery.ts";
export { executionReadTools } from "./executions.ts";
export { hookReadTools } from "./hooks.ts";
export { identityReadTools } from "./identity.ts";
export { knowledgeSourceReadTools } from "./knowledge-sources.ts";
export { metricsReadTools } from "./metrics.ts";
export { patchCandidateReadTools } from "./patch-candidates.ts";
export { rbacReadTools } from "./rbac.ts";
export { skillCandidateReadTools } from "./skill-candidates.ts";
export { skillReadTools } from "./skills.ts";
export { statusReadTools } from "./status.ts";
export { subscriptionReadTools } from "./subscriptions.ts";
export { tunnelReadTools } from "./tunnels.ts";
export { workflowReadTools } from "./workflows.ts";

import type { ConversationTool } from "../index.ts";
import { auditReadTools } from "./audit.ts";
import { connectorReadTools } from "./connectors.ts";
import { executionReadTools } from "./executions.ts";
import { hookReadTools } from "./hooks.ts";
import { identityReadTools } from "./identity.ts";
import { knowledgeSourceReadTools } from "./knowledge-sources.ts";
import {
  approveDiscoveryArtifactTool,
  getDiscoveryArtifactTool,
  listDiscoveryArtifactsTool,
} from "./discovery.ts";
import { metricsReadTools } from "./metrics.ts";
import { patchCandidateReadTools } from "./patch-candidates.ts";
import { rbacReadTools } from "./rbac.ts";
import { skillCandidateReadTools } from "./skill-candidates.ts";
import { skillReadTools } from "./skills.ts";
import { statusReadTools } from "./status.ts";
import { subscriptionReadTools } from "./subscriptions.ts";
import { tunnelReadTools } from "./tunnels.ts";
import { workflowReadTools } from "./workflows.ts";

export const ALL_GENERATED_READ_TOOLS: ConversationTool[] = [
  ...workflowReadTools,
  ...connectorReadTools,
  ...executionReadTools,
  ...skillReadTools,
  ...skillCandidateReadTools,
  ...patchCandidateReadTools,
  ...knowledgeSourceReadTools,
  ...auditReadTools,
  ...metricsReadTools,
  ...identityReadTools,
  ...rbacReadTools,
  ...hookReadTools,
  ...subscriptionReadTools,
  ...tunnelReadTools,
  ...statusReadTools,
  // Discovery read + write: list_ + get_ are tenant_read; approve_ is
  // tenant_write but registered here so the palette sees it.
  listDiscoveryArtifactsTool,
  getDiscoveryArtifactTool,
  approveDiscoveryArtifactTool,
];
