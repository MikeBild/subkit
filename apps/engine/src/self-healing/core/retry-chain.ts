export type RepairAttemptDisposition =
  | Readonly<{ kind: "accept" }>
  | Readonly<{ kind: "retry"; reason: "unsafe" | "fixture_failed" | "not_executable" }>;

export function evolveRepairAttempt(
  facts: Readonly<{
    classification: "safe" | "unsafe";
    fixture_required: boolean;
    fixture_passed: boolean;
    executable: boolean;
  }>,
): RepairAttemptDisposition {
  if (!facts.executable) return { kind: "retry", reason: "not_executable" };
  if (facts.classification !== "safe") return { kind: "retry", reason: "unsafe" };
  if (facts.fixture_required && !facts.fixture_passed)
    return { kind: "retry", reason: "fixture_failed" };
  return { kind: "accept" };
}

export function finalRepairGate(
  facts: Readonly<{
    caller_allows_auto_apply: boolean;
    policy_allows_auto_apply: boolean;
  }>,
): boolean {
  return facts.caller_allows_auto_apply && facts.policy_allows_auto_apply;
}

export function decideRepairDisposition(
  facts: Readonly<{
    auto_applied: boolean;
    closed: boolean;
  }>,
): "applied" | "inapplicable" | "proposed" {
  if (facts.auto_applied) return "applied";
  return facts.closed ? "inapplicable" : "proposed";
}
