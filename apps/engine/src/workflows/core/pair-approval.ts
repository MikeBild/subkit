export const PAIR_REQUEST_TTL_MS = 72 * 60 * 60_000;

export type PairState = "pending" | "approved" | "declined" | "withdrawn" | "expired" | "stale";

export interface PairFacts {
  readonly state: PairState;
  readonly first_approver_id: string;
  readonly expires_at: Date;
}

export type PairDecision =
  | { readonly kind: "approve" }
  | { readonly kind: "decline" }
  | { readonly kind: "withdraw"; readonly admin: boolean };

export type PairVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "pair_request_closed"
        | "pair_request_expired"
        | "pair_same_person"
        | "pair_not_requester";
    };

export function pairExpiry(created_at: Date, valid_until: Date | null): Date {
  const ttl = new Date(created_at.getTime() + PAIR_REQUEST_TTL_MS);
  return valid_until && valid_until.getTime() < ttl.getTime() ? valid_until : ttl;
}

export function effectivePairState(
  facts: Pick<PairFacts, "state" | "expires_at">,
  at: Date,
): PairState {
  if (facts.state === "pending" && facts.expires_at.getTime() <= at.getTime()) return "expired";
  return facts.state;
}

export function decidePair(
  facts: PairFacts,
  decision: PairDecision,
  viewer_id: string,
  at: Date,
): PairVerdict {
  const state = effectivePairState(facts, at);
  if (state === "expired" && facts.state === "pending")
    return { ok: false, code: "pair_request_expired" };
  if (state !== "pending") return { ok: false, code: "pair_request_closed" };
  const isFirst = facts.first_approver_id === viewer_id;
  if (decision.kind === "withdraw")
    return isFirst || decision.admin ? { ok: true } : { ok: false, code: "pair_not_requester" };
  if (isFirst) return { ok: false, code: "pair_same_person" };
  return { ok: true };
}

export function viewerCanApprove(
  facts: PairFacts,
  viewer_id: string,
  viewer_holds_permission: boolean,
  at: Date,
): boolean {
  return viewer_holds_permission && decidePair(facts, { kind: "approve" }, viewer_id, at).ok;
}
