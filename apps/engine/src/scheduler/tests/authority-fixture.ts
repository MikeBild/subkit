import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { workflowExecutionAuthorities, workflows } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";

/** Scheduler tests seed a reviewed boundary explicitly; runtime never creates it. */
export async function grantScheduleAuthorityFixture(
  db: Db,
  tenant_id: string,
  workflow_id: string,
  execution_environment: "dev" | "prod" = "prod",
  max_runs = 100,
) {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)));
  if (!workflow?.current_version_id) throw new Error("fixture workflow has no active version");
  const preview = await previewWorkflowAuthority(
    {
      tenant_id,
      workflow_id,
      workflow_version_id: workflow.current_version_id,
      execution_environment,
    },
    db,
  );
  if (!preview.eligible_for_repeated_runs)
    throw new Error("fixture workflow needs exact run review");
  const now = await databaseNow(db);
  const [authority] = await db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id,
      workflow_id,
      workflow_version_id: workflow.current_version_id,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      target_constraints: {
        targets: preview.manifest.effects.flatMap((effect) =>
          effect.target ? [effect.target] : [],
        ),
      },
      execution_environment,
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: new Date(now.getTime() + 3_600_000),
      max_runs,
      created_by: "00000000-0000-4000-8000-000000000001",
    })
    .returning();
  if (!authority) throw new Error("fixture authority missing");
  return authority;
}
