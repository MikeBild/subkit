import { toConversationTool } from "../../../api/operations/tool.ts";
import { getWorkflowOperation, listWorkflowsOperation } from "../../../api/operations/workflows.ts";
import type { ConversationTool } from "../index.ts";

export const listWorkflowsTool: ConversationTool = toConversationTool(listWorkflowsOperation);

export const getWorkflowTool: ConversationTool = toConversationTool(getWorkflowOperation);

export const workflowReadTools: ConversationTool[] = [listWorkflowsTool, getWorkflowTool];
