import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { conversations, roles, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { startTaskRun, TASK_RESULT_STEP_ID, type TaskRun } from "../../tasks/index.ts";
import { createTask } from "../../tasks/service/tasks.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { getTaskRunMarker } from "../core/draft.ts";
import { updatePlaybook } from "../playbook.ts";
import { PlaybookDocumentSchema, type PlaybookPlan } from "../playbook-contract.ts";
import { readConversationPlaybookPlan } from "../service/tool-state.ts";
import { prepareGate } from "../tools/sdk-wrap/gate-subjects.ts";
import {
  TASK_RUN_CONFIRM_STEP_ID,
  taskRunPlaybookRefusal,
} from "../tools/sdk-wrap/task-run-playbook.ts";

let db: TestDb;
let tenant_id: string;
let owner: ResolvedPrincipal;
let run: TaskRun;
let conversation_id: string;

const GOAL = "Send the weekly report";

async function storedPlan(): Promise<PlaybookPlan> {
  const plan = await readConversationPlaybookPlan(db.db, { tenant_id, conversation_id });
  if (!plan) throw new Error("the run conversation has no stored plan");
  return plan;
}

beforeAll(async () => {
  db = await createTestDb("task_run_seeded_plan");
  tenant_id = (await seedTenant(db.db)).id;
  const [role] = await db.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "member")))
    .limit(1);
  if (!role) throw new Error("member role missing");
  const [user] = await db.db
    .insert(users)
    .values({ tenant_id, email: "owner@seeded-plan.test", role_id: role.id })
    .returning({ id: users.id });
  if (!user) throw new Error("user fixture missing");
  owner = { provider: "session", kind: "user", id: user.id, tenant_id, roles: ["member"] };
  const task = await createTask(
    {
      locale: "de",
      tenant_id,
      principal: owner,
      input: {
        name: "Weekly report",
        description: null,
        goal: GOAL,
        done_when: "The report is in the inbox",
        plan: {
          title: "Weekly report",
          goal: GOAL,
          steps: [
            {
              id: "collect",
              label: "Collect the numbers",
              criterion: { kind: "assessment", description: "Numbers are complete", result: null },
              depends_on: [],
              evidence_ids: [],
              note: null,
              progress: "open",
              next_action: null,
            },
          ],
          cancelled: false,
          completion_step_id: null,
        },
        bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: true },
        environment: "dev",
        schedule_cron: null,
        schedule_timezone: null,
        schedule_run_at: null,
        max_turns: 20,
        run_deadline_minutes: 240,
      },
    },
    db.db,
  );
  const started = await startTaskRun(
    { tenant_id, task_id: task.id, trigger: "manual", started_by: owner },
    db.db,
    { aiAccessConfigured: async () => true },
  );
  if (!started.admitted || !started.run.conversation_id) throw new Error("run was not started");
  run = started.run;
  conversation_id = started.run.conversation_id;
}, 120_000);

afterAll(async () => {
  await db.cleanup();
});

describe("a started task run seeds its conversation before the first turn", () => {
  test("the conversation carries the run marker with the task's bindings", async () => {
    const [row] = await db.db
      .select({ draft: conversations.draft, owner_id: conversations.owner_id })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
      .limit(1);
    expect(row?.owner_id).toBe(owner.id);
    expect(getTaskRunMarker(row?.draft)).toEqual({
      task_id: run.task_id,
      task_run_id: run.id,
      environment: "dev",
      workflow_ids: [],
      connector_ids: [],
      web_search: true,
    });
  });

  test("the stored plan ends in the result confirmation the run guard compares against", async () => {
    expect(TASK_RUN_CONFIRM_STEP_ID).toBe(TASK_RESULT_STEP_ID);
    const plan = await storedPlan();
    expect(plan.goal).toBe(GOAL);
    expect(plan.completion_step_id).toBe(TASK_RUN_CONFIRM_STEP_ID);
    expect(plan.steps.map((step) => step.id)).toEqual(["collect", TASK_RUN_CONFIRM_STEP_ID]);
    expect(plan.steps.at(-1)?.criterion).toEqual({ kind: "human_confirmation", question: GOAL });
  });

  test("the run guard accepts a model update that only changes work steps and it is stored", async () => {
    const plan = await storedPlan();
    const [collect, confirm] = plan.steps;
    if (!collect || !confirm) throw new Error("seeded steps missing");
    const next: PlaybookPlan = {
      ...plan,
      steps: [
        { ...collect, label: "Collect last week's numbers", progress: "in_progress" },
        {
          id: "draft",
          label: "Write the summary",
          criterion: { kind: "assessment", description: "Summary reads well", result: null },
          depends_on: ["collect"],
          evidence_ids: [],
          note: null,
          progress: "open",
          next_action: null,
        },
        { ...confirm, depends_on: ["collect", "draft"] },
      ],
    };
    const scope = { db: db.db, tenant_id, conversation_id };
    expect(await taskRunPlaybookRefusal(scope, { plan: next })).toBeNull();
    const view = await updatePlaybook(
      db.db,
      { tenant_id, conversation_id, principal: owner },
      { expected_revision: 1, plan: next },
    );
    expect(view?.steps.map((step) => step.id)).toEqual(["collect", "draft", "confirm-result"]);
    expect((await storedPlan()).steps.map((step) => step.label)).toEqual([
      "Collect last week's numbers",
      "Write the summary",
      GOAL,
    ]);
  });

  test("the run guard refuses a model update that touches the confirmation or the goal", async () => {
    const plan = await storedPlan();
    const scope = { db: db.db, tenant_id, conversation_id };
    const work = plan.steps.filter((step) => step.id !== TASK_RUN_CONFIRM_STEP_ID);
    const refused = async (next: PlaybookPlan) => {
      const result = await taskRunPlaybookRefusal(scope, { plan: next });
      return result && !result.ok ? result.error_code : null;
    };
    expect(await refused({ ...plan, steps: work, completion_step_id: null })).toBe(
      "task_run_plan_confirmation_missing",
    );
    expect(await refused({ ...plan, completion_step_id: null })).toBe(
      "task_run_plan_completion_changed",
    );
    expect(await refused({ ...plan, cancelled: true })).toBe("task_run_plan_cancel_refused");
    const [document] = await db.db
      .select({ playbook: conversations.playbook })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
      .limit(1);
    expect(PlaybookDocumentSchema.safeParse(document?.playbook).success).toBe(true);
  });
});

describe("confirmation cards name the task only for a person who may see it", () => {
  const card = async (tool: string, args: Record<string, unknown>, who: ResolvedPrincipal | null) =>
    (await prepareGate(tool, args, tenant_id, db.db, undefined, who)).pending_output?.summary;

  test("the owner reads the task name on every card", async () => {
    expect(await card("run_task", { task_id: run.task_id }, owner)).toBe(
      "Start a run of the task “Weekly report” now, in its own conversation.",
    );
    expect(await card("abort_task_run", { task_run_id: run.id }, owner)).toBe(
      "Stop the current run of the task “Weekly report”; it cannot be continued afterwards.",
    );
    expect(await card("save_task", { task_id: run.task_id, expected_revision: 1 }, owner)).toBe(
      "Update the task “Weekly report”: its schedule stays as it is, and what it may use stays as it is.",
    );
    expect(
      await card("save_task", { task_id: run.task_id, name: "Monthly report" }, owner),
    ).toContain("the task “Monthly report”");
  });

  test("another member, a foreign tenant and a missing principal keep the id", async () => {
    const stranger: ResolvedPrincipal = {
      ...owner,
      id: "5eed0000-0000-4000-8000-0000000000aa",
    };
    const foreign: ResolvedPrincipal = {
      ...owner,
      tenant_id: "5eed0000-0000-4000-8000-0000000000bb",
    };
    for (const who of [stranger, foreign, null]) {
      expect(await card("run_task", { task_id: run.task_id }, who)).toBe(
        `Start a run of the task ${run.task_id} now, in its own conversation.`,
      );
      expect(await card("abort_task_run", { task_run_id: run.id }, who)).toBe(
        `Stop the task run ${run.id}; it cannot be continued afterwards.`,
      );
      expect(await card("save_task", { task_id: run.task_id }, who)).toContain(
        `Update the task ${run.task_id}:`,
      );
    }
    expect(await card("run_task", { task_id: "not-a-uuid" }, owner)).toContain("not-a-uuid");
  });
});
