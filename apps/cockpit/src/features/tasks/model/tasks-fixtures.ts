import {
  formPlan,
  type TaskLatestRun,
  type TaskRun,
  type TaskUsagePeriod,
  type TaskView,
} from "./tasks-model";

export const TASK_ID = "018f4b4a-6d33-7b3a-9c2d-000000000001";
export const RUN_ID = "018f4b4a-6d33-7b3a-9c2d-000000000002";
export const CONVERSATION_ID = "018f4b4a-6d33-7b3a-9c2d-000000000003";

export function task(change: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK_ID,
    name: "Rechnungen nachfassen",
    description: null,
    category: "other",
    owner_id: "018f4b4a-6d33-7b3a-9c2d-000000000009",
    goal: "Fasst offene Rechnungen nach, bis sie bezahlt sind.",
    done_when: "Alle Rechnungen aus Oktober sind bezahlt.",
    plan: formPlan(
      "Rechnungen nachfassen",
      "Fasst offene Rechnungen nach, bis sie bezahlt sind.",
      "Alle Rechnungen aus Oktober sind bezahlt.",
    ),
    bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
    environment: "prod",
    schedule_cron: null,
    schedule_timezone: null,
    schedule_run_at: null,
    last_claimed_at: null,
    paused_at: null,
    paused_by: null,
    paused_reason: null,
    max_turns: 20,
    run_deadline_minutes: 240,
    fingerprint: "a".repeat(64),
    revision: 3,
    lifecycle: "active",
    source_conversation_id: null,
    source_message_id: null,
    created_at: "2026-11-01T08:00:00.000Z",
    updated_at: "2026-11-18T08:00:00.000Z",
    latest_run: null,
    grant_live: false,
    next_start_at: null,
    ...change,
  };
}

export function run(change: Partial<TaskRun> = {}): TaskRun {
  return {
    id: RUN_ID,
    task_id: TASK_ID,
    task_revision: 3,
    fingerprint: "a".repeat(64),
    conversation_id: CONVERSATION_ID,
    trigger: "manual",
    started_by: null,
    grant_id: null,
    state: "running",
    waiting_reason: null,
    next_check_at: null,
    sleep_reason: null,
    deadline_at: "2026-11-19T14:00:00.000Z",
    turns_used: 2,
    no_progress_count: 0,
    last_seen_turn_id: null,
    last_playbook_revision: 1,
    trace_id: "c".repeat(32),
    failure_code: null,
    result_ready_at: null,
    completed_at: null,
    completed_by: null,
    ended_at: null,
    created_at: "2026-11-19T09:00:00.000Z",
    updated_at: "2026-11-19T09:30:00.000Z",
    ...change,
  };
}

export function latestRun(of: TaskRun | null): TaskLatestRun | null {
  return of
    ? {
        id: of.id,
        state: of.state,
        waiting_reason: of.waiting_reason,
        next_check_at: of.next_check_at,
        started_at: of.created_at,
        ended_at: of.ended_at,
        conversation_id: of.conversation_id,
      }
    : null;
}

export function usagePeriod(change: Partial<TaskUsagePeriod> = {}): TaskUsagePeriod {
  return {
    period: "last_run",
    task_run_id: RUN_ID,
    attribution: "conversation_turns",
    not_included: ["workflow_run_model_calls"],
    calls: 4,
    tokens: 12_500,
    cost: { amount: 0.42, currency: "USD", unpriced_models: [] },
    ...change,
  };
}
