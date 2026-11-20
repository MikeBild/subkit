import {
  AUTHORITY_EXTEND_BELOW_RUN_SHARE,
  AUTHORITY_EXTEND_WITHIN_DAYS,
} from "../../workflows/authority-extension.ts";
import { DAY_MS, remainingRuns } from "../../workflows/core/authority.ts";

export interface TaskGrantFacts {
  fingerprint: string;
  valid_from: Date;
  valid_until: Date | null;
  max_runs: number | null;
  reserved_runs: number;
  revoked_at: Date | null;
}

export type TaskGrantStatus =
  | "live"
  | "revoked"
  | "not_yet_valid"
  | "expired"
  | "exhausted"
  | "fingerprint_mismatch";

export function taskGrantRemainingRuns(grant: TaskGrantFacts): number | null {
  return remainingRuns(grant);
}

export function taskGrantStatus(
  grant: TaskGrantFacts,
  taskFingerprint: string,
  now: Date,
): TaskGrantStatus {
  if (grant.revoked_at !== null) return "revoked";
  if (grant.fingerprint !== taskFingerprint) return "fingerprint_mismatch";
  if (grant.valid_from > now) return "not_yet_valid";
  if (grant.valid_until !== null && grant.valid_until <= now) return "expired";
  if (remainingRuns(grant) === 0) return "exhausted";
  return "live";
}

export function isTaskGrantLive(
  grant: TaskGrantFacts,
  taskFingerprint: string,
  now: Date,
): boolean {
  return taskGrantStatus(grant, taskFingerprint, now) === "live";
}

export function isTaskGrantExpiringSoon(
  grant: TaskGrantFacts,
  taskFingerprint: string,
  now: Date,
): boolean {
  if (taskGrantStatus(grant, taskFingerprint, now) !== "live") return false;
  const endsSoon =
    grant.valid_until !== null &&
    grant.valid_until.getTime() - now.getTime() <= AUTHORITY_EXTEND_WITHIN_DAYS * DAY_MS;
  const remaining = remainingRuns(grant);
  const runsLow =
    grant.max_runs !== null &&
    remaining !== null &&
    remaining < grant.max_runs * AUTHORITY_EXTEND_BELOW_RUN_SHARE;
  return endsSoon || runsLow;
}
