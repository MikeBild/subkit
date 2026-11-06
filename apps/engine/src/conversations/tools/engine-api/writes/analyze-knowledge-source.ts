import { analyzeKnowledgeSourceOperation } from "../../../../api/operations/knowledge-sources.ts";
import { toConversationTool } from "../../../../api/operations/tool.ts";
import type { ConversationTool } from "../../index.ts";

export const analyzeKnowledgeSourceTool: ConversationTool = toConversationTool(
  analyzeKnowledgeSourceOperation,
);
