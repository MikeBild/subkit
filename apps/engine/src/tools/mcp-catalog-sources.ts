import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { connectors, skills } from "../db/schema/index.ts";

export async function listActivePromptSkills(db: Db, tenantId: string) {
  return db
    .select({
      id: skills.id,
      title: skills.title,
      scope: skills.scope,
    })
    .from(skills)
    .where(and(eq(skills.tenant_id, tenantId), eq(skills.lifecycle, "active")))
    .orderBy(desc(skills.created_at));
}

export async function listResourceConnectors(db: Db, tenantId: string) {
  return db
    .select({
      id: connectors.id,
      slug: connectors.slug,
      display_name: connectors.display_name,
      driver: connectors.driver,
    })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenantId), isNull(connectors.deleted_at)))
    .orderBy(desc(connectors.created_at));
}
