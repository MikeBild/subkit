import { expect } from "bun:test";
import type { Locale } from "@/lib/i18n";
import { ALL_PERMISSIONS, journeys, mount, NOW, WORKFLOW, workflow } from "./journey-fixtures";

const isolated = journeys(import.meta.path);

const SCHEDULE = "99999999-9999-4999-8999-999999999999";
const CRON = "45 6 1 * *";

interface Schedule {
  cron: string;
  timezone: string;
  paused: boolean;
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

function scenario() {
  let schedule: Schedule | null = null;
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
  await app.press("schedule-rhythm-monthly");
  await app.fill("schedule-time", "06:45");
  await app.click("schedule-dialog-submit");
  expect(app.seen).toContain("POST /v1/schedules");
  expect(flow.bodies[0]).toMatchObject({ workflow_id: WORKFLOW, cron: CRON });
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
