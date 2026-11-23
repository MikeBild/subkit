import { and, eq } from "drizzle-orm";
import { type Executor, intakeProposalRevisions, tenants } from "../../db/index.ts";
import { decideIntakeConfirmer, type IntakeParty } from "../core/intake-policy.ts";
import { IntakeSecondPersonRequiredError } from "../intake-errors.ts";

export async function assertConfirmerMayAdmit(
  tx: Executor,
  p: { tenant_id: string; proposal_id: string; revision: number; confirmer: IntakeParty },
): Promise<void> {
  const [tenant] = await tx
    .select({ policy: tenants.workflow_approval_policy })
    .from(tenants)
    .where(eq(tenants.id, p.tenant_id))
    .limit(1);
  if (tenant?.policy !== "pair") return;
  const [revision] = await tx
    .select({
      kind: intakeProposalRevisions.created_by_type,
      id: intakeProposalRevisions.created_by_id,
    })
    .from(intakeProposalRevisions)
    .where(
      and(
        eq(intakeProposalRevisions.tenant_id, p.tenant_id),
        eq(intakeProposalRevisions.proposal_id, p.proposal_id),
        eq(intakeProposalRevisions.revision, p.revision),
      ),
    )
    .limit(1);
  if (!revision) return;
  const verdict = decideIntakeConfirmer({
    policy: "pair",
    proposer: revision,
    confirmer: p.confirmer,
  });
  if (verdict === "own_proposal") throw new IntakeSecondPersonRequiredError();
}
