export function knowledgeSearchCacheKey(
  p: Readonly<{
    tenant_id: string;
    query: string;
    scope?: string;
    workflow_id?: string;
    knowledge_source_ids?: readonly string[];
    tags?: readonly string[];
    limit?: number;
  }>,
): string {
  const limit = Math.min(Math.max(1, p.limit ?? 10), 50);
  return `${p.tenant_id}:${JSON.stringify([
    p.scope ?? "",
    p.workflow_id ?? "",
    [...(p.knowledge_source_ids ?? [])].sort(),
    [...(p.tags ?? [])].sort(),
    limit,
    p.query.trim().toLowerCase(),
  ])}`;
}
