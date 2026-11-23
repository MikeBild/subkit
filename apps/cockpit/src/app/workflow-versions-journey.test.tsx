import { expect } from "bun:test";
import type { Locale } from "@/lib/i18n";
import {
  ALL_PERMISSIONS,
  journeys,
  mount,
  NOW,
  TENANT,
  USER,
  WORKFLOW,
  workflow,
} from "./journey-fixtures";

const isolated = journeys(import.meta.path);

const V1 = "66666666-6666-4666-8666-000000000001";
const V2 = "66666666-6666-4666-8666-000000000002";
const V3 = "66666666-6666-4666-8666-000000000003";
const AUTHORITY = "77777777-7777-4777-8777-777777777777";

function version(id: string, number: number, note: string | null) {
  return {
    id,
    workflow_id: WORKFLOW,
    version: number,
    note,
    created_at: NOW,
    dag: { name: workflow.name, steps: [] },
    invalid: false,
    author: { kind: "user", id: USER },
    checksum: `checksum-${number}`,
  };
}

const SCHEDULE = "88888888-8888-4888-8888-888888888888";

function authority(live: boolean) {
  return {
    id: AUTHORITY,
    workflow_id: WORKFLOW,
    workflow_version_id: V2,
    effect_manifest_digest: "digest",
    effect_manifest: {
      schema_version: 1,
      tenant_id: TENANT,
      workflow_id: WORKFLOW,
      workflow_version_id: V2,
      workflow_digest: "workflow",
      execution_environment: "prod",
      execution_options_digest: "options",
      effects: [],
      issues: [],
    },
    execution_environment: "prod",
    target_constraints: { targets: [] },
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
    max_runs: null,
    reserved_runs: 0,
    remaining_runs: null,
    created_by: USER,
    created_at: NOW,
    revoked_at: null,
    revoked_by: null,
    open_ended: true,
    inherited_from: null,
    superseded_by: null,
    active_version: live,
    ready_for_new_run: live,
    state: "approved",
  };
}

const schedule = {
  id: SCHEDULE,
  workflow_id: WORKFLOW,
  admission_hold: null,
  input_error: null,
  workflow_slug: workflow.slug,
  workflow_name: workflow.name,
  prepared_version_id: null,
  cron: "0 7 * * *",
  timezone: "Europe/Berlin",
  execution_mode: "prod",
  paused: false,
  auto_pause: null,
  input: null,
  created_at: NOW,
  updated_at: NOW,
};

function scenario() {
  let restored = false;
  const history = () =>
    restored
      ? [
          version(V3, 3, "restored from v1"),
          version(V2, 2, "Send the invite"),
          version(V1, 1, null),
        ]
      : [version(V2, 2, "Send the invite"), version(V1, 1, null)];
  const record = () => ({
    ...workflow,
    operating_status: "ready",
    current_version_id: restored ? V3 : V2,
    draft_version_id: null,
    current_version: restored ? 3 : 2,
    definition: { name: workflow.name, steps: [] },
  });
  const routes = {
    [`/v1/workflows/${WORKFLOW}`]: record,
    [`/v1/workflows/${WORKFLOW}/history`]: () => ({ items: history(), total: history().length }),
    [`POST /v1/workflows/${WORKFLOW}/restore/1`]: () => {
      restored = true;
      return record();
    },
    [`/v1/workflows/${WORKFLOW}/execution-authorities`]: () => ({
      items: [authority(!restored)],
      next_cursor: null,
    }),
    "/v1/schedules": () => ({ schedules: [schedule], total: 1 }),
    [`/v1/workflows/${WORKFLOW}/diagnosis`]: () => ({
      workflow_id: WORKFLOW,
      workflow_version_id: restored ? V3 : V2,
      environment: "prod",
      is_current: true,
      diagnoses: [],
    }),
    [`/v1/workflows/${WORKFLOW}/automation-status`]: () => ({
      schedules: [
        {
          schedule_id: SCHEDULE,
          state: restored ? "approval_required" : "authorized",
          cron: schedule.cron,
          timezone: schedule.timezone,
          environment: "prod",
          next_run_at: null,
        },
      ],
      inbound_hooks: [],
    }),
  };
  return { routes };
}

async function restoreOlderVersion(locale: Locale) {
  const flow = scenario();
  const app = await mount(`/workflows/${WORKFLOW}#workflow-section-build`, {
    locale,
    permissions: ALL_PERMISSIONS,
    routes: flow.routes,
  });
  app.at(`/workflows/${WORKFLOW}`);
  const automation = () => app.find("workflow-automation")?.getAttribute("data-state");
  expect(automation()).toBe("approved");

  await app.click("workflow-versions-toggle");
  expect(app.find("workflow-versions")?.textContent).toContain(
    app.t("workflowVersions.state.current"),
  );
  await app.click("workflow-versions-row-link-1");
  expect(app.find("workflow-version-title")?.textContent).toBe(`${workflow.name} · v1`);
  expect(app.find("workflow-version-hint")?.textContent).toBe(
    app.t("workflowVersions.restoreHint", { next: "v3", newest: "v2" }),
  );

  await app.click("workflow-version-restore");
  expect(app.seen).toContain(`POST /v1/workflows/${WORKFLOW}/restore/1`);
  expect(app.find("workflow-version-sheet")).toBeNull();
  expect(app.text()).toContain(app.t("workflowVersions.restored", { from: "v1", next: "v3" }));
  const versions = app.find("workflow-versions")?.textContent ?? "";
  expect(versions).toContain(app.t("workflowVersions.restoredFrom", { version: "v1" }));
  expect(versions).toContain("v3");
  expect(automation()).toBe("grant");
  app.at(`/workflows/${WORKFLOW}`);
  expect(app.missingKeys()).toEqual([]);
}

isolated("Workflow versions (de) › restoring an older version asks for approval again", () =>
  restoreOlderVersion("de"),
);

isolated("Workflow versions (en) › restoring an older version asks for approval again", () =>
  restoreOlderVersion("en"),
);
