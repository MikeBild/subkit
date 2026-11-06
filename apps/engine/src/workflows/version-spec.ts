import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowVersions } from "../db/schema/index.ts";
import type { SpecCarrier } from "./core/spec.ts";

export async function loadVersionSpec(
  exec: Executor,
  scope: { tenant_id: string; workflow_id: string; version_id: string | null },
): Promise<SpecCarrier | null> {
  if (!scope.version_id) return null;
  const [row] = await exec
    .select({ spec: workflowVersions.spec })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, scope.tenant_id),
        eq(workflowVersions.workflow_id, scope.workflow_id),
        eq(workflowVersions.id, scope.version_id),
      ),
    )
    .limit(1);
  return row ?? null;
}
