export type PairState = "pending" | "approved" | "declined" | "withdrawn" | "expired" | "stale";

export interface PairApproval {
  id: string;
  state: PairState;
  stale_reason: "manifest_changed" | "first_approver_unavailable" | null;
  first_approver: { user_id: string; name: string };
  second_approver: { user_id: string; name: string } | null;
  expires_at: string;
  decided_at?: string | null;
  viewer_can_approve: boolean;
}

export type PairAction = "approve" | "decline" | "withdraw";

export interface PairView {
  state: PairState;
  slots: [{ name: string; filled: true }, { name: string | null; filled: boolean }];
  tone: "success" | "warning" | "danger" | "info" | "neutral";
  open: boolean;
  actions: PairAction[];
}

const TONE: Record<PairState, PairView["tone"]> = {
  pending: "info",
  approved: "success",
  declined: "danger",
  withdrawn: "neutral",
  expired: "warning",
  stale: "warning",
};

export function pairState(
  pair: Pick<PairApproval, "state" | "expires_at">,
  now: number,
): PairState {
  if (pair.state === "pending" && Date.parse(pair.expires_at) <= now) return "expired";
  return pair.state;
}

export function pairView(pair: PairApproval, viewerId: string, now: number): PairView {
  const state = pairState(pair, now);
  const open = state === "pending";
  const mine = pair.first_approver.user_id === viewerId;
  const actions: PairAction[] = !open
    ? []
    : mine
      ? ["withdraw"]
      : pair.viewer_can_approve
        ? ["approve", "decline"]
        : [];
  return {
    state,
    slots: [
      { name: pair.first_approver.name, filled: true },
      {
        name: pair.second_approver?.name ?? null,
        filled: state === "approved" && pair.second_approver !== null,
      },
    ],
    tone: TONE[state],
    open,
    actions,
  };
}

export function openPairs(pairs: readonly PairApproval[], now: number): PairApproval[] {
  return pairs.filter((pair) => pairState(pair, now) === "pending");
}

const PAIR_MIN_APPROVERS = 2;

export interface PairPolicy {
  workflow_approvals: "single" | "pair";
  eligible_approvers: number;
}

export interface PairVisibility {
  setting: boolean;
  option: boolean;
  hints: boolean;
}

export function pairVisibility(
  policy: PairPolicy | null | undefined,
  chosen = false,
): PairVisibility {
  const enabled = policy?.workflow_approvals === "pair";
  const setting = enabled || (policy?.eligible_approvers ?? 0) >= PAIR_MIN_APPROVERS;
  return { setting, option: setting || chosen, hints: enabled };
}

export type PairRefusalClass =
  | "needs_pair"
  | "needs_two_approvers"
  | "same_person"
  | "not_requester"
  | "not_required"
  | "request_missing"
  | "request_closed"
  | "boundary_changed"
  | "unsupported";

export const PAIR_REFUSALS = {
  pair_approval_required: "needs_pair",
  pair_needs_two_approvers: "needs_two_approvers",
  pair_same_person: "same_person",
  pair_not_requester: "not_requester",
  pair_not_required: "not_required",
  pair_request_not_found: "request_missing",
  pair_request_closed: "request_closed",
  pair_request_expired: "request_closed",
  pair_request_stale: "request_closed",
  authority_manifest_changed: "boundary_changed",
  pair_schedule_unsupported: "unsupported",
  pair_start_run_unsupported: "unsupported",
} as const satisfies Record<string, PairRefusalClass>;

export type PairRefusal = keyof typeof PAIR_REFUSALS;

export function pairRefusal(error: unknown): PairRefusal | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && Object.hasOwn(PAIR_REFUSALS, code)
    ? (code as PairRefusal)
    : null;
}

export function needsPair(error: unknown): boolean {
  return pairRefusal(error) === "pair_approval_required";
}

export function needsTwoApprovers(error: unknown): boolean {
  return pairRefusal(error) === "pair_needs_two_approvers";
}

export type PairFailure = Extract<
  PairRefusal,
  | "pair_same_person"
  | "pair_request_closed"
  | "authority_manifest_changed"
  | "pair_not_required"
  | "pair_approval_required"
>;

const PAIR_FAILURES: ReadonlySet<PairRefusal> = new Set<PairFailure>([
  "pair_same_person",
  "pair_request_closed",
  "authority_manifest_changed",
  "pair_not_required",
  "pair_approval_required",
]);

export function pairFailure(error: unknown): PairFailure | null {
  const refusal = pairRefusal(error);
  return refusal !== null && PAIR_FAILURES.has(refusal) ? (refusal as PairFailure) : null;
}

export function pairRequestBody<
  T extends { valid_from: string; valid_until: string | null; max_runs: number | null },
>(grant: T & { start_run?: boolean; activation?: unknown }): Omit<T, "start_run" | "activation"> {
  const { start_run: _run, activation: _activation, ...body } = grant;
  return body;
}
