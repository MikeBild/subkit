import type { z } from "@hono/zod-openapi";
import { and, asc, desc, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { patchCandidates, workflows } from "../db/schema/index.ts";
import {
  type GrantWorkflowAuthoritySchema,
  grantWorkflowAuthority,
} from "../workflows/execution-authorities.ts";
import { approvePatchCandidate, PatchDecisionError } from "./candidate-decision.ts";
import { preparePatchCandidate } from "./prepare-candidate.ts";

export type PatchCandidateRow = typeof patchCandidates.$inferSelect;

interface PatchCandidateWithWorkflow {
  candidate: PatchCandidateRow;
  workflow_name: string | null;
}

interface ListPatchCandidatesInput {
  status?: PatchCandidateRow["status"] | undefined;
  workflow_id?: string | undefined;
  order?: "asc" | "desc" | undefined;
}

interface ApproveReviewedInput {
  principal: ResolvedPrincipal;
  request: Request;
  candidate: PatchCandidateRow;
  expected_review_digest: string;
  execution_authority?: z.infer<typeof GrantWorkflowAuthoritySchema> | undefined;
}

export async function listPatchCandidatesWithWorkflow(
  db: Db,
  tenantId: string,
  input: ListPatchCandidatesInput,
): Promise<PatchCandidateWithWorkflow[]> {
  const tenantConds = [eq(patchCandidates.tenant_id, tenantId)];
  if (input.status) tenantConds.push(eq(patchCandidates.status, input.status));
  if (input.workflow_id) tenantConds.push(eq(patchCandidates.workflow_id, input.workflow_id));
  return db
    .select({ candidate: patchCandidates, workflow_name: workflows.name })
    .from(patchCandidates)
    .leftJoin(
      workflows,
      and(eq(workflows.id, patchCandidates.workflow_id), eq(workflows.tenant_id, tenantId)),
    )
    .where(and(...tenantConds))
    .orderBy(
      input.order === "asc" ? asc(patchCandidates.created_at) : desc(patchCandidates.created_at),
      asc(patchCandidates.id),
    );
}

export async function getPatchCandidateWithWorkflow(
  db: Db,
  tenantId: string,
  id: string,
): Promise<PatchCandidateWithWorkflow | null> {
  const rows = await db
    .select({ candidate: patchCandidates, workflow_name: workflows.name })
    .from(patchCandidates)
    .leftJoin(
      workflows,
      and(eq(workflows.id, patchCandidates.workflow_id), eq(workflows.tenant_id, tenantId)),
    )
    .where(and(eq(patchCandidates.tenant_id, tenantId), eq(patchCandidates.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPatchCandidate(
  db: Db,
  tenantId: string,
  id: string,
): Promise<PatchCandidateRow | null> {
  const rows = await db
    .select()
    .from(patchCandidates)
    .where(and(eq(patchCandidates.tenant_id, tenantId), eq(patchCandidates.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

async function approveWithAuthority(
  db: Db,
  input: ApproveReviewedInput,
  authority: z.infer<typeof GrantWorkflowAuthoritySchema>,
): Promise<string> {
  const { principal, candidate } = input;
  return db.transaction(async (tx) => {
    const prepared = await preparePatchCandidate(
      {
        tenant_id: principal.tenant_id,
        candidate_id: candidate.id,
        actor_id: principal.id,
        actor_type: principal.kind,
        expected_review_digest: input.expected_review_digest,
      },
      tx as unknown as Db,
    );
    if (prepared.workflow_version_id !== authority.workflow_version_id)
      throw new PatchDecisionError("review_changed");
    await grantWorkflowAuthority(candidate.workflow_id, authority, {
      principal,
      request: input.request,
      db: tx as unknown as Db,
    });
    const applied = await approvePatchCandidate(
      {
        tenant_id: principal.tenant_id,
        candidate_id: candidate.id,
        actor_id: principal.id,
        actor_type: principal.kind,
        expected_review_digest: input.expected_review_digest,
        prepared_version_id: authority.workflow_version_id,
      },
      tx as unknown as Db,
    );
    if (!applied) throw new PatchDecisionError("already_decided");
    return applied;
  });
}

export async function approveReviewedPatchCandidate(
  db: Db,
  input: ApproveReviewedInput,
): Promise<string | null> {
  const { principal, candidate } = input;
  try {
    return !input.execution_authority
      ? await approvePatchCandidate(
          {
            tenant_id: principal.tenant_id,
            candidate_id: candidate.id,
            actor_id: principal.id,
            actor_type: principal.kind,
            expected_review_digest: input.expected_review_digest,
          },
          db,
        )
      : await approveWithAuthority(db, input, input.execution_authority);
  } catch (error) {
    if (input.execution_authority) {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.PATCH_CANDIDATE_APPROVED,
          resource_type: "patch_candidate",
          resource_id: candidate.id,
          result: "error",
          reason:
            error instanceof PatchDecisionError ? error.code : "execution_authority_not_granted",
          metadata: { workflow_id: candidate.workflow_id, combined_review: true },
        },
        db,
      );
    }
    throw error;
  }
}
