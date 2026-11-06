import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowAutohealPolicies } from "../db/schema/workflows.ts";
import { log } from "../logging/logger.ts";

export type AutohealPolicy = "safe-patches" | "never-auto" | "dry-run-gate";

export const DEFAULT_AUTOHEAL_POLICY: AutohealPolicy = "safe-patches";

export async function resolvePolicy(
  tenant_id: string,
  workflow_id: string,
  db: Executor,
): Promise<AutohealPolicy> {
  const rows = await db
    .select()
    .from(workflowAutohealPolicies)
    .where(
      and(
        eq(workflowAutohealPolicies.tenant_id, tenant_id),
        eq(workflowAutohealPolicies.workflow_id, workflow_id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return DEFAULT_AUTOHEAL_POLICY;
  return row.policy as AutohealPolicy;
}

interface PolicyDecisionInput {
  policy: AutohealPolicy;
  classification: "safe" | "unsafe";
  fixture_passed: boolean;
  has_fixture: boolean;
  drift_kind?: string | undefined;
}

export function shouldAutoApply(d: PolicyDecisionInput): boolean {
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
  log.selfHealing.policy.evaluated({
    policy: d.policy,
    classification: d.classification,
    fixture_passed: d.fixture_passed,
    has_fixture: d.has_fixture,
    auto_apply: result,
    reason,
  });
  return result;
}
