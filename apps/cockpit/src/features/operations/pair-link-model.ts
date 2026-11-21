import { type PairApproval, type PairState, pairState } from "./pair-model";

export const PAIR_SEARCH_PARAM = "pair";

export type ClosedPairState = Exclude<PairState, "pending">;

export type PairLinkRow =
  | { key: "at"; at: string }
  | { key: "reason"; reason: NonNullable<PairApproval["stale_reason"]> };

export type PairLinkTarget =
  | { kind: "none" }
  | { kind: "loading"; id: string }
  | { kind: "open"; pair: PairApproval }
  | { kind: "closed"; pair: PairApproval; state: ClosedPairState; rows: PairLinkRow[] }
  | { kind: "missing"; id: string };

export function pairLinkId(search: string): string | null {
  const value = new URLSearchParams(search).get(PAIR_SEARCH_PARAM)?.trim() ?? "";
  return value.length > 0 ? value : null;
}

function closedRows(pair: PairApproval, state: ClosedPairState): PairLinkRow[] {
  if (state === "approved") return [];
  const at = pair.decided_at ?? null;
  const rows: PairLinkRow[] = [];
  if (state === "stale" && pair.stale_reason)
    rows.push({ key: "reason", reason: pair.stale_reason });
  if (state === "expired") rows.push({ key: "at", at: at ?? pair.expires_at });
  else if (at) rows.push({ key: "at", at });
  return rows;
}

export function pairLinkTarget(
  id: string | null,
  items: readonly PairApproval[] | null,
  now: number,
  actedOn: string | null = null,
): PairLinkTarget {
  if (id === null) return { kind: "none" };
  if (items === null) return { kind: "loading", id };
  const pair = items.find((item) => item.id === id);
  if (!pair) return { kind: "missing", id };
  const state = pairState(pair, now);
  if (state === "pending") return { kind: "open", pair };
  if (actedOn === id) return { kind: "none" };
  return { kind: "closed", pair, state, rows: closedRows(pair, state) };
}

export function shownPair(
  target: PairLinkTarget,
  fallback: PairApproval | null,
): PairApproval | null {
  return target.kind === "open" ? target.pair : fallback;
}
