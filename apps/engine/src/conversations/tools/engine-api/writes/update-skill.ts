import { updateSkillOperation } from "../../../../api/operations/skills.ts";
import { toConversationTool } from "../../../../api/operations/tool.ts";
import type { ConversationTool } from "../../index.ts";

export const updateSkillTool: ConversationTool = toConversationTool(updateSkillOperation);
