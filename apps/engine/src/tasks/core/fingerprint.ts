import { workflowJsonDigest } from "../../workflows/canonical-json.ts";

export interface TaskFingerprintSource {
  goal: string;
  done_when: string;
  plan: unknown;
  bindings: {
    workflow_ids: readonly string[];
    connector_ids: readonly string[];
    skill_slugs: readonly string[];
    web_search: boolean;
  };
  environment: "dev" | "prod";
  schedule_cron: string | null;
  schedule_timezone: string | null;
  schedule_run_at: string | null;
  max_turns: number;
  run_deadline_minutes: number;
  owner_id: string;
}

function instant(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function taskFingerprintContent(source: TaskFingerprintSource) {
  return {
    goal: source.goal,
    done_when: source.done_when,
    plan: source.plan,
    bindings: {
      workflow_ids: [...source.bindings.workflow_ids].sort(),
      connector_ids: [...source.bindings.connector_ids].sort(),
      skill_slugs: [...source.bindings.skill_slugs].sort(),
      web_search: source.bindings.web_search,
    },
    environment: source.environment,
    schedule_cron: source.schedule_cron,
    schedule_timezone: source.schedule_timezone,
    schedule_run_at: instant(source.schedule_run_at),
    max_turns: source.max_turns,
    run_deadline_minutes: source.run_deadline_minutes,
    owner_id: source.owner_id,
  };
}

export function taskFingerprint(source: TaskFingerprintSource): string {
  return workflowJsonDigest(taskFingerprintContent(source));
}
