import { describe, expect, test } from "bun:test";
import {
  abortTaskRunOperation,
  getTaskRunOperation,
  startTaskRunOperation,
} from "../../../api/operations/task-runs.ts";
import {
  findTaskOperation,
  getTaskOperation,
  listTasksOperation,
} from "../../../api/operations/tasks.ts";
import { toConversationTool } from "../../../api/operations/tool.ts";
import { TASK_RESULT_STEP_ID } from "../../../tasks/index.ts";
import { policyDecide } from "../../../tools/policy.ts";
import { conversationToolProvider } from "../../../tools/providers/conversation.ts";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import {
  buildPendingOutputForTool,
  canSetConversationToolPolicy,
  decideToolMode,
} from "../../tool-policies.ts";
import {
  filterByAuthoringPalette,
  filterByTaskRunPalette,
  TASK_RUN_TOOLS,
} from "../authoring-palette.ts";
import { type ConversationTool, getTool } from "../index.ts";
import { findTaskTool, getTaskRunTool, getTaskTool, listTasksTool } from "./tasks.ts";
import { SAVE_TASK_RESULT_STEP_ID, taskPlanTemplate } from "./writes/save-task.ts";
import { abortTaskRunTool, runTaskTool } from "./writes/tasks.ts";

const READ_TOOLS = ["find_task", "get_task", "get_task_run", "list_tasks"];
const RUN_TOOLS = ["abort_task_run", "run_task"];

const BOUND: Array<[ConversationTool, ConversationTool]> = [
  [listTasksTool, toConversationTool(listTasksOperation)],
  [findTaskTool, toConversationTool(findTaskOperation)],
  [getTaskTool, toConversationTool(getTaskOperation)],
  [getTaskRunTool, toConversationTool(getTaskRunOperation)],
  [runTaskTool, toConversationTool(startTaskRunOperation)],
  [abortTaskRunTool, toConversationTool(abortTaskRunOperation)],
];

const MODES = ["ask", "plan", "auto", "yolo", null] as const;
const ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

function modeOf(
  tool: string,
  category: "tenant_read" | "tenant_write",
  permission_mode: (typeof MODES)[number],
) {
  return decideToolMode({ tool, category, input: {}, overrides: {}, permission_mode }).mode;
}

function mcpNames(mcpMode: "product" | "authoring" | "admin"): string[] {
  return conversationToolProvider
    .list({ surface: "mcp", mcpMode, readOnly: mcpMode !== "admin" })
    .map((tool) => tool.name)
    .filter((name) => name.includes("task"))
    .sort();
}

describe("task tools", () => {
  test("the lazily loaded tools describe exactly what their operations bind", () => {
    for (const [lazy, bound] of BOUND) {
      expect({
        name: lazy.name,
        description: lazy.description,
        category: lazy.category,
        permission: lazy.permission,
      }).toEqual({
        name: bound.name,
        description: bound.description,
        category: bound.category,
        permission: bound.permission,
      });
      expect(lazy.inputSchema).toBe(bound.inputSchema);
    }
  });

  test("every task tool is registered under a plain name", () => {
    for (const name of [...READ_TOOLS, ...RUN_TOOLS, "save_task"]) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(getTool(name)?.name).toBe(name);
    }
  });

  test("reads never ask", () => {
    for (const permission_mode of MODES)
      for (const tool of [listTasksTool, findTaskTool, getTaskTool, getTaskRunTool])
        expect(modeOf(tool.name, "tenant_read", permission_mode)).toBe("no_confirm");
  });

  test("run_task asks exactly when run_workflow asks", () => {
    for (const permission_mode of MODES)
      expect(modeOf("run_task", "tenant_write", permission_mode)).toBe(
        modeOf("run_workflow", "tenant_write", permission_mode),
      );
    expect(modeOf("run_task", "tenant_write", "ask")).toBe("confirm_before_execution");
    expect(modeOf("run_task", "tenant_write", "auto")).toBe("no_confirm");
  });

  test("abort_task_run and save_task ask in every mode but yolo", () => {
    for (const tool of ["abort_task_run", "save_task"])
      expect(MODES.filter((mode) => modeOf(tool, "tenant_write", mode) !== "no_confirm")).toEqual([
        "ask",
        "plan",
        "auto",
        null,
      ]);
  });

  test("a direct MCP call of abort_task_run or save_task needs a confirmation", () => {
    for (const tool of ["abort_task_run", "save_task"]) {
      const call = { tool, category: "tenant_write", surface: "mcp" } as const;
      expect(policyDecide({ ...call, args: {} }).kind).toBe("needs_confirm");
      expect(policyDecide({ ...call, args: { __policy_confirmed: true } }).kind).toBe("proceed");
    }
    expect(
      policyDecide({ tool: "run_task", category: "tenant_write", surface: "mcp", args: {} }).kind,
    ).toBe(
      policyDecide({ tool: "run_workflow", category: "tenant_write", surface: "mcp", args: {} })
        .kind,
    );
  });

  test("a no-confirm override cannot be stored for a task write", () => {
    for (const tool of ["run_task", "abort_task_run", "save_task"]) {
      expect(canSetConversationToolPolicy(tool, "no_confirm")).toBe(false);
      expect(
        decideToolMode({
          tool,
          category: "tenant_write",
          input: {},
          overrides: { [tool]: "no_confirm" },
          permission_mode: "ask",
        }).mode,
      ).toBe("confirm_before_execution");
    }
  });

  test("a normal chat offers the write tools, a task run offers no task tool", () => {
    const tools = [...READ_TOOLS, ...RUN_TOOLS, "save_task"].map((name) => getTool(name));
    const present = tools.filter((tool): tool is ConversationTool => tool !== undefined);
    expect(present).toHaveLength(7);
    const chat = filterByAuthoringPalette(present, createEmptyDraftDocument(), new Set());
    expect(chat.map((tool) => tool.name).sort()).toEqual(
      [...READ_TOOLS, ...RUN_TOOLS, "save_task"].sort(),
    );
    expect(filterByTaskRunPalette(present)).toEqual([]);
    for (const name of [...READ_TOOLS, ...RUN_TOOLS, "save_task"])
      expect(TASK_RUN_TOOLS.has(name)).toBe(false);
  });

  test("the confirmation cards say in one sentence what will happen", () => {
    expect(buildPendingOutputForTool("run_task", { task_id: ID })).toEqual({
      summary: `Start a run of the task ${ID} now, in its own conversation.`,
      task_id: ID,
    });
    expect(buildPendingOutputForTool("abort_task_run", { task_run_id: ID })).toEqual({
      summary: `Stop the task run ${ID}; it cannot be continued afterwards.`,
      task_run_id: ID,
    });
    expect(
      buildPendingOutputForTool("save_task", {
        name: "Weekly report",
        environment: "prod",
        schedule_cron: "0 8 * * 1",
        schedule_timezone: "Europe/Berlin",
        workflow_ids: [ID, ID],
        connector_ids: [ID],
        skill_slugs: [],
        web_search: true,
      }),
    ).toEqual({
      summary:
        "Save the task “Weekly report”: it runs on the schedule 0 8 * * 1 (Europe/Berlin) once it has its standing permission, and it may use 2 workflows, 1 connector and web search.",
      name: "Weekly report",
      environment: "prod",
    });
    expect(buildPendingOutputForTool("save_task", { name: "By hand" })?.summary).toBe(
      "Save the task “By hand”: it runs only when someone starts it, and it may use no workflow, connector, skill or web search.",
    );
    expect(
      buildPendingOutputForTool("save_task", {
        name: "Once",
        schedule_run_at: "2031-01-01T08:00:00.000Z",
        skill_slugs: ["report"],
      })?.summary,
    ).toBe(
      "Save the task “Once”: it runs once at 2031-01-01T08:00:00.000Z once it has its standing permission, and it may use 1 skill.",
    );
    expect(buildPendingOutputForTool("save_task", { task_id: ID, expected_revision: 2 })).toEqual({
      summary: `Update the task ${ID}: its schedule stays as it is, and what it may use stays as it is.`,
      task_id: ID,
    });
    expect(
      buildPendingOutputForTool("save_task", {
        task_id: ID,
        name: "Renamed",
        schedule_cron: null,
        schedule_run_at: null,
        web_search: false,
      })?.summary,
    ).toBe(
      "Update the task “Renamed”: it runs only when someone starts it, and it may use no workflow, connector, skill or web search.",
    );
    expect(buildPendingOutputForTool("run_task", null)?.summary).toContain("(unknown)");
    expect(buildPendingOutputForTool("abort_task_run", [])?.summary).toContain("(unknown)");
  });

  test("product mode lists reads and run control, save_task needs authoring", () => {
    expect(mcpNames("product")).toEqual([...RUN_TOOLS, ...READ_TOOLS].sort());
    expect(mcpNames("authoring")).toEqual([...RUN_TOOLS, ...READ_TOOLS, "save_task"].sort());
    expect(mcpNames("admin")).toEqual([...RUN_TOOLS, ...READ_TOOLS, "save_task"].sort());
    const product = { surface: "mcp", mcpMode: "product", readOnly: true } as const;
    expect(conversationToolProvider.resolve("save_task", product)).toBeUndefined();
    expect(conversationToolProvider.resolve("run_task", product)?.descriptor.rbac?.permission).toBe(
      "task:run",
    );
  });

  test("the MCP permission check names the task or the run", () => {
    const admin = { surface: "mcp", mcpMode: "admin" } as const;
    const id = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
    const rbac = (name: string) => conversationToolProvider.resolve(name, admin)?.descriptor.rbac;
    expect(rbac("run_task")?.resource?.({ task_id: id })).toEqual({ type: "task", id });
    expect(rbac("abort_task_run")?.resource?.({ task_run_id: id })).toEqual({
      type: "task_run",
      id,
    });
    expect(rbac("get_task")?.resource?.({ id })).toEqual({ type: "task", id });
    expect(rbac("save_task")?.permission).toBe("task:write");
    expect(rbac("save_task")?.resource?.({})).toBeNull();
  });
});

describe("save_task plan template", () => {
  test("uses the step id the task service reserves for the result confirmation", () => {
    expect(SAVE_TASK_RESULT_STEP_ID).toBe(TASK_RESULT_STEP_ID);
  });

  test("drops the result step and everything a conversation recorded", () => {
    const template = taskPlanTemplate(
      {
        title: "Plan",
        goal: "Old goal",
        steps: [
          {
            id: "collect",
            label: "Collect",
            criterion: {
              kind: "assessment",
              description: "Complete",
              result: "A result long enough to pass the schema.",
            },
            depends_on: [],
            evidence_ids: ["5eed0000-0000-4000-8000-000000000001"],
            note: "seen",
            progress: "blocked",
            next_action: {
              label: "Ask",
              owner: null,
              elicitation_id: "5eed0000-0000-4000-8000-000000000002",
            },
          },
          {
            id: "run",
            label: "Run",
            criterion: {
              kind: "execution_succeeded",
              workflow_id: "5eed0000-0000-4000-8000-000000000003",
              environment: "dev",
              after: "2026-01-01T00:00:00.000Z",
            },
            depends_on: ["collect", SAVE_TASK_RESULT_STEP_ID],
            evidence_ids: [],
            note: null,
            progress: "open",
            next_action: null,
          },
          {
            id: SAVE_TASK_RESULT_STEP_ID,
            label: "Old goal",
            criterion: { kind: "human_confirmation", question: "Old goal" },
            depends_on: ["collect", "run"],
            evidence_ids: [],
            note: null,
            progress: "open",
            next_action: null,
          },
        ],
        cancelled: false,
        completion_step_id: SAVE_TASK_RESULT_STEP_ID,
      },
      "New goal",
    );
    expect(template).toEqual({
      title: "Plan",
      goal: "New goal",
      steps: [
        {
          id: "collect",
          label: "Collect",
          criterion: { kind: "assessment", description: "Complete", result: null },
          depends_on: [],
          evidence_ids: [],
          note: null,
          progress: "open",
          next_action: { label: "Ask", owner: null, elicitation_id: null },
        },
        {
          id: "run",
          label: "Run",
          criterion: {
            kind: "execution_succeeded",
            workflow_id: "5eed0000-0000-4000-8000-000000000003",
            environment: "dev",
            after: "2026-01-01T00:00:00.000Z",
          },
          depends_on: ["collect"],
          evidence_ids: [],
          note: null,
          progress: "open",
          next_action: null,
        },
      ],
      cancelled: false,
      completion_step_id: null,
    });
  });
});
