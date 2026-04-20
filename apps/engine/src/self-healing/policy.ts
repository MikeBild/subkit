// Auto-apply policy resolution.
//
// Reads `workflow_autoheal_policies` for the requested (tenant,
// workflow) pair. If the row is missing we fall back to the documented
// default `safe-patches`.
//
// The three modes:
//
//   - safe-patches (default)
//       auto-apply a patch when the classifier says safe AND the
//       fixture dry-run passes. Park everything else.
//
//   - never-auto
//       never auto-apply. Every patch parks for review.
//
//   - dry-run-gate
//       auto-apply any patch — safe or unsafe — whose fixture dry-run
//       passes. Used only for non-critical workflows by operators who
//       want broad automation.

import { and, eq } from "drizzle-orm";
import { type Db, getDb } from "../db/client.ts";
import { workflowAutohealPolicies } from "../db/schema/workflows.ts";
import { log } from "../logging/logger.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AutohealPolicy = "safe-patches" | "never-auto" | "dry-run-gate";

export const DEFAULT_AUTOHEAL_POLICY: AutohealPolicy = "safe-patches";

export async function resolvePolicy(
  tenant_id: string,
  workflow_id: string,
  exec?: Executor,
): Promise<AutohealPolicy> {
  const db: Executor = exec ?? getDb();
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

export interface PolicyDecisionInput {
  policy: AutohealPolicy;
  classification: "safe" | "unsafe";
  fixture_passed: boolean;
  has_fixture: boolean;
}

/**
 * Pure decision function. Given a resolved policy + a classifier
 * verdict + the fixture dry-run outcome, return whether the engine
 * should auto-apply the patch. The docs/19 rule is encoded here:
 *
 *   - NEVER auto-apply without a fixture (§Fixture dry-run gate).
 *   - `never-auto` always parks.
 *   - `safe-patches` auto-applies when safe AND dry-run passed.
 *   - `dry-run-gate` auto-applies when dry-run passed (even unsafe).
 */
export function shouldAutoApply(d: PolicyDecisionInput): boolean {
  let result = false;
  let reason = "unknown";
  if (!d.has_fixture) {
    reason = "no_fixture";
  } else if (d.policy === "never-auto") {
    reason = "policy=never-auto";
  } else if (d.policy === "safe-patches") {
    result = d.classification === "safe" && d.fixture_passed;
    reason = result
      ? "safe_and_fixture_passed"
      : d.classification !== "safe"
        ? "unsafe_classification"
        : "fixture_failed";
  } else if (d.policy === "dry-run-gate") {
    result = d.fixture_passed;
    reason = result ? "fixture_passed" : "fixture_failed";
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
