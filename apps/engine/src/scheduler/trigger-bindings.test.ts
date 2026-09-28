// Precedence table for the effective trigger. The scheduler fires from the
// `workflows_schedules` row, not the definition, so a bound row must win over
// whatever the definition declares — and a declaration without a row must not
// read as a trigger that fires.

import { describe, expect, test } from "bun:test";
import type { WorkflowTrigger } from "../workflows/types.ts";
import {
  type EffectiveTrigger,
  resolveEffectiveTrigger,
  scheduleBindingState,
  type TriggerBinding,
  type WorkflowScheduleBinding,
  workflowTriggerView,
} from "./trigger-bindings.ts";

const row = (over: Partial<WorkflowScheduleBinding> = {}): WorkflowScheduleBinding => ({
  id: "s1",
  cron: "7 * * * *",
  timezone: "UTC",
  paused: false,
  execution_mode: "prod",
  admission_hold: null,
  state: "active",
  next_fire_at: "2026-01-01T00:07:00.000Z",
  last_enqueued_at: null,
  ...over,
});

const HELD = {
  reason_code: "execution_authority_unavailable" as const,
  observed_at: "2026-01-01T00:00:00.000Z",
};
const DEF_SCHEDULE: WorkflowTrigger = { kind: "schedule", cron: "0 6 * * *", tz: "UTC" };
const DEF_WEBHOOK: WorkflowTrigger = {
  kind: "webhook",
  source: "stripe",
  events: [],
  verify: "none",
};
const DEF_REQUEST: WorkflowTrigger = { kind: "request" };

const cases: Array<{
  name: string;
  definition: WorkflowTrigger | null;
  binding: TriggerBinding;
  expected: EffectiveTrigger;
}> = [
  {
    name: "no definition trigger, bound schedule row → schedule from the binding",
    definition: null,
    binding: { schedule: row(), webhooks_active: 0 },
    expected: { kind: "schedule", source: "binding", state: "active" },
  },
  {
    name: "definition says request, bound schedule row → the row wins",
    definition: DEF_REQUEST,
    binding: { schedule: row(), webhooks_active: 0 },
    expected: { kind: "schedule", source: "binding", state: "active" },
  },
  {
    name: "definition says webhook, firing schedule row → the row wins over webhooks too",
    definition: DEF_WEBHOOK,
    binding: { schedule: row(), webhooks_active: 2 },
    expected: { kind: "schedule", source: "binding", state: "active" },
  },
  {
    name: "paused row → paused",
    definition: DEF_SCHEDULE,
    binding: {
      schedule: row({ paused: true, state: "paused", next_fire_at: null }),
      webhooks_active: 0,
    },
    expected: { kind: "schedule", source: "binding", state: "paused" },
  },
  {
    name: "admission-held row → held",
    definition: null,
    binding: {
      schedule: row({ admission_hold: HELD, state: "held", next_fire_at: null }),
      webhooks_active: 0,
    },
    expected: { kind: "schedule", source: "binding", state: "held" },
  },
  {
    name: "schedule on a workflow that is not active → activation_required",
    definition: null,
    binding: {
      schedule: row({ state: "activation_required", next_fire_at: null }),
      webhooks_active: 0,
    },
    expected: { kind: "schedule", source: "binding", state: "activation_required" },
  },
  {
    name: "paused schedule beside active webhooks → the webhooks still fire, so webhook",
    definition: null,
    binding: {
      schedule: row({ paused: true, state: "paused", next_fire_at: null }),
      webhooks_active: 1,
    },
    expected: { kind: "webhook", source: "binding", state: "active" },
  },
  {
    name: "held schedule beside active webhooks → webhook",
    definition: DEF_SCHEDULE,
    binding: {
      schedule: row({ admission_hold: HELD, state: "held", next_fire_at: null }),
      webhooks_active: 2,
    },
    expected: { kind: "webhook", source: "binding", state: "active" },
  },
  {
    name: "schedule awaiting activation beside active webhooks → webhook",
    definition: null,
    binding: {
      schedule: row({ state: "activation_required", next_fire_at: null }),
      webhooks_active: 1,
    },
    expected: { kind: "webhook", source: "binding", state: "active" },
  },
  {
    name: "no schedule row, active webhook rows → webhook from the binding",
    definition: null,
    binding: { schedule: null, webhooks_active: 1 },
    expected: { kind: "webhook", source: "binding", state: "active" },
  },
  {
    name: "definition says schedule, no row → declared but unbound",
    definition: DEF_SCHEDULE,
    binding: { schedule: null, webhooks_active: 0 },
    expected: { kind: "schedule", source: "definition", state: "declared_unbound" },
  },
  {
    name: "definition says webhook, no active row → declared but unbound",
    definition: DEF_WEBHOOK,
    binding: { schedule: null, webhooks_active: 0 },
    expected: { kind: "webhook", source: "definition", state: "declared_unbound" },
  },
  {
    name: "definition says request, nothing bound → request from the definition",
    definition: DEF_REQUEST,
    binding: { schedule: null, webhooks_active: 0 },
    expected: { kind: "request", source: "definition", state: "active" },
  },
  {
    name: "nothing declared, nothing bound → request by default",
    definition: null,
    binding: { schedule: null, webhooks_active: 0 },
    expected: { kind: "request", source: "default", state: "active" },
  },
];

describe("resolveEffectiveTrigger precedence", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(resolveEffectiveTrigger(c.definition, c.binding)).toEqual(c.expected);
    });
  }

  test("binding state: paused beats activation beats held; only an active workflow fires", () => {
    const active = { lifecycle: "active", current_version_id: "v1" };
    expect(scheduleBindingState({ paused: true, admission_hold: HELD, ...active })).toBe("paused");
    expect(
      scheduleBindingState({
        paused: false,
        admission_hold: HELD,
        lifecycle: "archived",
        current_version_id: "v1",
      }),
    ).toBe("activation_required");
    expect(
      scheduleBindingState({
        paused: false,
        admission_hold: null,
        lifecycle: "draft",
        current_version_id: "v1",
      }),
    ).toBe("activation_required");
    expect(
      scheduleBindingState({
        paused: false,
        admission_hold: null,
        lifecycle: "active",
        current_version_id: null,
      }),
    ).toBe("activation_required");
    expect(scheduleBindingState({ paused: false, admission_hold: HELD, ...active })).toBe("held");
    expect(scheduleBindingState({ paused: false, admission_hold: null, ...active })).toBe("active");
  });

  test("the view carries the binding verbatim next to the resolved trigger", () => {
    const binding = { schedule: row(), webhooks_active: 3 };
    expect(workflowTriggerView(null, binding)).toEqual({
      schedule: binding.schedule,
      webhooks_active: 3,
      effective_trigger: { kind: "schedule", source: "binding", state: "active" },
    });
  });
});
