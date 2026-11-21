import type {
  AutomationInputs,
  AutomationRowState,
  AutomationStatusLike,
  ScheduleLike,
} from "@/features/grants/model/automation-state";
import type { WorkflowAuthority } from "@/features/grants/model/workflow-authorities";

export const WORKFLOW = "00000000-0000-4000-8000-000000000002";

export const ACTIVE = "00000000-0000-4000-8000-000000000003";

export const DRAFT = "00000000-0000-4000-8000-000000000013";

export const NOW = Date.parse("2030-03-10T12:00:00.000Z");

export function authority(overrides: Partial<WorkflowAuthority> = {}): WorkflowAuthority {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workflow_id: WORKFLOW,
    workflow_version_id: ACTIVE,
    effect_manifest_digest: "digest",
    effect_manifest: {
      schema_version: 1,
      tenant_id: "00000000-0000-4000-8000-000000000004",
      workflow_id: WORKFLOW,
      workflow_version_id: ACTIVE,
      workflow_digest: "workflow",
      execution_environment: "prod",
      execution_options_digest: "options",
      effects: [],
      issues: [],
    },
    execution_environment: "prod",
    target_constraints: { targets: [] },
    valid_from: "2030-03-01T00:00:00.000Z",
    valid_until: "2030-03-30T00:00:00.000Z",
    max_runs: 30,
    reserved_runs: 2,
    remaining_runs: 28,
    created_by: "00000000-0000-4000-8000-000000000005",
    created_at: "2030-03-01T00:00:00.000Z",
    revoked_at: null,
    revoked_by: null,
    open_ended: false,
    inherited_from: null,
    superseded_by: null,
    active_version: true,
    ready_for_new_run: true,
    state: "approved",
    ...overrides,
  };
}

export const schedule = (overrides: Partial<ScheduleLike> = {}): ScheduleLike => ({
  id: "schedule-1",
  cron: "0 7 * * *",
  timezone: "Europe/Berlin",
  execution_mode: "prod",
  paused: false,
  ...overrides,
});

export function status(
  schedules: AutomationRowState[] = [],
  hooks: AutomationRowState[] = [],
): AutomationStatusLike {
  return {
    schedules: schedules.map((state, index) => ({
      schedule_id: `schedule-${index + 1}`,
      state,
      cron: "0 7 * * *",
      timezone: "Europe/Berlin",
      environment: "prod",
      next_run_at: null,
    })),
    inbound_hooks: hooks.map((state, index) => ({
      inbound_hook_id: `hook-${index + 1}`,
      slug: `hook-${index + 1}`,
      state,
      environment: "prod",
    })),
  };
}

export const block = (overrides: Record<string, unknown> = {}) =>
  ({
    code: "report_inspection_missing",
    subject: { step_id: "send_email" },
    evidence: {},
    remedy_kind: "author",
    ...overrides,
  }) as NonNullable<AutomationInputs["diagnosis"]>["diagnoses"][number];

export function inputs(overrides: Partial<AutomationInputs> = {}): AutomationInputs {
  return {
    workflow: {
      lifecycle: "active",
      current_version_id: ACTIVE,
      draft_version_id: ACTIVE,
      current_version: 9,
      webhooks_active: 0,
    },
    draft: null,
    schedules: [schedule()],
    status: status(["approval_required"]),
    authorities: [],
    diagnosis: { is_current: true, diagnoses: [] },
    unanswered: { status: false, diagnosis: false },
    now: NOW,
    ...overrides,
  };
}

export function rows(
  entries: ReadonlyArray<readonly [AutomationRowState, "dev" | "prod"]>,
): AutomationStatusLike {
  return {
    schedules: entries.map(([state, environment], index) => ({
      schedule_id: `schedule-${index + 1}`,
      state,
      cron: "0 7 * * *",
      timezone: "Europe/Berlin",
      environment,
      next_run_at: null,
    })),
    inbound_hooks: [],
  };
}

export const hooked = {
  lifecycle: "active",
  current_version_id: ACTIVE,
  draft_version_id: ACTIVE,
  current_version: 9,
  webhooks_active: 1,
};
