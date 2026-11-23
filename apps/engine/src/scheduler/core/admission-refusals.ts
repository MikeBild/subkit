import { FAILURE_PAUSE_AFTER } from "../failure-backoff.ts";

export const REFUSAL_PAUSE_AFTER = FAILURE_PAUSE_AFTER;

export interface RefusalHold {
  readonly reason_code: string;
  readonly refusals?: number | undefined;
}

const PAUSING_REFUSALS: readonly string[] = [
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
];

export function refusalCountsTowardPause(reason_code: string): boolean {
  return PAUSING_REFUSALS.includes(reason_code);
}

export function countRefusal(
  hold: RefusalHold | null | undefined,
  reason_code: string,
): { refusals: number; pause: boolean } | null {
  if (!refusalCountsTowardPause(reason_code)) return null;
  const before = hold?.reason_code === reason_code ? Math.max(0, hold.refusals ?? 0) : 0;
  const refusals = before + 1;
  return { refusals, pause: refusals >= REFUSAL_PAUSE_AFTER };
}

const STANDING_STATES: Readonly<Record<string, readonly string[]>> = {
  execution_authority_required: ["repair_required", "approval_required"],
  execution_authority_expired: ["approval_required"],
  execution_authority_exhausted: ["approval_required"],
  execution_authority_revoked: ["approval_required"],
  execution_authority_changed: ["approval_required"],
};

export function holdStillStands(
  reason_code: string | null | undefined,
  inspected_state: string | null | undefined,
): boolean {
  const states = Object.hasOwn(STANDING_STATES, String(reason_code))
    ? STANDING_STATES[String(reason_code)]
    : undefined;
  return states !== undefined && typeof inspected_state === "string"
    ? states.includes(inspected_state)
    : false;
}
