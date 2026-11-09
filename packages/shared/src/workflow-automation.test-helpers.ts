import type { AutomationInputs, WorkflowAuthority } from "./workflow-automation.ts";

export const NOW = Date.parse("2026-01-15T12:00:00.000Z");

export const authority = (overrides: Partial<WorkflowAuthority> = {}): WorkflowAuthority => ({
  execution_environment: "dev",
  active_version: true,
  ready_for_new_run: true,
  state: "approved",
  valid_from: "2026-01-01T00:00:00.000Z",
  valid_until: "2026-02-01T00:00:00.000Z",
  revoked_at: null,
  remaining_runs: 8,
  max_runs: 10,
  reserved_runs: 2,
  ...overrides,
});

export const input = (overrides: Partial<AutomationInputs> = {}): AutomationInputs => ({
  workflow: { lifecycle: "active", current_version_id: "active", current_version: 1 },
  schedules: [],
  status: { schedules: [], inbound_hooks: [] },
  authorities: [],
  diagnosis: { is_current: true, diagnoses: [] },
  unanswered: { status: false, diagnosis: false },
  now: NOW,
  ...overrides,
});
