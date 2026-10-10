import { and, count, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { intakeItems, intakeProposals } from "../db/schema/intake.ts";

export interface IntakeSummary {
  collected: number;
  reviewing: number;
  proposals: number;
}

export async function getIntakeSummary(tenantId: string, db: Db): Promise<IntakeSummary> {
  const [items, proposals] = await Promise.all([
    db
      .select({ state: intakeItems.state, total: count() })
      .from(intakeItems)
      .where(eq(intakeItems.tenant_id, tenantId))
      .groupBy(intakeItems.state),
    db
      .select({ total: count() })
      .from(intakeProposals)
      .where(and(eq(intakeProposals.tenant_id, tenantId), eq(intakeProposals.status, "draft"))),
  ]);
  return {
    collected: items.find((row) => row.state === "collected")?.total ?? 0,
    reviewing: items.find((row) => row.state === "reviewing")?.total ?? 0,
    proposals: proposals[0]?.total ?? 0,
  };
}
