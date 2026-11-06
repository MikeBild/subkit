import {
  getExecutionOperation,
  listExecutionsOperation,
} from "../../../api/operations/executions.ts";
import { toConversationTool } from "../../../api/operations/tool.ts";
import type { ConversationTool } from "../index.ts";

export const listExecutionsTool: ConversationTool = {
  ...toConversationTool(listExecutionsOperation),
  strict: false,
};

export const getExecutionTool: ConversationTool = toConversationTool(getExecutionOperation);

export const executionReadTools: ConversationTool[] = [listExecutionsTool, getExecutionTool];
