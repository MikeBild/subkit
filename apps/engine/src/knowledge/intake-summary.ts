import { and, count, countDistinct, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { CategorySchema } from "../api/catalog-metadata.ts";
import type { Db } from "../db/client.ts";
import { catalogCategories } from "../db/schema/catalog_categories.ts";
import {
  intakeItems,
  intakeProposalItems,
  intakeProposalRevisions,
  intakeProposals,
} from "../db/schema/intake.ts";

export interface IntakeSummary {
  clips: number;
  sessions: number;
  proposals: number;
}

const AWAITING_REVIEW = ["collected", "reviewing"] as const;

export async function getIntakeSummary(
  tenantId: string,
  categories: readonly string[],
  db: Db,
): Promise<IntakeSummary> {
  const requested = categories.flatMap((category) => {
    const parsed = CategorySchema.safeParse(category);
    return parsed.success ? [parsed.data] : [];
  });
  if (requested.length === 0) return { clips: 0, sessions: 0, proposals: 0 };
  const redirects = await db
    .select({ redirect_to: catalogCategories.redirect_to })
    .from(catalogCategories)
    .where(
      and(
        eq(catalogCategories.tenant_id, tenantId),
        inArray(catalogCategories.name, requested),
        isNotNull(catalogCategories.redirect_to),
      ),
    );
  const scope = [
    ...new Set([
      ...requested,
      ...redirects.flatMap((row) => (row.redirect_to ? [row.redirect_to] : [])),
    ]),
  ];
  const isSession = sql<boolean>`${intakeItems.original_snapshot}->>'origin' = 'session'`;
  const [items, proposals] = await Promise.all([
    db
      .select({ session: isSession, total: count() })
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, tenantId),
          inArray(intakeItems.category, scope),
          inArray(intakeItems.state, [...AWAITING_REVIEW]),
        ),
      )
      .groupBy(isSession),
    db
      .select({ total: countDistinct(intakeProposals.id) })
      .from(intakeProposals)
      .innerJoin(
        intakeProposalRevisions,
        and(
          eq(intakeProposalRevisions.proposal_id, intakeProposals.id),
          eq(intakeProposalRevisions.revision, intakeProposals.current_revision),
        ),
      )
      .innerJoin(
        intakeProposalItems,
        eq(intakeProposalItems.proposal_revision_id, intakeProposalRevisions.id),
      )
      .innerJoin(
        intakeItems,
        and(
          eq(intakeItems.id, intakeProposalItems.item_id),
          eq(intakeItems.tenant_id, intakeProposals.tenant_id),
        ),
      )
      .where(
        and(
          eq(intakeProposals.tenant_id, tenantId),
          eq(intakeProposals.status, "draft"),
          inArray(intakeItems.category, scope),
        ),
      ),
  ]);
  return {
    clips: items.find((row) => !row.session)?.total ?? 0,
    sessions: items.find((row) => row.session)?.total ?? 0,
    proposals: proposals[0]?.total ?? 0,
  };
}
