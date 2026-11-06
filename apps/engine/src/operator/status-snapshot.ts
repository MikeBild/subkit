import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { connectors, llmUsage, skills, tenants } from "../db/schema/index.ts";
import {
  monthlyUsageForUser,
  readTenantMonthlyBudget,
  resolveUserMonthlyBudget,
} from "../llm/index.ts";

interface StatusUserUsage {
  tokens_today: number;
  tokens_month: number;
  budget_tokens: number | null;
  remaining_tokens: number | null;
}

interface StatusSnapshot {
  tenant_slug: string | null;
  connectors_count: number;
  skills_count: number;
  tokens_today: number;
  month: Awaited<ReturnType<typeof readTenantMonthlyBudget>>;
  user: StatusUserUsage | null;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function userUsage(
  db: Db,
  tenantId: string,
  userId: string,
  startOfDay: Date,
): Promise<StatusUserUsage> {
  const [todayUserRow, monthUser, resolvedUserBudget] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int` })
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenant_id, tenantId),
          eq(llmUsage.user_id, userId),
          sql`${llmUsage.created_at} >= ${startOfDay}`,
        ),
      ),
    monthlyUsageForUser(tenantId, userId, db),
    resolveUserMonthlyBudget(tenantId, userId, db),
  ]);
  const tokensMonth = Number(monthUser);
  return {
    tokens_today: Number(todayUserRow[0]?.total ?? 0),
    tokens_month: tokensMonth,
    budget_tokens: resolvedUserBudget,
    remaining_tokens:
      resolvedUserBudget == null ? null : Math.max(resolvedUserBudget - tokensMonth, 0),
  };
}

export async function loadStatusSnapshot(
  db: Db,
  tenantId: string,
  userId: string | null,
  now: Date,
): Promise<StatusSnapshot> {
  const startOfDay = startOfUtcDay(now);
  const [connectorRow, skillsRow, todayRow, tenantRow, month] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), isNull(connectors.deleted_at))),
    db.select({ n: sql<number>`count(*)::int` }).from(skills).where(eq(skills.tenant_id, tenantId)),
    db
      .select({ total: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int` })
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, tenantId), sql`${llmUsage.created_at} >= ${startOfDay}`)),
    db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    readTenantMonthlyBudget(tenantId, db),
  ]);
  return {
    tenant_slug: tenantRow[0]?.slug ?? null,
    connectors_count: Number(connectorRow[0]?.n ?? 0),
    skills_count: Number(skillsRow[0]?.n ?? 0),
    tokens_today: Number(todayRow[0]?.total ?? 0),
    month,
    user: userId ? await userUsage(db, tenantId, userId, startOfDay) : null,
  };
}
