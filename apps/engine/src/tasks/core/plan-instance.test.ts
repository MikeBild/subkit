import { describe, expect, test } from "bun:test";
import { type PlaybookPlan, PlaybookPlanSchema } from "../../conversations/public/authoring.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import {
  instantiateTaskPlan,
  TASK_PLAN_TEMPLATE_MAX_STEPS,
  TASK_RESULT_STEP_ID,
  taskPlanTemplateIssue,
  taskPlaybookFacts,
} from "./plan-instance.ts";

const WORKFLOW = "00000000-0000-4000-8000-000000000001";
const EVIDENCE = "00000000-0000-4000-8000-000000000002";
const DECISION = "00000000-0000-4000-8000-000000000003";
const STARTED = "2026-11-19T08:00:00.000Z";
const GOAL = "Send the weekly report";

type Step = PlaybookPlan["steps"][number];

function step(id: string, overrides: Partial<Step> = {}): Step {
  return {
    id,
    label: `Step ${id}`,
    criterion: { kind: "assessment", description: "Numbers are complete", result: null },
    depends_on: [],
    evidence_ids: [],
    note: null,
    progress: "open",
    next_action: null,
    ...overrides,
  };
}

function template(steps: Step[], overrides: Partial<PlaybookPlan> = {}): PlaybookPlan {
  return {
    title: "Weekly report",
    goal: "Template goal",
    steps,
    cancelled: false,
    completion_step_id: null,
    ...overrides,
  };
}

const used = template([
  step("collect", {
    criterion: {
      kind: "assessment",
      description: "Numbers are complete",
      result: "The numbers from last week were complete and checked.",
    },
    evidence_ids: [EVIDENCE],
    note: "Done last week",
    progress: "in_progress",
    next_action: { label: "Ask finance", owner: "Finance", elicitation_id: DECISION },
  }),
  step("send", {
    criterion: {
      kind: "execution_succeeded",
      workflow_id: WORKFLOW,
      environment: "prod",
      after: "2026-01-01T00:00:00.000Z",
    },
    depends_on: ["collect", TASK_RESULT_STEP_ID],
    progress: "blocked",
  }),
  step("read", {
    criterion: { kind: "resource_observed", resource: { type: "workflow", id: WORKFLOW } },
    progress: "waiting_for_input",
  }),
  step(TASK_RESULT_STEP_ID, {
    criterion: { kind: "human_confirmation", question: "Old question" },
    evidence_ids: [DECISION],
  }),
]);

describe("instantiateTaskPlan", () => {
  const instance = instantiateTaskPlan(used, { goal: GOAL, started_at: STARTED });

  test("is a valid playbook plan that ends with the confirmation of the goal", () => {
    expect(PlaybookPlanSchema.safeParse(instance).success).toBe(true);
    expect(instance.title).toBe("Weekly report");
    expect(instance.goal).toBe(GOAL);
    expect(instance.cancelled).toBe(false);
    expect(instance.completion_step_id).toBe(TASK_RESULT_STEP_ID);
    expect(instance.steps.map((item) => item.id)).toEqual([
      "collect",
      "send",
      "read",
      TASK_RESULT_STEP_ID,
    ]);
    expect(instance.steps.at(-1)).toEqual({
      id: TASK_RESULT_STEP_ID,
      label: GOAL,
      criterion: { kind: "human_confirmation", question: GOAL },
      depends_on: ["collect", "send", "read"],
      evidence_ids: [],
      note: null,
      progress: "open",
      next_action: null,
    });
  });

  test("resets everything a previous run left behind", () => {
    expect(instance.steps[0]).toEqual({
      id: "collect",
      label: "Step collect",
      criterion: { kind: "assessment", description: "Numbers are complete", result: null },
      depends_on: [],
      evidence_ids: [],
      note: null,
      progress: "open",
      next_action: { label: "Ask finance", owner: "Finance", elicitation_id: null },
    });
    expect(instance.steps[1]).toEqual({
      id: "send",
      label: "Step send",
      criterion: {
        kind: "execution_succeeded",
        workflow_id: WORKFLOW,
        environment: "prod",
        after: STARTED,
      },
      depends_on: ["collect"],
      evidence_ids: [],
      note: null,
      progress: "open",
      next_action: null,
    });
    expect(instance.steps[2]?.criterion).toEqual({
      kind: "resource_observed",
      resource: { type: "workflow", id: WORKFLOW },
    });
    expect(instance.steps[2]?.progress).toBe("open");
  });

  test("never carries evidence, whatever the template holds", () => {
    for (let count = 1; count <= TASK_PLAN_TEMPLATE_MAX_STEPS; count += 6) {
      const steps = Array.from({ length: count }, (_, index) =>
        step(`s${index}`, {
          evidence_ids: [EVIDENCE, DECISION],
          note: "kept",
          progress: "blocked",
        }),
      );
      const fresh = instantiateTaskPlan(template(steps, { cancelled: true }), {
        goal: GOAL,
        started_at: STARTED,
      });
      expect(PlaybookPlanSchema.safeParse(fresh).success).toBe(true);
      expect(fresh.steps).toHaveLength(count + 1);
      expect(fresh.steps.flatMap((item) => item.evidence_ids)).toEqual([]);
      expect(fresh.steps.every((item) => item.note === null && item.progress === "open")).toBe(
        true,
      );
    }
  });

  test("does not change the template", () => {
    const before = JSON.stringify(used);
    instantiateTaskPlan(used, { goal: GOAL, started_at: STARTED });
    expect(JSON.stringify(used)).toBe(before);
  });
});

describe("the confirmation step", () => {
  test("stores the goal alone, also at the playbook limit", () => {
    const goal = "x".repeat(600);
    const fresh = instantiateTaskPlan(template([step("one")]), { goal, started_at: STARTED });
    expect(PlaybookPlanSchema.safeParse(fresh).success).toBe(true);
    expect(fresh.steps.at(-1)?.label).toBe(goal);
    expect(fresh.steps.at(-1)?.criterion).toEqual({ kind: "human_confirmation", question: goal });
  });
});

describe("taskPlanTemplateIssue", () => {
  const confirmation = step(TASK_RESULT_STEP_ID, {
    criterion: { kind: "human_confirmation", question: GOAL },
  });

  test("accepts a template that leaves room for the confirmation", () => {
    const steps = Array.from({ length: TASK_PLAN_TEMPLATE_MAX_STEPS }, (_, index) =>
      step(`s${index}`),
    );
    expect(taskPlanTemplateIssue(template(steps))).toBeNull();
    expect(taskPlanTemplateIssue(template([...steps, confirmation]))).toBeNull();
    expect(taskPlanTemplateIssue(template([step("one")]))).toBeNull();
  });

  test("names what is wrong", () => {
    const steps = Array.from({ length: TASK_PLAN_TEMPLATE_MAX_STEPS + 1 }, (_, index) =>
      step(`s${index}`),
    );
    expect(taskPlanTemplateIssue(template(steps))).toBe("plan_too_many_steps");
    expect(taskPlanTemplateIssue(template([confirmation]))).toBe("plan_without_steps");
    expect(taskPlanTemplateIssue(template([step("one")], { cancelled: true }))).toBe(
      "plan_cancelled",
    );
    expect(taskPlanTemplateIssue(template([confirmation], { cancelled: true }))).toBe(
      "plan_cancelled",
    );
  });

  test("refuses a work step that uses the reserved confirmation id", () => {
    expect(taskPlanTemplateIssue(template([step("one"), step(TASK_RESULT_STEP_ID)]))).toBe(
      "plan_reserved_step_id",
    );
    expect(
      taskPlanTemplateIssue(
        template([step("one"), step(TASK_RESULT_STEP_ID)], { cancelled: true }),
      ),
    ).toBe("plan_cancelled");
  });
});

describe("taskPlaybookFacts", () => {
  const stored = instantiateTaskPlan(template([step("a"), step("b")]), {
    goal: GOAL,
    started_at: STARTED,
  });
  const view = (statuses: Record<string, string>, status = "in_progress") => ({
    status,
    revision: 4,
    steps: Object.entries(statuses).map(([id, value]) => ({ id, status: value, evidence: [] })),
  });
  const open = { a: "open", b: "open", [TASK_RESULT_STEP_ID]: "open" };

  test("passes status and revision through for an untouched plan", () => {
    expect(taskPlaybookFacts(view(open, "open"), stored, GOAL)).toEqual({
      status: "open",
      revision: 4,
      intact: true,
      result_confirmed: false,
      awaiting_result_confirmation: false,
      progress_marks: [],
    });
  });

  const awaiting: Array<[string, Record<string, string>, boolean]> = [
    ["all work verified", { a: "verified", b: "verified", [TASK_RESULT_STEP_ID]: "open" }, true],
    [
      "assessments delivered",
      { a: "assessment_ready", b: "verified", [TASK_RESULT_STEP_ID]: "waiting_for_input" },
      true,
    ],
    ["one step open", { a: "verified", b: "in_progress", [TASK_RESULT_STEP_ID]: "open" }, false],
    ["first step open", { a: "open", b: "verified", [TASK_RESULT_STEP_ID]: "open" }, false],
    [
      "already confirmed",
      { a: "verified", b: "verified", [TASK_RESULT_STEP_ID]: "verified" },
      false,
    ],
    ["no confirmation step", { a: "verified", b: "verified" }, false],
  ];
  for (const [label, statuses, expected] of awaiting)
    test(`awaiting confirmation: ${label}`, () => {
      expect(taskPlaybookFacts(view(statuses), stored, GOAL).awaiting_result_confirmation).toBe(
        expected,
      );
    });

  test("the result counts as confirmed only when the confirmation step is verified", () => {
    const facts = (status: string) =>
      taskPlaybookFacts(view({ ...open, [TASK_RESULT_STEP_ID]: status }), stored, GOAL);
    expect(facts("verified").result_confirmed).toBe(true);
    expect(facts("open").result_confirmed).toBe(false);
    expect(facts("assessment_ready").result_confirmed).toBe(false);
    expect(taskPlaybookFacts(view({ a: "verified" }), stored, GOAL).result_confirmed).toBe(false);
  });

  const confirm = stored.steps.at(-1)!;
  const tampered: Array<[string, Parameters<typeof taskPlaybookFacts>[1], Record<string, string>]> =
    [
      ["goal rewritten", { ...stored, goal: "Something else" }, open],
      ["completion points elsewhere", { ...stored, completion_step_id: "a" }, open],
      ["completion removed", { ...stored, completion_step_id: null }, open],
      ["confirmation step dropped", { ...stored, steps: stored.steps.slice(0, -1) }, open],
      [
        "confirmation turned into an assessment",
        {
          ...stored,
          steps: [...stored.steps.slice(0, -1), { ...confirm, criterion: { kind: "assessment" } }],
        },
        open,
      ],
      [
        "confirmation question rewritten",
        {
          ...stored,
          steps: [
            ...stored.steps.slice(0, -1),
            { ...confirm, criterion: { kind: "human_confirmation", question: "Fine?" } },
          ],
        },
        open,
      ],
      ["confirmation missing from the view", stored, { a: "open", b: "open" }],
    ];
  for (const [label, plan, statuses] of tampered)
    test(`not intact: ${label}`, () => {
      expect(taskPlaybookFacts(view(statuses), plan, GOAL).intact).toBe(false);
    });

  test("a different task goal makes the stored plan foreign", () => {
    expect(taskPlaybookFacts(view(open), stored, "Another goal").intact).toBe(false);
  });
});

describe("the progress marks of the facts", () => {
  const digest = (text: string) => workflowJsonDigest(text);
  const viewStep = (
    id: string,
    status: string,
    evidence: Array<{ id: string; freshness: string }> = [],
  ) => ({ id, status, evidence });
  const planStep = (id: string, result?: string | null) => ({
    id,
    criterion:
      result === undefined
        ? id === TASK_RESULT_STEP_ID
          ? { kind: "human_confirmation", question: GOAL }
          : { kind: "execution_succeeded" }
        : { kind: "assessment", result },
  });
  const marks = (
    steps: ReturnType<typeof viewStep>[],
    plan: ReturnType<typeof planStep>[],
  ): string[] =>
    taskPlaybookFacts(
      { status: "in_progress", revision: 2, steps },
      { goal: GOAL, completion_step_id: TASK_RESULT_STEP_ID, steps: plan },
      GOAL,
    ).progress_marks;

  test("an untouched plan carries no mark", () => {
    expect(
      marks(
        [viewStep("a", "open"), viewStep(TASK_RESULT_STEP_ID, "blocked")],
        [planStep("a", null), planStep(TASK_RESULT_STEP_ID)],
      ),
    ).toEqual([]);
  });

  test("ready work steps are counted, fresh evidence is named, written results by their content", () => {
    expect(
      marks(
        [
          viewStep("a", "verified", [
            { id: "call-1", freshness: "fresh" },
            { id: "call-2", freshness: "stale" },
            { id: "call-3", freshness: "unavailable" },
          ]),
          viewStep("b", "in_progress", [{ id: "call-4", freshness: "fresh" }]),
          viewStep("c", "assessment_ready"),
          viewStep("d", "waiting_for_input"),
          viewStep(TASK_RESULT_STEP_ID, "verified"),
        ],
        [
          planStep("a"),
          planStep("b", null),
          planStep("c", "Done."),
          planStep("d", ""),
          planStep(TASK_RESULT_STEP_ID),
        ],
      ),
    ).toEqual([
      "ready:1",
      "ready:2",
      "evidence:call-1",
      "evidence:call-4",
      `result:${digest("Done.")}`,
      `result:${digest("")}`,
    ]);
  });

  test("notes, labels, the order of steps and their ids leave the marks of the same work alone", () => {
    const of = (ids: [string, string]) =>
      marks(
        [
          viewStep(ids[0], "assessment_ready", [{ id: "call-1", freshness: "fresh" }]),
          viewStep(ids[1], "open"),
        ],
        [planStep(ids[0], "Done."), planStep(ids[1], null)],
      );
    expect(of(["a", "b"])).toEqual(of(["renamed", "other"]));
    expect(of(["a", "b"])).toEqual(["ready:1", "evidence:call-1", `result:${digest("Done.")}`]);
  });
});
