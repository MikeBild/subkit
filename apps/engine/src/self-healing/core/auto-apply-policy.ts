export type AutohealPolicy = "safe-patches" | "never-auto" | "dry-run-gate";

export const DEFAULT_AUTOHEAL_POLICY: AutohealPolicy = "safe-patches";

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
    result = d.classification === "safe" && (!d.has_fixture || d.fixture_passed);
    reason = result
      ? d.has_fixture
        ? "safe_and_fixture_passed"
        : "safe_no_fixture"
      : d.classification !== "safe"
        ? "unsafe_classification"
        : "fixture_failed";
  } else if (d.policy === "dry-run-gate") {
    result = d.has_fixture && d.fixture_passed;
    reason = !d.has_fixture ? "no_fixture" : d.fixture_passed ? "fixture_passed" : "fixture_failed";
  }
  return { auto_apply: result, reason };
}
