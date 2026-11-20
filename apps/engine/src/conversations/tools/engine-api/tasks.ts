import {
  TASK_TOOL_CONTRACTS,
  type TaskToolContract,
} from "../../../api/operations/task-tool-contract.ts";
import { toConversationTool } from "../../../api/operations/tool.ts";
import { getTaskRunMarker } from "../../core/draft.ts";
import type { ConversationTool, ToolResult } from "../index.ts";

type TaskToolFlags = Partial<Pick<ConversationTool, "visible_when_readonly">>;

export function lazyTaskTool(
  contract: TaskToolContract,
  load: () => Promise<ConversationTool>,
  flags: TaskToolFlags = {},
): ConversationTool {
  let loaded: Promise<ConversationTool> | null = null;
  return {
    name: contract.name,
    description: contract.description,
    inputSchema: contract.input,
    category: contract.category,
    permission: contract.permission,
    ...flags,
    execute(ctx, args) {
      loaded ??= load();
      return loaded.then((tool) => tool.execute(ctx, args));
    },
  };
}

export const TASK_TOOL_INSIDE_RUN: ToolResult = {
  ok: false,
  error_code: "task_tool_unavailable_in_run",
  message:
    "Tasks cannot be started, stopped or saved from inside a task run. Open a normal chat for that.",
};

export function outsideTaskRun(tool: ConversationTool): ConversationTool {
  return {
    ...tool,
    async execute(ctx, args) {
      if (getTaskRunMarker(ctx.getDraft())) return TASK_TOOL_INSIDE_RUN;
      return tool.execute(ctx, args);
    },
  };
}

const taskOperations = () => import("../../../api/operations/tasks.ts");
const taskRunOperations = () => import("../../../api/operations/task-runs.ts");

export const listTasksTool: ConversationTool = lazyTaskTool(
  TASK_TOOL_CONTRACTS.list_tasks,
  async () => toConversationTool((await taskOperations()).listTasksOperation),
);

export const findTaskTool: ConversationTool = lazyTaskTool(
  TASK_TOOL_CONTRACTS.find_task,
  async () => toConversationTool((await taskOperations()).findTaskOperation),
);

export const getTaskTool: ConversationTool = lazyTaskTool(TASK_TOOL_CONTRACTS.get_task, async () =>
  toConversationTool((await taskOperations()).getTaskOperation),
);

export const getTaskRunTool: ConversationTool = lazyTaskTool(
  TASK_TOOL_CONTRACTS.get_task_run,
  async () => toConversationTool((await taskRunOperations()).getTaskRunOperation),
);

export const taskReadTools: ConversationTool[] = [
  listTasksTool,
  findTaskTool,
  getTaskTool,
  getTaskRunTool,
];
