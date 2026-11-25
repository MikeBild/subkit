import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { UUID_RE } from "../utils/index.ts";

interface WorkflowLookupResult {
  id: string;
  slug: string;
  name: string;
  current_version_id: string | null;
  is_tool: boolean;
}

interface ResolveWorkflowOptions {
  require_published?: boolean;
}

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

export async function workflowIdBySlug(
  db: Executor,
  tenant_id: string,
  slug: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.slug, slug),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

interface WorkflowHead {
  workflow: {
    id: string;
    slug: string;
    lifecycle: string;
    draft_version_id: string | null;
    current_version_id: string | null;
  };
  head_version_id: string | null;
  head: { dag: unknown; version: number } | null;
}

export async function loadWorkflowHead(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
): Promise<WorkflowHead | null> {
  const [workflow] = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      lifecycle: workflows.lifecycle,
      draft_version_id: workflows.draft_version_id,
      current_version_id: workflows.current_version_id,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!workflow) return null;
  const head_version_id = workflow.draft_version_id ?? workflow.current_version_id;
  const [head] = head_version_id
    ? await db
        .select({ dag: workflowVersions.dag, version: workflowVersions.version })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, tenant_id),
            eq(workflowVersions.workflow_id, workflow.id),
            eq(workflowVersions.id, head_version_id),
          ),
        )
        .limit(1)
    : [];
  return { workflow, head_version_id, head: head ?? null };
}

export async function findLiveWorkflowByRef(db: Executor, tenant_id: string, ref: string) {
  const [row] = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      lifecycle: workflows.lifecycle,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        isNull(workflows.deleted_at),
        looksLikeUuid(ref)
          ? or(eq(workflows.id, ref), eq(workflows.slug, ref))
          : eq(workflows.slug, ref),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findWorkflowLabel(db: Executor, tenant_id: string, workflow_id: string) {
  const [row] = await db
    .select({ slug: workflows.slug, name: workflows.name })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)))
    .limit(1);
  return row;
}

export async function findCurrentVersionScopeIndex(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
) {
  const [row] = await db
    .select({ scope_index: workflowVersions.scope_index, dag: workflowVersions.dag })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)))
    .limit(1);
  return row;
}
