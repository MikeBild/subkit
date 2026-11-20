import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { type ToolPinDrift, toolPinDrifts } from "../../workflows/tool-pin-review.ts";
import type { TaskEnvironment } from "../types.ts";
import { assessBoundWorkflow } from "./workflows.ts";

export interface ComparedToolPins {
  digest: string;
  drift: ToolPinDrift | null;
}

export async function compareBoundToolPins(
  db: Db,
  input: {
    principal: ResolvedPrincipal;
    environment: TaskEnvironment;
    workflow_ids: readonly string[];
    expected_workflow_digests: Readonly<Record<string, string>>;
  },
): Promise<Map<string, ComparedToolPins>> {
  const compared = new Map<string, ComparedToolPins>();
  for (const workflow_id of input.workflow_ids) {
    const expected = input.expected_workflow_digests[workflow_id];
    if (!expected) continue;
    const assessed = await assessBoundWorkflow(db, {
      principal: input.principal,
      workflow_id,
      environment: input.environment,
      lock: false,
    });
    if (
      assessed.blocked_reason ||
      assessed.covering_authority ||
      !assessed.may_grant ||
      !assessed.effect_manifest ||
      assessed.effect_manifest_digest !== expected
    )
      continue;
    const [first] = await toolPinDrifts(
      db,
      input.principal.tenant_id,
      assessed.effect_manifest.effects,
    );
    compared.set(workflow_id, { digest: expected, drift: first?.reason ?? null });
  }
  return compared;
}
