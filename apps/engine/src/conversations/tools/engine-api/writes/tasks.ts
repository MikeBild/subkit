import { TASK_TOOL_CONTRACTS } from "../../../../api/operations/task-tool-contract.ts";
import { toConversationTool } from "../../../../api/operations/tool.ts";
import type { ConversationTool } from "../../index.ts";
import { lazyTaskTool, outsideTaskRun } from "../tasks.ts";
import { saveTaskTool } from "./save-task.ts";

const taskRunOperations = () => import("../../../../api/operations/task-runs.ts");

export const runTaskTool: ConversationTool = outsideTaskRun(
  lazyTaskTool(
    TASK_TOOL_CONTRACTS.run_task,
    async () => toConversationTool((await taskRunOperations()).startTaskRunOperation),
    { visible_when_readonly: true },
  ),
);

export const abortTaskRunTool: ConversationTool = outsideTaskRun(
  lazyTaskTool(
    TASK_TOOL_CONTRACTS.abort_task_run,
    async () => toConversationTool((await taskRunOperations()).abortTaskRunOperation),
    { visible_when_readonly: true },
  ),
);

export { saveTaskTool } from "./save-task.ts";

export const taskWriteTools: ConversationTool[] = [runTaskTool, abortTaskRunTool, saveTaskTool];
