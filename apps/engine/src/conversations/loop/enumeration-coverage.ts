import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { loadVisibleCatalog, visibleCatalogCoverage } from "../../llm/runtime/tenant-summary.ts";
import type { EnumerationCoverage } from "../intent-detector.ts";
import { resolveNamedWorkflowSlug } from "../tools/authoring-palette.ts";

export async function loadEnumerationCoverage(
  principal: ResolvedPrincipal,
  text: string | null,
  db: Db,
): Promise<EnumerationCoverage> {
  const catalog = await loadVisibleCatalog(principal, db);
  const slugs = new Set(catalog.workflows.map((row) => row.slug));
  return {
    ...visibleCatalogCoverage(catalog),
    names_existing_workflow: resolveNamedWorkflowSlug(text, slugs) !== null,
  };
}
