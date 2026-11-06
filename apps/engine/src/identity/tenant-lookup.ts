import { eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";

export async function findTenantIdBySlug(db: Executor, slug: string): Promise<string | null> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  return rows[0]?.id ?? null;
}
