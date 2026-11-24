import { expect } from "bun:test";
import { RUN_ID, run, TASK_ID, task } from "@/features/tasks/model/tasks-fixtures";
import { formatMoney, type Locale } from "@/lib/i18n";
import { type Journey, journeys, mount } from "./journey-fixtures";
import { ALL_PERMISSIONS, NOW, WORKFLOW, workflow } from "./workspace-journey-fixtures";

const isolated = journeys(import.meta.path);

const SCHEDULE = "99999999-9999-4999-8999-999999999999";
const CRON = "45 6 1 * *";

interface Schedule {
  cron: string;
  timezone: string;
  paused: boolean;
}

const DAILY = { cron: "0 8 * * *", timezone: "Europe/Berlin", paused: false };

function costProjection(cron: string) {
  const daily = cron.endsWith("* * *");
  return {
    state: "estimated",
    basis: "version",
    runs_sampled: 12,
    runs_per_month: daily ? 30.42 : 4.33,
    per_run_amount: 0.138,
    monthly_amount: daily ? 4.2 : 0.6,
    currency: "EUR",
    unpriced_models: [],
    rates_basis: "current",
  };
}

function entry(schedule: Schedule) {
  return {
    id: SCHEDULE,
    workflow_id: WORKFLOW,
    admission_hold: null,
    input_error: null,
    workflow_slug: workflow.slug,
    workflow_name: workflow.name,
    prepared_version_id: null,
    cron: schedule.cron,
    timezone: schedule.timezone,
    execution_mode: "prod",
    paused: schedule.paused,
    auto_pause: null,
    input: null,
    created_at: NOW,
    updated_at: NOW,
    cost_projection: costProjection(schedule.cron),
  };
}

function invocation(schedule: Schedule | null) {
  return {
    workflow_id: WORKFLOW,
    slug: workflow.slug,
    invalid: false,
    base_url: null,
    http: {
      method: "POST",
      path: `/v1/workflows/${WORKFLOW}/run`,
      url: null,
      headers: [],
      body: { source: "saved", workflow_id: WORKFLOW, input: {} },
      snippets: null,
    },
    visibility: { hooks: true, schedules: true },
    hooks: [],
    mcp: {
      tool_name: "wf_testflight_invite",
      fallback: { tool_name: "run_workflow", arguments: { workflow: workflow.slug, input: {} } },
    },
    schedules: schedule
      ? [
          {
            cron: schedule.cron,
            timezone: schedule.timezone,
            environment: "prod",
            state: schedule.paused ? "paused" : "active",
            next_fire_at: null,
          },
        ]
      : [],
    cli: { command: `subkit workflow run ${workflow.slug}`, environment: "prod" },
    input: { source: "none", schema: null, sample: {} },
    output: { schema: null },
    authority: {},
    webhook_input_shape: {},
  };
}

function scenario(initial: Schedule | null = null) {
  let schedule = initial;
  const bodies: unknown[] = [];
  const read = (init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    return body;
  };
  const routes = {
    [`/v1/workflows/${WORKFLOW}`]: () => ({
      ...workflow,
      operating_status: "ready",
      definition: { name: workflow.name, steps: [] },
    }),
    [`/v1/workflows/${WORKFLOW}/diagnosis`]: () => ({
      workflow_id: WORKFLOW,
      workflow_version_id: null,
      environment: "prod",
      is_current: true,
      diagnoses: [],
    }),
    [`/v1/workflows/${WORKFLOW}/invocation`]: () => invocation(schedule),
    [`/v1/workflows/${WORKFLOW}/input-schema`]: () => ({ schema: null }),
    [`/v1/workflows/${WORKFLOW}/schedule-cost`]: (url: URL) =>
      costProjection(url.searchParams.get("cron") ?? ""),
    "POST /v1/schedules": (_url: URL, init: RequestInit | undefined) => {
      const body = read(init);
      schedule = { cron: String(body.cron), timezone: String(body.timezone), paused: false };
      return { ...entry(schedule), upsert_status: "created" };
    },
    [`PUT /v1/schedules/${SCHEDULE}`]: (_url: URL, init: RequestInit | undefined) => {
      const body = read(init);
      if (!schedule) throw new Error("no schedule to update");
      schedule = { ...schedule, paused: body.paused === true };
      return { ...entry(schedule), upsert_status: "updated" };
    },
    "/v1/schedules": () => ({
      schedules: schedule ? [entry(schedule)] : [],
      total: schedule ? 1 : 0,
    }),
  };
  return { routes, bodies, current: () => schedule };
}

async function createPauseResume(locale: Locale) {
  const flow = scenario();
  const app = await mount(`/workflows/${WORKFLOW}#workflow-section-use`, {
    locale,
    permissions: ALL_PERMISSIONS,
    routes: flow.routes,
  });
  app.at(`/workflows/${WORKFLOW}`);
  await app.click("workflow-invocation-tab-schedule");
  expect(app.find("schedule-none")?.textContent).toContain(app.t("schedule.none"));

  await app.click("schedule-create");
  expect(app.find("schedule-dialog-title")?.textContent).toBe(app.t("schedule.createTitle"));
  expect(app.find("schedule-dialog")?.textContent).toContain("Europe/Berlin");
  await app.press("schedule-rhythm-monthly");
  await app.fill("schedule-time", "06:45");
  await app.click("schedule-dialog-submit");
  expect(app.seen).toContain("POST /v1/schedules");
  expect(flow.bodies[0]).toMatchObject({
    workflow_id: WORKFLOW,
    cron: CRON,
    timezone: "Europe/Berlin",
  });
  expect(app.find("schedule-dialog")).toBeNull();
  expect(app.text()).toContain(app.t("schedule.created"));
  expect(app.find("workflow-schedule")).not.toBeNull();
  expect(app.find("schedule-next-fact")?.textContent).not.toContain(app.t("schedule.isPaused"));

  await app.press("schedule-menu");
  expect(app.find("schedule-pause")?.textContent).toBe(app.t("schedule.pause"));
  await app.press("schedule-pause");
  expect(app.seen).toContain(`PUT /v1/schedules/${SCHEDULE}`);
  expect(flow.bodies[1]).toEqual({ paused: true });
  expect(flow.current()?.paused).toBe(true);
  expect(app.text()).toContain(app.t("schedule.paused"));
  expect(app.find("schedule-next-fact")?.textContent).toContain(app.t("schedule.isPaused"));

  await app.press("schedule-menu");
  expect(app.find("schedule-pause")?.textContent).toBe(app.t("schedule.resume"));
  await app.press("schedule-pause");
  expect(flow.bodies[2]).toEqual({ paused: false });
  expect(flow.current()?.paused).toBe(false);
  expect(app.text()).toContain(app.t("schedule.resumed"));
  expect(app.find("schedule-next-fact")?.textContent).not.toContain(app.t("schedule.isPaused"));
  app.at(`/workflows/${WORKFLOW}`);
  expect(app.missingKeys()).toEqual([]);
}

isolated("Schedules (de) › create, pause and resume a schedule", () => createPauseResume("de"));

isolated("Schedules (en) › create, pause and resume a schedule", () => createPauseResume("en"));

const perMonth = (app: Journey, amount: number) =>
  app.t("schedule.cost.amount", { amount: formatMoney(app.locale, amount, "EUR") });

isolated("Schedules › the schedule shows its monthly estimate", async () => {
  const app = await mount(`/workflows/${WORKFLOW}#workflow-section-use`, {
    routes: scenario(DAILY).routes,
  });
  await app.click("workflow-invocation-tab-schedule");
  const fact = app.find("schedule-cost-fact")?.textContent ?? "";
  expect(fact).toContain(perMonth(app, 4.2));
  expect(fact).toContain(app.t("schedule.cost.basis.version.other", { count: 12 }));
});

isolated("Schedules › the estimate of a new schedule follows the chosen rhythm", async () => {
  const app = await mount(`/workflows/${WORKFLOW}#workflow-section-use`, {
    routes: scenario().routes,
  });
  await app.click("workflow-invocation-tab-schedule");
  await app.click("schedule-create");
  await app.settle(80);
  expect(app.find("schedule-cost-preview")?.textContent).toContain(perMonth(app, 4.2));
  await app.click("schedule-rhythm-weekly");
  await app.settle(80);
  expect(app.find("schedule-cost-preview")?.textContent).toContain(perMonth(app, 0.6));
  expect(app.seen.filter((call) => call.includes("/schedule-cost?")).length).toBeGreaterThan(1);
});

const TASK_OCCURRENCE = "88888888-8888-4888-8888-888888888888";

const taskScheduleRoutes = {
  [`/v1/tasks/${TASK_ID}`]: () =>
    task({ schedule_cron: DAILY.cron, schedule_timezone: DAILY.timezone }),
  [`/v1/tasks/${TASK_ID}/runs`]: () => ({ items: [], next_cursor: null, total: 0 }),
  [`/v1/task-runs/${RUN_ID}`]: () =>
    run({ trigger: "cron", state: "completed", ended_at: NOW, completed_at: NOW }),
  [`/v1/tasks/${TASK_ID}/schedule-occurrences`]: () => ({
    items: [
      {
        id: TASK_OCCURRENCE,
        workflow_id: null,
        task_id: TASK_ID,
        schedule_id: null,
        due_at: NOW,
        last_due_at: NOW,
        started_at: NOW,
        state: "ran",
        reason_code: null,
        skipped_count: 0,
        execution_id: null,
        task_run_id: RUN_ID,
        run_outcome: "succeeded",
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    next_before: null,
  }),
};

isolated("Schedules › a task occurrence opens its scheduled run", async () => {
  const app = await mount(`/tasks/${TASK_ID}?tab=schedule`, {
    routes: taskScheduleRoutes,
    permissions: ALL_PERMISSIONS,
  });
  await app.click(`schedule-occurrence-open-${TASK_OCCURRENCE}`);
  expect(new URL(app.dom.window.location.href).searchParams.get("task_run")).toBe(RUN_ID);
  expect(app.find("task-run-sheet")).not.toBeNull();
});

isolated("Schedules › a task occurrence offers no run without task_run:read", async () => {
  const app = await mount(`/tasks/${TASK_ID}?tab=schedule`, {
    routes: taskScheduleRoutes,
    permissions: ALL_PERMISSIONS.filter((permission) => permission !== "task_run:read"),
  });
  expect(app.find("schedule-history")).not.toBeNull();
  expect(app.find(`schedule-occurrence-open-${TASK_OCCURRENCE}`)).toBeNull();
});
