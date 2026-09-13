// Auto-apply policy resolution.
//
// Reads `workflow_autoheal_policies` for the requested (tenant,
// workflow) pair. If the row is missing we fall back to the documented
// default `safe-patches`.
//
// The three modes:
//
//   - safe-patches (default)
//       auto-apply a patch when the classifier says safe. When a
//       fixture exists the dry-run must also pass; proactive scans have
//       no fixture, so a `safe` rename/widening patch auto-applies on
//       classification alone (the change is narrow and reversible via
//       the workflow_versions audit trail). Park everything else.
//
//   - never-auto
//       never auto-apply. Every patch parks for review.
//
//   - dry-run-gate
//       auto-apply any patch — safe or unsafe — whose fixture dry-run
//       passes. Used only for non-critical workflows by operators who
//       want broad automation. Requires a fixture (no dry-run, no
//       auto-apply) since the gate IS the fixture pass.

import { and, eq } from "drizzle-orm";

import { type Executor, getDb } from "../db/client.ts";
import { workflowAutohealPolicies } from "../db/schema/workflows.ts";
import { log } from "../logging/logger.ts";

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
 * should auto-apply the patch. The rule:
 *
 *   - `never-auto` always parks.
 *   - `safe-patches` auto-applies a `safe` patch. With a fixture the
 *     dry-run must also pass; without one (proactive scans) the `safe`
 *     classification alone suffices — otherwise a clean proactive drift
 *     could only ever park, and the candidates pile up unreviewed.
 *   - `dry-run-gate` auto-applies when the dry-run passed (even unsafe),
 *     and therefore REQUIRES a fixture.
 */
export function shouldAutoApply(d: PolicyDecisionInput): boolean {
  let result = false;
  let reason = "unknown";
  if (d.policy === "never-auto") {
    reason = "policy=never-auto";
  } else if (d.policy === "safe-patches") {
    // Safe + fixture → require the dry-run to pass. Safe + no fixture
    // (proactive) → classification alone. Unsafe never auto-applies.
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
