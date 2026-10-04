import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { workflows } from "../../db/schema/index.ts";
import { loadSnapshotCoverage } from "../../llm/core/tenant-summary.ts";
import type { EnumerationCoverage } from "../intent-detector.ts";
import { resolveNamedWorkflowSlug } from "../tools/authoring-palette.ts";

export async function loadEnumerationCoverage(
  tenant_id: string,
  text: string | null,
  exec: Executor,
): Promise<EnumerationCoverage> {
  const [coverage, rows] = await Promise.all([
    loadSnapshotCoverage(tenant_id, exec),
    exec
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at))),
  ]);
  const slugs = new Set(rows.map((r) => r.slug));
  return { ...coverage, names_existing_workflow: resolveNamedWorkflowSlug(text, slugs) !== null };
}
