import type { TranslationKey } from "@/lib/i18n";
import { TASK_RESULT_STEP_ID, type TaskPlan } from "./tasks-model";

export type StepMark = "done" | "active" | "waiting" | "open";

export interface StepLine {
  id: string;
  label: string | null;
  mark: StepMark;
}

export type PlaybookStepStatus =
  | "open"
  | "in_progress"
  | "waiting_for_input"
  | "blocked"
  | "verified"
  | "assessment_ready"
  | "stale"
  | "not_applicable";

export interface LiveStep {
  id: string;
  label: string;
  status: PlaybookStepStatus;
  assurance?: string;
  reason?: string | null;
}

const STEP_MARKS: Record<PlaybookStepStatus, StepMark> = {
  open: "open",
  in_progress: "active",
  waiting_for_input: "waiting",
  blocked: "open",
  verified: "done",
  assessment_ready: "done",
  stale: "open",
  not_applicable: "done",
};

function confirmMark(state: string | null | undefined, stored: StepMark): StepMark {
  if (state === "completed") return "done";
  if (state === "result_ready") return "waiting";
  return state && stored === "done" ? "open" : stored;
}

export function stepLines(
  plan: Pick<TaskPlan, "steps">,
  live: readonly LiveStep[] | null,
  state?: string | null,
): StepLine[] {
  const source: readonly { id: string; label: string; status?: PlaybookStepStatus }[] =
    live && live.length > 0 ? live : plan.steps;
  const work = source
    .filter((step) => step.id !== TASK_RESULT_STEP_ID)
    .map((step) => ({
      id: step.id,
      label: step.label as string | null,
      mark: step.status ? STEP_MARKS[step.status] : ("open" as StepMark),
    }));
  const confirm = source.find((step) => step.id === TASK_RESULT_STEP_ID);
  const stored = confirm?.status ? STEP_MARKS[confirm.status] : "open";
  return [
    ...work,
    {
      id: TASK_RESULT_STEP_ID,
      label: null,
      mark: live && live.length > 0 ? confirmMark(state, stored) : "open",
    },
  ];
}

const MARK_KEYS: Record<StepMark, TranslationKey> = {
  done: "tasks.step.done",
  active: "tasks.step.active",
  waiting: "tasks.step.waiting",
  open: "tasks.step.open",
};

export function stepMarkKey(mark: StepMark): TranslationKey {
  return MARK_KEYS[mark];
}

export type StepGraphState = "done" | "active" | "pending";

const GRAPH_STATES: Record<StepMark, StepGraphState> = {
  done: "done",
  active: "active",
  waiting: "active",
  open: "pending",
};

export function stepGraphState(mark: StepMark): StepGraphState {
  return GRAPH_STATES[mark];
}

export interface StepResult {
  id: string;
  label: string;
  text: string;
}

export function stepResults(live: readonly LiveStep[] | null | undefined): StepResult[] {
  return (live ?? [])
    .filter(
      (step) =>
        step.id !== TASK_RESULT_STEP_ID &&
        step.assurance === "assessment" &&
        step.status === "assessment_ready",
    )
    .map((step) => ({ id: step.id, label: step.label.trim(), text: (step.reason ?? "").trim() }))
    .filter((result) => result.text !== "");
}
