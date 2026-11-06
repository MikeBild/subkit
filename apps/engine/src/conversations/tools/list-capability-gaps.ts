import { listCapabilityGapsOperation } from "../../api/operations/discovery.ts";
import { toConversationTool } from "../../api/operations/tool.ts";
import type { ConversationTool } from "./index.ts";

export const listCapabilityGapsTool: ConversationTool = toConversationTool(
  listCapabilityGapsOperation,
);
