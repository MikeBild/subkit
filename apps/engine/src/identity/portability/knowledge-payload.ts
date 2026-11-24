import type { Executor } from "../../db/client.ts";
import { getKnowledgeSourceContent } from "../../knowledge/content.ts";
import type { KnowledgeSourceView } from "../../knowledge/types.ts";
import type { KnowledgePayload } from "./format.ts";

export async function knowledgePayload(
  exec: Executor,
  tenant_id: string,
  source: KnowledgeSourceView,
): Promise<KnowledgePayload> {
  const content = await getKnowledgeSourceContent(tenant_id, source.id, exec);
  return {
    slug: source.slug,
    name: source.name,
    description: source.description,
    category: source.category,
    tags: source.tags,
    source_type: source.source_type,
    documents: content?.documents ?? [],
  };
}
