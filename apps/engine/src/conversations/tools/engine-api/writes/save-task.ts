import { z } from "@hono/zod-openapi";
import {
  actorOfPrincipal,
  isRejection,
  type OperationScope,
} from "../../../../api/operations/index.ts";
import {
  SAVE_TASK_TOOL_DESCRIPTION,
  SAVE_TASK_TOOL_NAME,
  taskCockpitPath,
} from "../../../../api/operations/task-tool-contract.ts";
import { resolveMcpMode } from "../../../../mcp/mode-resolver.ts";
import { type PlaybookPlan, PlaybookPlanSchema } from "../../../playbook-contract.ts";
import { readConversationPlaybookPlan } from "../../../service/tool-state.ts";
import type { ConversationTool, ToolContext, ToolResult } from "../../index.ts";
import { outsideTaskRun } from "../tasks.ts";

export const SAVE_TASK_RESULT_STEP_ID = "confirm-result";

const Id = z.string().uuid();

const Input = z
  .object({
    task_id: Id.optional().describe(
      "Update this task. Omit to create a new task owned by the current person.",
    ),
    expected_revision: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Required with task_id: the `revision` that get_task returned."),
    name: z.string().trim().min(1).max(200).optional().describe("Short name. Required to create."),
    description: z.string().trim().max(2000).nullable().optional(),
    category: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(40)
      .optional(),
    goal: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .optional()
      .describe("What the task achieves, in one or two sentences. Required to create."),
    done_when: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe("How to tell that a run is finished. Required to create."),
    plan: PlaybookPlanSchema.optional().describe(
      "The steps of the task. Omit to take the plan from this conversation's playbook.",
    ),
    use_conversation_plan: z
      .boolean()
      .optional()
      .describe("With task_id: replace the task's plan with this conversation's playbook."),
    workflow_ids: z.array(Id).max(20).optional().describe("Saved workflows a run may start."),
    connector_ids: z.array(Id).max(20).optional().describe("Connectors a run may call."),
    skill_slugs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    web_search: z.boolean().optional(),
    environment: z
      .enum(["dev", "prod"])
      .optional()
      .describe("Where bound workflows run. Required to create."),
    schedule_cron: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .nullable()
      .optional()
      .describe("Five-field cron for a repeating task, at most every 15 minutes."),
    schedule_timezone: z.string().trim().min(1).max(64).nullable().optional(),
    schedule_run_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe("One start at this instant. Not together with schedule_cron."),
    max_turns: z.number().int().min(1).max(100).optional(),
    run_deadline_minutes: z.number().int().min(5).max(10080).optional(),
  })
  .openapi("SaveTaskToolInput");

type SaveTaskArgs = z.infer<typeof Input>;

function failure(error_code: string, message: string, next?: string[]): ToolResult {
  return { ok: false, error_code, message, ...(next ? { next_best_actions: next } : {}) };
}

export function taskPlanTemplate(plan: PlaybookPlan, goal: string): PlaybookPlan {
  return {
    title: plan.title,
    goal,
    steps: plan.steps
      .filter((step) => step.id !== SAVE_TASK_RESULT_STEP_ID)
      .map((step) => ({
        id: step.id,
        label: step.label,
        criterion:
          step.criterion.kind === "assessment"
            ? { ...step.criterion, result: null }
            : step.criterion,
        depends_on: step.depends_on.filter((id) => id !== SAVE_TASK_RESULT_STEP_ID),
        evidence_ids: [],
        note: null,
        progress: "open" as const,
        next_action: step.next_action ? { ...step.next_action, elicitation_id: null } : null,
      })),
    cancelled: plan.cancelled,
    completion_step_id: null,
  };
}

function conversationPlan(ctx: ToolContext): Promise<PlaybookPlan | null> {
  return readConversationPlaybookPlan(ctx.db, {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
  });
}

function given<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function invalid(error: z.ZodError): ToolResult {
  return {
    ok: false,
    error_code: "task_invalid",
    message:
      "The task is not complete or not valid. Fix the listed fields and call save_task again.",
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    },
  };
}

const PLAN_MISSING = failure(
  "task_plan_missing",
  "This conversation has no playbook to take the plan from. Write the steps with update_playbook first, or pass `plan`.",
  ["update_playbook"],
);

async function saveTask(ctx: ToolContext, args: SaveTaskArgs): Promise<ToolResult> {
  const principal = ctx.principal;
  if (!principal) return failure("principal_required", "Saving a task needs a signed-in person.");
  if (ctx.surface === "mcp" && resolveMcpMode(principal) === "product")
    return failure(
      "authoring_scope_required",
      "Saving a task over MCP needs a credential with the mcp:authoring scope. Without it, tasks can be listed, started and stopped here and are created in the Cockpit.",
    );
  const operations = await import("../../../../api/operations/tasks.ts");
  const { TaskCreateInputSchema, TaskUpdateInputSchema } = await import(
    "../../../../tasks/index.ts"
  );
  const scope: OperationScope = {
    db: ctx.db as OperationScope["db"],
    tenant_id: ctx.tenant_id,
    principal,
    actor: actorOfPrincipal(principal),
    ...(ctx.locale ? { locale: ctx.locale } : {}),
  };
  const { task_id, expected_revision, plan, use_conversation_plan, ...fields } = args;
  const { workflow_ids, connector_ids, skill_slugs, web_search, ...definition } = fields;
  const bindings = given({ workflow_ids, connector_ids, skill_slugs, web_search });
  if (!task_id) {
    const source = plan ?? (await conversationPlan(ctx));
    if (!source) return PLAN_MISSING;
    const parsed = TaskCreateInputSchema.safeParse({
      ...given(definition),
      plan: taskPlanTemplate(source, definition.goal ?? source.goal),
      bindings: {
        workflow_ids: [],
        connector_ids: [],
        skill_slugs: [],
        web_search: false,
        ...bindings,
      },
    });
    if (!parsed.success) return invalid(parsed.error);
    const created = await operations.createTaskOperation.handler(scope, parsed.data);
    if (isRejection(created)) return operations.taskToolFailure(created);
    return {
      ok: true,
      data: {
        saved: "created",
        task_id: created.id,
        name: created.name,
        revision: created.revision,
        cockpit_path: taskCockpitPath(created.id),
        note: "The task is stored. It starts no run by itself: start one with run_task, and a scheduled task runs only after a person gives it the standing permission in the Cockpit.",
      },
    };
  }
  if (expected_revision === undefined)
    return failure(
      "expected_revision_required",
      "Updating a task needs `expected_revision`. Read the task with get_task and pass its revision.",
      ["get_task"],
    );
  const current = await operations.getTaskOperation.handler(scope, { id: task_id });
  if (isRejection(current)) return operations.taskToolFailure(current);
  const stored = current;
  const source = plan ?? (use_conversation_plan ? await conversationPlan(ctx) : stored.plan);
  if (!source) return PLAN_MISSING;
  const parsed = TaskUpdateInputSchema.safeParse({
    name: stored.name,
    description: stored.description,
    category: stored.category,
    goal: stored.goal,
    done_when: stored.done_when,
    environment: stored.environment,
    schedule_cron: stored.schedule_cron,
    schedule_timezone: stored.schedule_timezone,
    schedule_run_at: stored.schedule_run_at,
    max_turns: stored.max_turns,
    run_deadline_minutes: stored.run_deadline_minutes,
    ...given(definition),
    plan: taskPlanTemplate(source, definition.goal ?? stored.goal),
    bindings: { ...stored.bindings, ...bindings },
    expected_revision,
  });
  if (!parsed.success) return invalid(parsed.error);
  const updated = await operations.updateTaskOperation.handler(scope, {
    id: task_id,
    input: parsed.data,
  });
  if (isRejection(updated)) return operations.taskToolFailure(updated);
  return {
    ok: true,
    data: {
      saved: "updated",
      task_id: updated.id,
      name: updated.name,
      revision: updated.revision,
      schedule_changed: updated.schedule_changed,
      grant_invalidated: updated.grant_invalidated,
      aborted_run_id: updated.aborted_run_id,
      cockpit_path: taskCockpitPath(updated.id),
      ...(updated.grant_invalidated
        ? {
            note: "The content of the task changed, so its standing permission ended. A person gives it again in the Cockpit before the next scheduled run.",
          }
        : {}),
    },
  };
}

export const saveTaskTool: ConversationTool = outsideTaskRun({
  name: SAVE_TASK_TOOL_NAME,
  description: SAVE_TASK_TOOL_DESCRIPTION,
  inputSchema: Input,
  strict: false,
  category: "tenant_write",
  authoring_only: true,
  visible_when_readonly: true,
  permission: { action: "task:write", resourceType: "task", resourceIdArg: "task_id" },
  async execute(ctx, args) {
    const parsed = Input.safeParse(args);
    return parsed.success ? saveTask(ctx, parsed.data) : invalid(parsed.error);
  },
});
