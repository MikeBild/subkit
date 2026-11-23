import { describe, expect, test } from "bun:test";
import { budgetPause, isBudgetPark, parkedScope } from "./budget-pause.ts";

const base = {
  error_code: "llm_spend_limit_reached",
  step_kind: "request",
  for_each: false,
  authorized: true,
  child: false,
  held: false,
  sensitive: false,
  persisted: true,
};

describe("budgetPause", () => {
  test("an approved saved run waits before its top-level model step", () => {
    expect(budgetPause(base)).toBe("park");
  });

  test("anything else that hits the budget keeps failing with the remedy", () => {
    expect(budgetPause({ ...base, step_kind: "branch" })).toBe("fail");
    expect(budgetPause({ ...base, step_kind: "parallel" })).toBe("fail");
    expect(budgetPause({ ...base, for_each: true })).toBe("fail");
    expect(budgetPause({ ...base, authorized: false })).toBe("fail");
    expect(budgetPause({ ...base, held: true })).toBe("fail");
    expect(budgetPause({ ...base, child: true })).toBe("fail");
    expect(budgetPause({ ...base, sensitive: true })).toBe("fail");
    expect(budgetPause({ ...base, persisted: false })).toBe("fail");
  });

  test("other failures are not the budget's business", () => {
    expect(budgetPause({ ...base, error_code: "upstream_error" })).toBe("none");
    expect(budgetPause({ ...base, error_code: undefined })).toBe("none");
  });
});

describe("parked scope", () => {
  test("keeps what earlier steps produced, never the refused step or run inputs", () => {
    const scope = {
      $input: { a: 1 },
      $caller: null,
      fetch: { data: [1] },
      summarize: { data: null },
    };
    expect(parkedScope(scope, "summarize")).toEqual({ fetch: { data: [1] } });
  });

  test("a stored park is recognised, anything else is not", () => {
    expect(isBudgetPark({ step_id: "s", month: "2026-11", parked_at: "x", scope: {} })).toBe(true);
    expect(isBudgetPark(null)).toBe(false);
    expect(isBudgetPark({ step_id: "s" })).toBe(false);
  });
});
