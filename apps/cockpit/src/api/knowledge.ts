import { apiRequest } from "./client";

interface KnowledgeChunk {
  ordinal: number;
  title: string | null;
  path: string | null;
  content: string;
  byte_size: number;
}

export async function loadKnowledgeChunks(
  sourceId: string,
): Promise<{ items: KnowledgeChunk[]; total: number }> {
  const path = `/v1/knowledge-sources/${encodeURIComponent(sourceId)}/chunks`;
  const first = await apiRequest<{ items: KnowledgeChunk[]; total: number }>(`${path}?limit=200`);
  const items = [...first.items];
  while (items.length < first.total) {
    const page = await apiRequest<{ items: KnowledgeChunk[]; total: number }>(
      `${path}?limit=200&offset=${items.length}`,
    );
    if (page.items.length === 0 || page.total !== first.total)
      throw new Error("knowledge-chunks-changed");
    items.push(...page.items);
  }
  return { ...first, items };
}
