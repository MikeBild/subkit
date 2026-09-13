import { z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Executor } from "../db/client.ts";
import {
  executionSteps,
  type patchCandidates,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { PatchProposalSchema } from "../llm/flows/repair.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import { applyPatchToWorkflowDag } from "./patch-apply.ts";
import { isExecutionStepId, resolveCandidateStepKey } from "./step-snapshot.ts";

export const PatchReadinessSchema = z
  .object({
    reviewable: z.boolean(),
    review_reason: z.string().nullable(),
    review_digest: z.string().nullable(),
    base_version_id: z.string().nullable(),
  })
  .openapi("PatchReadiness");

export type PatchReadiness = z.infer<typeof PatchReadinessSchema>;

export function evaluatePatchReadiness(input: {
  candidate_id: string;
  tenant_id: string;
  status: string;
  proposal: unknown;
  step_key: string | null;
  version_id: string | null;
  dag: unknown;
}): PatchReadiness {
  const proposal = PatchProposalSchema.safeParse(input.proposal);
  const outcome = proposal.success
    ? applyPatchToWorkflowDag(input.dag, input.step_key, proposal.data)
    : null;
  const reason =
    input.status !== "proposed"
      ? "already_decided"
      : !input.version_id
        ? "workflow_missing"
        : !proposal.success
          ? "invalid_proposal"
          : !outcome?.ok
            ? (outcome?.reason ?? "invalid_proposal")
            : null;
  return {
    reviewable: reason === null,
    review_reason: reason,
    base_version_id: input.version_id,
    review_digest:
      reason === null
        ? workflowJsonDigest({
            tenant: input.tenant_id,
            candidate: input.candidate_id,
            version: input.version_id,
            dag: input.dag,
            step: input.step_key,
            proposal: proposal.data,
          })
        : null,
  };
}

/** Readiness is derived from the current artifact, never from a model's safety label. */
export async function readPatchReadiness(
  tenant_id: string,
  candidate: typeof patchCandidates.$inferSelect,
  db: Executor,
): Promise<PatchReadiness> {
  const [version] = await db
    .select({ id: workflowVersions.id, dag: workflowVersions.dag })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.id, workflows.current_version_id),
        eq(workflowVersions.tenant_id, tenant_id),
      ),
    )
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, candidate.workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const diff = candidate.diff as Record<string, unknown>;
  return evaluatePatchReadiness({
    candidate_id: candidate.id,
    tenant_id,
    status: candidate.status,
    proposal: diff?.proposal,
    step_key: await resolveCandidateStepKey(tenant_id, diff ?? {}, db),
    version_id: version?.id ?? null,
    dag: version?.dag,
  });
}

/** Resolve an entire queue with two tenant-scoped reads instead of per-card queries. */
export async function readPatchReadinessBatch(
  tenant_id: string,
  candidates: (typeof patchCandidates.$inferSelect)[],
  db: Executor,
): Promise<PatchReadiness[]> {
  if (!candidates.length) return [];
  const workflowIds = [...new Set(candidates.map((candidate) => candidate.workflow_id))];
  const versions = await db
    .select({ workflow_id: workflows.id, id: workflowVersions.id, dag: workflowVersions.dag })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.id, workflows.current_version_id),
        eq(workflowVersions.tenant_id, tenant_id),
      ),
    )
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        inArray(workflows.id, workflowIds),
        isNull(workflows.deleted_at),
      ),
    );
  const byWorkflow = new Map(versions.map((version) => [version.workflow_id, version]));
  const diffs = candidates.map((candidate) => (candidate.diff ?? {}) as Record<string, unknown>);
  const stepIds = [
    ...new Set(
      diffs.flatMap((diff) =>
        typeof diff.workflow_step_id !== "string" && isExecutionStepId(diff.step_id)
          ? [diff.step_id]
          : [],
      ),
    ),
  ];
  const steps = stepIds.length
    ? await db
        .select({ id: executionSteps.id, key: executionSteps.step_key })
        .from(executionSteps)
        .where(and(eq(executionSteps.tenant_id, tenant_id), inArray(executionSteps.id, stepIds)))
    : [];
  const byStep = new Map(steps.map((step) => [step.id, step.key]));
  return candidates.map((candidate, index) => {
    const diff = diffs[index] ?? {};
    const version = byWorkflow.get(candidate.workflow_id);
    return evaluatePatchReadiness({
      candidate_id: candidate.id,
      tenant_id,
      status: candidate.status,
      proposal: diff.proposal,
      step_key:
        typeof diff.workflow_step_id === "string"
          ? diff.workflow_step_id
          : typeof diff.step_id === "string"
            ? (byStep.get(diff.step_id) ?? null)
            : null,
      version_id: version?.id ?? null,
      dag: version?.dag,
    });
  });
}
