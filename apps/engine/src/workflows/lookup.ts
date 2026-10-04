import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";

export interface WorkflowLookupResult {
  id: string;
  slug: string;
  name: string;
  current_version_id: string | null;
  is_tool: boolean;
}

export interface ResolveWorkflowOptions {
  require_published?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(ref: string): boolean {
  return UUID_RE.test(ref);
}

export async function resolveWorkflowByIdOrSlug(
  db: Db,
  tenant_id: string,
  ref: string,
  opts: ResolveWorkflowOptions = {},
): Promise<WorkflowLookupResult | null> {
  const isUuid = looksLikeUuid(ref);
  const rows = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      current_version_id: workflows.current_version_id,
      is_tool: workflows.is_tool,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        isUuid ? eq(workflows.id, ref) : eq(workflows.slug, ref),
        isNull(workflows.deleted_at),
        ...(opts.require_published ? [isNotNull(workflows.current_version_id)] : []),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
