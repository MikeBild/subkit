import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowExecutionAuthorities, workflows } from "../db/schema/index.ts";
import { authorityLive } from "../workflows/authority-live.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { decideRunCoverage, type RunCoverage } from "./core/run-coverage.ts";

export interface RunCoverageSubject {
  tenant_id: string;
  workflow_id: string;
  workflow_version_id?: string | undefined;
  expected_workflow_version_id?: string | undefined;
  execution_environment: "dev" | "prod";
  hold_writes?: boolean | undefined;
}

export async function readRunCoverage(
  db: Executor,
  subject: RunCoverageSubject,
): Promise<RunCoverage> {
  const [workflow] = await db
    .select({ lifecycle: workflows.lifecycle, current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, subject.tenant_id), eq(workflows.id, subject.workflow_id)))
    .limit(1);
  const currentVersionId = workflow?.current_version_id ?? null;
  const preview = currentVersionId
    ? await previewWorkflowAuthority(
        {
          tenant_id: subject.tenant_id,
          workflow_id: subject.workflow_id,
          workflow_version_id: currentVersionId,
          execution_environment: subject.execution_environment,
        },
        db,
      )
    : null;
  const [authority] =
    currentVersionId && preview
      ? await db
          .select({
            id: workflowExecutionAuthorities.id,
            effect_manifest_digest: workflowExecutionAuthorities.effect_manifest_digest,
          })
          .from(workflowExecutionAuthorities)
          .where(
            and(
              eq(workflowExecutionAuthorities.tenant_id, subject.tenant_id),
              eq(workflowExecutionAuthorities.workflow_id, subject.workflow_id),
              eq(workflowExecutionAuthorities.workflow_version_id, currentVersionId),
              eq(workflowExecutionAuthorities.execution_environment, subject.execution_environment),
              eq(workflowExecutionAuthorities.effect_manifest_digest, preview.digest),
              authorityLive(),
            ),
          )
          .orderBy(
            desc(workflowExecutionAuthorities.created_at),
            desc(workflowExecutionAuthorities.id),
          )
          .limit(1)
      : [];
  return decideRunCoverage(
    {
      workflow_id: subject.workflow_id,
      workflow_version_id: subject.workflow_version_id,
      expected_workflow_version_id: subject.expected_workflow_version_id,
      hold_writes: subject.hold_writes,
    },
    {
      lifecycle: workflow?.lifecycle ?? null,
      current_version_id: currentVersionId,
      preview: preview
        ? { eligible: preview.eligible_for_repeated_runs, digest: preview.digest }
        : null,
      authority: authority ?? null,
    },
  );
}
