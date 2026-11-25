import { and, eq, inArray } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { type Executor, intakeItems, intakeProposals } from "../../db/index.ts";
import { intakeItemSources, intakeProposalSources } from "../core/intake-status.ts";
import type { IntakeItemState, IntakeProposalStatus } from "../intake-types.ts";

type Locked = "id" | "tenant_id";

interface IntakeProposalTransition {
  tenant_id: string;
  ids: readonly string[];
  to: IntakeProposalStatus;
  set?: Omit<PgUpdateSetSource<typeof intakeProposals>, "status" | Locked>;
}

interface IntakeItemTransition {
  tenant_id: string;
  ids: readonly string[];
  to: IntakeItemState;
  set?: Omit<PgUpdateSetSource<typeof intakeItems>, "state" | Locked>;
}

export async function transitionIntakeProposals(
  tx: Executor,
  transition: IntakeProposalTransition,
): Promise<void> {
  const sources = intakeProposalSources(transition.to);
  if (sources.length === 0 || transition.ids.length === 0) return;
  await tx
    .update(intakeProposals)
    .set({ ...transition.set, status: transition.to })
    .where(
      and(
        eq(intakeProposals.tenant_id, transition.tenant_id),
        inArray(intakeProposals.id, [...transition.ids]),
        inArray(intakeProposals.status, sources),
      ),
    );
}

export async function transitionIntakeItems(
  tx: Executor,
  transition: IntakeItemTransition,
): Promise<void> {
  const sources = intakeItemSources(transition.to);
  if (sources.length === 0 || transition.ids.length === 0) return;
  await tx
    .update(intakeItems)
    .set({ ...transition.set, state: transition.to })
    .where(
      and(
        eq(intakeItems.tenant_id, transition.tenant_id),
        inArray(intakeItems.id, [...transition.ids]),
        inArray(intakeItems.state, sources),
      ),
    );
}
