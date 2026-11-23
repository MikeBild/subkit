import { SPEND_LIMIT_REACHED } from "@shared/error-taxonomy.ts";

export interface BudgetPauseFacts {
  error_code: string | undefined;
  step_kind: string;
  for_each: boolean;
  authorized: boolean;
  child: boolean;
  held: boolean;
  sensitive: boolean;
  persisted: boolean;
}

export type BudgetPause = "park" | "fail" | "none";

export function budgetPause(facts: BudgetPauseFacts): BudgetPause {
  if (facts.error_code !== SPEND_LIMIT_REACHED) return "none";
  const topLevelModelStep = facts.step_kind === "model" && !facts.for_each;
  const resumable =
    facts.authorized && !facts.child && facts.persisted && !facts.held && !facts.sensitive;
  return topLevelModelStep && resumable ? "park" : "fail";
}

export interface BudgetPark {
  step_id: string;
  month: string;
  parked_at: string;
  scope: Record<string, unknown>;
}

export function parkedScope(
  scope: Readonly<Record<string, unknown>>,
  refusedStepId: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(scope).filter(([key]) => key !== refusedStepId && !key.startsWith("$")),
  );
}

export function isBudgetPark(value: unknown): value is BudgetPark {
  if (!value || typeof value !== "object") return false;
  const park = value as Partial<BudgetPark>;
  return (
    typeof park.step_id === "string" &&
    typeof park.month === "string" &&
    typeof park.scope === "object" &&
    park.scope !== null
  );
}
