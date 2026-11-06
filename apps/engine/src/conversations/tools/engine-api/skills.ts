import { getSkillOperation, listSkillsOperation } from "../../../api/operations/skills.ts";
import { toConversationTool } from "../../../api/operations/tool.ts";
import type { ConversationTool } from "../index.ts";

export const listAllSkillsTool: ConversationTool = toConversationTool(listSkillsOperation);

export const getSkillTool: ConversationTool = toConversationTool(getSkillOperation);

export const skillReadTools: ConversationTool[] = [listAllSkillsTool, getSkillTool];
