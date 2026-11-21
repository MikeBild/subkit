import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowAutohealPolicies } from "../db/schema/workflows.ts";
import { log } from "../logging/index.ts";

import {
  type AutohealPolicy,
  DEFAULT_AUTOHEAL_POLICY,
  decideAutoApply,
  type PolicyDecisionInput,
} from "./core/auto-apply-policy.ts";

export { type AutohealPolicy, DEFAULT_AUTOHEAL_POLICY } from "./core/auto-apply-policy.ts";

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

export function shouldAutoApply(d: PolicyDecisionInput): boolean {
  const decision = decideAutoApply(d);
  log.selfHealing.policy.evaluated({
    policy: d.policy,
    classification: d.classification,
    fixture_passed: d.fixture_passed,
    has_fixture: d.has_fixture,
    auto_apply: decision.auto_apply,
    reason: decision.reason,
  });
  return decision.auto_apply;
}
