import {
  approveDiscoveryArtifactOperation,
  getDiscoveryArtifactOperation,
  listDiscoveryArtifactsOperation,
  resolveCapabilityGapOperation,
} from "../../../api/operations/discovery.ts";
import { toConversationTool } from "../../../api/operations/tool.ts";
import type { ConversationTool } from "../index.ts";

export const listDiscoveryArtifactsTool: ConversationTool = toConversationTool(
  listDiscoveryArtifactsOperation,
);

export const getDiscoveryArtifactTool: ConversationTool = toConversationTool(
  getDiscoveryArtifactOperation,
);

export const approveDiscoveryArtifactTool: ConversationTool = toConversationTool(
  approveDiscoveryArtifactOperation,
);

export const resolveCapabilityGapTool: ConversationTool = toConversationTool(
  resolveCapabilityGapOperation,
);

export const discoveryTools: ConversationTool[] = [
  listDiscoveryArtifactsTool,
  getDiscoveryArtifactTool,
  approveDiscoveryArtifactTool,
  resolveCapabilityGapTool,
];
