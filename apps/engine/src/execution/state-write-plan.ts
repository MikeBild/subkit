import { resolveValuePath } from "./selectors.ts";

export type StateWritePlan = { write: true; value: unknown } | { write: false };

export function planStateWrite(output: unknown, valuePath: string): StateWritePlan {
  const value = resolveValuePath(output, valuePath);
  return value === undefined ? { write: false } : { write: true, value };
}

export const stateValueKind = (plan: StateWritePlan): string =>
  !plan.write
    ? "skipped"
    : plan.value === null
      ? "null"
      : Array.isArray(plan.value)
        ? "array"
        : typeof plan.value;
