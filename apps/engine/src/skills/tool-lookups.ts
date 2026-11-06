import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { skills } from "../db/schema/index.ts";

export async function findSkillSafetyBySlug(db: Executor, tenant_id: string, slug: string) {
  const [row] = await db
    .select({ side_effects: skills.side_effects, title: skills.title })
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.slug, slug)))
    .limit(1);
  return row;
}

export async function lockServicePackageSkillOrigin(
  tx: Executor,
  tenant_id: string,
  connector_id: string,
  origin_tag: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`service-package-skill:${tenant_id}:${connector_id}:${origin_tag}`}))`,
  );
}
