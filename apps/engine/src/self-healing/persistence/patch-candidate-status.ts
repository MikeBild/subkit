import { and, eq, inArray } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { type Executor, patchCandidates } from "../../db/index.ts";
import {
  type PatchCandidateStatus,
  patchCandidateSources,
} from "../core/patch-candidate-status.ts";

interface PatchCandidateTransition {
  tenant_id: string;
  candidate_id: string;
  to: PatchCandidateStatus;
  set?: Omit<PgUpdateSetSource<typeof patchCandidates>, "status" | "id" | "tenant_id">;
}

export async function transitionPatchCandidate(
  tx: Executor,
  transition: PatchCandidateTransition,
): Promise<boolean> {
  const sources = patchCandidateSources(transition.to);
  if (sources.length === 0) return false;
  const rows = await tx
    .update(patchCandidates)
    .set({ ...transition.set, status: transition.to })
    .where(
      and(
        eq(patchCandidates.tenant_id, transition.tenant_id),
        eq(patchCandidates.id, transition.candidate_id),
        inArray(patchCandidates.status, sources),
      ),
    )
    .returning({ id: patchCandidates.id });
  return rows.length > 0;
}
