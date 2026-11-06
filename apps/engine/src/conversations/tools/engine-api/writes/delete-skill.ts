import { deleteSkillOperation } from "../../../../api/operations/skills.ts";
import { toConversationTool } from "../../../../api/operations/tool.ts";
import type { ConversationTool } from "../../index.ts";

export const deleteSkillTool: ConversationTool = toConversationTool(deleteSkillOperation);
