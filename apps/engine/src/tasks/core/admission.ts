import type { TaskAdmissionReason, TaskRunTrigger } from "../types.ts";
import { type TaskGrantFacts, taskGrantStatus } from "./grant.ts";

export interface TaskAdmissionFacts {
  task: { paused: boolean; fingerprint: string };
  owner: { active: boolean; permitted: boolean };
  ai_access: boolean;
  previous_run_active: boolean;
  trigger: TaskRunTrigger;
  grant: TaskGrantFacts | null;
}

export type TaskAdmission = { admit: true } | { admit: false; reason: TaskAdmissionReason };

const refuse = (reason: TaskAdmissionReason): TaskAdmission => ({ admit: false, reason });

export function taskTriggerNeedsGrant(trigger: TaskRunTrigger): boolean {
  return trigger !== "manual";
}

export function decideTaskAdmission(facts: TaskAdmissionFacts, now: Date): TaskAdmission {
  if (facts.task.paused) return refuse("paused");
  if (!facts.owner.active || !facts.owner.permitted) return refuse("owner_unavailable");
  if (!facts.ai_access) return refuse("ai_access_missing");
  if (facts.previous_run_active) return refuse("previous_run_active");
  if (!taskTriggerNeedsGrant(facts.trigger)) return { admit: true };
  if (facts.grant === null) return refuse("grant_required");
  switch (taskGrantStatus(facts.grant, facts.task.fingerprint, now)) {
    case "live":
      return { admit: true };
    case "fingerprint_mismatch":
      return refuse("grant_fingerprint_mismatch");
    case "expired":
      return refuse("grant_expired");
    case "exhausted":
      return refuse("grant_exhausted");
    default:
      return refuse("grant_required");
  }
}
