import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Executor } from "../../db/client.ts";
import {
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { can } from "../../rbac/evaluator.ts";
import { authorityLive } from "../../workflows/authority-live.ts";
import { remainingRuns } from "../../workflows/core/authority.ts";
import {
  mayGrantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { executableDefinition } from "../../workflows/stored-definition.ts";
import { lockWorkflowForVersionWrite } from "../../workflows/version-write-lock.ts";
import type { TaskEnvironment } from "../types.ts";
import type { TaskAuthorityPreview } from "./model.ts";

export type BoundWorkflowAssessment = TaskAuthorityPreview["workflows"][number];

interface AssessmentInput {
  principal: ResolvedPrincipal;
  workflow_id: string;
  environment: TaskEnvironment;
  lock: boolean;
}

function blocked(
  workflow_id: string,
  name: string | null,
  blocked_reason: NonNullable<BoundWorkflowAssessment["blocked_reason"]>,
  may_grant: boolean,
): BoundWorkflowAssessment {
  return {
    workflow_id,
    workflow_version_id: null,
    name,
    effect_manifest_digest: null,
    effect_manifest: null,
    blocked_reason,
    covering_authority: null,
    may_grant,
  };
}

async function readWorkflow(db: Executor, tenant_id: string, workflow_id: string) {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  return workflow ?? null;
}

async function assessEffect(
  db: Executor,
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: TaskEnvironment;
    dag: unknown;
  },
) {
  const { dag, ...target } = input;
  try {
    return {
      sensitive: executableDefinition(dag).execution_privacy === "sensitive",
      preview: await previewWorkflowAuthority(target, db),
    };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "workflow_version_invalid" || code === "workflow_version_unavailable") return null;
    throw error;
  }
}

export async function assessBoundWorkflow(
  db: Executor,
  input: AssessmentInput,
): Promise<BoundWorkflowAssessment> {
  const { principal, workflow_id, environment } = input;
  const tenant_id = principal.tenant_id;
  const workflow = input.lock
    ? await lockWorkflowForVersionWrite(db, tenant_id, workflow_id)
    : await readWorkflow(db, tenant_id, workflow_id);
  if (!workflow) return blocked(workflow_id, null, "workflow_missing", false);
  const readable = await can(db, {
    tenant_id,
    principal,
    permission: "workflow:read",
    resource: { type: "workflow", id: workflow_id },
  });
  if (!readable.allow) return blocked(workflow_id, null, "workflow_not_readable", false);
  const may_grant = await mayGrantWorkflowAuthority(db, principal, workflow_id);
  const version_id = workflow.current_version_id;
  if (workflow.lifecycle !== "active" || !version_id)
    return blocked(workflow_id, workflow.name, "workflow_not_active", may_grant);
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, workflow_id),
        eq(workflowVersions.id, version_id),
      ),
    )
    .limit(1);
  if (!version) return blocked(workflow_id, workflow.name, "workflow_missing", may_grant);
  const assessed = await assessEffect(db, {
    tenant_id,
    workflow_id,
    workflow_version_id: version_id,
    execution_environment: environment,
    dag: version.dag,
  });
  if (!assessed) return blocked(workflow_id, workflow.name, "workflow_not_repeatable", may_grant);
  const { preview, sensitive } = assessed;
  const [covering] = await db
    .select({
      id: workflowExecutionAuthorities.id,
      valid_until: workflowExecutionAuthorities.valid_until,
      max_runs: workflowExecutionAuthorities.max_runs,
      reserved_runs: workflowExecutionAuthorities.reserved_runs,
    })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, workflow_id),
        eq(workflowExecutionAuthorities.workflow_version_id, version_id),
        eq(workflowExecutionAuthorities.execution_environment, environment),
        eq(workflowExecutionAuthorities.effect_manifest_digest, preview.digest),
        authorityLive(),
      ),
    )
    .orderBy(workflowExecutionAuthorities.created_at)
    .limit(1);
  return {
    workflow_id,
    workflow_version_id: version_id,
    name: workflow.name,
    effect_manifest_digest: preview.digest,
    effect_manifest: preview.manifest,
    blocked_reason: sensitive
      ? "workflow_sensitive"
      : preview.eligible_for_repeated_runs
        ? null
        : "workflow_not_repeatable",
    covering_authority: covering
      ? {
          id: covering.id,
          valid_until: covering.valid_until?.toISOString() ?? null,
          remaining_runs: remainingRuns(covering),
        }
      : null,
    may_grant,
  };
}
