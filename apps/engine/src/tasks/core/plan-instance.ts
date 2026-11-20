import type { PlaybookPlan } from "../../conversations/public/authoring.ts";

export const TASK_RESULT_STEP_ID = "confirm-result";
export const TASK_PLAN_TEMPLATE_MAX_STEPS = 19;

type PlanStep = PlaybookPlan["steps"][number];

export type TaskPlanTemplateIssue = "plan_too_many_steps" | "plan_without_steps" | "plan_cancelled";

function workSteps(template: PlaybookPlan): PlanStep[] {
  return template.steps.filter((step) => step.id !== TASK_RESULT_STEP_ID);
}

export function taskPlanTemplateIssue(template: PlaybookPlan): TaskPlanTemplateIssue | null {
  if (template.cancelled) return "plan_cancelled";
  const count = workSteps(template).length;
  if (count === 0) return "plan_without_steps";
  if (count > TASK_PLAN_TEMPLATE_MAX_STEPS) return "plan_too_many_steps";
  return null;
}

function freshCriterion(
  criterion: PlanStep["criterion"],
  startedAt: string,
): PlanStep["criterion"] {
  if (criterion.kind === "assessment") return { ...criterion, result: null };
  if (criterion.kind === "execution_succeeded") return { ...criterion, after: startedAt };
  return criterion;
}

function freshStep(step: PlanStep, startedAt: string): PlanStep {
  return {
    id: step.id,
    label: step.label,
    criterion: freshCriterion(step.criterion, startedAt),
    depends_on: step.depends_on.filter((id) => id !== TASK_RESULT_STEP_ID),
    evidence_ids: [],
    note: null,
    progress: "open",
    next_action: step.next_action ? { ...step.next_action, elicitation_id: null } : null,
  };
}

export function instantiateTaskPlan(
  template: PlaybookPlan,
  run: { goal: string; started_at: string },
): PlaybookPlan {
  const steps = workSteps(template).map((step) => freshStep(step, run.started_at));
  return {
    title: template.title,
    goal: run.goal,
    steps: [
      ...steps,
      {
        id: TASK_RESULT_STEP_ID,
        label: run.goal,
        criterion: { kind: "human_confirmation", question: run.goal },
        depends_on: steps.map((step) => step.id),
        evidence_ids: [],
        note: null,
        progress: "open",
        next_action: null,
      },
    ],
    cancelled: false,
    completion_step_id: TASK_RESULT_STEP_ID,
  };
}

export interface TaskPlaybookFacts {
  status: string;
  revision: number;
  intact: boolean;
  result_confirmed: boolean;
  awaiting_result_confirmation: boolean;
}

export interface TaskStoredPlan {
  goal: string;
  completion_step_id: string | null;
  steps: ReadonlyArray<{ id: string; criterion: { kind: string; question?: string } }>;
}

export function taskPlaybookFacts(
  view: { status: string; revision: number; steps: ReadonlyArray<{ id: string; status: string }> },
  plan: TaskStoredPlan,
  goal: string,
): TaskPlaybookFacts {
  const stored = plan.steps.find((step) => step.id === TASK_RESULT_STEP_ID);
  const work = view.steps.filter((step) => step.id !== TASK_RESULT_STEP_ID);
  const confirmation = view.steps.find((step) => step.id === TASK_RESULT_STEP_ID);
  const result_confirmed = confirmation?.status === "verified";
  return {
    status: view.status,
    revision: view.revision,
    intact:
      plan.goal === goal &&
      plan.completion_step_id === TASK_RESULT_STEP_ID &&
      stored?.criterion.kind === "human_confirmation" &&
      stored.criterion.question === goal &&
      confirmation !== undefined,
    result_confirmed,
    awaiting_result_confirmation:
      confirmation !== undefined &&
      !result_confirmed &&
      work.every((step) => step.status === "verified" || step.status === "assessment_ready"),
  };
}
