export type AutohealPolicy = "safe-patches" | "never-auto" | "dry-run-gate";

export const DEFAULT_AUTOHEAL_POLICY: AutohealPolicy = "never-auto";

export interface PolicyDecisionInput {
  policy: AutohealPolicy;
  classification: "safe" | "unsafe";
  fixture_passed: boolean;
  has_fixture: boolean;
  drift_kind?: string | undefined;
}

export function decideAutoApply(
  d: Readonly<PolicyDecisionInput>,
): Readonly<{ auto_apply: boolean; reason: string }> {
  let result = false;
  let reason = "unknown";
  if (d.drift_kind === "gate_block") {
    reason = "gate_repair_requires_review";
  } else if (d.policy === "never-auto") {
    reason = "policy=never-auto";
  } else if (d.policy === "safe-patches") {
    result = d.classification === "safe" && d.has_fixture && d.fixture_passed;
    reason = result
      ? "safe_and_fixture_passed"
      : d.classification !== "safe"
        ? "unsafe_classification"
        : d.has_fixture
          ? "fixture_failed"
          : "no_fixture";
  } else if (d.policy === "dry-run-gate") {
    result = d.has_fixture && d.fixture_passed;
    reason = !d.has_fixture ? "no_fixture" : d.fixture_passed ? "fixture_passed" : "fixture_failed";
  }
  return { auto_apply: result, reason };
}
