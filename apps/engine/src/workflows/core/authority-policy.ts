export type CarryPolicyDecision = "carry" | "needs_pair";

export interface CarryPolicyFacts {
  readonly policy: "single" | "pair";
  readonly pair_approved: boolean;
}

export function decideCarryUnderPolicy(facts: CarryPolicyFacts): CarryPolicyDecision {
  return facts.policy === "pair" && !facts.pair_approved ? "needs_pair" : "carry";
}

export const CARRY_ORIGIN_MAX_HOPS = 64;

export interface CarryLineage {
  readonly id: string;
  readonly inherited_from: string | null;
}

export function pairApprovedOrigin(
  lineage: ReadonlyArray<CarryLineage>,
  authority_id: string,
  pair_approved: ReadonlySet<string>,
): boolean {
  const byId = new Map(lineage.map((row) => [row.id, row]));
  let current: string | null = authority_id;
  for (let hop = 0; hop < CARRY_ORIGIN_MAX_HOPS && current; hop++) {
    if (pair_approved.has(current)) return true;
    current = byId.get(current)?.inherited_from ?? null;
  }
  return false;
}
